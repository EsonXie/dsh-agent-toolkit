import { randomUUID } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { ApprovalCenter, type ApprovalPresentation, type ApprovalPrompt, type ApprovalRequestLike } from './center.ts'
import type { SessionRuntime } from '../ports.ts'

function fakeRt(sessionId: string, botId = 'reviewer', initiatorOpenId = 'ou_initiator'): SessionRuntime {
  return {
    botId, chatId: 'oc_chat1', sessionId, initiatorOpenId,
    agent: { sessionId, followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined },
    reply: undefined, inflight: undefined, tail: Promise.resolve(), turn: undefined, retiring: false,
  }
}

function harness(opts: { presentError?: Error } = {}) {
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
  )
  return { sessions, warns, presented, finalized, center }
}

function ask(sessionId: string, signal?: AbortSignal): ApprovalRequestLike {
  return { agent: { session: { id: sessionId } }, toolName: 'write', reason: '需要写入文件', ...(signal !== undefined ? { signal } : {}) }
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
