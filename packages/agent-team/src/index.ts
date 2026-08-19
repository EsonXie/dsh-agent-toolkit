/** agent-team 插件：团队 = preset 内 teams/ 名册，主 Agent 经 team_delegate 一次性委派角色成员。 */
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { defineDomain, domainTable, type Domain, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import { buildMemberPersona } from './prompt.ts'
import { loadTeams, type Team } from './roles.ts'
import { createTeamState, isSessionBlank, teamOption, type TeamState } from './teams.ts'
import { createDelegateTool } from './tool.ts'
import type { SelectTeamRequest, TeamStateView } from './types.ts'

export const name = 'agent-team'

export const inject = ['tools', 'subagents', 'systemPrompt', 'storageDomain', 'sessions']

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
  /** cordis.yml 全局挂载用：true 时 Node 半立即返回，仅让浏览器半 bundle 进 boot 清单。 */
  clientOnly?: boolean
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
  clientOnly: z.boolean(),
  promptTemplates: z.object({
    default: z.string(),
    families: z.dict(z.string()),
  }),
})

/** 团队选择存储域：key = sessionId，value = teamId。domain 名受 ^[a-z][a-z0-9_]*$ 约束（禁用连字符）。 */
const teamDomain = defineDomain({
  name: 'agent_team',
  version: 1,
  tables: { selected_team: domainTable<string, string>(zod.string()) },
})

type TeamDomain = Domain<typeof teamDomain>

// storage-domain 的 DomainFacility 是宿主平面单例，同一 domain 名二次 open 抛
// already-open（storage-domain/src/index.ts:101-103）。插件按 preset 代共享、跨会话单例
// 挂载（standing scope），但多个 preset / HMR 替换可能并发挂载，故模块级缓存首个 open 的
// Promise 并引用计数；最后一次挂载卸载才 close，并重置缓存让下一次挂载重新 open。
let openPromise: Promise<TeamDomain> | undefined
let openDomain: TeamDomain | undefined
let openRefs = 0

/** 获取共享 domain：首次调用 open，后续复用同一 Promise；await 成功后 +1 引用。 */
async function acquireTeamDomain(ctx: Context): Promise<TeamDomain> {
  if (openPromise === undefined) {
    openPromise = ctx.storageDomain.open(teamDomain).then(
      (domain) => { openDomain = domain; return domain },
      (error) => { openPromise = undefined; throw error },
    )
  }
  const domain = await openPromise
  openRefs++
  return domain
}

/** 释放一份引用（对应一次成功挂载）；归零时 close 并重置缓存。 */
async function releaseTeamDomain(): Promise<void> {
  if (openRefs === 0) return
  openRefs--
  if (openRefs === 0) {
    const domain = openDomain
    openDomain = undefined
    openPromise = undefined
    if (domain !== undefined) await domain.close()
  }
}

/** 把 teamsDir 解析为绝对路径：绝对路径原样，相对路径基于 preset 目录（ctx.baseUrl）。 */
function resolveTeamsPath(teamsDir: string, baseUrl: string | undefined): string {
  if (isAbsolute(teamsDir)) return teamsDir
  if (baseUrl === undefined) {
    throw new Error('agent-team: 无法解析相对 teamsDir——ctx.baseUrl 为空（插件应由 preset 挂载）')
  }
  return fileURLToPath(new URL(teamsDir, baseUrl))
}

/** 当前团队视图：GET/POST 的响应体。 */
function viewOf(state: TeamState): TeamStateView {
  return { currentId: state.current.id, options: state.teams.map(teamOption) }
}

/** 读 POST 请求的 JSON body；解析失败返回 undefined。 */
async function readJsonBody(req: AsyncIterable<unknown>): Promise<unknown> {
  const chunks: string[] = []
  for await (const chunk of req) chunks.push(String(chunk))
  try {
    return JSON.parse(chunks.join(''))
  } catch {
    return undefined
  }
}

/**
 * 最小结构化 res 类型：writeHead 返回自身以支持链式（Node ServerResponse 同款）。
 * 与 token-usage 一致按结构化最小类型声明 handler 的 req/res。
 */
type RouteRes = {
  writeHead(status: number, headers?: Record<string, string>): RouteRes
  end(chunk?: string): unknown
}

/**
 * 注册一条 prefix 路由：`/agent-team` 及其任意子路径（最长前缀优先），handler 自解析
 * `<sessionId>/state|select`。standing 实例跨会话共享，无法按会话注册 exact 路由。
 * webServer 是可选能力（headless 无此服务），走 ctx.inject 条件注册。
 * 信任边界：与 token-usage 端点一致，端点不做认证——sessionId 是不可猜测的不透明 id，
 * POST /select 仅在会话 blank 期改写团队选择；镜像宿主 webserver 的本地-only 信任模型。
 */
