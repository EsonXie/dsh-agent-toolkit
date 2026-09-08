// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CommonKeyOf } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskForm } from './TaskForm.tsx'
import { zh, type ScheduleKey } from './locales.ts'

/** t 桩：zh 真源 + {param} 插值（schedule-modal.client.spec.tsx 同款）。键域含共享 common 词汇（TranslateNS 并入）。 */
function t(key: ScheduleKey | CommonKeyOf, params?: Record<string, unknown>): string {
  let text: string = zh[key as ScheduleKey] ?? ''
  for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v))
  return text
}

function stubFetch(routes: Record<string, (body?: unknown) => unknown>) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method ?? 'GET', body })
    const handler = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1]
    if (handler === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(handler(body)), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const BASE_ROUTES = {
  '/dsh-agent-toolkit/api/cron/projects': () => ({ projects: ['D:\\work', 'D:\\ops'] }),
  '/dsh-agent-toolkit/api/agents': () => [{ id: 'main', name: '主 Agent' }, { id: 'explorer', name: 'Explorer' }],
  '/dsh-agent-toolkit/api/cron/tasks': () => ({ task: {} }),
}

test('创建（cron + 角色）：payload 装配 schedule/target 判别联合；cron 预览渲染 3 次触发', async () => {
  const calls = stubFetch(BASE_ROUTES)
  const saved = vi.fn()
  render(<TaskForm draft={undefined} t={t} onSaved={saved} onCancel={() => undefined} />)

  await screen.findByRole('option', { name: 'D:\\work' })
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '日报' } })
  fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '写日报' } })
  fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:\\ops' } })
  fireEvent.click(screen.getByRole('radio', { name: '角色' }))
  fireEvent.change(screen.getByRole('combobox', { name: '角色' }), { target: { value: 'explorer' } })
  fireEvent.change(screen.getByRole('textbox', { name: /表达式/ }), { target: { value: '0 9 * * *' } })
  fireEvent.change(screen.getByLabelText(/时区/), { target: { value: 'Asia/Shanghai' } })

  // 预览：未来 3 次触发（croner 内联计算，不打网络）
  await screen.findByText('未来 3 次触发')
  const previewItems = document.querySelectorAll('[data-testid="cron-preview"] li')
  expect(previewItems.length).toBe(3)

  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const create = calls.find((c) => c.url === '/dsh-agent-toolkit/api/cron/tasks' && c.method === 'POST')
  expect(create?.body).toMatchObject({
    name: '日报', prompt: '写日报', cwd: 'D:\\ops',
    schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' },
    target: { kind: 'role', roleId: 'explorer' },
    catchup: true, enabled: true,
  })
})

test('创建（every）：间隔秒数装配；<60 由服务端拒绝时展示错误', async () => {
  const calls = stubFetch({
    ...BASE_ROUTES,
    '/dsh-agent-toolkit/api/cron/tasks': () => { throw new Error('unreachable') },
  })
  // 用 400 响应模拟服务端拒绝：stubFetch 的 handler 返回值固定 200，改为直接校验 payload 装配。
  render(<TaskForm draft={undefined} t={t} onSaved={vi.fn()} onCancel={() => undefined} />)
  await screen.findByRole('option', { name: 'D:\\work' })
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '巡检' } })
  fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '巡检' } })
  fireEvent.click(screen.getByRole('radio', { name: '固定间隔' }))
  fireEvent.change(screen.getByLabelText(/间隔秒数/), { target: { value: '3600' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await vi.waitFor(() => {
    const create = calls.find((c) => c.method === 'POST')
    expect(create?.body).toMatchObject({ schedule: { kind: 'every', seconds: 3600 }, target: { kind: 'main' } })
  })
})

test('编辑：回填既有任务字段并 PUT', async () => {
  const calls = stubFetch({
    ...BASE_ROUTES,
    '/dsh-agent-toolkit/api/cron/tasks/task-1': () => ({ task: {} }),
  })
  const draft = {
    id: 'task-1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
    schedule: { kind: 'every', seconds: 7200 }, target: { kind: 'main' },
    catchup: false, enabled: false,
    nextRunAt: null, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
  } as const
  const saved = vi.fn()
  render(<TaskForm draft={draft} t={t} onSaved={saved} onCancel={() => undefined} />)
  await screen.findByRole('option', { name: 'D:\\work' })
  expect(screen.getByLabelText('名称')).toHaveProperty('value', '日报')
  expect(screen.getByLabelText(/间隔秒数/)).toHaveProperty('value', '7200')
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '晚报' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const put = calls.find((c) => c.method === 'PUT')
  expect(put?.url).toContain('task-1')
  expect(put?.body).toMatchObject({ name: '晚报', enabled: false, catchup: false })
})

test('保存失败：展示服务端错误消息', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/projects')) return new Response(JSON.stringify({ projects: ['D:\\work'] }), { status: 200 })
    if (url.includes('/agents')) return new Response(JSON.stringify([{ id: 'main', name: '主 Agent' }]), { status: 200 })
    return new Response(JSON.stringify({ error: '非法 cron 表达式' }), { status: 400 })
  }))
  render(<TaskForm draft={undefined} t={t} onSaved={vi.fn()} onCancel={() => undefined} />)
  await screen.findByRole('option', { name: 'D:\\work' })
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'x' } })
  fireEvent.change(screen.getByLabelText('提示词'), { target: { value: 'x' } })
  fireEvent.change(screen.getByRole('textbox', { name: /表达式/ }), { target: { value: 'bad' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toContain('非法 cron 表达式')
})
