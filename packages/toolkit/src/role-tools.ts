/** 角色工具白名单组合行：在角色 preset 的作用域内 restrict 全局工具面。
 *  0.2.1 起 SubagentStartRequest.toolFilter 删除，工具构成由 preset 承载；
 *  本行等价于旧 toolFilter: { allow } 的语义（宿主 tools.restrict 对未知名响亮
 *  报错，调用方须先与全局工具面求交，见 delegate/role-preset.ts）。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-agent-toolkit-role-tools'
export const inject = ['tools']

export interface Config {
  /** 保留可见的全局工具名（其余移除）。 */
  allow: string[]
}

export const Config: z<Config> = z.object({
  allow: z.array(z.string()).required(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.tools.restrict({ allow: config.allow }), 'dsh-agent-toolkit: role-tools restrict')
}
