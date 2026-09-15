/** 出站句柄：turn 级流式卡片（确认式状态机 + 失败分类治理 + 拆卡定格）。 */
import type { ChannelTunables, Disposer, ReplyHandle, TurnSegment, TurnStatus } from '../channel.ts'
import { feishuErrorCode, type FeishuApi } from './api.ts'
import {
  initialStreamState, PENDING_CARD_ID, STATUS_ELEMENT_ID,
  planFinalize, planSync, type CardOp, type PlannedOp, type StreamState,
} from './cards.ts'

/** 指数退避重试（默认 3 次，300ms 起）。 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 300): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** i))
    }
  }
  throw lastError
}

/** 卡片输出异常时的用户提示（仅真实废弃一张已发卡时发送）。 */
const ABANDON_NOTICE = '⚠️ 卡片输出异常，已在新卡片继续；如有内容缺失请重发。'

/** 单次 flush 内连续废弃换卡的上限（防异常死循环；超限抛给出站链日志）。 */
const MAX_ABANDON_PER_FLUSH = 3

export class FeishuReplyHandle implements ReplyHandle {
  private state: StreamState = initialStreamState()
  private segments: readonly TurnSegment[] = []
  private tail: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private planQueued = false
  private finalized = false
  /** settings 关流时捕获的真实 cardId（replace op 为 PENDING 占位时的解析锚点）。 */
  private closedCardId: string | null = null

  constructor(
    private readonly api: FeishuApi,
    private readonly chatId: string,
    private readonly tunables: ChannelTunables,
    private readonly log: (message: string) => void,
  ) {}

  beginTurn(): Promise<void> {
    return Promise.resolve()
  }

