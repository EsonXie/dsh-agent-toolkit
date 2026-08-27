/** dsh-agent-toolkit 浏览器半：委派卡 + Agents/Bots/Usage 四面板入口。 */
import type { Context } from '@deepseek-ai/cordis'
import { setupDelegateClient } from './delegate/index.ts'
import { setupAgentsClient } from './agents/index.ts'
import { setupPromptClient } from './prompt/index.ts'
import { setupUsageClient } from './usage/index.ts'
import { setupBotsClient } from './bots/index.ts'

export const inject = ['sessions', 'slots', 'locale']

export function apply(ctx: Context): void {
  setupDelegateClient(ctx)
  setupAgentsClient(ctx)
  setupPromptClient(ctx)
  setupUsageClient(ctx)
  setupBotsClient(ctx)
}
