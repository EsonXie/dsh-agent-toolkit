/** 出站句柄：turn 级流式卡片（节流合并 + 拆卡 + 定格着色）与表情回复。 */
import type { ChannelTunables, Disposer, ReplyHandle, TurnSegment, TurnStatus } from '../channel.ts'
import type { FeishuApi } from './api.ts'
import {
  initialStreamState, PENDING_CARD_ID, STATUS_ELEMENT_ID,
  planFinalize, planSync, type CardOp, type StreamState,
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

export class FeishuReplyHandle implements ReplyHandle {
  private state: StreamState = initialStreamState()
  private segments: readonly TurnSegment[] = []
  private tail: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private finalized = false

  constructor(
    private readonly api: FeishuApi,
    private readonly chatId: string,
    private readonly tunables: ChannelTunables,
    private readonly log: (message: string) => void,
  ) {}

  /** 惰性建卡：无文本输出的 turn 不产生空卡片。 */
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
    // 等 flush 定局（含失败回退）后再规划定格：失败回退时按未建卡降级为文本，
    // 而不是按乐观状态对幻影卡发 update/settings。
    await this.tail
    const { ops } = planFinalize(this.state, status)
    this.enqueue(() => this.exec(ops))
    if (this.state.cardId === null && detail !== undefined) {
      this.enqueue(() => withRetry(() => this.api.sendText(this.chatId, detail)).then(() => undefined))
    }
    await this.tail
  }

  notice(text: string): Promise<void> {
    this.enqueue(() => withRetry(() => this.api.sendText(this.chatId, text)).then(() => undefined))
    return this.tail.then(() => undefined)
  }

  private flush(): void {
    const planned = planSync(this.state, this.segments, this.tunables.cardMaxBytes, this.tunables.processMaxBytes)
    if (planned.ops.length === 0) return
    this.state = planned.state
    this.enqueue(() => this.exec(planned.ops))
  }

  private enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((error) => {
      // 建卡链路失败（create 未返回，卡片从未可见）：回到未建卡状态，并把乐观推进的
      // tail 回卷为 carry（base 保持原位——幻影卡上什么都没真正显示），让下一次
      // flush 走 insert 分支重新建卡、完整插入未显示内容，而不是对 null 卡号发 update。
      if (this.state.cardId === PENDING_CARD_ID) {
        const t = this.state.tail
        this.state = {
          ...this.state,
          cardId: null,
          ...(t !== undefined
            ? { tail: undefined, carry: { segIndex: t.segIndex, base: t.base }, closedSegCount: t.segIndex }
            : {}),
        }
      }
      this.log(`[project-bot] 卡片操作失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async exec(ops: readonly CardOp[]): Promise<void> {
    for (const op of ops) {
      if (op.type === 'create') {
        this.state.cardId = await withRetry(() => this.api.createCard(op.cardJson))
      } else if (op.type === 'send') {
        await withRetry(() => this.api.sendCardMessage(this.chatId, this.state.cardId!))
      } else if (op.type === 'insert') {
        await withRetry(() => this.api.insertElement(this.state.cardId!, op.elementJson, STATUS_ELEMENT_ID, op.sequence))
      } else if (op.type === 'update') {
        await withRetry(() => this.api.updateCardElement(this.state.cardId!, op.elementId, op.content, op.sequence))
      } else {
        await withRetry(() => this.api.setCardStreaming(this.state.cardId!, op.streaming, op.sequence, op.summary))
      }
    }
  }
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
