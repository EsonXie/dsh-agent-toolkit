/** dsh-agent-toolkit 委派卡浏览器半：注册 team_delegate 的 keyed 委派卡 + 文案词典。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
// 触发 dsh-client-locale 对 Context.locale 的声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 触发 ui-renderer 对 Context.slots 的声明合并（0.1.5 起由 client-runtime 迁入）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// 触发 ui-workspace 对 Context.uiWorkspace 的声明合并（0.1.7 起会话导航由 view owner 承担）。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { DelegateCard, type DelegateCardInjected } from './delegate-card.tsx'
import { en, NS, zh, type AgentTeamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 委派卡文案。 */
    'agent-team': AgentTeamKey
  }
}

/**
 * 注册委派卡。委派卡按固定 key 'team_delegate' 注册：Node 半 Config.toolName
 * 改名后卡片不生效（落 generic 兜底）。
 */
export function setupDelegateClient(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agent-toolkit: dictionaries')
  const injected: DelegateCardInjected = {
    openChild(address: SubagentAddress) {
      ctx.uiWorkspace.openSession(address)
    },
  }
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register(
      { name: 'tool.call.toolview', key: 'team_delegate', locale: NS, inject: () => injected },
      DelegateCard,
    ))
}
