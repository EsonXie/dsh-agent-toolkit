/** dsh-agent-toolkit usage 浏览器半：注册会话标题栏 utilities 入口。 */
import type { Context } from '@deepseek-ai/cordis'
// 触发 ui-conversation 对 SlotMap 的声明合并（conversation.session.header.utilities 键）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// 触发 ui-renderer 对 Context.slots 的声明合并（0.1.5 起由 client-runtime 迁入）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UsageEntry } from './entry.tsx'

export function setupUsageClient(ctx: Context): void {
  // inject() 等 slot 被 ui-conversation 声明后再注册，声明消失自动回滚。
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.utilities', id: 'dsh-agent-toolkit:usage', order: 100 },
      UsageEntry,
    ))
}
