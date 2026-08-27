/** 绑定路由：(botId, chatId) → 长期会话；create / resume / reset。 */
import { randomUUID } from 'node:crypto'
import type { AgentRegistry } from '../agents/registry.ts'
import type { BotRecord } from '../bots/store.ts'
import type { ReplyHandle } from './channel.ts'
import { hooksOf, type AgentHooks, type AgentsPort, type BindingStore, type DefaultModelAccessor, type SessionRuntime, type WorkspacePort } from './ports.ts'

export class Router {
  constructor(
    private readonly agents: AgentsPort,
    private readonly bindings: BindingStore,
    /** sessionId → runtime（进程内活跃会话表，与 bindings 持久表互补）。 */
    private readonly sessions: Map<string, SessionRuntime>,
    /** 存量 bot 无 agentOptions 时回退宿主默认模型。 */
    private readonly defaultModel: DefaultModelAccessor,
    /** 会话归入 bot 项目 workspace（与原生 UI session.create 同款挂载）。 */
    private readonly workspace: WorkspacePort,
    private readonly onWarn: (message: string) => void,
    /** Agent 注册表（agentRef → main/角色），会话创建时决定 persona/工具/模型装配。 */
    private readonly registry: AgentRegistry,
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
      const agent = await this.agents.resume({ sessionId: bound, ...this.resolveSession(bot) })
      await this.attach(bot.project, bound)
      return this.adopt(bot.id, chatId, bound, agent, reply)
    }
    const sessionId = randomUUID()
    const agent = await this.agents.create({ sessionId, cwd: bot.project, ...this.resolveSession(bot) })
    await this.bindings.set(bot.id, chatId, sessionId)
    await this.attach(bot.project, sessionId)
    return this.adopt(bot.id, chatId, sessionId, agent, reply)
  }

  /** attach 失败仅告警（会话降级为未分组），不阻塞消息处理。 */
  private async attach(cwd: string, sessionId: string): Promise<void> {
    try {
      await this.workspace.attach(cwd, sessionId)
    } catch (error) {
      this.onWarn(`[project-bot] 会话 ${sessionId} 挂载 workspace 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 有 agentOptions 原样透传；无则回退宿主默认模型（存量 bot 不抛 no provider/model）。 */
  private resolveOptions(bot: BotRecord): { provider?: string; model?: string } {
    return bot.agentOptions ?? this.defaultModel()
  }

  /**
   * 按 bot.agentRef 解析会话组装（agentOptions + 创作期 hooks）：
   * - 缺省/指向 main → 主 Agent 形态：bot 自带 persona/tools + 默认模型回退；
   * - 指向角色 → 角色形态：persona 单 section + tools.restrict + role.model；
   * - 指向不存在角色 → warn 并降级为主 Agent 形态。
   */
  private resolveSession(bot: BotRecord): { agentOptions: { provider?: string; model?: string }; hooks: AgentHooks } {
    const ref = bot.agentRef ?? 'main'
    const role = this.registry.get(ref)
    if (role === undefined || ref === 'main') {
      if (role === undefined && ref !== 'main') {
        this.onWarn(`[project-bot] bot "${bot.id}" 的 agentRef "${ref}" 不存在，降级绑定主 Agent`)
      }
      return { agentOptions: this.resolveOptions(bot), hooks: hooksOf(bot) }
    }
    const sections = role.persona === undefined || role.persona.trim().length === 0
      ? []
      : [{ name: 'dsh-agent-toolkit:agent:persona', order: 0, text: role.persona }]
    return {
      agentOptions: role.model ?? this.resolveOptions(bot),
      hooks: {
        ...(sections.length > 0 ? { sections } : {}),
        ...(role.tools !== undefined ? { tools: role.tools.allow } : {}),
      },
    }
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
