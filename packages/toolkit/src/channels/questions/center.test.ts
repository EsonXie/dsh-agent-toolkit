import { randomUUID } from 'node:crypto'
import { expect, test, vi } from 'vitest'
import {
  QuestionCenter,
  type QuestionItemLike,
  type QuestionPresentation,
  type QuestionPrompt,
  type QuestionRequestLike,
  type QuestionView,
} from './center.ts'
import type { ReplyHandle } from '../channel.ts'
import type { SessionRuntime } from '../ports.ts'

const CHAT = 'oc_chat1'
const INITIATOR = 'ou_initiator'

function fakeRt(sessionId: string, reply: ReplyHandle, botId = 'reviewer', initiatorOpenId = INITIATOR): SessionRuntime {
  return {
    botId, chatId: CHAT, sessionId, initiatorOpenId,
    agent: { sessionId, followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined, dispose: async () => undefined },
    reply, inflight: undefined, tail: Promise.resolve(), turn: undefined, retiring: false,
  }
}

interface ViewSnapshot {
  answers: Map<string, { selected: string[]; custom?: string }>
}

function snapshot(view: QuestionView): ViewSnapshot {
  return { answers: new Map(view.answers) }
}

function harness(opts: { presentError?: Error; abortDuringPresent?: AbortController } = {}) {
  const sessions = new Map<string, SessionRuntime>()
  const warns: string[] = []
  const debugEvents: Record<string, unknown>[] = []
  const presented: { prompt: QuestionPrompt }[] = []
  const finalized: { prompt: QuestionPrompt; view: ViewSnapshot; status: string }[] = []
  const breakCard = vi.fn(async () => undefined)
  const reply: ReplyHandle = {
    beginTurn: async () => undefined,
    update: async () => undefined,
    finalize: async () => undefined,
    notice: async () => undefined,
    breakCard,
  }
  const presentation: QuestionPresentation = {
    finalize: async (prompt, view, status) => { finalized.push({ prompt, view: snapshot(view), status }) },
  }
  const center = new QuestionCenter(
    sessions,
    (botId) => botId === 'reviewer'
      ? {
          botName: '评审',
          presenter: {
            present: async (prompt) => {
              if (opts.presentError !== undefined) throw opts.presentError
              opts.abortDuringPresent?.abort()
              presented.push({ prompt })
              return presentation
            },
          },
        }
      : undefined,
    (m) => { warns.push(m) },
    () => randomUUID(),
    (e) => { debugEvents.push(e) },
  )
  return { sessions, warns, debugEvents, presented, finalized, breakCard, center, reply }
}

function item(id: string, extra: Partial<QuestionItemLike> = {}): QuestionItemLike {
  return { id, question: `问题 ${id}`, ...extra }
}

function ask(sessionId: string, questions: QuestionItemLike[], signal?: AbortSignal): QuestionRequestLike {
  return { agent: { session: { id: sessionId } }, questions, ...(signal !== undefined ? { signal } : {}) }
}

function track<T>(p: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false }
  void p.then(
    (value) => { state.done = true; state.value = value },
    (error: unknown) => { state.done = true; state.error = error },
  )
  return state
}

test('非自有会话（sessions 无此 sessionId）→ undefined，不发卡不告警', async () => {
  const { warns, presented, center } = harness()
  expect(await center.handleRequest(ask('s_unknown', [item('q1')]))).toBeUndefined()
  expect(presented).toHaveLength(0)
  expect(warns).toHaveLength(0)
})

test('渠道无 questions presenter → undefined 且 warn', async () => {
  const { sessions, warns, presented, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply, 'no-presenter-bot'))
  expect(await center.handleRequest(ask('s1', [item('q1')]))).toBeUndefined()
  expect(presented).toHaveLength(0)
  expect(warns).toHaveLength(1)
})

