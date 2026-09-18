// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { AgentsPage } from './AgentsPage.tsx'
import { zh } from '../settings/locales.ts'

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
    '/dsh-agent-toolkit/api/providers/deepseek/models': () => ({ body: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/providers': () => ({ body: [] }),
    '/dsh-agent-toolkit/api/tools': () => ({ body: { preset: ['bash', 'read'], global: ['write'] } }),
    ...overrides,
  }
}

const stubUseWorkspaces = <S,>(selector: (s: { items: readonly unknown[] }) => S): S => selector({ items: [] })

/** t 桩：agent-toolkit 词典（页面文案无插值或插值由 zh 真源承载）。 */
function t(key: string, params?: Record<string, unknown>): string {
  let text = (zh as Record<string, string>)[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v))
  return text
}

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

/** 卡片操作区（编辑/删除）；Bot 行内亦有同名按钮，需按 testid 限定作用域。 */
function actionsOf(card: HTMLElement): HTMLElement {
  const actions = card.querySelector('[data-testid="agent-card-actions"]')
  if (actions === null) throw new Error('agent-card-actions not found')
  return actions as HTMLElement
}

function renderPage() {
  render(<AgentsPage t={t} useWorkspaces={stubUseWorkspaces} />)
}

test('按创建时间升序渲染卡片，main 置顶', async () => {
  stubFetch(routes())
  renderPage()

  const names = await screen.findAllByTestId('agent-card-name')
  expect(names.map((n) => n.textContent)).toEqual(['主 Agent', 'AAA', 'Explorer'])
})

test('main 卡无编辑/删除按钮，显示只读说明', async () => {
  stubFetch(routes())
  renderPage()

  await screen.findByText('主 Agent')
  const card = cardOf('主 Agent')
  expect(within(card).queryByRole('button', { name: zh['agents.edit'] })).toBeNull()
  expect(within(card).queryByRole('button', { name: zh['agents.delete'] })).toBeNull()
  expect(within(card).getByText(zh['agents.mainNote'])).toBeTruthy()
})

test('内置卡带「内置」徽标，普通卡不带；团队不可见卡带「团队不可见」徽标', async () => {
  const withHidden = [...AGENTS, { id: 'ghost', name: '幕后', visibleInTeam: false, createdAt: 3 }]
  stubFetch(routes({ '/dsh-agent-toolkit/api/agents': () => ({ body: withHidden }) }))
  renderPage()

  await screen.findByText('AAA')
  expect(within(cardOf('主 Agent')).getByText(zh['agents.builtin'])).toBeTruthy()
  expect(within(cardOf('Explorer')).getByText(zh['agents.builtin'])).toBeTruthy()
  expect(within(cardOf('AAA')).queryByText(zh['agents.builtin'])).toBeNull()
  expect(within(cardOf('幕后')).getByText(zh['agents.hiddenInTeam'])).toBeTruthy()
})

test('内置非 main 卡无删除按钮（服务端恒拒删），但保留编辑按钮', async () => {
  stubFetch(routes())
  renderPage()

  await screen.findByText('Explorer')
  const card = cardOf('Explorer')
  expect(within(card).queryByRole('button', { name: zh['agents.delete'] })).toBeNull()
  expect(within(card).queryByRole('button', { name: zh['agents.confirmDelete'] })).toBeNull()
  expect(within(card).getByRole('button', { name: zh['agents.edit'] })).toBeTruthy()
})

test('非 Bot 类 409：解析 error 字段展示可读文案，不出现裸 JSON', async () => {
  stubFetch(routes({
    '/dsh-agent-toolkit/api/agents/': (init) => (init?.method === 'DELETE'
      ? { status: 409, body: { error: '内置角色 aaa 不可删除' } }
      : { body: { ok: true } }),
  }))
  renderPage()

  await screen.findByText('AAA')
  const card = cardOf('AAA')
  fireEvent.click(within(actionsOf(card)).getByRole('button', { name: zh['agents.delete'] }))
  fireEvent.click(within(actionsOf(card)).getByRole('button', { name: zh['agents.confirmDelete'] }))

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('内置角色 aaa 不可删除')
  expect(alert.textContent).not.toContain('{')
  expect(alert.textContent).not.toContain('"error"')
})

