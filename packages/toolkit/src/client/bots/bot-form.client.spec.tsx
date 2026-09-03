// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// jsdom 无 canvas：QR 渲染打桩，只断言被调用。
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) }, toCanvas: vi.fn(async () => undefined) }))

import { toCanvas } from 'qrcode'

import { BotForm } from './BotForm.tsx'

const useWorkspaces = <S,>(selector: (s: { items: { path: string; title: string }[] }) => S): S =>
  selector({ items: [{ path: 'D:\\work\\demo', title: 'demo' }, { path: 'D:\\work\\ops', title: 'ops' }] })

interface FetchCall { url: string; method: string; body?: unknown }

function stubFetch(routes: Record<string, (body?: unknown) => unknown>) {
  const calls: FetchCall[] = []
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

beforeEach(() => { /* 各测试内 stubFetch */ })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('手动填写创建：名称/项目 + Provider/模型默认选中第一项 + 密钥；不携带 id/tools/persona', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  // Provider 与模型均默认选中第一项（无「默认」空值项）
  await screen.findByRole('option', { name: 'DeepSeek' })
  expect(screen.getByLabelText('Provider')).toHaveProperty('value', 'deepseek')
  await screen.findByRole('option', { name: 'DeepSeek Chat' })
  expect(screen.getByLabelText('模型')).toHaveProperty('value', 'deepseek-chat')

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '运维机器人' } })
  fireEvent.change(screen.getByLabelText('绑定项目'), { target: { value: 'D:\\work\\ops' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  // 第二步：默认扫码 tab，切到「手动填写」再填 feishu
  fireEvent.click(screen.getByRole('tab', { name: '手动填写' }))
  fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_000000000000000a' } })
  fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'plain-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const create = calls.find((c) => c.url === '/dsh-agent-toolkit/api/bots/bots' && c.method === 'POST')
  expect(create?.body).toMatchObject({
    name: '运维机器人', project: 'D:\\work\\ops',
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' },
  })
  expect(create?.body).not.toHaveProperty('id')
  expect(create?.body).not.toHaveProperty('tools')
  expect(create?.body).not.toHaveProperty('persona')
})

test('扫码创建：进入第二步自动发起扫码 → 轮询 → 完成后自动回填 appId 与 credentialRef', async () => {
  let polls = 0
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/bots/register-app/status': () => {
      polls += 1
      return polls < 2
        ? { state: { status: 'pending', url: 'https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH', expireIn: 600 } }
        : { state: { status: 'done', appId: 'cli_ffffffffffffffff', credentialRef: 'project_bot_ffffffff' } }
    },
    '/dsh-agent-toolkit/api/bots/register-app': () => ({ id: 'reg_1' }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '扫码机器人' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))

  expect(await screen.findByText('等待扫码确认…')).toBeTruthy()
  const link = screen.getByRole('link', { name: '点击链接' })
  expect(link).toHaveProperty('href', 'https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH')
  await vi.waitFor(() => {
    expect(toCanvas).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      'https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH',
      { width: 200 },
    )
  })
  expect(await screen.findByText(/已创建应用/, undefined, { timeout: 3000 })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const create = calls.find((c) => c.url === '/dsh-agent-toolkit/api/bots/bots' && c.method === 'POST')
  expect(create?.body).toMatchObject({
    feishu: { appId: 'cli_ffffffffffffffff', appSecretRef: 'project_bot_ffffffff' },
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  })
  expect(create?.body).not.toHaveProperty('id')
})

test('必填校验：无 Provider 时下拉禁用并提示；第一步缺名称不放行；第二步缺 App ID/Secret 不提交', async () => {
  const calls = stubFetch({ '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [] }) })
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={() => undefined} onCancel={() => undefined} />)

  // Provider 清单为空：select 禁用 + role=alert 提示
  await screen.findByText(/未发现可用 Provider/)
  expect(screen.getByLabelText('Provider')).toHaveProperty('disabled', true)

  // 第一步：缺名称点「下一步」不放行，提示错误、不发请求
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(await screen.findByText(/请填写/)).toBeTruthy()
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)

  // 补名称后放行进第二步，缺 feishu 点「保存」不提交（自动扫码在途，仅 register-app 请求，不创建 bot）
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '测试机器人' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByText(/请填写 App ID/)).toBeTruthy()
  expect(calls.filter((c) => c.method === 'POST' && c.url === '/dsh-agent-toolkit/api/bots/bots')).toHaveLength(0)
})

test('模型必填：models 清单为空回退手填，留空保存被拦且不提交', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [] }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={() => undefined} onCancel={() => undefined} />)

  // 等 provider 就绪并自动选中第一项（models 为空 → 模型回退为手填 Input）
  await screen.findByRole('option', { name: 'DeepSeek' })

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '模型测试' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('tab', { name: '手动填写' }))
  fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_000000000000000a' } })
  fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'plain-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByText(/请选择或填写模型/)).toBeTruthy()
  expect(calls.filter((c) => c.method === 'POST' && c.url === '/dsh-agent-toolkit/api/bots/bots')).toHaveLength(0)
})

