import { describe, expect, test, vi } from 'vitest'
import type { BotChannel, ChannelHandle, ReplyHandle } from './channel.ts'
import { BotRuntime, type RuntimeDeps } from './runtime.ts'
import type { BotRecord } from '../bots/store.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import type { ApprovalPrompt, CardActionAck, CardActionInput } from './approval/center.ts'

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
    tunables: { cardUpdateThrottleMs: 10, cardMaxBytes: 1024, processMaxBytes: 1024, cardPrintStep: 5, processingReactionEmoji: 'OneSecond' },
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
    botId: 'reviewer', chatId: 'oc_1', sessionId: 's1', initiatorOpenId: 'ou_x',
    agent: { sessionId: 's1', followup: () => undefined, cancel: () => { cancelled.push('s1') }, whenIdle: async () => undefined },
    reply: undefined, inflight: undefined, tail: Promise.resolve(), turn: undefined, retiring: false,
  })
  await runtime.unbindBot('reviewer')
  expect(closed).toEqual(['reviewer'])
  expect(cancelled).toEqual(['s1'])
  // 会话映射改为「落定后清空」（whenIdle + tail 落定才摘出，让旧卡 finalize）——见计划 Task 5。
  await vi.waitFor(() => { expect(runtime.sessions.has('s1')).toBe(false) })
  expect(deps.bindings.get('reviewer:oc_1')).toEqual({ sessionId: 's1' })
})

test('unbindBot 重绑窗口：旧 rt 收尾期间的消息不复用已取消 agent，新 rt 不被旧 retire 摘除', async () => {
  const { runtime, deps } = harness({
    agents: {
      create: async (input: { sessionId: string }) => ({
        sessionId: input.sessionId, followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined,
      }),
      resume: async (input: { sessionId: string }) => ({
        sessionId: input.sessionId, followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined,
      }),
    } as unknown as RuntimeDeps['agents'],
  })
  await runtime.startAll()
  await deps.bindings.put('reviewer:oc_1', { sessionId: 's1' })
  // 旧 rt 在飞（whenIdle 挂起 = finalize 收尾窗口内）
  let releaseIdle!: () => void
  const oldAgent = {
    sessionId: 's1', followup: () => undefined,
    cancel: vi.fn(), whenIdle: () => new Promise<void>((r) => { releaseIdle = r }),
  }
  runtime.sessions.set('s1', {
    botId: 'reviewer', chatId: 'oc_1', sessionId: 's1', initiatorOpenId: 'ou_x',
    agent: oldAgent, reply: undefined, inflight: undefined, tail: Promise.resolve(), turn: undefined, retiring: false,
  })

  await runtime.unbindBot('reviewer')       // retire 旧 rt（绑定保留）
  expect(oldAgent.cancel).toHaveBeenCalled()
  expect(runtime.sessions.get('s1')!.retiring).toBe(true)
  await runtime.reconcile('reviewer')       // 重绑：渠道重启

  runtime.inbound.onMessage({
    botId: 'reviewer', chatId: 'oc_1', userId: 'ou_new', messageId: 'om_2', text: '重绑后消息',
    reply: { beginTurn: async () => undefined, update: async () => undefined, finalize: async () => undefined, notice: async () => undefined },
    ackProcessing: async () => () => undefined,
  })
  await vi.waitFor(() => {
    const current = runtime.sessions.get('s1')
    expect(current).toBeDefined()
    expect(current!.agent).not.toBe(oldAgent)   // 不复用已取消 agent（resume + adopt 重建）
    expect(current!.retiring).toBe(false)
  })
  const newRt = runtime.sessions.get('s1')!

  releaseIdle()                               // 旧 rt 收尾落定：identity guard 不得误删新 rt
  await vi.waitFor(() => { expect(runtime.sessions.get('s1')).toBe(newRt) })
})

/** 带审批能力的渠道 harness：capture io + 记录 present 的 key。 */
function approvalHarness() {
  let io: { onMessage(m: unknown): void; onCardAction?(a: CardActionInput): CardActionAck | undefined } | undefined
  const presented: ApprovalPrompt[] = []
  const channel: BotChannel = {
    type: 'feishu',
    start: async (_bot, channelIo) => {
      io = channelIo as typeof io
      return {
        close: async () => undefined,
        status: () => 'connected' as const,
        approval: {
          present: async (prompt: ApprovalPrompt) => {
            presented.push(prompt)
            return { finalize: async () => undefined }
          },
        },
      }
    },
  }
  const fakeReply: ReplyHandle = {
    beginTurn: async () => undefined, update: async () => undefined,
    finalize: async () => undefined, notice: async () => undefined,
  }
  const { runtime } = harness({
    channels: new Map([['feishu', channel]]),
    agents: {
      create: async (input: { sessionId: string }) => ({
        sessionId: input.sessionId,
        followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined,
      }),
      resume: async (input: { sessionId: string }) => ({
        sessionId: input.sessionId,
        followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined,
      }),
    } as unknown as RuntimeDeps['agents'],
  })
  return { runtime, fakeReply, presented, ioOf: () => io }
}

test('审批集成：渠道 approval presenter 发卡，io.onCardAction 路由回 center resolve', async () => {
  const { runtime, fakeReply, presented, ioOf } = approvalHarness()
  await runtime.startAll()
  const rt = await runtime.router.ensure(BOT, 'oc_chat1', fakeReply, 'ou_initiator')
  const pending = runtime.approval.handleRequest({ agent: { session: { id: rt.sessionId } }, toolName: 'write' })
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  // 经渠道 io 回调（与真实 card.action.trigger 同路径）
  const ack = ioOf()!.onCardAction!({ chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', value: { key: presented[0]!.key, decision: 'reject' } })
  expect(ack).toEqual({ toast: '已拒绝' })
  await expect(pending).resolves.toBe('rejected')
})

test('stopAll 兜底 dispose：挂起审批 settle cancelled', async () => {
  const { runtime, fakeReply, presented } = approvalHarness()
  await runtime.startAll()
  const rt = await runtime.router.ensure(BOT, 'oc_chat1', fakeReply, 'ou_initiator')
  const pending = runtime.approval.handleRequest({ agent: { session: { id: rt.sessionId } }, toolName: 'write' })
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  await runtime.stopAll()
  await expect(pending).resolves.toBe('cancelled')
})
