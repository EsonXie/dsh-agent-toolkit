/** AgentsPort 真实适配器工厂（bots Router 与 schedule 执行器共用）：create/resume 经 setupAgentScope 装配，
 *  sessionId 记入 cronExcludedSessions（cron_* 工具注册门控排除集，仅 schedule 执行会话登记）。 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { setupAgentScope } from './agent-setup.ts'
import type { AgentPort, AgentsPort } from './ports.ts'
import type { ScopeJoiner } from './scope-joiner.ts'

export function createAgentsPort(
  ctx: Context,
  joiner: ScopeJoiner,
  /** cron_* 工具注册门控排除集（仅 schedule 执行会话登记；bot 聊天会话自 2026-09-16 起与 web 主会话对齐，可建定时任务）。 */
  cronExcludedSessions?: Set<string>,
  /** 可选：会话建账（create/resume/接管）后应用宿主权限预设（bots 的 feishu.permissionPreset；schedule 不传）。 */
  applyPreset?: (session: Session) => void,
): AgentsPort {
  function adaptAgent(handle: AgentHandle): AgentPort {
    const { agent } = handle
    applyPreset?.(agent.session)
    return {
      sessionId: String(agent.id),
      followup: (message) => agent.followup(message as Parameters<typeof agent.followup>[0]),
      cancel: () => agent.cancel({ kind: 'user' }),
      whenIdle: () => agent.whenIdle(),
      dispose: () => handle.dispose(),
    }
  }
  /** 接管宿主内存中已存活的 agent（web 界面等）：dispose 为空操作——写句柄归原主，本插件不释放。 */
  function adaptLive(agent: Agent): AgentPort {
    applyPreset?.(agent.session)
    return {
      sessionId: String(agent.id),
      followup: (message) => agent.followup(message as Parameters<typeof agent.followup>[0]),
      cancel: () => agent.cancel({ kind: 'user' }),
      whenIdle: () => agent.whenIdle(),
      dispose: async () => undefined,
    }
  }
  return {
    async create(input) {
      cronExcludedSessions?.add(input.sessionId)
      const handle: AgentHandle = await ctx.agents.create({
        sessionId: SessionId(input.sessionId),
        meta: { cwd: input.cwd },
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        setup: (agentCtx) => setupAgentScope(agentCtx, input.hooks, joiner),
      })
      return adaptAgent(handle)
    },
    async resume(input) {
      cronExcludedSessions?.add(input.sessionId)
      const handle: AgentHandle = await ctx.agents.resume({
        resumeSessionId: SessionId(input.sessionId),
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        setup: (agentCtx) => setupAgentScope(agentCtx, input.hooks, joiner),
      })
      return adaptAgent(handle)
    },
    get(sessionId) {
      const agent = ctx.agents.get(SessionId(sessionId))
      return agent === undefined ? undefined : adaptLive(agent)
    },
  }
}
