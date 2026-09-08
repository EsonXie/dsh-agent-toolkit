import { describe, expect, test, vi } from 'vitest'
import { createApprovalAnswerer } from './answerer.ts'
import type { ApprovalCenter, ApprovalOutcome, ApprovalRequestLike } from './center.ts'

const REQ: ApprovalRequestLike = { agent: { session: { id: 's1' } }, toolName: 'write' }

function fakeCenter(outcome: ApprovalOutcome | undefined): ApprovalCenter {
  return { handleRequest: vi.fn(async () => outcome) } as unknown as ApprovalCenter
}

test('center 缺席（runtime 未启动）→ next 透传', async () => {
  const answerer = createApprovalAnswerer(() => undefined)
  const next = vi.fn(async () => 'unavailable' as const)
  expect(await answerer(REQ, next)).toBe('unavailable')
  expect(next).toHaveBeenCalledTimes(1)
})

test('center 返回 undefined（非自有会话/发卡失败）→ next 透传', async () => {
  const answerer = createApprovalAnswerer(() => fakeCenter(undefined))
  const next = vi.fn(async () => 'unavailable' as const)
  expect(await answerer(REQ, next)).toBe('unavailable')
})

test('center 给出结果 → 直接返回，不调 next（飞书独占语义）', async () => {
  const answerer = createApprovalAnswerer(() => fakeCenter('allowed-once'))
  const next = vi.fn(async () => 'unavailable' as const)
  expect(await answerer(REQ, next)).toBe('allowed-once')
  expect(next).not.toHaveBeenCalled()
})
