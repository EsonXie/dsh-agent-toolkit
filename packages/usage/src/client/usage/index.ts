/** dsh-agent-toolkit usage 浏览器半：注册侧边栏底栏入口。 */
import type { Context } from '@deepseek-ai/cordis'
// 触发 ui-sidebar 对 SlotMap 的声明合并（sidebar.footer.action 键）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { UsageEntry } from './entry.tsx'

export function setupUsageClient(ctx: Context): void {
  // inject() 等 slot 被 ui-sidebar 声明后再注册，声明消失自动回滚。
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'dsh-agent-toolkit:usage', order: 0 },
      UsageEntry,
    ))
}