test('删除名下有 Bot 的角色：两段确认后展示 409 错误（含 Bot 数量），列表不变', async () => {
  stubFetch(routes())
  renderPage()

  await screen.findByText('AAA')
  const card = cardOf('AAA')
  fireEvent.click(within(actionsOf(card)).getByRole('button', { name: zh['agents.delete'] }))
  expect(within(actionsOf(card)).getByRole('button', { name: zh['agents.confirmDelete'] })).toBeTruthy()
  fireEvent.click(within(actionsOf(card)).getByRole('button', { name: zh['agents.confirmDelete'] }))

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('2')
  expect(screen.getByText('AAA')).toBeTruthy()
})

test('删除成功：DELETE 后 reload 并 toast（M1 反馈）', async () => {
  const calls = stubFetch(routes({
    '/dsh-agent-toolkit/api/agents/': (init) => (init?.method === 'DELETE' ? { body: { ok: true } } : { body: { ok: true } }),
  }))
  renderPage()

  await screen.findByText('AAA')
  const card = cardOf('AAA')
  fireEvent.click(within(actionsOf(card)).getByRole('button', { name: zh['agents.delete'] }))
  fireEvent.click(within(actionsOf(card)).getByRole('button', { name: zh['agents.confirmDelete'] }))

  await vi.waitFor(() => {
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('aaa'))).toBe(true)
  })
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain(zh['feedback.deleted'])
})

test('保存成功：toast 出现且列表重载', async () => {
  const calls = stubFetch(routes())
  renderPage()

  await screen.findByText('AAA')
  fireEvent.click(within(actionsOf(cardOf('AAA'))).getByRole('button', { name: zh['agents.edit'] }))
  const nameInput = await screen.findByLabelText('名称')
  fireEvent.change(nameInput, { target: { value: 'AAA 改' } })
  fireEvent.click(screen.getByRole('button', { name: zh['agents.save'] }))

  expect(await screen.findByRole('alert')).toBeTruthy()
  await vi.waitFor(() => {
    const gets = calls.filter((c) => c.url === '/dsh-agent-toolkit/api/agents' && c.method === 'GET')
    expect(gets.length).toBeGreaterThanOrEqual(2)
  })
})

test('Bot 列表按 agentRef 归入对应卡片，行内含编辑/删除操作', async () => {
  stubFetch(routes())
  renderPage()

  await screen.findByText('机器人一')
  const card = cardOf('AAA')
  const botRow = within(card).getByText('机器人一').closest('[data-testid="bot-row"]') as HTMLElement
  expect(botRow).toBeTruthy()
  expect(within(botRow).getByRole('button', { name: '编辑' })).toBeTruthy()
  expect(within(botRow).getByRole('button', { name: '删除' })).toBeTruthy()
})

test('+ 添加 Bot：角色卡内联展开 BotForm，归属锁定该 agent（无绑定 Agent 下拉、无 Provider/模型）', async () => {
  stubFetch(routes())
  renderPage()

  await screen.findByText('AAA')
  fireEvent.click(within(cardOf('AAA')).getByRole('button', { name: zh['agents.addBot'] }))

  expect(await screen.findByLabelText('绑定项目')).toBeTruthy()
  expect(screen.queryByLabelText('绑定 Agent')).toBeNull()
  expect(screen.queryByLabelText('Provider')).toBeNull()
  expect(screen.queryByLabelText('模型')).toBeNull()
})

test('main 卡内联展开 BotForm 时渲染 Provider/模型（bot 级模型覆盖仅主 Agent 可用）', async () => {
  stubFetch(routes({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ body: { providers: [{ id: 'deepseek', name: 'DeepSeek' }] } }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ body: { models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] } }),
  }))
  renderPage()

  await screen.findByText('主 Agent')
  fireEvent.click(within(cardOf('主 Agent')).getByRole('button', { name: zh['agents.addBot'] }))

  expect(await screen.findByLabelText('Provider')).toBeTruthy()
  expect(screen.getByLabelText('模型')).toBeTruthy()
})

test('Bot 删除成功：DELETE 后 reload 并 toast', async () => {
  const calls = stubFetch(routes({
    '/dsh-agent-toolkit/api/bots/bots': (init) => (init?.method === 'DELETE' ? { body: { ok: true } } : { body: BOTS }),
  }))
  renderPage()

  await screen.findByText('机器人一')
  const card = cardOf('AAA')
  const botRow = within(card).getByText('机器人一').closest('[data-testid="bot-row"]') as HTMLElement
  fireEvent.click(within(botRow).getByRole('button', { name: '删除' }))
  fireEvent.click(within(botRow).getByRole('button', { name: '确认删除？' }))

  await vi.waitFor(() => {
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('id=bot-a'))).toBe(true)
  })
  expect(await screen.findByRole('alert')).toBeTruthy()
})

