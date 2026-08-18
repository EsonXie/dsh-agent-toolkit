/** token-usage 插件 Node 半：占位桩，Task 7 装配完整逻辑。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  timezone: string
}

export const Config: z<Config> = z.object({
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'),
})

export const name = 'token-usage'

export const inject = ['storageDomain', 'tokenMeter', 'commands']

export function apply(_ctx: Context, _config: Config): void {}
