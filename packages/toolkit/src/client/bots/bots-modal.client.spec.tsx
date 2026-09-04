// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BotsModal } from './BotsModal.tsx'

const BOTS = {
  bots: [
    {
      id: 'reviewer', name: '评审机器人', channel: 'feishu',
      feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'r1' },
      project: 'D:\\work\\demo', status: 'connected', createdAt: 1, updatedAt: 1,
    },
    {
      id: 'ops', name: '运维机器人', channel: 'feishu',
      feishu: { appId: 'cli_000000000000000a', appSecretRef: 'r2' },
      project: 'D:\\work\\demo', status: 'failed', createdAt: 1, updatedAt: 1,
    },
    {
      id: 'docs', name: '文档机器人', channel: 'feishu',
      feishu: { appId: 'cli_000000000000000b', appSecretRef: 'r3' },
      project: 'D:\\work\\other', status: 'not-running', createdAt: 1, updatedAt: 1,
    },
    {
      id: 'loose', name: '未绑定机器人', project: 'D:\\work\\other', status: 'unbound', createdAt: 1, updatedAt: 1,
    },
  ],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(BOTS), { status: 200, headers: { 'content-type': 'application/json' } })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const useWorkspaces = <S,>(selector: (s: { items: unknown[] }) => S): S => selector({ items: [] })

function rowOf(name: string): HTMLElement {
  const main = screen.getByText(name).closest('button')
  if (main === null) throw new Error(`row not found: ${name}`)
  return main.parentElement as HTMLElement
}

test('删除两段确认：首点仅切确认态；再点 DELETE 并刷新列表', async () => {
  let deletes = 0
  let gets = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if ((init?.method ?? 'GET') === 'DELETE' && url.includes('id=reviewer')) {
      deletes += 1
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/bots')) gets += 1
    return new Response(JSON.stringify(BOTS), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces} />)
  expect(await screen.findByText('评审机器人')).toBeTruthy()

  // 首段：只切确认态，不发 DELETE
  fireEvent.click(within(rowOf('评审机器人')).getByRole('button', { name: '删除' }))
  expect(within(rowOf('评审机器人')).getByRole('button', { name: '确认删除？' })).toBeTruthy()
  expect(deletes).toBe(0)

  // 第二段：确认 → DELETE → reload（GET 计数 +1）
  const getsBefore = gets
  fireEvent.click(within(rowOf('评审机器人')).getByRole('button', { name: '确认删除？' }))
  await vi.waitFor(() => { expect(deletes).toBe(1) })
  await vi.waitFor(() => { expect(gets).toBe(getsBefore + 1) })
})

test('删除确认态转移：点其它行的删除按钮，原行复位', async () => {
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces} />)
  expect(await screen.findByText('评审机器人')).toBeTruthy()
  fireEvent.click(within(rowOf('评审机器人')).getByRole('button', { name: '删除' }))
  expect(within(rowOf('评审机器人')).getByRole('button', { name: '确认删除？' })).toBeTruthy()
  fireEvent.click(within(rowOf('运维机器人')).getByRole('button', { name: '删除' }))
  expect(within(rowOf('评审机器人')).getByRole('button', { name: '删除' })).toBeTruthy()
  expect(within(rowOf('运维机器人')).getByRole('button', { name: '确认删除？' })).toBeTruthy()
})

test('删除失败：DELETE 500 → role=alert 错误行', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'DELETE') return new Response('boom', { status: 500 })
    return new Response(JSON.stringify(BOTS), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces} />)
  expect(await screen.findByText('评审机器人')).toBeTruthy()
  fireEvent.click(within(rowOf('评审机器人')).getByRole('button', { name: '删除' }))
  fireEvent.click(within(rowOf('评审机器人')).getByRole('button', { name: '确认删除？' }))
  expect((await screen.findByRole('alert')).textContent).toContain('删除失败')
})

test('列表按项目分组，显示渠道标记与运行状态', async () => {
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces} onEdit={() => undefined} />)
  expect(await screen.findByText('评审机器人')).toBeTruthy()
  expect(screen.getByText('运维机器人')).toBeTruthy()
  expect(screen.getByText('文档机器人')).toBeTruthy()
  // 分组标题：两个项目
  expect(screen.getByText('D:\\work\\demo')).toBeTruthy()
  expect(screen.getByText('D:\\work\\other')).toBeTruthy()
  // 渠道标记：仅已绑定 bot 显示（4 条里 3 条已绑定，未绑定那条无徽标）
  expect(screen.getAllByText('飞书').length).toBe(3)
  // 未绑定态
  expect(screen.getByText('未绑定机器人')).toBeTruthy()
  expect(screen.getByText('未绑定')).toBeTruthy()
  // 状态
  expect(screen.getByText('已连接')).toBeTruthy()
  expect(screen.getByText('连接失败')).toBeTruthy()
  expect(screen.getByText('未运行')).toBeTruthy()
})

test('点击机器人行触发 onEdit；新建按钮触发 onCreate', async () => {
  const edits: string[] = []
  let created = 0
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces}
    onEdit={(bot) => { edits.push(bot.id) }} onCreate={() => { created += 1 }} />)
  ;(await screen.findByText('评审机器人')).click()
  expect(edits).toEqual(['reviewer'])
  screen.getByRole('button', { name: '新建机器人' }).click()
  expect(created).toBe(1)
})

test('加载失败显示错误态', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })))
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces} />)
  expect(await screen.findByText('加载失败，请重试')).toBeTruthy()
})