test('signal 已 aborted → 抛 UserQuestionError ASK_ABORTED，不发卡', async () => {
  const { sessions, presented, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const controller = new AbortController()
  controller.abort()
  await expect(center.handleRequest(ask('s1', [item('q1')], controller.signal)))
    .rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
  expect(presented).toHaveLength(0)
})

test('发卡期间 abort → reject UserQuestionError ASK_ABORTED、定格 cancelled、不留 pending', async () => {
  const controller = new AbortController()
  const { sessions, presented, finalized, center, reply } = harness({ abortDuringPresent: controller })
  sessions.set('s1', fakeRt('s1', reply))
  await expect(center.handleRequest(ask('s1', [item('q1')], controller.signal)))
    .rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
  // 卡片已发出（present 成功返回），随后按取消定格
  expect(presented).toHaveLength(1)
  await vi.waitFor(() => { expect(finalized.map((f) => f.status)).toEqual(['cancelled']) })
  // pending 已摘除：迟到的开放题答案不再被消费
  expect(center.tryConsumeText('reviewer', CHAT, INITIATOR, '迟到答案')).toBe(false)
})

test('发卡失败 → undefined + warn（调用方回退其他应答通道）', async () => {
  const { sessions, warns, presented, center, reply } = harness({ presentError: new Error('cardkit boom') })
  sessions.set('s1', fakeRt('s1', reply))
  expect(await center.handleRequest(ask('s1', [item('q1', { options: [{ label: '红' }] })]))).toBeUndefined()
  expect(presented).toHaveLength(0)
  expect(warns.some((m) => m.includes('cardkit boom'))).toBe(true)
})

test('submit：单选+多选+开放+自定义混合，formValue 按位置序号聚合，全齐 resolve', async () => {
  const { sessions, presented, finalized, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [
    item('q1', { options: [{ label: '红' }, { label: '蓝' }] }),
    item('q2', { multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] }),
    item('q3'),
    item('q4', { options: [{ label: '对' }, { label: '错' }] }),
  ]))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const key = presented[0]!.prompt.key
  const ack = center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR,
    value: { kind: 'question', key, submit: true },
    formValue: { q0: '蓝', 'q1__opt0': true, 'q1__opt1': 'true', q2: '自由回答', q3: '对', 'q3__custom': '补充说明' },
  })
  expect(ack).toEqual({ toast: '已提交作答' })
  await expect(pending).resolves.toEqual({
    answers: [
      { id: 'q1', selected: ['蓝'] },
      { id: 'q2', selected: ['甲', '乙'] },
      { id: 'q3', selected: [], custom: '自由回答' },
      { id: 'q4', selected: ['对'], custom: '补充说明' },
    ],
  })
  await vi.waitFor(() => { expect(finalized.map((f) => f.status)).toEqual(['answered']) })
})

test('submit 缺题：toast 指出未答数，保持 pending 不 resolve', async () => {
  const { sessions, presented, finalized, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [
    item('q1', { options: [{ label: '红' }] }),
    item('q2'),
  ]))
  const tracker = track(pending)
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const key = presented[0]!.prompt.key
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR,
    value: { kind: 'question', key, submit: true },
    formValue: { q0: '红' },
  })).toEqual({ toast: '还有 1 道题未作答' })
  await Promise.resolve()
  expect(tracker.done).toBe(false)
  expect(finalized).toHaveLength(0)
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR,
    value: { kind: 'question', key, submit: true },
    formValue: { q0: '红', q1: '开放作答' },
  })).toEqual({ toast: '已提交作答' })
  await expect(pending).resolves.toEqual({
    answers: [{ id: 'q1', selected: ['红'] }, { id: 'q2', selected: [], custom: '开放作答' }],
  })
})

test('submit 与文本拦截合并：开放题先被 inbound 文本作答，submit 时其余题经 formValue 补齐', async () => {
  const { sessions, presented, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [
    item('q1', { options: [{ label: '红' }] }),
    item('q2'),
  ]))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const key = presented[0]!.prompt.key
  expect(center.tryConsumeText('reviewer', CHAT, INITIATOR, '文本作答')).toBe(true)
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR,
    value: { kind: 'question', key, submit: true },
    formValue: { q0: '红' },
  })).toEqual({ toast: '已提交作答' })
  await expect(pending).resolves.toEqual({
    answers: [{ id: 'q1', selected: ['红'] }, { id: 'q2', selected: [], custom: '文本作答' }],
  })
})

test('submit 时 formValue 对某题给空值 → 该题视为未答', async () => {
  const { sessions, presented, finalized, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [item('q1', { options: [{ label: '红' }] })]))
  track(pending)
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const key = presented[0]!.prompt.key
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR,
    value: { kind: 'question', key, submit: true },
    formValue: { q0: '' },
  })).toEqual({ toast: '还有 1 道题未作答' })
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR,
    value: { kind: 'question', key, submit: true },
    formValue: {},
  })).toEqual({ toast: '还有 1 道题未作答' })
  await Promise.resolve()
  expect(finalized).toHaveLength(0)
})

