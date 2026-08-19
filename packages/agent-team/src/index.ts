/** agent-team 插件：团队 = preset 内 teams/ 名册，主 Agent 经 team_delegate 一次性委派角色成员。 */
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only 激活对应包对 cordis Context 的声明合并（inject 的 service 属性）。
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { buildMemberPersona } from './prompt.ts'
import { loadTeams, type Team } from './roles.ts'
import { createTeamState, foldSelectedTeam, teamOption, type TeamState } from './teams.ts'
import { createDelegateTool } from './tool.ts'
import { TEAM_SELECTED_EVENT, type TeamProjection } from './types.ts'

export const name = 'agent-team'

export const inject = ['tools', 'subagents', 'systemPrompt']

/** 团队介绍段在 prompt 中的位置：紧随内置 subagent 段（116.5）之后。 */
const TEAM_SECTION_ORDER = 116.6

export interface Config {
  /** teams 目录路径，相对 preset 目录（默认 './teams'）。 */
  teamsDir?: string
  /** 默认团队 id；缺省取 teams/ 下文件名字典序第一个。未命中名册时激活失败。 */
  defaultTeam?: string
  /** ctx.subagents provider 名（默认 'spawn'）。 */
  provider?: string
  /** 模型可见工具名（默认 'team_delegate'）。 */
  toolName?: string
  /** C 段模型适配模板覆盖。 */
  promptTemplates?: {
    default?: string
    families?: Record<string, string>
  }
}

export const Config: z<Config> = z.object({
  teamsDir: z.string().default('./teams'),
  defaultTeam: z.string(),
  provider: z.string().default('spawn'),
  toolName: z.string().default('team_delegate'),
  promptTemplates: z.object({
    default: z.string(),
    families: z.dict(z.string()),
  }),
})

/** team 投影的 wire schema（zod，permission-presets/token-usage 先例）。 */
const TeamProjectionSchema = zod.object({
  currentId: zod.string(),
  options: zod.array(zod.object({ id: zod.string(), summary: zod.string() })),
}) as unknown as zod.ZodType<TeamProjection>

/** 把 teamsDir 解析为绝对路径：绝对路径原样，相对路径基于 preset 目录（ctx.baseUrl）。 */
function resolveTeamsPath(teamsDir: string, baseUrl: string | undefined): string {
  if (isAbsolute(teamsDir)) return teamsDir
  if (baseUrl === undefined) {
    throw new Error('agent-team: 无法解析相对 teamsDir——ctx.baseUrl 为空（插件应由 preset 挂载）')
  }
  return fileURLToPath(new URL(teamsDir, baseUrl))
}

/** 激活时读会话事件（冷恢复 fold 用）；agent scope 的实际属性名以 cordis 类型为准微调。 */
function sessionEventsOf(ctx: Context): readonly SessionEvent[] {
  const agent = (ctx as { agent?: { session?: { events?: readonly SessionEvent[] } } }).agent
  return agent?.session?.events ?? []
}

/** 以指定团队注册 team_delegate，返回 disposer（切换时先 dispose 再重注册）。 */
function registerDelegateTool(ctx: Context, toolName: string, provider: string, team: Team, config: Config): () => void {
  return ctx.tools.register(createDelegateTool(toolName, {
    roles: team.roles,
    provider,
    templates: config.promptTemplates,
    startRun: (p, request) => ctx.subagents.start(p, request),
  }))
}

/** 注册 /team 命令与 team 投影（服务仅在对应注册表被组合时存在，故走条件 inject）。 */
function installTeamSwitch(ctx: Context, state: TeamState, reinstall: () => void): void {
  ctx.inject(['commands'], (commandCtx: Context) => {
    commandCtx.commands.register({
      name: 'team',
      description: '切换当前团队（仅会话开始前可用）',
      input: { hint: '<team>' },
      handler: ({ agent, rawInput }: CommandInvocation) => {
        const id = rawInput.trim()
        if (id === '') {
          return { kind: 'success' as const, text: `当前团队 ${state.current.id}（可用：${state.teams.map(t => t.id).join(', ')}）` }
        }
        const outcome = state.trySelect(id, agent.session.events)
        if (!outcome.ok) return { kind: 'error' as const, text: outcome.error }
        if (outcome.changed) {
          reinstall()
          agent.session.append(TEAM_SELECTED_EVENT, { team: id })
        }
        return { kind: 'success' as const, text: `团队 ${id}` }
      },
    })
  })
  ctx.inject(['sessionProjections'], (projectionCtx: Context) => {
    projectionCtx.sessionProjections.register({
      key: 'team',
      schema: TeamProjectionSchema,
      init: (): TeamProjection => ({ currentId: state.current.id, options: state.teams.map(teamOption) }),
      apply: (projection: TeamProjection, event: SessionEvent): TeamProjection =>
        event.type === TEAM_SELECTED_EVENT
          ? { ...projection, currentId: (event.data as { team: string }).team }
          : projection,
      view: (projection: TeamProjection) => projection,
      stateVersion: 1,
    })
  })
}

/**
 * 激活：读名册 → 建团队状态（冷恢复 fold）→ 注册委派工具、/team 命令、team 投影与团队介绍段。
 * 直接 apply() 绕过 Schemastery 默认值，这里手动补默认（内置 tool-subagent 同款防御）。
 * teams/ 缺失/非法或 defaultTeam 未命中时抛错：fiber FAILED，preset 挂载被拒并标记 broken。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const teamsDir = config.teamsDir ?? './teams'
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'team_delegate'
  const teams = await loadTeams(resolveTeamsPath(teamsDir, ctx.baseUrl))
  if (config.defaultTeam !== undefined && !teams.some(t => t.id === config.defaultTeam)) {
    throw new Error(`agent-team: defaultTeam "${config.defaultTeam}" 不在名册中（可用：${teams.map(t => t.id).join(', ')}）`)
  }
  const state = createTeamState({
    teams,
    defaultTeamId: config.defaultTeam,
    initialId: foldSelectedTeam(sessionEventsOf(ctx)),
  })
  let disposeTool = registerDelegateTool(ctx, toolName, provider, state.current, config)
  installTeamSwitch(ctx, state, () => {
    disposeTool()
    disposeTool = registerDelegateTool(ctx, toolName, provider, state.current, config)
  })
  ctx.systemPrompt.section({
    name: `plugin:${name}`,
    order: TEAM_SECTION_ORDER,
    text: `你有一个团队可用：用 ${toolName} 把自包含的子任务委派给合适的成员，成员结果会作为工具返回值回到本对话。`,
  })
}

// buildMemberPersona 仅经 tool.ts 使用；此处再导出便于宿主/调试方直接复用。
export { buildMemberPersona }
