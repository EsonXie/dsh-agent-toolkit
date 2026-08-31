/** @dsh-agent-toolkit/token-usage 插件入口：per-day token 用量统计（/token-usage 命令 + JSON API + 侧边栏面板）。 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only 激活对应包对 cordis Context 的声明合并（inject 的 service 属性）。
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { setupUsage } from './usage/index.ts'

export const name = '@dsh-agent-toolkit/token-usage'

// 硬依赖服务全集。webServer 为可选服务（经 registerOptionalRoutes 惰性等待），不进 inject。
export const inject = ['storageDomain', 'tokenMeter', 'commands']

/** 插件配置输出型。 */
export interface Config {
  timezone: string
}

export const Config: z<unknown, Config> = z.object({
  timezone: z.string().default('Asia/Shanghai'),
}) as z<unknown, Config>

export function apply(ctx: Context, config: Config): void {
  setupUsage(ctx, { timezone: config.timezone })
}

// 供 dsh-agent-toolkit 函数级转发复用（见设计 spec「toolkit 集成方式」）。
export { setupUsage } from './usage/index.ts'
