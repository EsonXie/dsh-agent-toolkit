/** project-bot 浏览器半：注册侧边栏底栏「消息机器人」入口。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// 触发 ui-sidebar 对 SlotMap 的声明合并（sidebar.footer.action 键）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BotsEntry } from './BotsEntry.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'project-bot', order: 1 },
      BotsEntry,
    ))
}
