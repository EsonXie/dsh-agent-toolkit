/** team_delegate 工具：查角色 → 一次性 spawn 前台委派 → 规范 JSON 返回。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { buildMemberPersona, type PromptTemplates } from './prompt.ts'
import type { Team } from './roles.ts'

/** createDelegateTool 的外部依赖。 */
export interface DelegateToolDeps {
  /** 返回调用方会话的当前团队（standing 共享注册下按 exec.agent 解析；懒建保证不空）。 */
  readonly currentTeamFor: (agent: Agent) => Team
  /** ctx.subagents 的 provider 名（默认 'spawn'）。 */
  readonly provider: string
  /** C 段模板覆盖（Config.promptTemplates）。 */
  readonly templates?: PromptTemplates
  /** 委派入口：生产为 ctx.subagents.start.bind(ctx.subagents)，测试注入假实现。 */
  readonly startRun: (provider: string, request: SubagentStartRequest) => Promise<SubagentRun>
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
async function settleForegroundRun(run: SubagentRun, roleName: string) {
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withPartialText(error, result.output))
      return {
        kind: 'foreground' as const,
        role: roleName,
        runId: run.id,
        output: result.output as unknown as JsonValue[],
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
 * @param deps - 当前团队解析、provider、模板与委派入口。
 * @returns defineTool 产物，交给 ctx.tools.register。
 *
 * 工具注册是 standing scope 下跨会话共享的单次注册，description 无法内嵌具体名册；
 * 名册对模型的动态可见性走系统提示团队段（index.ts 的 prompt section 函数 text）。
 */
export function createDelegateTool(toolName: string, deps: DelegateToolDeps) {
  return defineTool({
    name: toolName,
    description:
      'Delegate a self-contained task to a member of the current session\'s team (a separate agent with its '
      + 'own persona and optional model override). The member does NOT see this conversation — give it a '
      + 'complete, standalone prompt. The role must be one of the current session\'s team members; the '
      + 'available members and their descriptions are listed in the team section of the system prompt. This '
      + 'call waits for the member and returns its result.',
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
          output: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{
        type: 'text' as const,
        text: (value.output as { type: string; text?: string }[])
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text).join(''),
      }],
    },
    // 成员不改父会话；父方无写操作。与内置 subagent 工具同款。
    isConcurrencySafe: () => true,
    // UI 卡片（spec §7.3）：host 端纯函数，回放安全；成功保留待定态标题，失败回退默认错误卡。
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `委派 · ${args.role}: ${args.description}`,
      rawInput: args.prompt,
    }),
    presentResult: (_args, result) => (result.isError ? undefined : { card: 'generic' as const }),
    async execute(args, exec) {
      const parent: Agent | undefined = exec.agent
      if (!parent) throw new Error('team_delegate 需要调用方 agent（exec.agent 为空）')
      const team = deps.currentTeamFor(parent)
      const role = team.roles.find(r => r.name === args.role)
      if (!role) {
        throw new Error(`未知角色 "${args.role}"。可用角色：${team.roles.map(r => r.name).join(', ')}`)
      }
      const model = role.model ?? parent.options.model
      const persona = buildMemberPersona(role, model, deps.templates)
      const request: SubagentStartRequest = {
        label: `role:${role.name}: ${args.description}`,
        prompt: [{ type: 'text', text: args.prompt } as ContentBlock],
        parent,
        persona,
        maxDepth: 1, // 禁止套娃：成员（深度 1）再委派时 childDepth 2 > 1，provider 响亮拒绝
        signal: exec.signal,
        ...role.provider !== undefined || role.model !== undefined
          ? { agentOptions: { ...role.provider !== undefined ? { provider: role.provider } : {}, ...role.model !== undefined ? { model: role.model } : {} } }
          : {},
      } as SubagentStartRequest
      const run = await deps.startRun(deps.provider, request)
      return settleForegroundRun(run, role.name)
    },
  })
}
