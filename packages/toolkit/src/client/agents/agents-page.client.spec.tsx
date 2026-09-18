// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { AgentsPage } from './AgentsPage.tsx'

// 服务端 GET /agents 已按 createdAt 升序返回（main 恒置顶），客户端按返回顺序渲染。
const AGENTS = [
  { id: 'main', name: '主 Agent', builtin: true, createdAt: 0 },
  { id: 'aaa', name: 'AAA', createdAt: 1 },
  { id: 'explorer', name: 'Explorer', description: '快速只读代码库探索', builtin: true, createdAt: 2 },
]

const BOTS = {
  bots: [
    { id: 'bot-a', name: '机器人一', project: 'D:\\work\\a', status: 'connected', agentRef: 'aaa', createdAt: 1, updatedAt: 1 },
  ],
}

interface RouteResult { status?: number; body?: unknown }
type Route = (init?: RequestInit) => RouteResult
interface FetchCall { url: string; method: string; body?: unknown }

function stubFetch(routes: Record<string, Route>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    const handler = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1]
    if (handler === undefined) return new Response('not found', { status: 404 })
    const result = handler(init)
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
  return calls
}

function routes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    // 更具体的前缀在前（stubFetch 按插入序首个命中）
    '/dsh-agent-toolkit/api/agents/': (init) => (init?.method === 'DELETE'
      ? { status: 409, body: { error: '角色 "aaa" 仍有 2 个 Bot 绑定，请先删除这些 Bot', bots: 2 } }
      : { body: { ok: true } }),
    '/dsh-agent-toolkit/api/agents': () => ({ body: AGENTS }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ body: BOTS }),
    '/dsh-agent-toolkit/api/providers': () => ({ body: [] }),
    '/dsh-agent-toolkit/api/tools': () => ({ body: { preset: ['bash', 'read'], global: ['write'] } }),
    ...overrides,
  }
}

const stubUseWorkspaces = <S,>(selector: (s: { items: readonly unknown[] }) => S): S => selector({ items: [] })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function cardOf(name: string): HTMLElement {
  const label = screen.getByText(name)
  const card = label.closest('[data-testid="agent-card"]')
  if (card === null) throw new Error(`card not found: ${name}`)
  return card as HTMLElement
}

test('按创建时间升序渲染卡片，main 置顶', async () => {
  stubFetch(routes())
  render(<AgentsPage t={(k) => k} useWorkspaces={stubUseWorkspaces} />)

  const names = await screen.findAllByTestId('agent-card-name')
  expect(names.map((n) => n.textContent)).toEqual(['主 Agent', 'AAA', 'Explorer'])
})

test('main 卡无编辑/删除按钮，显示只读说明', async () => {
  stubFetch(routes())
  render(<AgentsPage t={(k) => k} useWorkspaces={stubUseWorkspaces} />)

  await screen.findByText('主 Agent')
  const card = cardOf('主 Agent')
  expect(within(card).queryByRole('button', { name: '编辑' })).toBeNull()
  expect(within(card).queryByRole('button', { name: '删除' })).toBeNull()
  expect(within(card).getByText('使用宿主默认模型与装配')).toBeTruthy()
})

test('内置卡带「内置」徽标，普通卡不带', async () => {
  stubFetch(routes())
  render(<AgentsPage t={(k) => k} useWorkspaces={stubUseWorkspaces} />)

  await screen.findByText('AAA')
  expect(within(cardOf('主 Agent')).getByText('内置')).toBeTruthy()
  expect(within(cardOf('Explorer')).getByText('内置')).toBeTruthy()
  expect(within(cardOf('AAA')).queryByText('内置')).toBeNull()
})

test('删除名下有 Bot 的角色：两段确认后展示 409 错误（含 Bot 数量），列表不变', async () => {
  stubFetch(routes())
  render(<AgentsPage t={(k) => k} useWorkspaces={stubUseWorkspaces} />)

  await screen.findByText('AAA')
  const card = cardOf('AAA')
  fireEvent.click(within(card).getByRole('button', { name: '删除' }))
  expect(within(card).getByRole('button', { name: '确认删除？' })).toBeTruthy()
  fireEvent.click(within(card).getByRole('button', { name: '确认删除？' }))

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('2')
  expect(screen.getByText('AAA')).toBeTruthy()
})

test('保存成功：toast 出现且列表重载', async () => {
  const calls = stubFetch(routes())
  render(<AgentsPage t={(k) => k} useWorkspaces={stubUseWorkspaces} />)

  await screen.findByText('AAA')
  fireEvent.click(within(cardOf('AAA')).getByRole('button', { name: '编辑' }))
  const nameInput = await screen.findByLabelText('名称')
  fireEvent.change(nameInput, { target: { value: 'AAA 改' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  expect(await screen.findByRole('alert')).toBeTruthy()
  await vi.waitFor(() => {
    const gets = calls.filter((c) => c.url === '/dsh-agent-toolkit/api/agents' && c.method === 'GET')
    expect(gets.length).toBeGreaterThanOrEqual(2)
  })
})