test('绑定 Agent 下拉：选项来自 /agents（Task 14 端点），缺省 main；选中角色后创建携带 agentRef', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/agents': () => ([{ id: 'main', name: '主 Agent' }, { id: 'reviewer', name: '评审' }]),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  // 下拉含角色选项且缺省选中 main
  await screen.findByRole('option', { name: '评审' })
  expect(screen.getByLabelText('绑定 Agent')).toHaveProperty('value', 'main')

  fireEvent.change(screen.getByLabelText('绑定 Agent'), { target: { value: 'reviewer' } })
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '评审机器人' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('tab', { name: '手动填写' }))
  fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_000000000000000a' } })
  fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'plain-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const create = calls.find((c) => c.url === '/dsh-agent-toolkit/api/bots/bots' && c.method === 'POST')
  expect(create?.body).toMatchObject({ agentRef: 'reviewer' })
})

test('编辑模式：agentRef 回显角色；切回 main 提交 agentRef: null', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/agents': () => ([{ id: 'main', name: '主 Agent' }, { id: 'reviewer', name: '评审' }]),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  const bot = {
    id: 'reviewer', name: '评审', channel: 'feishu' as const,
    feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
    project: 'D:\\work\\demo', agentRef: 'reviewer',
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    createdAt: 1, updatedAt: 1, status: 'connected',
  }
  render(<BotForm bot={bot} useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  await screen.findByRole('option', { name: '评审' })
  expect(screen.getByLabelText('绑定 Agent')).toHaveProperty('value', 'reviewer')

  fireEvent.change(screen.getByLabelText('绑定 Agent'), { target: { value: 'main' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const update = calls.find((c) => c.url.startsWith('/dsh-agent-toolkit/api/bots/bots?id=') && c.method === 'PUT')
  expect(update?.body).toMatchObject({ agentRef: null })
})

test('Agent 名册不可用：下拉只剩 main 选项，创建不携带 agentRef（默认主 Agent）', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  await screen.findByRole('option', { name: 'DeepSeek' })
  expect(screen.getByLabelText('绑定 Agent')).toHaveProperty('value', 'main')

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '无名册机器人' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('tab', { name: '手动填写' }))
  fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_000000000000000a' } })
  fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'plain-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const create = calls.find((c) => c.url === '/dsh-agent-toolkit/api/bots/bots' && c.method === 'POST')
  expect(create?.body).not.toHaveProperty('agentRef')
})

test('手动填写 tab：展示所需权限提示文案', async () => {
  stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={() => undefined} onCancel={() => undefined} />)

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '权限提示' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('tab', { name: '手动填写' }))

  expect(await screen.findByText(/im:message/)).toBeTruthy()
  expect(screen.getByText(/cardkit:card:write/)).toBeTruthy()
  expect(screen.getByText(/im.message.receive_v1/)).toBeTruthy()
})

test('编辑绑定态：第 2 步显示当前应用与解绑（两段确认）；解绑 PUT feishu:null 并回列表', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  const bot = {
    id: 'reviewer', name: '评审', channel: 'feishu' as const,
    feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
    project: 'D:\\work\\demo',
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    createdAt: 1, updatedAt: 1, status: 'connected',
  }
  render(<BotForm bot={bot} useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByText(/当前应用：cli_a1b2c3d4e5f60718/)).toBeTruthy()

  // 第一段：只切确认态，不发请求
  fireEvent.click(screen.getByRole('button', { name: '解绑' }))
  expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)

  // 第二段：确认后 PUT feishu:null → onSaved
  fireEvent.click(screen.getByRole('button', { name: '确认解绑？' }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const update = calls.find((c) => c.url.includes('id=reviewer') && c.method === 'PUT')
  expect(update?.body).toMatchObject({ feishu: null })
})

test('编辑未绑定态：第 2 步显示绑定区块；手动填写后保存携带 feishu', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/bots/register-app': () => ({ id: 'reg_1' }),
    '/dsh-agent-toolkit/api/bots/register-app/status': () => ({ state: { status: 'pending', url: 'https://example/qr', expireIn: 600 } }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  const bot = {
    id: 'loose', name: '未绑定', project: 'D:\\work\\demo',
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    createdAt: 1, updatedAt: 1, status: 'not-running',
  }
  render(<BotForm bot={bot} useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  // 绑定区块出现（与创建一致的 tab 结构）；自动扫码已发起，切手动填写
  fireEvent.click(await screen.findByRole('tab', { name: '手动填写' }))
  fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_000000000000000a' } })
  fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'plain-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const update = calls.find((c) => c.url.includes('id=loose') && c.method === 'PUT')
  expect(update?.body).toMatchObject({ feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' } })
})

test('编辑未绑定态：不绑定也能保存（payload 不带 feishu，bot 维持未绑定）', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/bots/register-app': () => ({ id: 'reg_1' }),
    '/dsh-agent-toolkit/api/bots/register-app/status': () => ({ state: { status: 'pending', url: 'https://example/qr', expireIn: 600 } }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  const bot = {
    id: 'loose', name: '未绑定', project: 'D:\\work\\demo',
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    createdAt: 1, updatedAt: 1, status: 'not-running',
  }
  render(<BotForm bot={bot} useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const update = calls.find((c) => c.url.includes('id=loose') && c.method === 'PUT')
  expect(update?.body).not.toHaveProperty('feishu')
})
