import { expect, test, vi } from 'vitest'
import { createQuestionAnswerer } from './answerer.ts'
import type { QuestionAnswerLike, QuestionCenter, QuestionRequestLike } from './center.ts'

const REQ: QuestionRequestLike = { agent: { session: { id: 's1' } }, questions: [{ id: 'q1', question: '选哪个？' }] }
const ANSWER: QuestionAnswerLike = { answers: [{ id: 'q1', selected: ['甲'] }] }

function fakeCenter(outcome: QuestionAnswerLike | undefined): QuestionCenter {
  return { handleRequest: vi.fn(async () => outcome) } as unknown as QuestionCenter
}

test('center 缺席（runtime 未启动）→ next 透传', async () => {
  const answerer = createQuestionAnswerer(() => undefined)
  const next = vi.fn(async () => ANSWER)
  expect(await answerer(REQ, next)).toBe(ANSWER)
  expect(next).toHaveBeenCalledTimes(1)
})

test('center 返回 undefined（非自有会话/发卡失败）→ next 透传', async () => {
  const answerer = createQuestionAnswerer(() => fakeCenter(undefined))
  const next = vi.fn(async () => ANSWER)
  expect(await answerer(REQ, next)).toBe(ANSWER)
  expect(next).toHaveBeenCalledTimes(1)
})

test('center 给出答案 → 直接返回，不调 next（飞书独占语义）', async () => {
  const answerer = createQuestionAnswerer(() => fakeCenter(ANSWER))
  const next = vi.fn(async () => ANSWER)
  expect(await answerer(REQ, next)).toEqual(ANSWER)
  expect(next).not.toHaveBeenCalled()
})

test('center 抛错（abort）→ 错误上抛，不透传 next', async () => {
  const center = {
    handleRequest: vi.fn(async () => {
      throw Object.assign(new Error('ask_user_question was aborted before the user answered'), { name: 'UserQuestionError', code: 'ASK_ABORTED' })
    }),
  } as unknown as QuestionCenter
  const answerer = createQuestionAnswerer(() => center)
  const next = vi.fn(async () => ANSWER)
  await expect(answerer(REQ, next)).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_ABORTED' })
  expect(next).not.toHaveBeenCalled()
})
