import { describe, expect, test, vi } from 'vitest'
import type { BotChannel, ChannelHandle } from '../src/core/channel.ts'
import { BotRuntime, type RuntimeDeps } from '../src/core/runtime.ts'
import type { BotRecord } from '../src/store.ts'

const BOT: BotRecord = {
  id: 'reviewer', name: '评审', channel: 'feishu',
  feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
  project: 'D:\\work\\demo', createdAt: 0, updatedAt: 0,
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
    channels: new Map([['feishu', channel]]),
    tunables: { cardUpdateThrottleMs: 10, cardMaxBytes: 1024, processingReactionEmoji: 'OneSecond' },
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
