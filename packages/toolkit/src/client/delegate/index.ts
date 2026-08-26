/** dsh-agent-toolkit 委派卡浏览器半：注册 team_delegate 的 keyed 委派卡 + 文案词典。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
// 触发 dsh-client-locale 对 Context.locale 的声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
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
  // dsh-session (Node half's JsonValue type source) declares the same-named
  // Context.sessions, shadowing the client ISessions type — restore the face
  // the runtime actually serves.
  const sessions = ctx.sessions as unknown as ISessions
  const injected: DelegateCardInjected = {
    openChild(address: SubagentAddress) {
      sessions.openSubagent(address)
    },
  }
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register(
      { name: 'tool.call.toolview', key: 'team_delegate', locale: NS, inject: () => injected },
      DelegateCard,
    ))
}
