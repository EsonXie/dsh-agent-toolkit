/** team_delegate 工具：查角色 → 一次性 spawn 前台委派 → 规范 JSON 返回。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { isTeamVisible, type AgentRecord } from '../agents/store.ts'
import type { ActiveRoutes, DelegateRoute } from './active.ts'

/** createDelegateTool 的外部依赖。 */
export interface DelegateToolDeps {
  /** 当前生效名册（闭包返回同一数组；查找与错误清单均排除 main）。 */
  readonly roster: () => readonly AgentRecord[]
  /** ctx.subagents 的 provider 名（默认 'spawn'）。 */
  readonly provider: string
  /** 成员 persona 装配（生产为 buildAgentPersona，测试注入假实现）。 */
  readonly buildPersona: (role: AgentRecord) => string
  /** 委派入口：生产为 ctx.subagents.start.bind(ctx.subagents)，测试注入假实现。 */
  readonly startRun: (provider: string, request: SubagentStartRequest) => Promise<SubagentRun>
  /** 在途表：运行中委派卡 chip 的数据源。 */
  readonly active: ActiveRoutes
  /** 持久路由写入（子会话头部 chip 数据源）；实现方保证不抛错语义由调用处 catch 兜底。 */
  readonly recordRoute: (childSessionId: string, route: DelegateRoute) => Promise<void>
  /** 父会话真实可见工具面（生产走 scopeOf(agent.ctx) + scoped schemas；测试注入 fake）。 */
  readonly visibleSurface: (agent: Agent) => string[]
  /** 未知名 warn-drop 日志（生产 ctx.logger.warn）。 */
  readonly warn: (msg: string) => void
}

/** 非 completed 的 stopReason 意味着成员未干净完成。 */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return '成员运行被取消'
    case 'error': return '成员运行失败'
    case 'max-tokens': return '成员在结束前触及 token 上限'
    case 'refusal': return '成员拒绝了该任务'
    default: return `成员运行异常结束（${String(result.stopReason)}）`
  }
}