test('选项题只填自定义（不选选项）→ 视为已答', async () => {
  const { sessions, presented, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [item('q1', { options: [{ label: '红' }] })]))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const key = presented[0]!.prompt.key
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR,
    value: { kind: 'question', key, submit: true },
    formValue: { 'q0__custom': '都不是' },
  })).toEqual({ toast: '已提交作答' })
  await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: '都不是' }] })
})

test('取消按钮 → reject UserQuestionError ASK_CANCELLED 且定格 cancelled', async () => {
  const { sessions, presented, finalized, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [item('q1', { options: [{ label: '红' }] })]))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key: presented[0]!.prompt.key, cancel: true },
  })).toEqual({ toast: '已跳过提问' })
  await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
  await vi.waitFor(() => { expect(finalized.map((f) => f.status)).toEqual(['cancelled']) })
})

test('旧版 select/toggle/confirm value 不再识别 → undefined', async () => {
  const { sessions, presented, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [item('q1', { options: [{ label: '红' }] })]))
  track(pending)
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const key = presented[0]!.prompt.key
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key, qid: 'q1', select: '红' },
  })).toBeUndefined()
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key, qid: 'q1', toggle: '红' },
  })).toBeUndefined()
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key, qid: 'q1', confirm: true },
  })).toBeUndefined()
})

test('pending 中 signal abort → reject ASK_ABORTED 且定格 cancelled', async () => {
  const { sessions, presented, finalized, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const controller = new AbortController()
  const pending = center.handleRequest(ask('s1', [item('q1', { options: [{ label: '红' }] })], controller.signal))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
  await vi.waitFor(() => { expect(finalized.map((f) => f.status)).toEqual(['cancelled']) })
})

test('作答 settle 后 signal 再 abort → 不重复 finalize/breakCard，promise 保持已答', async () => {
  const { sessions, presented, finalized, breakCard, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const controller = new AbortController()
  const pending = center.handleRequest(ask('s1', [item('q1', { options: [{ label: '红' }] })], controller.signal))
  const tracker = track(pending)
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR,
    value: { kind: 'question', key: presented[0]!.prompt.key, submit: true },
    formValue: { q0: '红' },
  })).toEqual({ toast: '已提交作答' })
  await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['红'] }] })
  await vi.waitFor(() => { expect(finalized.map((f) => f.status)).toEqual(['answered']) })
  // 迟到 abort：abort 监听已注销，不得把已答卡片重绘为 cancelled，也不得二次 breakCard
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(finalized.map((f) => f.status)).toEqual(['answered'])
  expect(breakCard).toHaveBeenCalledTimes(1)
  expect(tracker.error).toBeUndefined()
})

test('非发起人点击 → toast 越权，pending 不动', async () => {
  const { sessions, presented, finalized, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [item('q1', { options: [{ label: '红' }] })]))
  const tracker = track(pending)
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const ack = center.handleCardAction({
    chatId: CHAT, operatorOpenId: 'ou_someone_else',
    value: { kind: 'question', key: presented[0]!.prompt.key, submit: true },
    formValue: { q0: '红' },
  })
  expect(ack).toEqual({ toast: '仅会话发起人可作答' })
  await Promise.resolve()
  expect(tracker.done).toBe(false)
  expect(finalized).toHaveLength(0)
  center.dispose()
  await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
})

test('未知 key → toast 已失效', () => {
  const { center } = harness()
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key: 'gone', submit: true },
  })).toEqual({ toast: '该问题已作答或已失效' })
})

