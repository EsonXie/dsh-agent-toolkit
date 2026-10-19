/** 角色 persona 组合行：在角色 preset 的 agent 作用域内注入 deployment:persona-prefix 段。
 *  0.2.1 起子代理 persona 由 agent preset 组合承载（宿主 @deepseek-ai/dsh-persona 同款机制，
 *  自研行避免对宿主包解析的依赖）。prefix 中的 {{…}} 由宿主 systemPrompt 严格插值——
 *  persona 文案禁止出现字面量双花括号。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-agent-toolkit-role-persona'
export const inject = ['systemPrompt']

export interface Config {
  /** persona 正文，渲染为 deployment:persona-prefix 段。 */
  prefix: string
}

export const Config: z<Config> = z.object({
  prefix: z.string().required(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'deployment:persona-prefix',
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: config.prefix,
  }), 'dsh-agent-toolkit: role-persona section')
}
