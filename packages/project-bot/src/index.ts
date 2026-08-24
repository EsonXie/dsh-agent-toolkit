/** project-bot 插件：项目机器人（飞书渠道）。Task 14 替换为完整组装。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  /** 卡片流式更新节流间隔（毫秒）。 */
  cardUpdateThrottleMs: number
  /** 单张卡片内容字节上限（飞书硬上限 30KB，留余量）。 */
  cardMaxBytes: number
  /** 扫码创建应用的轮询超时（毫秒）。 */
  registerAppTimeoutMs: number
  /** 「处理中」表情回复的 emoji_type。 */
  processingReactionEmoji: string
}

export const Config: z<Config> = z.object({
  cardUpdateThrottleMs: z.number().default(500),
  cardMaxBytes: z.number().default(28_000),
  registerAppTimeoutMs: z.number().default(600_000),
  processingReactionEmoji: z.string().default('OneSecond'),
})

export const name = 'project-bot'

export const inject = ['agents', 'credentials', 'storageDomain', 'tools']

export function apply(_ctx: Context, _config: Config): void {
  // Task 14 填充
}