test('加载失败：整页错误态', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })))
  renderPage()
  expect(await screen.findByRole('alert')).toBeTruthy()
})

test('modules.feishu=false：bots API 404 时降级为空列表，Agent 卡片仍正常渲染', async () => {
  // bots 路由未注册 → 404（fetchBots 拒绝）；agents 路由正常，页面不应整页报错。
  stubFetch(routes({ '/dsh-agent-toolkit/api/bots/bots': () => ({ status: 404, body: {} }) }))
  renderPage()

  const names = await screen.findAllByTestId('agent-card-name')
  expect(names.map((n) => n.textContent)).toEqual(['主 Agent', 'AAA', 'Explorer'])
  expect(screen.queryByRole('alert')).toBeNull()
  // Bot 区降级：无 Bot 行，但「+ 添加 Bot」按钮仍在（归属本卡）。
  expect(screen.queryAllByTestId('bot-row')).toHaveLength(0)
  expect(within(cardOf('AAA')).getByRole('button', { name: zh['agents.addBot'] })).toBeTruthy()
})

// —— 以下由 agents.spec.tsx（AgentsModal）迁入，经 AgentsPage 内联编辑器覆盖同一 AgentEditor 行为。 ——

test('新建角色→保存：persona 单文本 + 工具默认全勾（preset+全局）→ PUT /agents/:id 携带记录', async () => {
  const calls = stubFetch(routes())
  renderPage()
  await screen.findByText('AAA')

  fireEvent.click(screen.getByRole('button', { name: zh['agents.create'] }))
  fireEvent.change(await screen.findByLabelText('ID'), { target: { value: 'ops' } })
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '运维' } })
  fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '你是运维。' } })
  expect((screen.getByLabelText('自定义白名单') as HTMLInputElement).checked).toBe(true)
  await vi.waitFor(() => {
    expect((screen.getByLabelText('工具 bash') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('工具 read') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('工具 write') as HTMLInputElement).checked).toBe(true)
  })
  fireEvent.click(screen.getByRole('button', { name: zh['agents.save'] }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/agents/ops' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).toMatchObject({
      id: 'ops', name: '运维', persona: '你是运维。',
      tools: { allow: ['bash', 'read', 'write'] },
    })
    expect(put?.body).not.toHaveProperty('promptLayers')
  })
})

test('新建角色：工具名册未解析前点保存 → 内联错误且不发 PUT（防静默产不受限角色）', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/dsh-agent-toolkit/api/tools') return await new Promise<Response>(() => undefined)
    const handler = routes()['/dsh-agent-toolkit/api/agents']
    if (url === '/dsh-agent-toolkit/api/agents') return new Response(JSON.stringify(handler(init).body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url === '/dsh-agent-toolkit/api/bots/bots') return new Response(JSON.stringify(BOTS), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('not found', { status: 404 })
  }))
  renderPage()
  await screen.findByText('AAA')

  fireEvent.click(screen.getByRole('button', { name: zh['agents.create'] }))
  fireEvent.change(await screen.findByLabelText('ID'), { target: { value: 'ops' } })
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '运维' } })
  fireEvent.click(screen.getByRole('button', { name: zh['agents.save'] }))
  expect(await screen.findByText('工具名册加载中，请稍候')).toBeTruthy()
  expect(vi.mocked(fetch).mock.calls.some(([u, i]) => String(u).includes('/agents/ops') && (i as RequestInit | undefined)?.method === 'PUT')).toBe(false)
})

