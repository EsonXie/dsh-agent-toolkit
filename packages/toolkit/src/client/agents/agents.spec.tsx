// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AgentsModal } from './AgentsModal.tsx'

const AGENTS = [
  { id: 'main', name: '主 Agent', builtin: true },
  { id: 'explorer', name: 'Explorer', description: '快速只读代码库探索', builtin: true },
  { id: 'scout', name: '侦察', description: '只读探索' },
]

const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'openai', name: 'OpenAI' },
]

interface FetchCall { url: string; method: string; body?: unknown }

function stubFetch(routes: Record<string, (init?: RequestInit) => unknown>) {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method ?? 'GET', body })
    const handler = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1]
    if (handler === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(handler(init)), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

function routes() {
  return {
    // 更具体的前缀在前（stubFetch 按插入序首个命中）
    '/dsh-agent-toolkit/api/agents/': () => ({ ok: true }),
    '/dsh-agent-toolkit/api/agents': () => AGENTS,
    '/dsh-agent-toolkit/api/providers/deepseek/models': () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    '/dsh-agent-toolkit/api/providers': () => PROVIDERS,
    '/dsh-agent-toolkit/api/tools': () => ({ native: ['bash', 'read'], global: ['write'] }),
  }
}

beforeEach(() => { /* 各测试内 stubFetch */ })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('列表渲染：main 不进列表、内置徽标与描述摘要、底部新建角色按钮', async () => {
  const calls = stubFetch(routes())
  render(<AgentsModal open onClose={() => undefined} />)

  expect(await screen.findByText('Explorer')).toBeTruthy()
  // main 被过滤不进列表；锁定标识已随 main 一并移除
  expect(screen.queryByText('主 Agent')).toBeNull()
  expect(screen.queryByText('锁定')).toBeNull()
  // 角色行：name + description 摘要 + builtin 徽标（可见角色中仅 explorer 内置）
  // 描述同时出现在列表行与编辑器「描述」输入框，故用 getAllByText 断言存在
  expect(screen.getAllByText('快速只读代码库探索').length).toBeGreaterThan(0)
  expect(screen.getAllByText('内置')).toHaveLength(1)
  // 底部新建按钮
  expect(screen.getByRole('button', { name: '新建角色' })).toBeTruthy()
  expect(calls[0]).toMatchObject({ url: '/dsh-agent-toolkit/api/agents', method: 'GET' })
})

test('新建角色→保存：Persona 单文本 + 工具默认全勾（原生+扩展）→ PUT /agents/:id 携带记录', async () => {
  const calls = stubFetch(routes())
  render(<AgentsModal open onClose={() => undefined} />)
  await screen.findByText('Explorer')

  fireEvent.click(screen.getByRole('button', { name: '新建角色' }))
  fireEvent.change(screen.getByLabelText('ID'), { target: { value: 'ops' } })
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '运维' } })
  fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '你是运维。' } })
  // 新建模式默认全勾 native + global（fetchTools 返回 ToolsCatalog 后异步填入）
  await vi.waitFor(() => {
    expect((screen.getByLabelText('工具 bash') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('工具 read') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('工具 write') as HTMLInputElement).checked).toBe(true)
  })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/agents/ops' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).toMatchObject({
      id: 'ops', name: '运维', persona: '你是运维。',
      tools: { allow: ['bash', 'read', 'write'] },
    })
    // 载荷为 persona 单字段，不再携带 promptLayers
    expect(put?.body).not.toHaveProperty('promptLayers')
  })
})

test('新建角色：工具名册未解析前保存按钮禁用（防静默产不受限角色）', async () => {
  // 名册请求挂起（永不 resolve），模拟名册未到达 / fetchTools 失败前的窗口
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/dsh-agent-toolkit/api/tools') return await new Promise<Response>(() => undefined)
    const routes: Record<string, (init?: RequestInit) => unknown> = {
      '/dsh-agent-toolkit/api/agents/': () => ({ ok: true }),
      '/dsh-agent-toolkit/api/agents': () => AGENTS,
      '/dsh-agent-toolkit/api/providers': () => PROVIDERS,
    }
    const handler = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1]
    if (handler === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(handler(init)), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  render(<AgentsModal open onClose={() => undefined} />)
  await screen.findByText('Explorer')

  fireEvent.click(screen.getByRole('button', { name: '新建角色' }))
  fireEvent.change(screen.getByLabelText('ID'), { target: { value: 'ops' } })
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '运维' } })
  // 名册未到 → 保存禁用（否则 tools 为空会整段省略 allow，产出不受限角色）
  expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
})

test('内置角色锁定不可删：初始选中回退首个可见内置角色无删除按钮；选中普通角色有删除按钮', async () => {
  const calls = stubFetch(routes())
  render(<AgentsModal open onClose={() => undefined} />)
  await screen.findByText('Explorer')

  // 初始选中回退到第一个可见角色（explorer，内置 → 锁定），无删除按钮
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull()

  fireEvent.click(screen.getByText('侦察'))
  expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
})

test('选中既有非默认角色：编辑器回显该角色（ID 正确）→ 保存发 PUT /agents/<该id>', async () => {
  const calls = stubFetch(routes())
  render(<AgentsModal open onClose={() => undefined} />)
  await screen.findByText('Explorer')

  // 点击后选中 scout（无重挂时 ID 会滞留，此处断言 ID 回显为 scout）
  fireEvent.click(screen.getByText('侦察'))
  expect(screen.getByText('ID：scout')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '侦察队长' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/agents/scout' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).toMatchObject({ id: 'scout', name: '侦察队长' })
  })
})

test('模型级联：选 provider 后拉取该 provider 的模型列表', async () => {
  const calls = stubFetch(routes())
  render(<AgentsModal open onClose={() => undefined} />)
  await screen.findByText('Explorer')

  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'deepseek' } })
  await screen.findByRole('option', { name: 'DeepSeek Chat' })
  expect(calls.some((c) => c.url === '/dsh-agent-toolkit/api/providers/deepseek/models')).toBe(true)
})

test('加载失败显示错误态', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })))
  render(<AgentsModal open onClose={() => undefined} />)
  // 左右两栏（列表 + 编辑器）都会显示加载失败提示
  expect((await screen.findAllByText('加载失败，请重试')).length).toBeGreaterThan(0)
})
