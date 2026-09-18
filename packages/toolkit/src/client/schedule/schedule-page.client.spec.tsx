// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CommonKeyOf } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, expect, test, vi } from 'vitest'
import { SchedulePage } from './SchedulePage.tsx'
import { zh, type ScheduleKey } from './locales.ts'

/** t 桩：zh 真源 + {param} 插值（delegate-card.test.tsx 同款）。键域含共享 common 词汇（TranslateNS 并入）。 */
function t(key: ScheduleKey | CommonKeyOf, params?: Record<string, unknown>): string {
  let text: string = zh[key as ScheduleKey] ?? ''
  for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v))
  return text
}

const TASK = {
  id: 'task-1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' },
  target: { kind: 'main' }, catchup: true, enabled: true,
  nextRunAt: '2026-09-08T01:00:00.000Z',
  createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
  lastRun: { status: 'ok', triggeredAt: '2026-09-07T01:00:00.000Z' },
}

function stubFetch(routes: Record<string, (body?: unknown) => unknown>) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body !== undefined && init.body !== '{}' ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method ?? 'GET', body })
    const handler = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1]
    if (handler === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(handler(body)), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderPage() {
  const openSession = vi.fn()
  render(<SchedulePage t={t} openSession={openSession} />)
  return { openSession }
}

test('无弹窗壳：整页渲染不出现 dialog role', async () => {
  stubFetch({ '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [TASK] }) })
  renderPage()
  await screen.findByText('日报')
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('列表渲染：名称/调度摘要/目标/下次触发/上次运行徽标', async () => {
  stubFetch({ '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [TASK] }) })
  renderPage()
  await screen.findByText('日报')
  expect(screen.getByText(/cron: 0 9 \* \* \* \(Asia\/Shanghai\)/)).toBeDefined()
  expect(screen.getByText('主 Agent')).toBeDefined()
  expect(screen.getByText(/下次触发/)).toBeDefined()
  expect(screen.getByText('成功')).toBeDefined()
})

test('人类可读调度描述：每天/每工作日/每周/每小时/自定义/一次性/固定间隔', async () => {
  const make = (id: string, name: string, schedule: unknown) => ({
    ...TASK, id, name, schedule, lastRun: undefined,
  })
  stubFetch({
    '/dsh-agent-toolkit/api/cron/tasks': () => ({
      tasks: [
        make('daily', '每天', { kind: 'cron', expr: '0 9 * * *' }),
        make('weekdays', '工作日', { kind: 'cron', expr: '30 8 * * 1-5' }),
        make('weekly', '每周', { kind: 'cron', expr: '0 7 * * 3' }),
        make('hourly', '每小时', { kind: 'cron', expr: '15 * * * *' }),
        make('custom', '自定义', { kind: 'cron', expr: '*/5 * * * *' }),
        make('at', '单次', { kind: 'at', at: '2026-09-20T01:00:00.000Z' }),
        make('every', '间隔', { kind: 'every', seconds: 3600 }),
      ],
    }),
  })
  renderPage()
  expect(await screen.findByText('每天 09:00')).toBeDefined()
  expect(screen.getByText('每工作日 08:30')).toBeDefined()
  expect(screen.getByText('每周三 07:00')).toBeDefined()
  expect(screen.getByText('每小时第 15 分')).toBeDefined()
  expect(screen.getByText('自定义 */5 * * * *')).toBeDefined()
  expect(screen.getByText(/^一次性 /)).toBeDefined()
  expect(screen.getByText('每 3600 秒')).toBeDefined()
})

test('enabled 行内开关：PUT enabled=false 并 toast', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/cron/tasks/task-1': () => ({ task: TASK }),
    '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [TASK] }),
  })
  renderPage()
  const toggle = await screen.findByRole('switch', { name: /日报/ })
  fireEvent.click(toggle)
  await vi.waitFor(() => {
    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('task-1'))
    expect(put?.body).toEqual({ enabled: false })
  })
  expect(await screen.findByRole('alert')).toBeTruthy()
})

test('删除两段确认：第一次点击变确认，第二次发 DELETE 并 toast', async () => {
  const calls = stubFetch({ '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [TASK] }) })
  renderPage()
  const del = await screen.findByRole('button', { name: '删除' })
  fireEvent.click(del)
  expect(screen.getByRole('button', { name: '确认删除？' })).toBeDefined()
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '确认删除？' }))
  await vi.waitFor(() => { expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('task-1'))).toBe(true) })
  expect(await screen.findByRole('alert')).toBeTruthy()
})

test('立即触发：POST trigger 并重拉', async () => {
  const calls = stubFetch({ '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [TASK] }) })
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: '立即触发' }))
  await vi.waitFor(() => { expect(calls.some((c) => c.method === 'POST' && c.url.includes('/trigger'))).toBe(true) })
})

test('运行历史：点击任务行展开拉取 runs，sessionId 链接点击打开会话', async () => {
  stubFetch({
    '/dsh-agent-toolkit/api/cron/tasks/task-1/runs': () => ({
      runs: [{ id: 'r1', taskId: 'task-1', triggeredAt: '2026-09-07T01:00:00.000Z', finishedAt: '2026-09-07T01:02:00.000Z', status: 'ok', sessionId: 'sess-1' }],
    }),
    '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [TASK] }),
  })
  const { openSession } = renderPage()
  fireEvent.click(await screen.findByRole('button', { name: /日报/ }))
  fireEvent.click(await screen.findByRole('button', { name: '查看会话' }))
  expect(openSession).toHaveBeenCalledWith('sess-1')
})

test('新建任务：直接渲染 SchedulePage 后点添加，内联渲染 TaskForm（React #310 hooks 宿主回归）', async () => {
  stubFetch({
    '/dsh-agent-toolkit/api/cron/projects': () => ({ projects: ['D:\\work'] }),
    '/dsh-agent-toolkit/api/agents': () => [],
    '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [] }),
  })
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: '新建任务' }))
  expect(await screen.findByLabelText('名称')).toBeDefined()
})

test('保存成功：POST 后回列表并 toast', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/cron/projects': () => ({ projects: ['D:\\work'] }),
    '/dsh-agent-toolkit/api/agents': () => [],
    '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [] }),
  })
  renderPage()
  fireEvent.click(await screen.findByRole('button', { name: '新建任务' }))
  fireEvent.change(await screen.findByLabelText('名称'), { target: { value: '日报' } })
  fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '写日报' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await vi.waitFor(() => {
    expect(calls.some((c) => c.method === 'POST' && c.url === '/dsh-agent-toolkit/api/cron/tasks')).toBe(true)
  })
  expect(await screen.findByRole('alert')).toBeTruthy()
})
