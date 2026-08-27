/** dsh-agent-toolkit 分层提示词浏览器半：注册侧边栏底栏入口。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { PromptLayersEntry } from './entry.tsx'

export function setupPromptClient(ctx: Context): void {
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'dsh-agent-toolkit:prompt-layers', order: 0 },
      PromptLayersEntry,
    ))
}
