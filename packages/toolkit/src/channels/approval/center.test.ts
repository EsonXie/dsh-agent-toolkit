import { randomUUID } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { ApprovalCenter, type ApprovalPresentation, type ApprovalPrompt, type ApprovalRequestLike } from './center.ts'
import type { SessionRuntime } from '../ports.ts'

function fakeRt(sessionId: string, botId = 'reviewer', initiatorOpenId = 'ou_initiator'): SessionRuntime {
  return {
    botId, chatId: 'oc_chat1', sessionId, initiatorOpenId,
    agent: { sessionId, followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined, dispose: async () => undefined },
    reply: undefined, inflight: undefined, tail: Promise.resolve(), turn: undefined, retiring: false,
  }
}

function harness(opts: { presentError?: Error; timeoutMs?: number } = {}) {
  const sessions = new Map<string, SessionRuntime>()
  const warns: string[] = []
  const presented: ApprovalPrompt[] = []
  const finalized: { status: string; operatorName?: string }[] = []
  const presentation: ApprovalPresentation = {
    finalize: async (status, operatorName) => { finalized.push({ status, ...(operatorName !== undefined ? { operatorName } : {}) }) },
  }
  const center = new ApprovalCenter(
    sessions,
    (botId) => botId === 'reviewer'
      ? {
          botName: '评审',
          presenter: {
            present: async (prompt) => {
              if (opts.presentError !== undefined) throw opts.presentError
              presented.push(prompt)
              return presentation
            },
          },
        }
      : undefined,
    (m) => { warns.push(m) },
    () => randomUUID(),
    opts.timeoutMs,
  )
  return { sessions, warns, presented, finalized, center }
}

function ask(sessionId: string, signal?: AbortSignal): ApprovalRequestLike {
  return { agent: { session: { id: sessionId } }, toolName: 'write', reason: '需要写入文件', ...(signal !== undefined ? { signal } : {}) }
}

/** 记录 promise 落定状态（不引入未处理 rejection）。 */
function track<T>(p: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false }
  void p.then(
    (value) => { state.done = true; state.value = value },
    (error: unknown) => { state.done = true; state.error = error },
  )
  return state
}