/** 报错时附上成员已产出的部分文本，让截断/取消的真实产出仍回到主 Agent。 */
function withPartialText(error: string, output: ContentBlock[]): string {
  const text = output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\n成员中断前的部分产出：\n${text}`
}

/** 收集并释放一次前台运行；dispose 失败不掩盖独立的结果失败。 */
async function settleForegroundRun(run: SubagentRun, roleId: string, route?: DelegateRoute) {
  // 本地 run 的 run.id 契约上即子 session id（dsh-subagent types.ts:249-255）。
  const childSessionId = String(run.id)
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withPartialText(error, result.output))
      return {
        kind: 'foreground' as const,
        role: roleId,
        runId: String(run.id),
        childSessionId,
        output: result.output as unknown as JsonValue[],
        ...route !== undefined ? { provider: route.provider, model: route.model } : {},
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError([execution.reason, disposal.reason],
        `成员运行失败：${String(execution.reason)}；dispose 失败：${String(disposal.reason)}`)
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * 创建 team_delegate 工具。
 * @param toolName - 模型可见工具名（Config.toolName，默认 team_delegate）。
 * @param deps - 名册、provider、persona 装配与委派入口。
 * @returns defineTool 产物，交给 ctx.tools.register。
 *
 * 工具注册是 standing scope 的单次注册，description 无法内嵌名册；名册对模型的
 * 可见性走系统提示团队段（index.ts）。
 */
export function createDelegateTool(toolName: string, deps: DelegateToolDeps) {
  const tool = defineTool({
    name: toolName,
    description:
      'Delegate a self-contained task to a team member (a separate agent with its own persona and '
      + 'optional model override). The member does NOT see this conversation — give it a complete, '
      + 'standalone prompt. Available members and their descriptions are listed in the team section '
      + 'of the system prompt. This call waits for the member and returns its result.',
    parameters: {
      role: { type: 'string', required: true, description: 'The member to delegate to. Must be one of the listed names.' },
      description: { type: 'string', required: true, description: 'A short (3-5 word) description of the delegated task, for display.' },
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the member. It does not share this conversation\'s context, so include everything it needs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          role: { type: 'string', required: true },
          runId: { type: 'string', required: true },
          childSessionId: { type: 'string', required: true },
          output: { type: 'array', required: true, items: { type: 'json' } },
          provider: { type: 'string' },
          model: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text' as const,
        text: (value.output as { type: string; text?: string }[])
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text).join(''),
      }],
      // 浏览器半委派卡经 tool/result 的持久化 meta 读子会话坐标（回放可重建）。
      presentationMeta: (_args, value) => ({
        role: value.role as string,
        runId: value.runId as string,
        childSessionId: value.childSessionId as string,
        ...typeof value.provider === 'string' && typeof value.model === 'string'
          ? { provider: value.provider, model: value.model }
          : {},
      }),
    },
    // 成员不改父会话；父方无写操作。与内置 subagent 工具同款。
    isConcurrencySafe: () => true,
    // generic 兜底（浏览器半缺席/回放旧事件时降级；generic title 在 Web 不渲染，
    // 供 headless 与日志使用）。
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `委派 · ${args.role}: ${args.description}`,
      rawInput: args.prompt,
    }),
    presentResult: (_args, result) => (result.isError ? undefined : { card: 'generic' as const }),
    async execute(args, exec) {
      const parent: Agent | undefined = exec.agent
      if (!parent) throw new Error('team_delegate 需要调用方 agent（exec.agent 为空）')
      // 主 Agent 与团队不可见角色不可委派：查找与错误清单都排除。
      const roster = deps.roster().filter(r => r.id !== 'main' && isTeamVisible(r))
      const role = roster.find(r => r.id === args.role)
      if (!role) {
        throw new Error(`未知角色 "${args.role}"。可用角色：${roster.map(r => r.id).join(', ')}`)
      }
      const persona = deps.buildPersona(role)
      // 白名单与父会话真实可见面求交（warn-drop 未知名）——宿主 child-agent 对 toolFilter
      // 直接 restrict，未知名响亮失败（spawn-in-process 测试 "an unknown toolFilter name
      // fails the spawn loudly" 佐证）；与 bot 会话路径（channels/agent-setup.ts）对称，
      // 消除两条路径的白名单有效性不对称。求交为空抛错防静默零工具子会话。
      let toolFilter: { allow: string[] } | undefined
      if (role.tools !== undefined) {
        const visible = new Set(deps.visibleSurface(parent).filter((n) => n !== RUN_CODE_NAME))
        const effective = role.tools.allow.filter((n) => visible.has(n))
        const dropped = role.tools.allow.filter((n) => !visible.has(n))
        if (dropped.length > 0) {
          deps.warn(`dsh-agent-toolkit: 角色 ${role.id} 白名单含本会话不可见工具，委派时忽略：${dropped.join(', ')}`)
        }
        if (effective.length === 0) {
          throw new Error(`dsh-agent-toolkit: 角色 ${role.id} 工具白名单求交后为空（原 ${role.tools.allow.length} 个均不可见）：${role.tools.allow.join(', ')}`)
        }
        toolFilter = { allow: effective }
      }
      const request: SubagentStartRequest = {
        label: `role:${role.id}: ${args.description}`,
        prompt: [{ type: 'text', text: args.prompt } as ContentBlock],
        parent,
        persona,
        maxDepth: 1, // 禁止套娃：成员（深度 1）再委派时 childDepth 2 > 1，provider 响亮拒绝
        signal: exec.signal,
        ...role.model !== undefined
          ? { agentOptions: { provider: role.model.provider, model: role.model.model } }
          : {},
        ...toolFilter !== undefined
          ? { toolFilter }
          : {},
      } as SubagentStartRequest
      // 路由解析与 spawn driver resolveChildAgentOptions 同源：角色覆盖 ?? 父 options。
      // 字段为空串视为未配置；任一缺失整体省略（不猜部署默认——显示错值比不显示更糟）。
      const route: DelegateRoute | undefined =
        (role.model !== undefined && role.model.provider !== '' && role.model.model !== ''
          ? role.model
          : undefined)
        ?? (typeof parent.options.provider === 'string' && parent.options.provider !== ''
            && typeof parent.options.model === 'string' && parent.options.model !== ''
          ? { provider: parent.options.provider, model: parent.options.model }
          : undefined)
      const parentSessionId = String(parent.session.id)
      if (route !== undefined) deps.active.set(parentSessionId, role.id, route)
      try {
        const run = await deps.startRun(deps.provider, request)
        if (route !== undefined) {
          // 展示向写入失败不阻断委派（域关闭等异常吞掉）。
          await deps.recordRoute(String(run.id), route).catch(() => undefined)
        }
        return await settleForegroundRun(run, role.id, route)
      } finally {
        if (route !== undefined) deps.active.delete(parentSessionId, role.id)
      }
    },
  })
  return tool
}
