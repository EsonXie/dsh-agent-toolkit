// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// jsdom 无 canvas：QR 渲染打桩，只断言被调用。
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) }, toCanvas: vi.fn(async () => undefined) }))

import { toCanvas } from 'qrcode'

import { BotForm } from '../src/client/BotForm.tsx'

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

test('手动填写创建：名称/项目/persona + Provider/模型默认选中第一项 + 密钥；不携带 id 与 tools', async () => {
  const calls = stubFetch({
    '/project-bot/api/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }] }),
    '/project-bot/api/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/project-bot/api/bots': () => ({ bot: {} }),
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
  fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '你是运维助手' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  // 第二步：默认扫码 tab，切到「手动填写」再填 feishu
  fireEvent.click(screen.getByRole('tab', { name: '手动填写' }))
  fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_000000000000000a' } })
  fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'plain-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const create = calls.find((c) => c.url === '/project-bot/api/bots' && c.method === 'POST')
  expect(create?.body).toMatchObject({
    name: '运维机器人', project: 'D:\\work\\ops',
    persona: '你是运维助手',
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' },
  })
  expect(create?.body).not.toHaveProperty('id')
  expect(create?.body).not.toHaveProperty('tools')
})

test('扫码创建：进入第二步自动发起扫码 → 轮询 → 完成后自动回填 appId 与 credentialRef', async () => {
  let polls = 0
  const calls = stubFetch({
    '/project-bot/api/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/project-bot/api/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/project-bot/api/register-app/status': () => {
      polls += 1
      return polls < 2
        ? { state: { status: 'pending', url: 'https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH', expireIn: 600 } }
        : { state: { status: 'done', appId: 'cli_ffffffffffffffff', credentialRef: 'project_bot_ffffffff' } }
    },
    '/project-bot/api/register-app': () => ({ id: 'reg_1' }),
    '/project-bot/api/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '扫码机器人' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))

  expect(await screen.findByText('等待扫码确认…')).toBeTruthy()
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
  const create = calls.find((c) => c.url === '/project-bot/api/bots' && c.method === 'POST')
  expect(create?.body).toMatchObject({
    feishu: { appId: 'cli_ffffffffffffffff', appSecretRef: 'project_bot_ffffffff' },
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  })
  expect(create?.body).not.toHaveProperty('id')
})

test('必填校验：无 Provider 时下拉禁用并提示；第一步缺名称不放行；第二步缺 App ID/Secret 不提交', async () => {
  const calls = stubFetch({ '/project-bot/api/providers': () => ({ providers: [] }) })
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
  expect(calls.filter((c) => c.method === 'POST' && c.url === '/project-bot/api/bots')).toHaveLength(0)
})

test('模型必填：models 清单为空回退手填，留空保存被拦且不提交', async () => {
  const calls = stubFetch({
    '/project-bot/api/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/project-bot/api/models?provider=deepseek': () => ({ models: [] }),
    '/project-bot/api/bots': () => ({ bot: {} }),
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
  expect(calls.filter((c) => c.method === 'POST' && c.url === '/project-bot/api/bots')).toHaveLength(0)
})
