/** 审批中心（渠道无关）：自有 bot 会话的 approval ask → 渠道审批卡片挂起 → 卡片回调 resolve。
 *  spec: docs/superpowers/specs/archive/2026-09-08-feishu-approval-card-design.md（飞书独占 / 仅发起人）；
 *  超时自动拒绝（0.4.7）：present 成功入 pending 起 approvalTimeoutMs 定时器，到点无人审批即自动拒绝
 *  （outcome rejected + 卡片定格 rejected）；<= 0 关闭；定时器在 settle 统一清理，幂等不二次 settle。 */
import { randomUUID } from 'node:crypto'
import type { SessionRuntime } from '../ports.ts'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** waterfall answerer 收到的请求结构（结构子集化，不依赖宿主包类型）。 */
export interface ApprovalRequestLike {
  agent: { session: { id: unknown } }
  toolName: string
  reason?: string
  signal?: AbortSignal
}

/** 发给渠道的审批卡片内容。 */
export interface ApprovalPrompt {
  key: string
  chatId: string
  botName: string
  toolName: string
  reason?: string
  /** 话题锚点：发卡时回复到触发本 turn 的入站消息；replyAnchor 缺席则不带此键。 */
  replyToMessageId?: string
}

/** 一次已展示的审批：finalize 把卡片定格为终态（实现内部 fire-and-forget 友好，失败自告警）。 */
export interface ApprovalPresentation {
  finalize(status: 'allowed' | 'rejected' | 'cancelled', operatorName?: string): Promise<void>
}

/** 渠道侧审批能力：发卡 → 返回定格句柄。 */
export interface ApprovalPresenter {
  present(prompt: ApprovalPrompt): Promise<ApprovalPresentation>
}

/** channelFor 的返回：该 bot 的审批能力 + 展示名。 */
export interface ApprovalChannel {
  presenter: ApprovalPresenter
  botName: string
}

/** 渠道回调入核的卡片动作（渠道已解析成渠道无关形态）。 */
export interface CardActionInput {
  chatId: string
  operatorOpenId: string
  operatorName?: string
  value: unknown
  /** form 容器提交回调的表单值（name → 值；lark SDK normalizeCardAction 丢弃 form_value，渠道从 raw 直取）。 */
  formValue?: Record<string, unknown>
}

/** 回调应答（飞书侧经 WS 响应帧回 toast）。 */
export interface CardActionAck {
  toast?: string
}

interface PendingEntry {
  sessionId: string
  resolve(outcome: ApprovalOutcome): void
  presentation: ApprovalPresentation
  signal: AbortSignal | undefined
  onAbort: () => void
  /** 超时定时器（approvalTimeoutMs > 0 时创建；settle 统一清理）。 */
  timer?: ReturnType<typeof setTimeout>
}

export class ApprovalCenter {
  private readonly pending = new Map<string, PendingEntry>()

  constructor(
    private readonly sessions: Map<string, SessionRuntime>,
    private readonly channelFor: (botId: string) => ApprovalChannel | undefined,
    private readonly warn: (message: string) => void,
    private readonly newId: () => string = randomUUID,
    /** 审批卡超时自动拒绝（毫秒；缺省/<= 0 关闭；见 Config feishu.approvalTimeoutMs）。 */
    private readonly approvalTimeoutMs?: number,
  ) {}

  async handleRequest(req: ApprovalRequestLike): Promise<ApprovalOutcome | undefined> {
    const sessionId = String(req.agent.session.id)
    const rt = this.sessions.get(sessionId)
    if (rt === undefined) return undefined
    // 已取消的 ask 不发卡不回退：直接 cancelled（与 api-proxy 的同步 settle 对齐，
    // 防 abort 落在注册监听之前的 zombie 窗口）。
    if (req.signal?.aborted === true) return 'cancelled'
    const channel = this.channelFor(rt.botId)
    if (channel === undefined) {
      this.warn(`[project-bot] bot "${rt.botId}" 的渠道无审批能力，回退其他审批通道`)
      return undefined
    }
    const key = this.newId()
    let presentation: ApprovalPresentation
    try {
      presentation = await channel.presenter.present({
        key, chatId: rt.chatId, botName: channel.botName, toolName: req.toolName,
        ...(req.reason !== undefined ? { reason: req.reason } : {}),
        // 话题锚点：rt.replyAnchor 由入站在 dispatch 时写入；缺席时不带键，行为零变化。
        ...(rt.replyAnchor !== undefined ? { replyToMessageId: rt.replyAnchor } : {}),
      })
    } catch (error) {
      this.warn(`[project-bot] 审批卡片发送失败，回退其他审批通道：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: PendingEntry = {
        sessionId, resolve, presentation, signal: req.signal,
        onAbort: () => this.settle(key, 'cancelled'),
      }
      this.pending.set(key, entry)
      // 超时守门（feishu.approvalTimeoutMs，默认 5 分钟）：到点无人审批即自动拒绝（卡片定格 rejected）。
      // settle 开头的 pending 守卫已保证幂等：已处理/已取消/已 abort 的 entry 不会被超时二次 settle。
      if (this.approvalTimeoutMs !== undefined && this.approvalTimeoutMs > 0) {
        entry.timer = setTimeout(() => this.settle(key, 'rejected', '超时自动拒绝'), this.approvalTimeoutMs)
        entry.timer.unref?.()
      }
      req.signal?.addEventListener('abort', entry.onAbort, { once: true })
    })
  }

  handleCardAction(action: CardActionInput): CardActionAck | undefined {
    const value = action.value as { key?: unknown; decision?: unknown } | null
    if (value === null || typeof value !== 'object' || typeof value.key !== 'string'
      || (value.decision !== 'allow' && value.decision !== 'reject')) return undefined
    const entry = this.pending.get(value.key)
    if (entry === undefined) return { toast: '该申请已处理或已失效' }
    const rt = this.sessions.get(entry.sessionId)
    if (rt === undefined || rt.initiatorOpenId !== action.operatorOpenId) {
      return { toast: '仅会话发起人可审批' }
    }
    this.settle(value.key, value.decision === 'allow' ? 'allowed-once' : 'rejected', action.operatorName)
    return { toast: value.decision === 'allow' ? '已允许' : '已拒绝' }
  }

  dispose(): void {
    for (const key of [...this.pending.keys()]) this.settle(key, 'cancelled')
  }

  private settle(key: string, outcome: ApprovalOutcome, operatorName?: string): void {
    const entry = this.pending.get(key)
    if (entry === undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.pending.delete(key)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    entry.resolve(outcome)
    const status = outcome === 'allowed-once' ? 'allowed' : outcome === 'rejected' ? 'rejected' : 'cancelled'
    void entry.presentation.finalize(status, operatorName).catch((error: unknown) => {
      this.warn(`[project-bot] 审批卡片定格失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
