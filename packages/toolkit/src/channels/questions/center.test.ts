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
  toggled: Map<string, readonly string[]>
}

function snapshot(view: QuestionView): ViewSnapshot {
  return { answers: new Map(view.answers), toggled: new Map(view.toggled) }
}

function harness(opts: { presentError?: Error; abortDuringPresent?: AbortController } = {}) {
  const sessions = new Map<string, SessionRuntime>()
  const warns: string[] = []
  const presented: { prompt: QuestionPrompt; view: ViewSnapshot }[] = []
  const refreshed: { prompt: QuestionPrompt; view: ViewSnapshot }[] = []
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
    refresh: async (prompt, view) => { refreshed.push({ prompt, view: snapshot(view) }) },
    finalize: async (prompt, view, status) => { finalized.push({ prompt, view: snapshot(view), status }) },
  }
  const center = new QuestionCenter(
    sessions,
    (botId) => botId === 'reviewer'
      ? {
          botName: '评审',
          presenter: {
            present: async (prompt, view) => {
              if (opts.presentError !== undefined) throw opts.presentError
              opts.abortDuringPresent?.abort()
              presented.push({ prompt, view: snapshot(view) })
              return presentation
            },
          },
        }
      : undefined,
    (m) => { warns.push(m) },
    () => randomUUID(),
  )
  return { sessions, warns, presented, refreshed, finalized, breakCard, center, reply }
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

test('单选题点击 → resolve 已选答案、定格 answered、breakCard 续接', async () => {
  const { sessions, presented, finalized, breakCard, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [item('q1', { options: [{ label: '红' }, { label: '蓝' }] })]))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  expect(presented[0]!.prompt).toMatchObject({ chatId: CHAT, botName: '评审' })
  const ack = center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR,
    value: { kind: 'question', key: presented[0]!.prompt.key, qid: 'q1', select: '蓝' },
  })
  expect(ack).toEqual({ toast: '已提交作答' })
  await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['蓝'] }] })
  await vi.waitFor(() => { expect(finalized.map((f) => f.status)).toEqual(['answered']) })
  expect(finalized[0]!.view.answers.get('q1')).toEqual({ selected: ['蓝'] })
  expect(breakCard).toHaveBeenCalledTimes(1)
})

test('多问题：答完第一题不 resolve（refresh 被调），全部收齐才 resolve', async () => {
  const { sessions, presented, refreshed, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [
    item('q1', { options: [{ label: '红' }, { label: '蓝' }] }),
    item('q2', { options: [{ label: '是' }, { label: '否' }] }),
  ]))
  const tracker = track(pending)
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const key = presented[0]!.prompt.key
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key, qid: 'q1', select: '红' },
  })).toEqual({ toast: '已记录，请继续作答剩余问题' })
  await vi.waitFor(() => { expect(refreshed).toHaveLength(1) })
  expect(refreshed[0]!.view.answers.get('q1')).toEqual({ selected: ['红'] })
  expect(tracker.done).toBe(false)
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key, qid: 'q2', select: '否' },
  })).toEqual({ toast: '已提交作答' })
  await expect(pending).resolves.toEqual({
    answers: [{ id: 'q1', selected: ['红'] }, { id: 'q2', selected: ['否'] }],
  })
})

test('multi_select：toggle 刷新携带勾选态，confirm 后才记入 answers', async () => {
  const { sessions, presented, refreshed, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [
    item('q1', { multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] }),
  ]))
  const tracker = track(pending)
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const key = presented[0]!.prompt.key
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key, qid: 'q1', toggle: '甲' },
  })).toEqual({})
  await vi.waitFor(() => { expect(refreshed).toHaveLength(1) })
  expect(refreshed[0]!.view.toggled.get('q1')).toEqual(['甲'])
  expect(refreshed[0]!.view.answers.has('q1')).toBe(false)
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key, qid: 'q1', toggle: '乙' },
  })).toEqual({})
  await vi.waitFor(() => { expect(refreshed).toHaveLength(2) })
  expect(refreshed[1]!.view.toggled.get('q1')).toEqual(['甲', '乙'])
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key, qid: 'q1', toggle: '甲' },
  })).toEqual({})
  await vi.waitFor(() => { expect(refreshed).toHaveLength(3) })
  expect(refreshed[2]!.view.toggled.get('q1')).toEqual(['乙'])
  expect(tracker.done).toBe(false)
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key, qid: 'q1', confirm: true },
  })).toEqual({ toast: '已提交作答' })
  await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['乙'] }] })
})

test('取消按钮 → reject UserQuestionError ASK_CANCELLED 且定格 cancelled', async () => {
  const { sessions, presented, finalized, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [item('q1', { options: [{ label: '红' }] })]))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key: presented[0]!.prompt.key, cancel: true },
  })).toEqual({ toast: '已取消提问' })
  await expect(pending).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
  await vi.waitFor(() => { expect(finalized.map((f) => f.status)).toEqual(['cancelled']) })
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
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key: presented[0]!.prompt.key, qid: 'q1', select: '红' },
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
  const { sessions, presented, refreshed, finalized, center, reply } = harness()
  sessions.set('s1', fakeRt('s1', reply))
  const pending = center.handleRequest(ask('s1', [item('q1', { options: [{ label: '红' }] })]))
  const tracker = track(pending)
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const ack = center.handleCardAction({
    chatId: CHAT, operatorOpenId: 'ou_someone_else',
    value: { kind: 'question', key: presented[0]!.prompt.key, qid: 'q1', select: '红' },
  })
  expect(ack).toEqual({ toast: '仅会话发起人可作答' })
  await Promise.resolve()
  expect(tracker.done).toBe(false)
  expect(refreshed).toHaveLength(0)
  expect(finalized).toHaveLength(0)
  center.dispose()
  await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
})

test('未知 key → toast 已失效', () => {
  const { center } = harness()
  expect(center.handleCardAction({
    chatId: CHAT, operatorOpenId: INITIATOR, value: { kind: 'question', key: 'gone', qid: 'q1', select: '红' },
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
  const { sessions, presented, refreshed, center, reply } = harness()
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
  await vi.waitFor(() => { expect(refreshed).toHaveLength(0) })
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
