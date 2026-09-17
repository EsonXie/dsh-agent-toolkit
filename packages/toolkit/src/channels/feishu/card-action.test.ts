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

test('form 提交回调：raw.action.form_value 透传为 formValue（SDK normalize 丢弃该字段）', () => {
  const raw = {
    context: { open_message_id: 'om_1', open_chat_id: 'oc_chat1' },
    operator: { open_id: 'ou_initiator' },
    action: {
      tag: 'button', name: 'btn_submit',
      value: { kind: 'question', key: 'k1', submit: true },
      form_value: { q0: '红', q1: ['甲', '乙'], q2: '自由文本' },
    },
  }
  expect(toCardActionInput(raw)).toEqual({
    chatId: 'oc_chat1', operatorOpenId: 'ou_initiator',
    value: { kind: 'question', key: 'k1', submit: true },
    formValue: { q0: '红', q1: ['甲', '乙'], q2: '自由文本' },
  })
})

test('无 form_value 的普通按钮回调：不带 formValue 键', () => {
  expect(toCardActionInput(RAW)).not.toHaveProperty('formValue')
})
