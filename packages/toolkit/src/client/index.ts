/** dsh-agent-toolkit 浏览器半：委派卡 + Agents/Bots/Usage 四面板入口。 */
import type { Context } from '@deepseek-ai/cordis'
import { setupDelegateClient } from './delegate/index.ts'
import { setupSubagentModelClient } from './subagent-model/index.ts'
import { setupAgentsClient } from './agents/index.ts'
import { setupPromptClient } from './prompt/index.ts'
import { setupUsageClient } from '@dsh-agent-toolkit/token-usage/client-module'
import { setupBotsClient } from './bots/index.ts'

export const inject = ['sessions', 'slots', 'locale']

export function apply(ctx: Context): void {
  setupDelegateClient(ctx)
  setupSubagentModelClient(ctx)
  setupAgentsClient(ctx)
  setupPromptClient(ctx)
  try {
    setupUsageClient(ctx)
  } catch (error) {
    // 双装：独立包 @dsh-agent-toolkit/token-usage 已注册同一侧边栏入口 id，slots 重复
    // id 抛错——本包停用用量面板，不向上抛以免拖垮整个浏览器半（其余面板照常注册）。
    console.warn('[dsh-agent-toolkit] 侧边栏「Token 用量」入口已由独立包 @dsh-agent-toolkit/token-usage 注册，本包停用用量面板', error)
  }
  setupBotsClient(ctx)
}
