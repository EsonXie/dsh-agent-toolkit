/** 子会话头部 chip 注册：conversation.session.header.utilities 槽位（list/session scope）。 */
import type { Context } from '@deepseek-ai/cordis'
// 触发 dsh-client-ui-conversation 的 SlotMap 声明合并（本文件调用 slots.register 需要槽位类型可见）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from '../delegate/locales.ts'
import { SubagentModelChip } from './SubagentModelChip.tsx'

export function setupSubagentModelClient(ctx: Context): void {
  // 词典由 setupDelegateClient 统一注册（同 NS 'agent-team'），此处不重复注册。
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.utilities', id: 'subagent-model', order: 10, locale: NS },
      SubagentModelChip,
    ))
}