function installTeamRoutes(
  ctx: Context,
  stateFor: (sid: string) => TeamState,
  table: KvTable<string, string>,
): void {
  ctx.inject(['webServer'], (webCtx: Context) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/agent-team',
      handler: async (req: { method?: string; url?: string } & AsyncIterable<unknown>, res: RouteRes) => {
        const pathname = new URL(req.url ?? '', 'http://localhost').pathname
        const rest = pathname.startsWith('/agent-team/') ? pathname.slice('/agent-team/'.length) : ''
        const slash = rest.indexOf('/')
        if (rest === '' || slash < 0) { res.writeHead(404).end(); return }
        const sid = decodeURIComponent(rest.slice(0, slash))
        const action = rest.slice(slash + 1)
        const fail = (status: number, error: string) =>
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error }))
        if (action === 'state' && req.method === 'GET') {
          const state = stateFor(sid)
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(viewOf(state)))
          return
        }
        if (action === 'select' && req.method === 'POST') {
          const body = await readJsonBody(req)
          const team = (body as Partial<SelectTeamRequest> | undefined)?.team
          if (typeof team !== 'string') { fail(400, '请求体缺 team 字段或不是 JSON'); return }
          // blank 判定经 ctx.sessions 读会话事件；会话不存在按 blank 处理（尚无事件）。
          const events: readonly SessionEvent[] | undefined = ctx.sessions.get(SessionId(sid))?.events
          if (!isSessionBlank(events ?? [])) { fail(409, '会话已开始，团队已锁定'); return }
          const state = stateFor(sid)
          const prevId = state.current.id
          const outcome = state.trySelect(team, events ?? [])
          if (!outcome.ok) { fail(400, outcome.error); return }
          if (outcome.changed) {
            // 先落盘（提交点）再发布：put 失败时回滚状态机，返回非 2xx。
            try {
              await table.put(sid, team)
            } catch (error) {
              if (state.current.id !== prevId) state.trySelect(prevId, events ?? [])
              fail(500, `团队切换持久化失败：${error instanceof Error ? error.message : String(error)}`)
              return
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(viewOf(state)))
          return
        }
        res.writeHead(404).end()
      },
    }), 'agent-team: http route')
  })
}

/**
 * 激活（standing scope，按 preset 代共享）：读名册 → 取共享 KV → 建按 sessionId 懒建的
 * TeamState Map → 单次注册 team_delegate 工具、prefix 路由与动态团队段。
 * 直接 apply() 绕过 Schemastery 默认值，这里手动补默认（内置 tool-subagent 同款防御）。
 * teams/ 缺失/非法、defaultTeam 未命中或 storageDomain 打开失败时抛错：fiber FAILED，
 * preset 挂载被拒（真实原因见 chip hover title / select RPC reason）。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.clientOnly === true) return // 全局挂载点：仅让浏览器半 bundle 进 boot 清单
  const teamsDir = config.teamsDir ?? './teams'
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'team_delegate'
  const teams = await loadTeams(resolveTeamsPath(teamsDir, ctx.baseUrl))
  if (config.defaultTeam !== undefined && !teams.some(t => t.id === config.defaultTeam)) {
    throw new Error(`agent-team: defaultTeam "${config.defaultTeam}" 不在名册中（可用：${teams.map(t => t.id).join(', ')}）`)
  }
  const domain = await acquireTeamDomain(ctx)
  const table: KvTable<string, string> = domain.table('selected_team')
  ctx.effect(() => releaseTeamDomain)
  // 每会话 TeamState，首次触碰（HTTP/工具/prompt 段）惰性创建：KV 命中 ?? defaultTeam ?? 字典序首个。
  const states = new Map<string, TeamState>()
  const stateFor = (sid: string): TeamState => {
    let state = states.get(sid)
    if (state === undefined) {
      state = createTeamState({
        teams,
        defaultTeamId: config.defaultTeam,
        initialId: table.get(sid),
      })
      states.set(sid, state)
    }
    return state
  }
  const currentTeamFor = (agent: Agent): Team => stateFor(String(agent.session.id)).current
  // team_delegate 固定发送 persona 与 maxDepth:1（tool.ts），两者分别要求 provider 具备
  // persona / depthLimit 能力；缺失时每次委派都在运行时失败，故在最早可得的挂载点响亮
  // 报错（内置 tool-subagent 同款：tool-subagent/src/index.ts:283-292）。同时镜像 provider
  // 生命周期：兄弟 fiber 加载顺序与 HMR 替换都可能改变 provider 可用性，工具随 provider
  // 在场与否挂载/摘除；工具注册一次、跨会话共享，切换团队不重注册。
  let disposeTool: (() => void) | undefined
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
        currentTeamFor,
        provider,
        templates: config.promptTemplates,
        startRun: (p, request) => ctx.subagents.start(p, request),
      }))
    }
  }
  ctx.on('subagent/provider-added', (p) => {
    if (p.name === provider) mountTool(p)
  })
  ctx.on('subagent/provider-removed', (name) => {
    if (name !== provider || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })
  const present = ctx.subagents.getProvider(provider)
  if (present !== undefined) {
    mountTool(present)
  } else {
    ctx.logger.info(`agent-team: subagent provider "${provider}" 尚未注册；team_delegate 将等它出现时挂载`)
  }
  installTeamRoutes(ctx, stateFor, table)
  ctx.on('session/disposed', (session) => {
    states.delete(String(session.id))
  })
  ctx.systemPrompt.section({
    name: `plugin:${name}`,
    order: TEAM_SECTION_ORDER,
    // 动态名册：按组装上下文中的 agent 求值（名册对模型的可见性不走工具 schema 管道）。
    // agent 缺省（非 agent 组装场景）返回通用介绍，不抛错。
    text: (context: AssembleContext): string => {
      const agent = context.agent
      if (agent === undefined) {
        return `你有一个团队可用：用 ${toolName} 把自包含的子任务委派给合适的成员，成员结果会作为工具返回值回到本对话。`
      }
      const state = stateFor(String(agent.session.id))
      const roster = state.current.roles.map(r => `${r.name}: ${r.description}`).join('\n')
      return `你有一个团队可用：用 ${toolName} 把自包含的子任务委派给合适的成员，成员结果会作为工具返回值回到本对话。\n当前团队：${state.current.id}\n可用成员：\n${roster}`
    },
  })
}

// buildMemberPersona 仅经 tool.ts 使用；此处再导出便于宿主/调试方直接复用。
export { buildMemberPersona }
