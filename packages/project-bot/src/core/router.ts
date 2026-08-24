/** 绑定路由：(botId, chatId) → 长期会话；create / resume / reset。 */
import { randomUUID } from 'node:crypto'
import type { BotRecord } from '../store.ts'
import type { ReplyHandle } from './channel.ts'
import { hooksOf, type AgentsPort, type BindingStore, type DefaultModelAccessor, type SessionRuntime } from './ports.ts'

export class Router {
  constructor(
    private readonly agents: AgentsPort,
    private readonly bindings: BindingStore,
    /** sessionId → runtime（进程内活跃会话表，与 bindings 持久表互补）。 */
    private readonly sessions: Map<string, SessionRuntime>,
    /** 存量 bot 无 agentOptions 时回退宿主默认模型。 */
    private readonly defaultModel: DefaultModelAccessor,
  ) {}

  /** 取（或建/恢复）该 chat 的会话 runtime；reply 刷新为最近一次入站携带的句柄。 */
  async ensure(bot: BotRecord, chatId: string, reply: ReplyHandle): Promise<SessionRuntime> {
    const bound = this.bindings.get(bot.id, chatId)
    if (bound !== undefined) {
      const existing = this.sessions.get(bound)
      if (existing !== undefined) {
        existing.reply = reply
        return existing
      }
      const agent = await this.agents.resume({ sessionId: bound, agentOptions: this.resolveOptions(bot), hooks: hooksOf(bot) })
      return this.adopt(bot.id, chatId, bound, agent, reply)
    }
    const sessionId = randomUUID()
    const agent = await this.agents.create({ sessionId, cwd: bot.project, agentOptions: this.resolveOptions(bot), hooks: hooksOf(bot) })
    await this.bindings.set(bot.id, chatId, sessionId)
    return this.adopt(bot.id, chatId, sessionId, agent, reply)
  }

  /** 有 agentOptions 原样透传；无则回退宿主默认模型（存量 bot 不抛 no provider/model）。 */
  private resolveOptions(bot: BotRecord): { provider?: string; model?: string } {
    return bot.agentOptions ?? this.defaultModel()
  }

  /** /new：取消旧会话、清绑定、开新会话。 */
  async reset(bot: BotRecord, chatId: string, reply: ReplyHandle): Promise<SessionRuntime> {
    const bound = this.bindings.get(bot.id, chatId)
    if (bound !== undefined) {
      this.sessions.get(bound)?.agent.cancel()
      this.sessions.delete(bound)
      await this.bindings.delete(bot.id, chatId)
    }
    return this.ensure(bot, chatId, reply)
  }

  lookup(botId: string, chatId: string): SessionRuntime | undefined {
    const bound = this.bindings.get(botId, chatId)
    return bound === undefined ? undefined : this.sessions.get(bound)
  }

  private adopt(botId: string, chatId: string, sessionId: string, agent: SessionRuntime['agent'], reply: ReplyHandle): SessionRuntime {
    const rt: SessionRuntime = {
      botId, chatId, sessionId, agent, reply,
      inflight: undefined, tail: Promise.resolve(), turn: undefined,
    }
    this.sessions.set(sessionId, rt)
    return rt
  }
}
