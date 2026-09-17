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

/** IM 引导段名：bot 会话恒注入（原 BASIC_TOOLS persona prefix 句，2026-09-16 挪入渠道段）。 */
export const GUIDANCE_SECTION_NAME = 'dsh-agent-toolkit:channel:guidance'

/** guidance 段文本：与 injectSender 无关，恒注入；角色白名单收窄掉 ask_user_question 后仍有兜底提问指引。 */
export function guidanceSectionText(channel: string): string {
  return `本会话经 ${channel} 渠道进行。如需用户补充信息或做出决策，优先使用 ask_user_question 工具；该工具不可用时，直接在回复中提问并等待用户下一条消息。`
}

export class Router {
  constructor(
    private readonly agents: AgentsPort,
    private readonly bindings: BindingStore,
    /** sessionId → runtime（进程内活跃会话表，与 bindings 持久表互补）。 */
    private readonly sessions: Map<string, SessionRuntime>,
    /** main 形态会话（bot 未自配 agentOptions 时）与未配置模型的角色的模型来源（宿主默认模型）。 */
    private readonly defaultModel: DefaultModelAccessor,
    /** 会话归入 bot 项目 workspace：首条消息投递时惰性挂载（attachOnce），建账期不挂。 */
    private readonly workspace: WorkspacePort,
    private readonly onWarn: (message: string) => void,
    /** Agent 注册表（agentRef → main/角色），会话创建时决定 persona/工具/模型装配。 */
    private readonly registry: AgentRegistry,
    /** 开启时在 guidance 段之后再追加渠道发起人提示段（guidance 与它语义不同，恒注入）。 */
    private readonly injectSender = true,
  ) {}

  /** 本进程内已挂载的 sessionId（宿主 attachSession 幂等，重启后首条消息补挂一次）。 */
  private readonly attached = new Set<string>()

  /**
   * 首条消息投递时的惰性 workspace 挂载（每会话每进程一次；失败仅告警且不计入，下条消息重试）。
   * 建账（create/resume/接管/switch）时不挂：空白会话一旦进 workspace 且 cwd 匹配，会被宿主 web
   * 客户端 connectWorkspace 的 blank 复用启发式捕获——web「新会话」实际打开的是飞书绑定会话，
   * 消息与出站全部回流飞书。首条消息投递即转 non-blank，此刻挂载无捕获窗口。
   */
  async attachOnce(bot: BotRecord, sessionId: string): Promise<void> {
    if (this.attached.has(sessionId)) return
    try {
      await this.workspace.attach(bot.project, sessionId)
    } catch (error) {
      this.onWarn(`[project-bot] 会话 ${sessionId} 挂载 workspace 失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.attached.add(sessionId)
  }

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
      // 宿主内存中已存活（web 界面等持有写句柄）→ 接管复用；冷会话才 resume（避免 already owned）。
      const agent = this.agents.get(bound) ?? await this.agents.resume({ sessionId: bound, ...this.resolveSession(bot, userId) })
      return this.adopt(bot.id, chatId, userId, bound, agent, reply)
    }
    const sessionId = randomUUID()
    const agent = await this.agents.create({ sessionId, cwd: bot.project, ...this.resolveSession(bot, userId) })
    await this.bindings.set(bot.id, chatId, sessionId)
    return this.adopt(bot.id, chatId, userId, sessionId, agent, reply)
  }

  /** 向 hooks.sections 追加渠道段：guidance（order 15）恒注入；injectSender 开启时再追加 sender（order 20）。 */
  private withChannelSections(hooks: AgentHooks, bot: BotRecord, userId: string): AgentHooks {
    const guidance: AgentSection = { name: GUIDANCE_SECTION_NAME, order: 15, text: guidanceSectionText(bot.channel ?? 'unknown') }
    if (!this.injectSender) return { ...hooks, sections: [...(hooks.sections ?? []), guidance] }
    const sender: AgentSection = { name: SENDER_SECTION_NAME, order: 20, text: senderSectionText(bot.channel ?? 'unknown', userId) }
    return { ...hooks, sections: [...(hooks.sections ?? []), guidance, sender] }
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
      return { agentOptions: bot.agentOptions ?? this.defaultModel(), hooks: this.withChannelSections(hooksOf(bot), bot, userId) }
    }
    return {
      agentOptions: roleAgentOptions(role, this.defaultModel),
      hooks: this.withChannelSections(roleHooks(role), bot, userId),
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

  /** 取消会话并等出站链落定后摘出 sessions（让在飞 turn 的 turn/end 正常 finalize 旧卡），随后 dispose 释放写句柄。 */
  private retire(sessionId: string, rt: SessionRuntime): void {
    rt.retiring = true
    rt.agent.cancel()
    void (async () => {
      await rt.agent.whenIdle().catch(() => undefined)
      await rt.tail.catch(() => undefined)
      if (this.sessions.get(sessionId) !== rt) return
      this.sessions.delete(sessionId)
      await this.disposeAgent(sessionId, rt)
    })()
  }

  /** 摘除后释放宿主写句柄：不 dispose 则该会话在宿主侧永远 already owned，无法再 resume。 */
  private async disposeAgent(sessionId: string, rt: SessionRuntime): Promise<void> {
    await rt.agent.dispose().catch((error) => {
      this.onWarn(`[project-bot] 会话 ${sessionId} 的 agent 释放失败：${error instanceof Error ? error.message : String(error)}`)
    })
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
   * 目标已在内存且非 retiring → 直接复用（initiator 不变）；在宿主内存存活（web 界面等持有写句柄）→
   * 接管复用（保持其当前装配，setup 不重跑）；冷会话才 resume + adopt（套用 bot 装配，切换人成为发起人）。
   * binding 在接管/resume 成功后才覆盖（失败绑定不变；覆盖失败摘除本次 adopt 的 runtime，不留孤儿）。
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
      const agent = this.agents.get(sessionId) ?? await this.agents.resume({ sessionId, ...this.resolveSession(bot, userId) })
      rt = this.adopt(bot.id, chatId, userId, sessionId, agent, reply)
      adopted = true
    }
    try {
      await this.bindings.set(bot.id, chatId, sessionId)
    } catch (error) {
      // 本次 adopt 的 runtime 未写进绑定即失败：摘除并释放写句柄不留孤儿（复用路径 runtime 先于本次调用存在，不动）。
      if (adopted && this.sessions.get(sessionId) === rt) {
        this.sessions.delete(sessionId)
        await this.disposeAgent(sessionId, rt)
      }
      throw error
    }
    if (oldBound !== undefined && oldBound !== sessionId) {
      const old = this.sessions.get(oldBound)
      if (old !== undefined && old !== rt && !old.retiring) this.releaseUnbound(bot.id, chatId, oldBound, old)
    }
    return rt
  }

  /** 未绑定会话闲置落定（在飞 turn 卡片收尾）后，仍未被重新绑定才摘出 sessions 并 dispose（摘除窗口内被切回不误删）。 */
  private releaseUnbound(botId: string, chatId: string, sessionId: string, rt: SessionRuntime): void {
    void (async () => {
      await rt.agent.whenIdle().catch(() => undefined)
      await rt.tail.catch(() => undefined)
      if (this.sessions.get(sessionId) !== rt || this.bindings.get(botId, chatId) === sessionId) return
      this.sessions.delete(sessionId)
      await this.disposeAgent(sessionId, rt)
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
