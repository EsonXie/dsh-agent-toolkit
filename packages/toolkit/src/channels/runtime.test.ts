import { describe, expect, test, vi } from 'vitest'
import type { BotChannel, ChannelHandle, ReplyHandle } from './channel.ts'
import { BotRuntime, type RuntimeDeps } from './runtime.ts'
import { bindingKey, type BotRecord } from '../bots/store.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import type { BindingStore } from './ports.ts'
import type { ApprovalPrompt, CardActionAck, CardActionInput } from './approval/center.ts'
import type { QuestionPrompt } from './questions/center.ts'

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
    agents: { create: vi.fn(), resume: vi.fn(), get: () => undefined } as unknown as RuntimeDeps['agents'],
    registry: fakeRegistry,
    defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-v4' }),
    workspace: { attach: async () => undefined },
    channels: new Map([['feishu', channel]]),
    tunables: { cardUpdateThrottleMs: 10, cardMaxBytes: 1024, processMaxBytes: 1024, cardPrintStep: 5, processingReactionEmoji: 'OneSecond' },
    maxErrorDetailChars: 500,
    docMaxBytes: 1024,
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

test('绑定键：话题消息独立键，非话题维持旧形态', async () => {
  // bindingKey 纯函数：threadId 存在 → bot:chat:thread，缺席 → bot:chat
  expect(bindingKey('b', 'oc_1', 'omt_a')).toBe('b:oc_1:omt_a')
  expect(bindingKey('b', 'oc_1')).toBe('b:oc_1')
  expect(bindingKey('b', 'oc_1', undefined)).toBe('b:oc_1')
  // bindings 适配器经 bindingKey：话题键与 chat 键互不可见
  const { runtime, deps } = harness()
  const store = (runtime as unknown as { bindingStore(): BindingStore }).bindingStore()
  await store.set('b', 'oc_1', 'omt_a', 's-topic')
  await store.set('b', 'oc_1', undefined, 's-chat')
  expect(deps.bindings.get('b:oc_1:omt_a')).toEqual({ sessionId: 's-topic' })
  expect(deps.bindings.get('b:oc_1')).toEqual({ sessionId: 's-chat' })
  expect(store.get('b', 'oc_1', 'omt_a')).toBe('s-topic')
  expect(store.get('b', 'oc_1')).toBe('s-chat')
  expect(store.get('b', 'oc_1', undefined)).toBe('s-chat')
  // delete 定点删话题键，不影响 chat 键
  await store.delete('b', 'oc_1', 'omt_a')
  expect(deps.bindings.get('b:oc_1:omt_a')).toBeUndefined()
  expect(deps.bindings.get('b:oc_1')).toEqual({ sessionId: 's-chat' })
})

