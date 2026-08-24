import { describe, expect, test, vi } from 'vitest'
import type { ReplyHandle } from '../src/core/channel.ts'
import type { AgentPort, AgentsPort, BindingStore, SessionRuntime } from '../src/core/ports.ts'
import { Router } from '../src/core/router.ts'
import type { BotRecord } from '../src/store.ts'

function fakeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: 'reviewer', name: '评审', channel: 'feishu',
    feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
    project: 'D:\\work\\demo', persona: '你是评审助手', tools: ['bash'],
    createdAt: 0, updatedAt: 0, ...overrides,
  }
}

function fakeAgent(sessionId: string) {
  return { sessionId, followup: vi.fn(), cancel: vi.fn(), whenIdle: vi.fn(async () => undefined) }
}

function fakeBindings(): BindingStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: (b, c) => map.get(`${b}:${c}`),
    set: async (b, c, s) => { map.set(`${b}:${c}`, s) },
    delete: async (b, c) => { map.delete(`${b}:${c}`) },
    deleteBot: async (b) => { for (const k of [...map.keys()]) if (k.startsWith(`${b}:`)) map.delete(k) },
  }
}

const reply = {} as ReplyHandle

function setup() {
  const created: { input: Record<string, unknown>; agent: AgentPort }[] = []
  const resumed: { input: Record<string, unknown>; agent: AgentPort }[] = []
  const agents: AgentsPort = {
    create: async (input) => { const agent = fakeAgent(input.sessionId); created.push({ input: input as unknown as Record<string, unknown>, agent }); return agent },
    resume: async (input) => { const agent = fakeAgent(input.sessionId); resumed.push({ input: input as unknown as Record<string, unknown>, agent }); return agent },
  }
  const bindings = fakeBindings()
  const sessions = new Map<string, SessionRuntime>()
  return { agents, bindings, sessions, router: new Router(agents, bindings, sessions), created, resumed }
}

describe('Router.ensure', () => {
  test('无绑定：create 新 agent 并写绑定，persona/tools/cwd 透传', async () => {
    const { router, bindings, created } = setup()
    const rt = await router.ensure(fakeBot(), 'oc_1', reply)
    expect(created).toHaveLength(1)
    expect(created[0].input.cwd).toBe('D:\\work\\demo')
    expect(created[0].input.hooks).toEqual({ persona: '你是评审助手', tools: ['bash'] })
    expect(bindings.get('reviewer', 'oc_1')).toBe(rt.sessionId)
    expect(rt.reply).toBe(reply)
  })

  test('有绑定且进程内有 runtime：直接复用并刷新 reply', async () => {
    const { router, created, resumed } = setup()
    const first = await router.ensure(fakeBot(), 'oc_1', reply)
    const reply2 = {} as ReplyHandle
    const second = await router.ensure(fakeBot(), 'oc_1', reply2)
    expect(second).toBe(first)
    expect(first.reply).toBe(reply2)
    expect(created).toHaveLength(1)
    expect(resumed).toHaveLength(0)
  })

  test('有绑定但进程内无 runtime（重启后）：resume 恢复', async () => {
    const { router, bindings, resumed } = setup()
    await bindings.set('reviewer', 'oc_1', 'sess-old')
    const rt = await router.ensure(fakeBot(), 'oc_1', reply)
    expect(resumed).toHaveLength(1)
    expect(resumed[0].input.sessionId).toBe('sess-old')
    expect(rt.sessionId).toBe('sess-old')
  })
})

describe('Router.reset（/new）', () => {
  test('取消旧 agent、清绑定、开新会话', async () => {
    const { router, bindings, created } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply)
    const next = await router.reset(fakeBot(), 'oc_1', reply)
    expect(old.agent.cancel).toHaveBeenCalledOnce()
    expect(next.sessionId).not.toBe(old.sessionId)
    expect(bindings.get('reviewer', 'oc_1')).toBe(next.sessionId)
    expect(created).toHaveLength(2)
  })

  test('无旧绑定时直接开新会话', async () => {
    const { router, created } = setup()
    await router.reset(fakeBot(), 'oc_9', reply)
    expect(created).toHaveLength(1)
  })
})

test('Router.lookup 按绑定反查 runtime', async () => {
  const { router } = setup()
  expect(router.lookup('reviewer', 'oc_1')).toBeUndefined()
  const rt = await router.ensure(fakeBot(), 'oc_1', reply)
  expect(router.lookup('reviewer', 'oc_1')).toBe(rt)
})
