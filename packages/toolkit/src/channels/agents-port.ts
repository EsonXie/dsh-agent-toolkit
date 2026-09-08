/** AgentsPort 真实适配器工厂（bots Router 与 schedule 执行器共用）：create/resume 经 setupAgentScope 装配，
 *  sessionId 记入 ownedSessions（插件自有会话集合，cron_* 工具注册门控据此排除 bot/schedule 会话）。 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { setupAgentScope } from './agent-setup.ts'
import type { AgentPort, AgentsPort } from './ports.ts'
import type { ScopeJoiner } from './scope-joiner.ts'

export function createAgentsPort(ctx: Context, joiner: ScopeJoiner, ownedSessions?: Set<string>): AgentsPort {
  function adaptAgent(handle: AgentHandle): AgentPort {
    const { agent } = handle
    return {
      sessionId: String(agent.id),
      followup: (message) => agent.followup(message as Parameters<typeof agent.followup>[0]),
      cancel: () => agent.cancel({ kind: 'user' }),
      whenIdle: () => agent.whenIdle(),
    }
  }
  return {
    async create(input) {
      ownedSessions?.add(input.sessionId)
      const handle: AgentHandle = await ctx.agents.create({
        sessionId: SessionId(input.sessionId),
        meta: { cwd: input.cwd },
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        setup: (agentCtx) => setupAgentScope(agentCtx, input.hooks, joiner),
      })
      return adaptAgent(handle)
    },
    async resume(input) {
      ownedSessions?.add(input.sessionId)
      const handle: AgentHandle = await ctx.agents.resume({
        resumeSessionId: SessionId(input.sessionId),
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        setup: (agentCtx) => setupAgentScope(agentCtx, input.hooks, joiner),
      })
      return adaptAgent(handle)
    },
  }
}