  update(segments: readonly TurnSegment[]): Promise<void> {
    if (this.finalized) return Promise.resolve()
    this.segments = segments
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, this.tunables.cardUpdateThrottleMs)
    }
    return Promise.resolve()
  }

  async finalize(status: TurnStatus, detail?: string): Promise<void> {
    if (this.finalized) {
      await this.tail
      return
    }
    this.finalized = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.flush()
    // 等 flush 定局（含失败恢复）后再规划定格：状态此刻是已确认态。
    await this.tail
    const hadCard = this.state.cardId !== null
    const { ops } = planFinalize(this.state, status, this.segments, this.tunables.processMaxBytes)
    // 定格批不触发废弃重规划（卡已在收尾）：遇 abandon 直接止步。
    this.enqueue(async () => {
      for (const op of ops) {
        const outcome = await this.execOne({ op, commit: (s: StreamState) => s })
        if (outcome === 'abandoned') return
      }
    })
    if (!hadCard && detail !== undefined) {
      this.enqueue(() => withRetry(() => this.api.sendText(this.chatId, detail)).then(() => undefined))
    }
    await this.tail
  }

  notice(text: string): Promise<void> {
    this.enqueue(() => withRetry(() => this.api.sendText(this.chatId, text)).then(() => undefined))
    return this.tail.then(() => undefined)
  }

  /** 文件消息与卡片序列无关：直接调用（不进 enqueue 串行链），带重试，错误传播给调用方。 */
  async sendFile(name: string, data: Uint8Array): Promise<void> {
    await withRetry(async () => {
      const fileKey = await this.api.uploadFile(name, data)
      await this.api.sendFile(this.chatId, fileKey)
    })
  }

  /**
   * 规划入串行链：planSync 在执行点读最新已确认状态与最新 segments，
   * 在飞期间到达的 flush 只标位不重复规划（杜绝重复建卡/重复 insert）。
   */
  private flush(): void {
    if (this.planQueued) return
    this.planQueued = true
    this.enqueue(async () => {
      this.planQueued = false
      const { ops } = planSync(this.state, this.segments, this.tunables.cardMaxBytes, this.tunables.processMaxBytes, this.tunables.cardPrintStep)
      await this.exec(ops)
    })
  }

  /** 逐 op 确认执行；遇废弃从已确认状态重新规划续写（上限 MAX_ABANDON_PER_FLUSH 次）。 */
  private async exec(ops: readonly PlannedOp[]): Promise<void> {
    let pending = ops
    for (let attempts = 0; ; attempts++) {
      let abandoned = false
      for (const planned of pending) {
        if ((await this.execOne(planned)) === 'abandoned') {
          abandoned = true
          break
        }
      }
      if (!abandoned) return
      if (attempts >= MAX_ABANDON_PER_FLUSH) throw new Error('卡片连续废弃超限，本批输出放弃（下一 flush 继续）')
      pending = planSync(this.state, this.segments, this.tunables.cardMaxBytes, this.tunables.processMaxBytes, this.tunables.cardPrintStep).ops
    }
  }

  /**
   * 单个 op：成功（或 insert 300301 视同成功）才 commit；
   * 失败按错误码分类：流式超时重激活重放 / 200860 废弃续写 / 未知错误 seq+2 重放一次。
   */
  private async execOne(planned: PlannedOp): Promise<'ok' | 'abandoned'> {
    const { op } = planned
    if (op.type === 'noop') {
      this.commit(planned)
      return 'ok'
    }
    if (op.type === 'replace') {
      // 纯显示修复：失败不进失败分类治理（内容早已正确在卡），重试一次后记日志、照常 commit。
      // cardId 为 PENDING 占位时（同一次 planSync 内建卡即拆卡）解析为紧邻前一个关流 settings 的真实 id。
      const cardId = op.cardId === PENDING_CARD_ID ? this.closedCardId : op.cardId
      if (cardId === null || cardId === PENDING_CARD_ID) {
        this.log('[project-bot] 关流后全量重放跳过：取不到真实 cardId')
        this.commit(planned)
        return 'ok'
      }
      try {
        await withRetry(() => this.api.replaceCard(cardId, op.cardJson, op.sequence), 2)
      } catch (error) {
        this.log(`[project-bot] 关流后全量重放失败（不影响内容）：${error instanceof Error ? error.message : String(error)}`)
      }
      this.commit(planned)
      return 'ok'
    }
    const liveCard = this.state.cardId !== null && this.state.cardId !== PENDING_CARD_ID
    try {
      await this.invokeThenCommit(planned)
      return 'ok'
    } catch (error) {
      // 建卡链路（尚无活卡）：状态未推进，抛给出站链日志，下次 flush 自然重试。
      if (!liveCard) throw error
      const code = feishuErrorCode(error)
      if (op.type === 'insert' && code === 300301) {
        // 元素重复 = 服务端已执行（此前响应丢失），视同成功。
        this.commit(planned)
        return 'ok'
      }
      if (code === 200850 || code === 200510) {
        // 流式被平台超时自动关闭：重激活（占一个 sequence）后以新 sequence 重放一次。
        if (await this.reactivate()) {
          try {
            await this.invokeThenCommit(planned, this.state.seq + 1)
            return 'ok'
          } catch {
            return this.abandon('流式超时重激活后重放失败', true)
          }
        }
        return this.abandon('流式超时且重激活失败', true)
      }
      if (code === 200860) {
        // 确定性超限：op 未被应用。废弃换卡，从确认点续写（不重演已显示部分）。
        return this.abandon('卡片超出平台大小上限', false)
      }
      // 未知/网络错误（op 可能已执行）：sequence 跳过可能已消耗的序号重放一次
      // （update/settings 幂等；insert 重演由 300301 兜底）。跳步按本次尝试的 sequence
      // 计（state.seq 是最后已确认序号，未包含本次尝试，用它 +2 会差一）。
      try {
        const retrySeq = (op.type === 'insert' || op.type === 'update' || op.type === 'settings' ? op.sequence : this.state.seq) + 2
        await this.invokeThenCommit(planned, retrySeq)
        return 'ok'
      } catch (retryError) {
        if (op.type === 'insert' && feishuErrorCode(retryError) === 300301) {
          this.commit(planned)
          return 'ok'
        }
        return this.abandon('卡片操作重放失败', true)
      }
    }
  }

  /**
   * 执行 API 并在成功后 commit；seqOverride 用于重放（create 的真实 cardId 在此覆盖进状态）。
   * 带序号 op 的发送/提交序号一律取 max(本次序号, 已确认 seq+1)：重放/重激活会推高已确认 seq，
   * 批内后续 op 的规划序号可能落后，照发会以非递增序号碰撞（平台可能视作幂等 no-op 静默丢 op →
   * 定格/关流 op 消失 → 卡死「输出中」）。
   */
  private async invokeThenCommit(planned: PlannedOp, seqOverride?: number): Promise<void> {
    const effectiveSeq = effectiveSeqOf(planned.op, seqOverride, this.state.seq)
    const op = withSeq(planned.op, effectiveSeq)
    if (op.type === 'create') {
      const id = await withRetry(() => this.api.createCard(op.cardJson))
      this.state = { ...planned.commit(this.state), cardId: id }
      return
    }
    if (op.type === 'send') {
      await withRetry(() => this.api.sendCardMessage(this.chatId, this.state.cardId!))
    } else if (op.type === 'insert') {
      await this.api.insertElement(this.state.cardId!, op.elementJson, STATUS_ELEMENT_ID, op.sequence)
    } else if (op.type === 'update') {
      await this.api.updateCardElement(this.state.cardId!, op.elementId, op.content, op.sequence)
    } else if (op.type === 'settings') {
      await this.api.setCardStreaming(this.state.cardId!, op.streaming, op.sequence, op.summary)
      if (!op.streaming) this.closedCardId = this.state.cardId
    }
    this.commit(planned, effectiveSeq)
  }

  private commit(planned: PlannedOp, seqOverride?: number): void {
    const next = planned.commit(this.state)
    // 建卡批次里 create 已把真实 cardId 叠入状态，后续 op 的规划快照仍带 PENDING 占位：
    // 占位符不得回写真实卡号，否则同批末尾的 insert/update 会对 __pending__ 发 op。
    const current = this.state.cardId
    const cardId = next.cardId === PENDING_CARD_ID && current !== null && current !== PENDING_CARD_ID
      ? current
      : next.cardId
    this.state = seqOverride !== undefined
      ? { ...next, seq: seqOverride, cardId }
      : { ...next, seq: Math.max(next.seq, this.state.seq), cardId }
  }

  /** 流式超时后的官方恢复路径：settings 重设 streaming_mode:true（占一个 sequence）。 */
  private async reactivate(): Promise<boolean> {
    const { cardId, seq } = this.state
    if (cardId === null || cardId === PENDING_CARD_ID) return false
    try {
      await this.api.setCardStreaming(cardId, true, seq + 1)
      this.state = { ...this.state, seq: seq + 1 }
      return true
    } catch {
      return false
    }
  }

  /**
   * 废弃当前卡：尽力关流 → cardId 归零、尾段回卷为 carry → 调用方重新规划续写。
   * reshowTail=true（未知失败，op 可能已执行）时从尾段 base 重演（少量重复优于丢失）；
   * reshowTail=false（200860 确定性未应用）时跳过已显示部分（零重复）。
   */
  private async abandon(reason: string, reshowTail: boolean): Promise<'abandoned'> {
    const { cardId, tail, seq } = this.state
    const hadRealCard = cardId !== null && cardId !== PENDING_CARD_ID
    if (hadRealCard) {
      await this.api.setCardStreaming(cardId as string, false, seq + 1).catch(() => undefined)
    }
    if (tail !== undefined) {
      const kind = this.segments[tail.segIndex]?.kind
      const base = kind === 'process' ? 0 : reshowTail ? tail.base : tail.base + tail.shownText.length
      this.state = {
        ...this.state,
        cardId: null,
        tail: undefined,
        closedSegCount: tail.segIndex,
        carry: { segIndex: tail.segIndex, base },
        cardSegs: [],
      }
    } else {
      this.state = { ...this.state, cardId: null, cardSegs: [] }
    }
    this.log(`[project-bot] 卡片输出异常（${reason}），已废弃当前卡并在新卡继续`)
    if (hadRealCard) {
      await withRetry(() => this.api.sendText(this.chatId, ABANDON_NOTICE)).catch(() => undefined)
    }
    return 'abandoned'
  }

  private enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((error) => {
      this.log(`[project-bot] 卡片操作失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

/** 重放用：仅带 sequence 语义的 op 替换序号（create/send 无序号）。 */
function withSeq(op: CardOp, sequence: number | undefined): CardOp {
  if (sequence === undefined) return op
  if (op.type === 'insert') return { ...op, sequence }
  if (op.type === 'update') return { ...op, sequence }
  if (op.type === 'settings') return { ...op, sequence }
  return op
}

/**
 * 带序号 op 的生效 sequence（create/send 返回 undefined = 不占序号）：
 * 重放/重激活推高已确认 seq 后，规划或重放序号落后时抬升到已确认 seq+1，保证单调不碰撞。
 */
function effectiveSeqOf(op: CardOp, override: number | undefined, confirmedSeq: number): number | undefined {
  if (op.type !== 'insert' && op.type !== 'update' && op.type !== 'settings') return undefined
  return Math.max(override ?? op.sequence, confirmedSeq + 1)
}

/** 「处理中」表情：加上后返回删除 disposer；加/删失败都静默（表情残留无害）。 */
export function makeAck(api: FeishuApi, messageId: string, emojiType: string): () => Promise<Disposer | undefined> {
  return async () => {
    try {
      const reactionId = await api.addReaction(messageId, emojiType)
      return () => {
        void api.removeReaction(messageId, reactionId).catch(() => undefined)
      }
    } catch {
      return undefined
    }
  }
}
