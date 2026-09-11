/** 绑定路由：(botId, chatId) → 长期会话；create / resume / reset。 */
import { randomUUID } from 'node:crypto'
import type { AgentRegistry } from '../agents/registry.ts'
import type { BotRecord } from '../bots/store.ts'
import type { ReplyHandle } from './channel.ts'
import { hooksOf, type AgentHooks, type AgentSection, type AgentsPort, type BindingStore, type DefaultModelAccessor, type SessionRuntime, type WorkspacePort } from './ports.ts'
import { roleAgentOptions, roleHooks } from './role-assembly.ts'

/** 发起人提示段名：bot 会话声明来源渠道与发起人 open_id。 */
export const SENDER_SECTION_NAME = 'dsh-agent-toolkit:channel:sender'

/** sender 段文本（单聊语义；channel 取 BotRecord.channel，未来新渠道零改动透传）。 */
export function senderSectionText(channel: string, userId: string): string {
  return `本会话由 ${channel} 渠道的单聊会话发起。发起人 ID（${channel} open_id）：\`${userId}\`。`
}

export class Router {
  constructor(
    private readonly agents: AgentsPort,
    private readonly bindings: BindingStore,
    /** sessionId → runtime（进程内活跃会话表，与 bindings 持久表互补）。 */
    private readonly sessions: Map<string, SessionRuntime>,
    /** main 形态会话（bot 未自配 agentOptions 时）与未配置模型的角色的模型来源（宿主默认模型）。 */
    private readonly defaultModel: DefaultModelAccessor,
    /** 会话归入 bot 项目 workspace（与原生 UI session.create 同款挂载）。 */
    private readonly workspace: WorkspacePort,
    private readonly onWarn: (message: string) => void,
    /** Agent 注册表（agentRef → main/角色），会话创建时决定 persona/工具/模型装配。 */
    private readonly registry: AgentRegistry,
    /** 开启时向 hooks.sections 末尾追加渠道发起人提示段。 */
    private readonly injectSender = true,
  ) {}

  /**
   * 取（或建/恢复）该 chat 的会话 runtime。存量活跃会话保持其 reply——运行中 turn 的出站
   * 必须留在原句柄收尾，reply 刷新由 Inbound 在 in-flight 准入通过后执行；
   * retiring（已 cancel、收尾中）的会话不可复用，重绑窗口内恢复时 resume + adopt 重建。
   */
  async ensure(bot: BotRecord, chatId: string, reply: ReplyHandle, userId: string): Promise<SessionRuntime> {
    const bound = this.bindings.get(bot.id, chatId)
    if (bound !== undefined) {
      const existing = this.sessions.get(bound)
      // 活跃会话不替换 reply：运行中 turn 的出站必须留在原句柄收尾；
      // reply 的刷新由 Inbound 在 in-flight 准入通过后执行。
      if (existing !== undefined && !existing.retiring) return existing
      const agent = await this.agents.resume({ sessionId: bound, ...this.resolveSession(bot, userId) })
      await this.attach(bot.project, bound)
      return this.adopt(bot.id, chatId, userId, bound, agent, reply)
    }
    const sessionId = randomUUID()
    const agent = await this.agents.create({ sessionId, cwd: bot.project, ...this.resolveSession(bot, userId) })
    await this.bindings.set(bot.id, chatId, sessionId)
    await this.attach(bot.project, sessionId)
    return this.adopt(bot.id, chatId, userId, sessionId, agent, reply)
  }

