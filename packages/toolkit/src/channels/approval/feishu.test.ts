import { describe, expect, test, vi } from 'vitest'
import { buildApprovalCardJson, buildApprovalFinalCardJson, FeishuApprovalPresenter } from './feishu.ts'
import type { FeishuApi } from '../feishu/api.ts'

const PROMPT = { key: 'k1', chatId: 'oc_chat1', botName: '评审', toolName: 'write', reason: '需要写入文件' }

test('审批卡 JSON：markdown 正文 + 允许/拒绝按钮，value 编码 key 与 decision', () => {
  const card = JSON.parse(buildApprovalCardJson(PROMPT))
  expect(card.schema).toBe('2.0')
  const body = JSON.stringify(card.body)
  expect(body).toContain('评审')
  expect(body).toContain('write')
  expect(body).toContain('需要写入文件')
  // card JSON 2.0 无 action 容器（200861）：按钮作为 body 直接子元素。
  const buttons = card.body.elements.filter((e: { tag: string }) => e.tag === 'button')
  expect(buttons).toHaveLength(2)
  expect(buttons[0]).toMatchObject({ tag: 'button', type: 'primary', behaviors: [{ type: 'callback', value: { key: 'k1', decision: 'allow' } }] })
  expect(buttons[1]).toMatchObject({ tag: 'button', type: 'danger', behaviors: [{ type: 'callback', value: { key: 'k1', decision: 'reject' } }] })
})

test('终态卡 JSON：无按钮，状态文案区分允许/拒绝/取消', () => {
  const allowed = JSON.stringify(JSON.parse(buildApprovalFinalCardJson(PROMPT, 'allowed', '张三')))
  expect(allowed).toContain('已允许')
  expect(allowed).toContain('张三')
  expect(allowed).not.toContain('"button"')
  expect(JSON.stringify(JSON.parse(buildApprovalFinalCardJson(PROMPT, 'rejected')))).toContain('已拒绝')
  expect(JSON.stringify(JSON.parse(buildApprovalFinalCardJson(PROMPT, 'cancelled')))).toContain('已取消')
})

function fakeApi(overrides: Partial<FeishuApi> = {}) {
  return {
    calls: [] as string[],
    createCard: vi.fn(async () => 'card_1'),
    sendCardMessage: vi.fn(async () => undefined),
    replaceCard: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as FeishuApi & { calls: string[] }
}

test('present = 建卡 + 发消息（withRetry 包裹）；finalize = replaceCard sequence 1', async () => {
  const api = fakeApi()
  const presenter = new FeishuApprovalPresenter(api, () => undefined)
  const presentation = await presenter.present(PROMPT)
  expect(api.createCard).toHaveBeenCalledTimes(1)
  expect(api.sendCardMessage).toHaveBeenCalledWith('oc_chat1', 'card_1')
  await presentation.finalize('allowed', '张三')
  expect(api.replaceCard).toHaveBeenCalledWith('card_1', expect.any(String), 1)
})

test('建卡失败：错误传播（ApprovalCenter 回退 next 的前提）', async () => {
  const api = fakeApi({ createCard: vi.fn(async () => { throw new Error('cardkit boom') }) })
  const presenter = new FeishuApprovalPresenter(api, () => undefined)
  await expect(presenter.present(PROMPT)).rejects.toThrow('cardkit boom')
})
