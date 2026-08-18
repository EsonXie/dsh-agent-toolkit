/** token-usage 浏览器半：注册会话头按钮。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// 触发 ui-conversation 对 SlotMap 的声明合并（conversation.session.header.actions 键）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { UsageButton } from './UsageButton.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  // inject() 等 slot 被 ui-conversation 声明后再注册，声明消失自动回滚。
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.actions', id: 'token-usage', order: 30 },
      UsageButton,
    ))
}
