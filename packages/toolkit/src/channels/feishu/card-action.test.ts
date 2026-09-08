import { describe, expect, test } from 'vitest'
import { toCardActionInput, toastResponse } from './card-action.ts'

// 形状对齐 SDK normalizeCardAction 的输入（RawCardActionEvent：context 嵌套 + operator/action）
const RAW = {
  context: { open_message_id: 'om_1', open_chat_id: 'oc_chat1' },
  operator: { open_id: 'ou_initiator', name: '张三' },
  action: { tag: 'button', value: { key: 'k1', decision: 'allow' } },
}

test('raw 卡片回调 → CardActionInput（chatId/operatorOpenId/operatorName/value）', () => {
  expect(toCardActionInput(RAW)).toEqual({
    chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', operatorName: '张三',
    value: { key: 'k1', decision: 'allow' },
  })
})

test('畸形 raw → undefined', () => {
  expect(toCardActionInput(null)).toBeUndefined()
  expect(toCardActionInput({})).toBeUndefined()
  expect(toCardActionInput({ operator: {}, action: { tag: 'button' } })).toBeUndefined()
})

test('toastResponse：有 toast 才产生应答帧负载', () => {
  expect(toastResponse(undefined)).toBeUndefined()
  expect(toastResponse({})).toBeUndefined()
  expect(toastResponse({ toast: '已允许' })).toEqual({ toast: { type: 'info', content: '已允许' } })
})