test('value 畸形（无 key / kind 非 question）→ undefined 静默忽略', () => {
  const { center } = harness()
  expect(center.handleCardAction({ chatId: CHAT, operatorOpenId: INITIATOR, value: null })).toBeUndefined()
  expect(center.handleCardAction({ chatId: CHAT, operatorOpenId: INITIATOR, value: { unrelated: 1 } })).toBeUndefined()
  expect(center.handleCardAction({ chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'approval', key: 'k' } })).toBeUndefined()
  expect(center.handleCardAction({ chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question' } })).toBeUndefined()
})

test('tryConsumeText：开放题归属该 chat 最早 pending key，仅发起人，答完即 settle', async () => {
  const { sessions, presented, center, reply } = harness()
  // 无 pending → false
  expect(center.tryConsumeText('reviewer', CHAT, INITIATOR, 'hi')).toBe(false)
  // 该 chat 只有带选项的 pending（无开放题）→ false
  sessions.set('s_pick', fakeRt('s_pick', reply))
  const pick = center.handleRequest(ask('s_pick', [item('q_pick', { options: [{ label: '甲' }] })]))
  const pickTracker = track(pick)
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  expect(center.tryConsumeText('reviewer', CHAT, INITIATOR, '选项题不吃文本')).toBe(false)
  // 两个含开放题的 pending（同 chat）：文本归属最早 key
  sessions.set('s_open1', fakeRt('s_open1', reply))
  sessions.set('s_open2', fakeRt('s_open2', reply))
  const first = center.handleRequest(ask('s_open1', [item('q_open1')]))
  const second = center.handleRequest(ask('s_open2', [item('q_open2')]))
  await vi.waitFor(() => { expect(presented).toHaveLength(3) })
  expect(center.tryConsumeText('reviewer', CHAT, 'ou_other', '文本')).toBe(false)
  expect(pickTracker.done).toBe(false)
  expect(center.tryConsumeText('reviewer', CHAT, INITIATOR, '第一个答案')).toBe(true)
  await expect(first).resolves.toEqual({ answers: [{ id: 'q_open1', selected: [], custom: '第一个答案' }] })
  expect(center.tryConsumeText('reviewer', CHAT, INITIATOR, '第二个答案')).toBe(true)
  await expect(second).resolves.toEqual({ answers: [{ id: 'q_open2', selected: [], custom: '第二个答案' }] })
  // 全部收齐后（剩余 options-only pending 无开放题）→ false
  expect(center.tryConsumeText('reviewer', CHAT, INITIATOR, '再来')).toBe(false)
})

test('dispose → 全部 pending 以 ASK_CANCELLED reject，卡片 finalize cancelled', async () => {
  const { sessions, presented, finalized, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  sessions.set('s2', fakeRt('s2', reply))
  const first = center.handleRequest(ask('s1', [item('q1', { options: [{ label: '甲' }] })]))
  const second = center.handleRequest(ask('s2', [item('q2', { options: [{ label: '乙' }] })]))
  track(first)
  track(second)
  await vi.waitFor(() => { expect(presented).toHaveLength(2) })
  center.dispose()
  await expect(first).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
  await expect(second).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
  await vi.waitFor(() => { expect(finalized.map((f) => f.status)).toEqual(['cancelled', 'cancelled']) })
})

// 2026-09-17 生产排障：dsh web 不展示插件 warn（日志盲点），fall-through 分支补 debugLog 事件。
test('debugLog：req.agent 缺席 → question-fallback reason no-agent', async () => {
  const { debugEvents, center } = harness()
  expect(await center.handleRequest({ questions: [item('q1')] })).toBeUndefined()
  expect(debugEvents).toEqual([{ event: 'question-fallback', reason: 'no-agent', qCount: 1 }])
})

test('debugLog：sessions 未命中 → question-fallback reason session-not-found', async () => {
  const { debugEvents, center } = harness()
  expect(await center.handleRequest(ask('s_unknown', [item('q1')]))).toBeUndefined()
  expect(debugEvents).toEqual([{ event: 'question-fallback', reason: 'session-not-found', sessionId: 's_unknown', qCount: 1 }])
})

test('debugLog：渠道无 presenter → question-fallback reason no-channel（带 botId）', async () => {
  const { sessions, debugEvents, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply, 'no-presenter-bot'))
  expect(await center.handleRequest(ask('s1', [item('q1')]))).toBeUndefined()
  expect(debugEvents).toEqual([{ event: 'question-fallback', reason: 'no-channel', sessionId: 's1', botId: 'no-presenter-bot', qCount: 1 }])
})

test('debugLog：发卡失败 → question-fallback reason present-failed（带错误摘要）', async () => {
  const { sessions, debugEvents, center, reply } = harness({ presentError: new Error('cardkit boom') })
  sessions.set('s1', fakeRt('s1', reply))
  expect(await center.handleRequest(ask('s1', [item('q1')]))).toBeUndefined()
  expect(debugEvents).toEqual([
    { event: 'question-fallback', reason: 'present-failed', sessionId: 's1', botId: 'reviewer', qCount: 1, error: 'cardkit boom' },
  ])
})

test('debugLog：发卡成功 → question-presented（key/sessionId/chatId/qCount）', async () => {
  const { sessions, presented, debugEvents, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [item('q1', { options: [{ label: '红' }] })]))
  track(pending)
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  expect(debugEvents).toEqual([
    { event: 'question-presented', key: presented[0]!.prompt.key, sessionId: 's1', botId: 'reviewer', chatId: CHAT, qCount: 1 },
  ])
  center.dispose()
  await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
})
