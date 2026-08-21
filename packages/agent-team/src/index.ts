/** agent-team 插件：扁平角色名册（内置保底 + 用户目录覆盖），主 Agent 经 team_delegate 一次性委派。 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { resolveRoster } from './roster.ts'
import { createDelegateTool } from './tool.ts'

export const name = 'agent-team'

export const inject = ['tools', 'subagents', 'systemPrompt']

/** 团队名册段在 prompt 中的位置：紧随内置 subagent 段（116.5）之后。 */
const TEAM_SECTION_ORDER = 116.6

export interface Config {
  /** ctx.subagents provider 名（默认 'spawn'）。 */
  provider?: string
  /** 模型可见工具名（默认 'team_delegate'）。注意：浏览器半委派卡按 'team_delegate' key 注册，改名后卡片不生效（落 generic 兜底）。 */
  toolName?: string
  /** cordis.yml 全局挂载用：true 时 Node 半立即返回，仅让浏览器半 bundle 进 boot 清单。 */
  clientOnly?: boolean
}

export const Config: z<Config> = z.object({
  provider: z.string().default('spawn'),
  toolName: z.string().default('team_delegate'),
  clientOnly: z.boolean(),
})

/** 用户级角色目录：$DSH_HOME/agent-team/roles。 */
function userRolesDir(): string {
  return join(resolveDshHome(), 'agent-team', 'roles')
}

/**
 * 激活（standing scope）：解析名册（内置保底 ← 用户目录同名覆盖）→ 注册 team_delegate
 * 与静态名册提示段。名册激活期读一次；改 roles/*.yml 需重挂 preset/重启生效。
 * provider 能力守卫与生命周期镜像同内置 tool-subagent：persona/depthLimit 缺失响亮报错，
 * 工具随 provider 在场与否挂载/摘除。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.clientOnly === true) return
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'team_delegate'
  const roster = await resolveRoster(userRolesDir())
  if (roster.overridden.length > 0) {
    ctx.logger.info(`agent-team: 内置角色被用户级名册覆盖：${roster.overridden.join(', ')}`)
  }
  const rosterText = roster.roles.map(r => `${r.name}: ${r.description}`).join('\n')
  let disposeTool: (() => void) | undefined
  let providerFailed = false
  const mountTool = (p: SubagentProvider): void => {
    const missing: string[] = []
    if (!p.capabilities.persona) missing.push('persona')
    if (!p.capabilities.depthLimit) missing.push('depthLimit')
    if (missing.length > 0) {
      throw new Error(
        `agent-team: provider "${p.name}" 缺少 team_delegate 委派必需能力 ${missing.join('/')}（固定发送 persona 与 maxDepth:1）——请配置具备 persona 与 depthLimit 能力的 provider（如 spawn/fork）`,
      )
    }
    if (disposeTool === undefined) {
      disposeTool = ctx.tools.register(createDelegateTool(toolName, {
        roster: () => roster.roles,
        provider,
        startRun: (pr, request) => ctx.subagents.start(pr, request),
      }))
    }
  }
  ctx.on('subagent/provider-added', (p) => {
    if (p.name !== provider || providerFailed) return
    try {
      mountTool(p)
    } catch (error) {
      providerFailed = true
      ctx.logger.error(error instanceof Error ? error.message : String(error))
    }
  })
  ctx.on('subagent/provider-removed', (removed) => {
    if (removed !== provider) return
    providerFailed = false
    if (disposeTool !== undefined) {
      disposeTool()
      disposeTool = undefined
    }
  })
  const present = ctx.subagents.getProvider(provider)
  if (present !== undefined) {
    mountTool(present)
  } else {
    ctx.logger.info(`agent-team: subagent provider "${provider}" 尚未注册；team_delegate 将等它出现时挂载`)
  }
  ctx.systemPrompt.section({
    name: `plugin:${name}`,
    order: TEAM_SECTION_ORDER,
    text: `你有一组可委派的成员：用 ${toolName} 把自包含的子任务委派给合适的成员，成员结果会作为工具返回值回到本对话。\n可用成员：\n${rosterText}`,
  })
}

// buildMemberPersona 仅经 tool.ts 使用；此处再导出便于宿主/调试方直接复用。
export { buildMemberPersona } from './prompt.ts'