/** 纯微任务排空：fake timers 下不可用真实 setTimeout；present 的 await 链走微任务即可落定。 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('非自有会话 → undefined（调用方回退 next）', async () => {
  const { center } = harness()
  expect(await center.handleRequest(ask('s_unknown'))).toBeUndefined()
})

test('正常链路：发卡挂起，点允许 resolve allowed-once 并定格卡片', async () => {
  const { sessions, presented, finalized, center } = harness()
  sessions.set('s1', fakeRt('s1'))
  const pending = center.handleRequest(ask('s1'))
  // present 是异步的，先让它落定拿到 key
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  expect(presented[0]).toMatchObject({ chatId: 'oc_chat1', botName: '评审', toolName: 'write', reason: '需要写入文件' })
  // replyAnchor 缺席：prompt 不带 replyToMessageId 键（行为零变化）
  expect(presented[0]).not.toHaveProperty('replyToMessageId')
  const ack = center.handleCardAction({ chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', operatorName: '张三', value: { key: presented[0]!.key, decision: 'allow' } })
  expect(ack).toEqual({ toast: '已允许' })
  await expect(pending).resolves.toBe('allowed-once')
  await vi.waitFor(() => { expect(finalized).toEqual([{ status: 'allowed', operatorName: '张三' }]) })
})

test('点拒绝 resolve rejected', async () => {
  const { sessions, presented, center } = harness()
  sessions.set('s1', fakeRt('s1'))
  const pending = center.handleRequest(ask('s1'))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const ack = center.handleCardAction({ chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', value: { key: presented[0]!.key, decision: 'reject' } })
  expect(ack).toEqual({ toast: '已拒绝' })
  await expect(pending).resolves.toBe('rejected')
})

test('越权：非发起人点击只 toast 不 resolve', async () => {
  const { sessions, presented, center } = harness()
  sessions.set('s1', fakeRt('s1'))
  const pending = center.handleRequest(ask('s1'))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const ack = center.handleCardAction({ chatId: 'oc_chat1', operatorOpenId: 'ou_someone_else', value: { key: presented[0]!.key, decision: 'allow' } })
  expect(ack).toEqual({ toast: '仅会话发起人可审批' })
  // 仍挂起：abort 收尾防泄漏
  const controller = new AbortController()
  void controller
  center.dispose()
  await expect(pending).resolves.toBe('cancelled')
})

test('失效 key（重复点击/已取消）→ toast 已失效', async () => {
  const { center } = harness()
  expect(center.handleCardAction({ chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', value: { key: 'gone', decision: 'allow' } }))
    .toEqual({ toast: '该申请已处理或已失效' })
})

test('非本中心 value 形态 → undefined 静默忽略', () => {
  const { center } = harness()
  expect(center.handleCardAction({ chatId: 'c', operatorOpenId: 'o', value: null })).toBeUndefined()
  expect(center.handleCardAction({ chatId: 'c', operatorOpenId: 'o', value: { unrelated: 1 } })).toBeUndefined()
})

test('signal abort → resolve cancelled 并定格已取消', async () => {
  const { sessions, presented, finalized, center } = harness()
  sessions.set('s1', fakeRt('s1'))
  const controller = new AbortController()
  const pending = center.handleRequest(ask('s1', controller.signal))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  controller.abort()
  await expect(pending).resolves.toBe('cancelled')
  await vi.waitFor(() => { expect(finalized).toEqual([{ status: 'cancelled' }]) })
})

test('signal 已 aborted：立即 cancelled（不注册监听防 zombie）', async () => {
  const { sessions, presented, center } = harness()
  sessions.set('s1', fakeRt('s1'))
  const controller = new AbortController()
  controller.abort()
  await expect(center.handleRequest(ask('s1', controller.signal))).resolves.toBe('cancelled')
  // 已 aborted 的 ask 不应发卡（无意义的卡片）
  expect(presented).toHaveLength(0)
})

test('发卡失败 → undefined + warn（回退其他审批通道）', async () => {
  const { sessions, warns, center } = harness({ presentError: new Error('cardkit boom') })
  sessions.set('s1', fakeRt('s1'))
  expect(await center.handleRequest(ask('s1'))).toBeUndefined()
  expect(warns.some((m) => m.includes('cardkit boom'))).toBe(true)
})

test('渠道无审批能力 → undefined + warn', async () => {
  const { sessions, warns, center } = harness()
  sessions.set('s1', fakeRt('s1', 'no-presenter-bot'))  // channelFor 只认 reviewer
  expect(await center.handleRequest(ask('s1'))).toBeUndefined()
  expect(warns).toHaveLength(1)
})

test('dispose 兜底：全部挂起项 settle cancelled', async () => {
  const { sessions, presented, center } = harness()
  sessions.set('s1', fakeRt('s1'))
  const pending = center.handleRequest(ask('s1'))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  center.dispose()
  await expect(pending).resolves.toBe('cancelled')
})

test('rt 带 replyAnchor → prompt 带 replyToMessageId（话题锚点）', async () => {
  const { sessions, presented, center } = harness()
  sessions.set('s1', { ...fakeRt('s1'), replyAnchor: 'om_turn1' })
  const pending = center.handleRequest(ask('s1'))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  expect(presented[0]).toMatchObject({ replyToMessageId: 'om_turn1' })
  center.dispose()
  await expect(pending).resolves.toBe('cancelled')
})

// ---------- 超时自动拒绝（feishu.approvalTimeoutMs，默认 5 分钟；<= 0 关闭） ----------

test('超时：advance 不足时长不 settle（保持挂起等审批）', async () => {
  vi.useFakeTimers()
  try {
    const { sessions, presented, finalized, center } = harness({ timeoutMs: 5_000 })
    sessions.set('s1', fakeRt('s1'))
    const tracker = track(center.handleRequest(ask('s1')))
    await flush()
    expect(presented).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(tracker.done).toBe(false)
    expect(finalized).toHaveLength(0)
  } finally {
    vi.useRealTimers()
  }
})

test('超时：到点自动拒绝——resolve rejected、finalize rejected（operatorName 超时自动拒绝）', async () => {
  vi.useFakeTimers()
  try {
    const { sessions, presented, finalized, center } = harness({ timeoutMs: 5_000 })
    sessions.set('s1', fakeRt('s1'))
    const pending = center.handleRequest(ask('s1'))
    await flush()
    expect(presented).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toBe('rejected')
    expect(finalized).toEqual([{ status: 'rejected', operatorName: '超时自动拒绝' }])
  } finally {
    vi.useRealTimers()
  }
})

test('超时前已处理：定时器随 settle 清理，advance 后无二次 settle', async () => {
  vi.useFakeTimers()
  try {
    const { sessions, presented, finalized, center } = harness({ timeoutMs: 5_000 })
    sessions.set('s1', fakeRt('s1'))
    const pending = center.handleRequest(ask('s1'))
    await flush()
    expect(presented).toHaveLength(1)
    expect(center.handleCardAction({
      chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', operatorName: '张三',
      value: { key: presented[0]!.key, decision: 'allow' },
    })).toEqual({ toast: '已允许' })
    await expect(pending).resolves.toBe('allowed-once')
    expect(finalized).toEqual([{ status: 'allowed', operatorName: '张三' }])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(finalized).toEqual([{ status: 'allowed', operatorName: '张三' }])
  } finally {
    vi.useRealTimers()
  }
})

test('approvalTimeoutMs=0：关闭超时，不启动定时器（advance 很久仍挂起）', async () => {
  vi.useFakeTimers()
  try {
    const { sessions, presented, finalized, center } = harness({ timeoutMs: 0 })
    sessions.set('s1', fakeRt('s1'))
    const tracker = track(center.handleRequest(ask('s1')))
    await flush()
    expect(presented).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(tracker.done).toBe(false)
    expect(finalized).toHaveLength(0)
  } finally {
    vi.useRealTimers()
  }
})
