import { describe, expect, test, vi } from 'vitest'
import type { BotChannel, ChannelHandle } from './channel.ts'
import { BotRuntime, type RuntimeDeps } from './runtime.ts'
import type { BotRecord } from '../bots/store.ts'
import type { AgentRegistry } from '../agents/registry.ts'

const fakeRegistry: AgentRegistry = {
  list: () => [],
  get: () => undefined,
  upsert: async () => undefined,
  remove: async () => undefined,
  subscribe: () => () => undefined,
}

const BOT: BotRecord = {
  id: 'reviewer', name: '评审', channel: 'feishu',
  feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
  project: 'D:\\work\\demo', createdAt: 0, updatedAt: 0,
}

const UNBOUND: BotRecord = {
  id: 'loose', name: '未绑定', project: 'D:\\work\\demo', createdAt: 0, updatedAt: 0,
}

function fakeTable<V>(initial: Record<string, V> = {}) {
  const map = new Map<string, V>(Object.entries(initial))
  return {
    map,
    get: (k: string) => map.get(k),
    put: async (k: string, v: V) => { map.set(k, v) },
    delete: async (k: string) => map.delete(k),
    entries: () => map.entries(),
    keys: () => map.keys(),
  }
}

function harness(overrides: Partial<RuntimeDeps> = {}) {
  const started: string[] = []
  const closed: string[] = []
  const warns: string[] = []
  const channel: BotChannel = {
    type: 'feishu',
    start: async (bot) => {
      started.push(bot.record.id)
      const handle: ChannelHandle = {
        close: async () => { closed.push(bot.record.id) },
        status: () => 'connected',
      }
      return handle
    },
  }
  const deps: RuntimeDeps = {
    bots: fakeTable<BotRecord>({ reviewer: BOT }) as unknown as RuntimeDeps['bots'],
    bindings: fakeTable() as unknown as RuntimeDeps['bindings'],
    agents: { create: vi.fn(), resume: vi.fn() } as unknown as RuntimeDeps['agents'],
    registry: fakeRegistry,
    defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-v4' }),
    workspace: { attach: async () => undefined },
    channels: new Map([['feishu', channel]]),
    tunables: { cardUpdateThrottleMs: 10, cardMaxBytes: 1024, processMaxBytes: 1024, processingReactionEmoji: 'OneSecond' },
    maxErrorDetailChars: 500,
    resolveSecret: async () => 'secret',
    validateProject: () => true,
    log: { warn: (m) => { warns.push(m) }, info: () => undefined },
    ...overrides,
  }
  return { deps, started, closed, warns, runtime: new BotRuntime(deps) }
}

test('startAll 为每个合法 bot 启动渠道', async () => {
  const { runtime, started } = harness()
  await runtime.startAll()
  expect(started).toEqual(['reviewer'])
  expect(runtime.statusOf('reviewer')).toBe('connected')
})

test('密钥缺失：不启动并告警', async () => {
  const { runtime, started, warns } = harness({ resolveSecret: async () => undefined })
  await runtime.startAll()
  expect(started).toEqual([])
  expect(warns.some((w) => w.includes('reviewer'))).toBe(true)
  expect(runtime.statusOf('reviewer')).toBe('not-running')
})

test('项目路径非法：不启动并告警', async () => {
  const { runtime, started, warns } = harness({ validateProject: () => false })
  await runtime.startAll()
  expect(started).toEqual([])
  expect(warns.some((w) => w.includes('项目'))).toBe(true)
})

test('reconcile 重连：先停旧渠道再按最新记录启动', async () => {
  const { runtime, started, closed, deps } = harness()
  await runtime.startAll()
  await deps.bots.put('reviewer', { ...BOT, name: '评审v2' })
  await runtime.reconcile('reviewer')
  expect(closed).toEqual(['reviewer'])
  expect(started).toEqual(['reviewer', 'reviewer'])
})

test('stopBot 停渠道并清理该 bot 的绑定与会话', async () => {
  const { runtime, closed, deps } = harness()
  await runtime.startAll()
  await deps.bindings.put('reviewer:oc_1', { sessionId: 's1' })
  await deps.bindings.put('other:oc_2', { sessionId: 's2' })
  await runtime.stopBot('reviewer')
  expect(closed).toEqual(['reviewer'])
  expect(deps.bindings.get('reviewer:oc_1')).toBeUndefined()
  expect(deps.bindings.get('other:oc_2')).toEqual({ sessionId: 's2' })
})

test('stopAll 取消在飞会话并关闭全部渠道（幂等）', async () => {
  const { runtime, closed } = harness()
  await runtime.startAll()
  await runtime.stopAll()
  await runtime.stopAll()
  expect(closed).toEqual(['reviewer'])
})

test('未绑定 bot：reconcile 不启动渠道、不告警，statusOf 返回 unbound', async () => {
  const { runtime, started, warns, deps } = harness()
  await deps.bots.put('loose', UNBOUND)
  await runtime.startAll()
  expect(started).toEqual(['reviewer'])
  expect(warns.filter((w) => w.includes('loose'))).toEqual([])
  expect(runtime.statusOf('loose')).toBe('unbound')
})

test('injectSender: false：入站建会话 hooks 不含 sender 段', async () => {
  const hookInputs: { hooks: unknown }[] = []
  const agents = {
    create: async (input: { sessionId: string; hooks: unknown }) => {
      hookInputs.push({ hooks: input.hooks })
      return { sessionId: input.sessionId, followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined }
    },
    resume: async () => undefined,
  } as unknown as RuntimeDeps['agents']
  const { runtime } = harness({ injectSender: false, agents })
  runtime.inbound.onMessage({
    botId: 'reviewer', chatId: 'oc_1', userId: 'ou_u1', messageId: 'om_1', text: '你好',
    reply: { beginTurn: async () => undefined, update: async () => undefined, finalize: async () => undefined, notice: async () => undefined },
    ackProcessing: async () => () => undefined,
  })
  await vi.waitFor(() => { expect(hookInputs).toHaveLength(1) })
  expect(hookInputs[0].hooks).not.toHaveProperty('sections')
})

test('unbindBot 停渠道并取消在飞会话，但保留绑定表', async () => {
  const { runtime, closed, deps } = harness()
  await runtime.startAll()
  await deps.bindings.put('reviewer:oc_1', { sessionId: 's1' })
  const cancelled: string[] = []
  runtime.sessions.set('s1', {
    botId: 'reviewer', chatId: 'oc_1', sessionId: 's1',
    agent: { sessionId: 's1', followup: () => undefined, cancel: () => { cancelled.push('s1') }, whenIdle: async () => undefined },
    reply: undefined, inflight: undefined, tail: Promise.resolve(), turn: undefined,
  })
  await runtime.unbindBot('reviewer')
  expect(closed).toEqual(['reviewer'])
  expect(cancelled).toEqual(['s1'])
  expect(runtime.sessions.has('s1')).toBe(false)
  expect(deps.bindings.get('reviewer:oc_1')).toEqual({ sessionId: 's1' })
})
