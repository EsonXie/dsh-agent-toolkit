/** delegate 模块：注册表驱动的 team_delegate 委派工具 + 函数式团队提示段。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { AgentRecord } from '../agents/store.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import { buildAgentPersona } from '../prompt/persona.ts'
import type { Rule } from '../prompt/types.ts'
import { createDelegateTool } from './tool.ts'
import type { ActiveRoutes, DelegateRoute } from './active.ts'

export type { DelegateToolDeps } from './tool.ts'
export { createDelegateTool } from './tool.ts'

/** 团队名册段在 prompt 中的位置：紧随内置 subagent 段（116.5）之后。 */
const TEAM_SECTION_ORDER = 116.6

/**
 * 团队名册段文本：仅当该 agent scope 的可见工具里确有委派工具时渲染，否则空
 * （空段渲染时被丢弃）。工具白名单 restrict 只作用于 tools 视图，名册段必须
 * 自行按 `tools.get(name, scope)` 联动，否则没勾委派的 bot 提示词仍会出现委派段落。
 */
export function teamSectionText(
  toolName: string,
  roles: readonly Pick<AgentRecord, 'id' | 'name' | 'description'>[],
  toolVisible: boolean,
): string {
  if (!toolVisible) return ''
  const rosterText = roles
    .filter(r => r.id !== 'main')
    .map(r => `${r.id}: ${r.description ?? r.name}`)
    .join('\n')
  return `你有一组可委派的成员：用 ${toolName} 把自包含的子任务委派给合适的成员，成员结果会作为工具返回值回到本对话。\n可用成员：\n${rosterText}`
}

export interface DelegateConfig {
  /** ctx.subagents provider 名（默认 'spawn'）。 */
  provider: string
  /** 模型可见工具名（默认 'team_delegate'）。注意：浏览器半委派卡按 'team_delegate' key 注册，改名后卡片不生效（落 generic 兜底）。 */
  toolName: string
  /** 按模型规则（Task 7 产物）。 */
  rules: Rule[]
}

/** setupDelegate 的存储/在途通道（Task 3 DelegateToolDeps 的两个新字段）。 */
export interface DelegateChannels {
  readonly active: ActiveRoutes
  readonly recordRoute: (childSessionId: string, route: DelegateRoute) => Promise<void>
}

/**
 * 挂载 team_delegate 工具与函数式团队提示段。
 * provider 能力守卫与生命周期镜像同归档 tool-subagent：persona/depthLimit 缺失响亮报错，
 * 工具随 provider 在场与否挂载/摘除。名册来自注册表（main 排除），工具与提示段都经
 * 闭包读取 registry，UI 改角色后新会话即生效。
 */
export function setupDelegate(ctx: Context, config: DelegateConfig, registry: AgentRegistry, channels: DelegateChannels): void {
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
          buildAgentPersona({ rules: config.rules }, role, role.model),
        startRun: (pr, request) => ctx.subagents.start(pr, request),
        active: channels.active,
        recordRoute: channels.recordRoute,
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
    text: (context) => teamSectionText(
      config.toolName,
      registry.list(),
      // 该 agent scope 的可见工具里确有委派工具才渲染：被白名单 restrict 掉、或
      // provider 未挂载（工具没注册）的会话不再出现委派段落（tools.get 对被
      // restrict 掉的全局工具返回 absent）。
      ctx.tools.get(config.toolName, context.scope) !== undefined,
    ),
  })
}
