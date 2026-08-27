/** delegate 模块：注册表驱动的 team_delegate 委派工具 + 函数式团队提示段。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { AgentRecord } from '../agents/store.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import { buildAgentPersona } from '../prompt/persona.ts'
import type { LayerConfig, Rule } from '../prompt/types.ts'
import { createDelegateTool } from './tool.ts'

export type { DelegateToolDeps } from './tool.ts'
export { createDelegateTool } from './tool.ts'

/** 团队名册段在 prompt 中的位置：紧随内置 subagent 段（116.5）之后。 */
const TEAM_SECTION_ORDER = 116.6

export interface DelegateConfig {
  /** ctx.subagents provider 名（默认 'spawn'）。 */
  provider: string
  /** 模型可见工具名（默认 'team_delegate'）。注意：浏览器半委派卡按 'team_delegate' key 注册，改名后卡片不生效（落 generic 兜底）。 */
  toolName: string
  /** persona 装配用的全局提示分层（Task 7 产物）。 */
  getLayers: () => LayerConfig[]
  /** 按模型规则（Task 7 产物）。 */
  rules: Rule[]
}

/**
 * 挂载 team_delegate 工具与函数式团队提示段。
 * provider 能力守卫与生命周期镜像同归档 tool-subagent：persona/depthLimit 缺失响亮报错，
 * 工具随 provider 在场与否挂载/摘除。名册来自注册表（main 排除），工具与提示段都经
 * 闭包读取 registry，UI 改角色后新会话即生效。
 */
export function setupDelegate(ctx: Context, config: DelegateConfig, registry: AgentRegistry): void {
  const { provider, toolName } = config
  let disposeTool: (() => void) | undefined
  let providerFailed = false
  const mountTool = (p: SubagentProvider): void => {
    const missing: string[] = []
    if (!p.capabilities.persona) missing.push('persona')
    if (!p.capabilities.depthLimit) missing.push('depthLimit')
    if (missing.length > 0) {
      throw new Error(
        `dsh-agent-toolkit: provider "${p.name}" 缺少 team_delegate 委派必需能力 ${missing.join('/')}（固定发送 persona 与 maxDepth:1）——请配置具备 persona 与 depthLimit 能力的 provider（如 spawn/fork）`,
      )
    }
    if (disposeTool === undefined) {
      disposeTool = ctx.tools.register(createDelegateTool(toolName, {
        roster: () => registry.list(),
        provider,
        buildPersona: (role: AgentRecord) =>
          buildAgentPersona({ getLayers: config.getLayers, rules: config.rules }, role, role.model),
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
    ctx.logger.info(`dsh-agent-toolkit: subagent provider "${provider}" 尚未注册；team_delegate 将等它出现时挂载`)
  }
  ctx.systemPrompt.section({
    name: 'plugin:dsh-agent-toolkit:team',
    order: TEAM_SECTION_ORDER, // 紧随内置 subagent 段（116.5）之后，同归档 agent-team
    text: () => {
      const roles = registry.list().filter(r => r.id !== 'main')
      const rosterText = roles.map(r => `${r.id}: ${r.description ?? r.name}`).join('\n')
      return `你有一组可委派的成员：用 ${config.toolName} 把自包含的子任务委派给合适的成员，成员结果会作为工具返回值回到本对话。\n可用成员：\n${rosterText}`
    },
  })
}