test('停止/解绑/全停路径均清空该 bot 的排队队列', async () => {
  const { runtime } = harness()
  await runtime.startAll()
  const clearSpy = vi.spyOn(runtime.inbound, 'clearQueues')
  await runtime.stopBot('reviewer')
  expect(clearSpy).toHaveBeenCalledWith('reviewer')
  clearSpy.mockClear()
  await runtime.unbindBot('reviewer')
  expect(clearSpy).toHaveBeenCalledWith('reviewer')
  clearSpy.mockClear()
  await runtime.stopAll()
  expect(clearSpy).toHaveBeenCalledWith('reviewer')
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

test('injectSender: false：入站建会话 hooks 只含 guidance 段、不含 sender 段', async () => {
  const hookInputs: { hooks: unknown }[] = []
  const agents = {
    get: () => undefined,
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
  expect(hookInputs[0].hooks).toMatchObject({
    sections: [
      { name: 'dsh-agent-toolkit:channel:guidance', order: 15, text: '本会话经 feishu 渠道进行。如需用户补充信息或做出决策，优先使用 ask_user_question 工具；该工具不可用时，直接在回复中提问并等待用户下一条消息。' },
    ],
  })
})

test('unbindBot 停渠道并取消在飞会话，但保留绑定表', async () => {
  const { runtime, closed, deps } = harness()
  await runtime.startAll()
  await deps.bindings.put('reviewer:oc_1', { sessionId: 's1' })
  const cancelled: string[] = []
  const disposed: string[] = []
  runtime.sessions.set('s1', {
    botId: 'reviewer', chatId: 'oc_1', sessionId: 's1', initiatorOpenId: 'ou_x',
    agent: { sessionId: 's1', followup: () => undefined, cancel: () => { cancelled.push('s1') }, whenIdle: async () => undefined, dispose: async () => { disposed.push('s1') } },
    reply: undefined, inflight: undefined, tail: Promise.resolve(), turn: undefined, retiring: false,
  })
  await runtime.unbindBot('reviewer')
  expect(closed).toEqual(['reviewer'])
  expect(cancelled).toEqual(['s1'])
  // 会话映射改为「落定后清空」（whenIdle + tail 落定才摘出，让旧卡 finalize）——见计划 Task 5。
  await vi.waitFor(() => { expect(runtime.sessions.has('s1')).toBe(false) })
  expect(disposed).toEqual(['s1'])   // 释放写句柄：重绑后 resume 不再 already owned
  expect(deps.bindings.get('reviewer:oc_1')).toEqual({ sessionId: 's1' })
})

test('unbindBot 重绑窗口：旧 rt 收尾期间的消息不复用已取消 agent，新 rt 不被旧 retire 摘除', async () => {
  const { runtime, deps } = harness({
    agents: {
      get: () => undefined,
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
    dispose: async () => undefined,
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
      get: () => undefined,
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

/** 带问答能力的渠道 harness：capture io + 记录 present 的 key。 */
function questionHarness() {
  let io: { onMessage(m: unknown): void; onCardAction?(a: CardActionInput): CardActionAck | undefined } | undefined
  const presented: QuestionPrompt[] = []
  const channel: BotChannel = {
    type: 'feishu',
    start: async (_bot, channelIo) => {
      io = channelIo as typeof io
      return {
        close: async () => undefined,
        status: () => 'connected' as const,
        questions: {
          present: async (prompt: QuestionPrompt) => {
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
      get: () => undefined,
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

test('onCardAction 按 value.kind 路由：question → QuestionCenter，无 kind → ApprovalCenter', async () => {
  const { runtime, ioOf } = questionHarness()
  await runtime.startAll()
  const questionAck: CardActionAck = { toast: 'question' }
  const approvalAck: CardActionAck = { toast: 'approval' }
  const questionSpy = vi.spyOn(runtime.questions, 'handleCardAction').mockReturnValue(questionAck)
  const approvalSpy = vi.spyOn(runtime.approval, 'handleCardAction').mockReturnValue(approvalAck)
  const action = (value: unknown): CardActionInput => ({ chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', value })
  expect(ioOf()!.onCardAction!(action({ kind: 'question', key: 'k', submit: true }))).toEqual(questionAck)
  expect(questionSpy).toHaveBeenCalledTimes(1)
  expect(approvalSpy).not.toHaveBeenCalled()
  // 审批卡无 kind 字段（legacy 兼容）：落回 ApprovalCenter
  expect(ioOf()!.onCardAction!(action({ key: 'k', decision: 'allow' }))).toEqual(approvalAck)
  expect(approvalSpy).toHaveBeenCalledTimes(1)
  expect(questionSpy).toHaveBeenCalledTimes(1)
})

test('问答集成：渠道 questions presenter 发卡，io.onCardAction(kind:question) 路由回 center resolve', async () => {
  const { runtime, fakeReply, presented, ioOf } = questionHarness()
  await runtime.startAll()
  const rt = await runtime.router.ensure(BOT, 'oc_chat1', fakeReply, 'ou_initiator')
  const pending = runtime.questions.handleRequest({
    agent: { session: { id: rt.sessionId } },
    questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '继续' }, { label: '停止' }] }],
  })
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const ack = ioOf()!.onCardAction!({
    chatId: 'oc_chat1', operatorOpenId: 'ou_initiator',
    value: { kind: 'question', key: presented[0]!.key, submit: true },
    formValue: { q0: '继续' },
  })
  expect(ack).toEqual({ toast: '已提交作答' })
  await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['继续'] }] })
})

test('问答集成：发起人下一条纯文本经 inbound 拦截直接作答，不触发新 turn', async () => {
  const { runtime, fakeReply, presented } = questionHarness()
  await runtime.startAll()
  const rt = await runtime.router.ensure(BOT, 'oc_chat1', fakeReply, 'ou_initiator')
  const pending = runtime.questions.handleRequest({
    agent: { session: { id: rt.sessionId } },
    questions: [{ id: 'q1', question: '你的想法？' }],
  })
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const ensureSpy = vi.spyOn(runtime.router, 'ensure')
  runtime.inbound.onMessage({
    botId: 'reviewer', chatId: 'oc_chat1', userId: 'ou_initiator', messageId: 'om_ans', text: '我的想法是这样',
    reply: fakeReply, ackProcessing: async () => () => undefined,
  })
  await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: '我的想法是这样' }] })
  expect(ensureSpy).not.toHaveBeenCalled()
})

test('stopAll 兜底 dispose：挂起问答 settle cancelled 且 questions.dispose 被调用', async () => {
  const { runtime, fakeReply, presented } = questionHarness()
  await runtime.startAll()
  const rt = await runtime.router.ensure(BOT, 'oc_chat1', fakeReply, 'ou_initiator')
  const pending = runtime.questions.handleRequest({
    agent: { session: { id: rt.sessionId } },
    questions: [{ id: 'q1', question: '继续吗？' }],
  })
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const disposeSpy = vi.spyOn(runtime.questions, 'dispose')
  await runtime.stopAll()
  expect(disposeSpy).toHaveBeenCalledTimes(1)
  await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
})
