/** card.action.trigger 回调解析：SDK normalizeCardAction → 渠道无关 CardActionInput；toast 应答帧负载。 */
import * as lark from '@larksuiteoapi/node-sdk'
import type { CardActionAck, CardActionInput } from '../approval/center.ts'

/** raw → CardActionInput；normalize 失败（畸形/缺字段）→ undefined。 */
export function toCardActionInput(raw: unknown): CardActionInput | undefined {
  // SDK normalizeCardAction 对 null 直取 event.context 会抛 TypeError；先挡掉非对象输入。
  if (raw === null || typeof raw !== 'object') return undefined
  const evt = lark.normalizeCardAction(raw as lark.RawCardActionEvent)
  if (evt === null) return undefined
  // normalizeCardAction 丢弃 form_value：form 提交回调的值从 raw 直取。
  const formValue = (raw as { action?: { form_value?: unknown } }).action?.form_value
  return {
    chatId: evt.chatId,
    operatorOpenId: evt.operator.openId,
    ...(evt.operator.name !== undefined ? { operatorName: evt.operator.name } : {}),
    value: evt.action.value,
    ...(formValue !== null && typeof formValue === 'object' && !Array.isArray(formValue)
      ? { formValue: formValue as Record<string, unknown> } : {}),
  }
}

/** WS 应答帧负载：handler 返回值经 WSClient 回传（lib/index.js handleEventData：truthy result → respPayload.data）。 */
export function toastResponse(ack: CardActionAck | undefined): { toast: { type: 'info'; content: string } } | undefined {
  if (ack?.toast === undefined) return undefined
  return { toast: { type: 'info', content: ack.toast } }
}
