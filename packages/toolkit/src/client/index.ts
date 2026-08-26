/** dsh-agent-toolkit 浏览器半：委派卡 + Agents/Bots/Usage 三面板入口。 */
import type { Context } from '@deepseek-ai/cordis'
import { setupDelegateClient } from './delegate/index.ts'
import { setupUsageClient } from './usage/index.ts'
import { setupBotsClient } from './bots/index.ts'

export function apply(ctx: Context): void {
  setupDelegateClient(ctx)
  setupUsageClient(ctx)
  setupBotsClient(ctx)
}
