// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { DelegateCard } from './delegate-card.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ZH = {
  'card.viewChild': '查看子对话',
  'card.running': '成员执行中',
  'card.failed': '委派失败',
  'card.modelAria': '子 Agent 使用模型 {route}',
  'header.modelAria': '子会话模型 {route}',
} as const

type Key = keyof typeof ZH

function t(key: Key, params?: Record<string, unknown>): string {
  let text: string = ZH[key]
  for (const [k, v] of Object.entries(params ?? {})) text = text.replace(`{${k}}`, String(v))
  return text
}

const openChild = vi.fn()

function callBlock(args: Record<string, unknown>) {
  return { kind: 'tool-call', callId: 'c1', name: 'team_delegate', argsRaw: JSON.stringify(args), resultView: null, subCalls: [] }
}

function resultBlock(args: Record<string, unknown>, meta?: Record<string, unknown>) {
  return {
    kind: 'tool-result', callId: 'c1', name: 'team_delegate', argsRaw: JSON.stringify(args),
    content: [{ type: 'text', text: '结论' }], isError: false,
    call: { argsRaw: JSON.stringify(args) }, meta,
    resultView: null, subCalls: [],
  }
}

const ARGS = { role: 'reviewer', description: '审查登录模块', prompt: '请审查' }

function propsFor(block: unknown) {
  return { block, sessionId: 'parent-s1', openChild, t } as unknown as Parameters<typeof DelegateCard>[0]
}

test('运行中：轮询命中在途端点 → 渲染模型 chip', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ provider: 'deepseek', model: 'deepseek-reasoner' }),
  })))
  render(<DelegateCard {...propsFor(callBlock(ARGS))} />)
  expect(await screen.findByText('deepseek / deepseek-reasoner')).toBeTruthy()
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/dsh-agent-toolkit/api/delegate/active?session=parent-s1&role=reviewer'))
})

test('运行中：404 → 不渲染 chip', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
  render(<DelegateCard {...propsFor(callBlock(ARGS))} />)
  await waitFor(() => { expect(fetch).toHaveBeenCalled() })
  expect(screen.queryByText(/deepseek/)).toBeNull()
})

test('运行中且 args 缺 role：不发起轮询、不渲染 chip', () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  render(<DelegateCard {...propsFor(callBlock({ description: '审查登录模块', prompt: '请审查' }))} />)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(screen.queryByText(/deepseek/)).toBeNull()
  expect(screen.queryByText('reviewer')).toBeNull()
})

test('settled：读 meta 渲染 chip，不请求在途端点', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  render(<DelegateCard {...propsFor(resultBlock(ARGS, {
    role: 'reviewer', runId: 'r1', childSessionId: 'child-1', provider: 'deepseek', model: 'deepseek-chat',
  }))} />)
  expect(screen.getByText('deepseek / deepseek-chat')).toBeTruthy()
  expect(fetchMock).not.toHaveBeenCalled()
})

test('settled 旧事件（meta 无新字段）：不渲染 chip', () => {
  render(<DelegateCard {...propsFor(resultBlock(ARGS, { role: 'reviewer', runId: 'r1', childSessionId: 'child-1' }))} />)
  expect(screen.queryByText(/deepseek/)).toBeNull()
})