test('模型级联：选 provider 后拉取该 provider 的模型列表', async () => {
  const calls = stubFetch(routes({
    '/dsh-agent-toolkit/api/providers/deepseek/models': () => ({ body: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/providers': () => ({ body: [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }] }),
  }))
  renderPage()
  await screen.findByText('AAA')

  fireEvent.click(within(actionsOf(cardOf('AAA'))).getByRole('button', { name: zh['agents.edit'] }))
  fireEvent.change(await screen.findByLabelText('Provider'), { target: { value: 'deepseek' } })
  await screen.findByRole('option', { name: 'DeepSeek Chat' })
  expect(calls.some((c) => c.url === '/dsh-agent-toolkit/api/providers/deepseek/models')).toBe(true)
})

test('编辑已配白名单角色：默认选中「自定义白名单」并回显勾选', async () => {
  const withTools = [
    { id: 'main', name: '主 Agent', builtin: true, createdAt: 0 },
    { id: 'aaa', name: 'AAA', createdAt: 1, tools: { allow: ['read'] } },
  ]
  stubFetch(routes({ '/dsh-agent-toolkit/api/agents': () => ({ body: withTools }) }))
  renderPage()
  await screen.findByText('AAA')

  fireEvent.click(within(actionsOf(cardOf('AAA'))).getByRole('button', { name: zh['agents.edit'] }))
  expect((await screen.findByLabelText('自定义白名单') as HTMLInputElement).checked).toBe(true)
  await vi.waitFor(() => {
    expect((screen.getByLabelText('工具 read') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('工具 bash') as HTMLInputElement).checked).toBe(false)
  })
})

test('编辑无 tools 角色：默认选中「不限制」，checkbox 禁用；保存省略 tools 字段', async () => {
  const calls = stubFetch(routes())
  renderPage()
  await screen.findByText('AAA')

  fireEvent.click(within(actionsOf(cardOf('AAA'))).getByRole('button', { name: zh['agents.edit'] }))
  expect((await screen.findByLabelText('不限制（继承会话全部工具）') as HTMLInputElement).checked).toBe(true)
  await vi.waitFor(() => {
    expect((screen.getByLabelText('工具 bash') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('工具 write') as HTMLInputElement).disabled).toBe(true)
  })
  // SaveBar 仅在 dirty 时可保存：改名置脏后再保存。
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'AAA 改' } })
  fireEvent.click(screen.getByRole('button', { name: zh['agents.save'] }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/agents/aaa' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).not.toHaveProperty('tools')
  })
})

test('自定义白名单全不勾：点保存 → 提示且不发 PUT', async () => {
  const withTools = [
    { id: 'main', name: '主 Agent', builtin: true, createdAt: 0 },
    { id: 'aaa', name: 'AAA', createdAt: 1, tools: { allow: ['read'] } },
  ]
  stubFetch(routes({ '/dsh-agent-toolkit/api/agents': () => ({ body: withTools }) }))
  renderPage()
  await screen.findByText('AAA')

  fireEvent.click(within(actionsOf(cardOf('AAA'))).getByRole('button', { name: zh['agents.edit'] }))
  await vi.waitFor(() => {
    expect((screen.getByLabelText('工具 read') as HTMLInputElement).checked).toBe(true)
  })
  fireEvent.click(screen.getByLabelText('工具 read'))
  fireEvent.click(screen.getByRole('button', { name: zh['agents.save'] }))
  expect((await screen.findAllByText('自定义白名单至少勾选一个工具，或改选不限制')).length).toBeGreaterThan(0)
})

test('编辑角色：团队可见默认勾选，取消勾选后保存携带 visibleInTeam: false', async () => {
  const calls = stubFetch(routes())
  renderPage()
  await screen.findByText('AAA')

  fireEvent.click(within(actionsOf(cardOf('AAA'))).getByRole('button', { name: zh['agents.edit'] }))
  const checkbox = await screen.findByLabelText('在 Agent 团队中可见') as HTMLInputElement
  expect(checkbox.checked).toBe(true)
  fireEvent.click(checkbox)
  expect(checkbox.checked).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: zh['agents.save'] }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/agents/aaa' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).toMatchObject({ id: 'aaa', visibleInTeam: false })
  })
})

test('编辑团队不可见角色：checkbox 回显不勾选；勾选后保存省略 visibleInTeam 字段', async () => {
  const hiddenAgents = [
    { id: 'main', name: '主 Agent', builtin: true, createdAt: 0 },
    { id: 'ghost', name: '幕后', visibleInTeam: false, createdAt: 1 },
  ]
  const calls = stubFetch(routes({ '/dsh-agent-toolkit/api/agents': () => ({ body: hiddenAgents }) }))
  renderPage()
  await screen.findByText('幕后')

  fireEvent.click(within(actionsOf(cardOf('幕后'))).getByRole('button', { name: zh['agents.edit'] }))
  const checkbox = await screen.findByLabelText('在 Agent 团队中可见') as HTMLInputElement
  expect(checkbox.checked).toBe(false)
  fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('button', { name: zh['agents.save'] }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/agents/ghost' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).toMatchObject({ id: 'ghost' })
    expect(put?.body).not.toHaveProperty('visibleInTeam')
  })
})