  /** attach 失败仅告警（会话降级为未分组），不阻塞消息处理。 */
  private async attach(cwd: string, sessionId: string): Promise<void> {
    try {
      await this.workspace.attach(cwd, sessionId)
    } catch (error) {
      this.onWarn(`[project-bot] 会话 ${sessionId} 挂载 workspace 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** injectSender 开启时向 hooks.sections 末尾追加 sender 段（主/角色形态通用）。 */
  private withSenderSection(hooks: AgentHooks, bot: BotRecord, userId: string): AgentHooks {
    if (!this.injectSender) return hooks
    const section: AgentSection = { name: SENDER_SECTION_NAME, order: 20, text: senderSectionText(bot.channel ?? 'unknown', userId) }
    return { ...hooks, sections: [...(hooks.sections ?? []), section] }
  }

  /**
   * 按 bot.agentRef 解析会话组装（agentOptions + 创作期 hooks）：
   * - 缺省/指向 main → 主 Agent 形态：bot 自带 persona/tools + 模型（自配 agentOptions 优先，缺省回退宿主默认模型）；
   * - 指向角色 → 角色形态：persona 单 section + tools.restrict + role.model；
   * - 指向不存在角色 → warn 并降级为主 Agent 形态。
   */
  private resolveSession(bot: BotRecord, userId: string): { agentOptions: { provider?: string; model?: string }; hooks: AgentHooks } {
    const ref = bot.agentRef ?? 'main'
    const role = this.registry.get(ref)
    if (role === undefined || ref === 'main') {
      if (role === undefined && ref !== 'main') {
        this.onWarn(`[project-bot] bot "${bot.id}" 的 agentRef "${ref}" 不存在，降级绑定主 Agent`)
      }
      return { agentOptions: bot.agentOptions ?? this.defaultModel(), hooks: this.withSenderSection(hooksOf(bot), bot, userId) }
    }
    return {
      agentOptions: roleAgentOptions(role, this.defaultModel),
      hooks: this.withSenderSection(roleHooks(role), bot, userId),
    }
  }

  /** /new：取消旧会话；等 turn/end 落定（旧卡在旧句柄 finalize）后再摘出 sessions。 */
  async reset(bot: BotRecord, chatId: string, reply: ReplyHandle, userId: string): Promise<SessionRuntime> {
    const bound = this.bindings.get(bot.id, chatId)
    if (bound !== undefined) {
      const old = this.sessions.get(bound)
      if (old !== undefined) this.retire(bound, old)
      await this.bindings.delete(bot.id, chatId)
    }
    return this.ensure(bot, chatId, reply, userId)
  }

  /** 取消会话并等出站链落定后摘出 sessions（让在飞 turn 的 turn/end 正常 finalize 旧卡）。 */
  private retire(sessionId: string, rt: SessionRuntime): void {
    rt.retiring = true
    rt.agent.cancel()
    void (async () => {
      await rt.agent.whenIdle().catch(() => undefined)
      await rt.tail.catch(() => undefined)
      if (this.sessions.get(sessionId) === rt) this.sessions.delete(sessionId)
    })()
  }

  lookup(botId: string, chatId: string): SessionRuntime | undefined {
    const bound = this.bindings.get(botId, chatId)
    return bound === undefined ? undefined : this.sessions.get(bound)
  }

  /** 当前绑定 sessionId（不要求进程内有 runtime；/sessions ✓ 标记与 /switch 已是当前判定用）。 */
  boundSessionId(botId: string, chatId: string): string | undefined {
    return this.bindings.get(botId, chatId)
  }

  /**
   * /switch：把 chat 的绑定覆盖到目标会话。
   * 目标已在内存且非 retiring → 直接复用（initiator 不变）；否则 resume + adopt（切换人成为发起人）。
   * binding 在 resume 成功后才覆盖（resume 失败绑定不变；覆盖失败摘除本次 adopt 的 runtime，不留孤儿）。
   * 切走的旧 runtime 不 retire（在飞 turn 卡片在本 chat 照常收尾），闲置落定后仍未重新绑定才摘除。
   */
  async switchTo(bot: BotRecord, chatId: string, sessionId: string, reply: ReplyHandle, userId: string): Promise<SessionRuntime> {
    const oldBound = this.bindings.get(bot.id, chatId)
    const existing = this.sessions.get(sessionId)
    let rt: SessionRuntime
    let adopted = false
    if (existing !== undefined && !existing.retiring) {
      rt = existing
    } else {
      const agent = await this.agents.resume({ sessionId, ...this.resolveSession(bot, userId) })
      await this.attach(bot.project, sessionId)
      rt = this.adopt(bot.id, chatId, userId, sessionId, agent, reply)
      adopted = true
    }
    try {
      await this.bindings.set(bot.id, chatId, sessionId)
    } catch (error) {
      // 本次 adopt 的 runtime 未写进绑定即失败：摘除不留孤儿（复用路径 runtime 先于本次调用存在，不动）。
      if (adopted && this.sessions.get(sessionId) === rt) this.sessions.delete(sessionId)
      throw error
    }
    if (oldBound !== undefined && oldBound !== sessionId) {
      const old = this.sessions.get(oldBound)
      if (old !== undefined && old !== rt && !old.retiring) this.releaseUnbound(bot.id, chatId, oldBound, old)
    }
    return rt
  }

  /** 未绑定会话闲置落定（在飞 turn 卡片收尾）后，仍未被重新绑定才摘出 sessions（摘除窗口内被切回不误删）。 */
  private releaseUnbound(botId: string, chatId: string, sessionId: string, rt: SessionRuntime): void {
    void (async () => {
      await rt.agent.whenIdle().catch(() => undefined)
      await rt.tail.catch(() => undefined)
      if (this.sessions.get(sessionId) === rt && this.bindings.get(botId, chatId) !== sessionId) {
        this.sessions.delete(sessionId)
      }
    })()
  }

  private adopt(botId: string, chatId: string, userId: string, sessionId: string, agent: SessionRuntime['agent'], reply: ReplyHandle): SessionRuntime {
    const rt: SessionRuntime = {
      botId, chatId, sessionId, initiatorOpenId: userId, agent, reply,
      inflight: undefined, tail: Promise.resolve(), turn: undefined, retiring: false,
    }
    this.sessions.set(sessionId, rt)
    return rt
  }
}
