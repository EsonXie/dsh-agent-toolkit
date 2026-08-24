/** 出站句柄：turn 级流式卡片（节流合并 + 拆卡 + 定格着色）与表情回复。 */
import type { ChannelTunables, Disposer, ReplyHandle, TurnStatus } from '../../core/channel.ts'
import type { FeishuApi } from './api.ts'
import {
  CARD_ELEMENT_ID, initialStreamState, PENDING_CARD_ID,
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
  private buffer = ''
  private tail: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private finalized = false

  constructor(
    private readonly api: FeishuApi,
    private readonly chatId: string,
    private readonly tunables: ChannelTunables,
    private readonly title: string,
    private readonly log: (message: string) => void,
  ) {}

  /** 惰性建卡：无文本输出的 turn 不产生空卡片。 */
  beginTurn(): Promise<void> {
    return Promise.resolve()
  }

  update(markdown: string): Promise<void> {
    if (this.finalized) return Promise.resolve()
    this.buffer = markdown
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
    const content = this.buffer.slice(this.state.offset, this.state.shownLen)
    const { ops } = planFinalize(this.state, content, status, this.title)
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
    if (this.buffer.length <= this.state.shownLen) return
    const planned = planSync(this.state, this.buffer, this.tunables.cardMaxBytes, this.title)
    this.state = planned.state
    this.enqueue(() => this.exec(planned.ops))
  }

  private enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((error) => {
      // 建卡链路失败：回到未建卡状态，让下一次 flush 重新创建。
      if (this.state.cardId === PENDING_CARD_ID) this.state = { ...this.state, cardId: null }
      this.log(`[project-bot] 卡片操作失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async exec(ops: readonly CardOp[]): Promise<void> {
    for (const op of ops) {
      if (op.type === 'create') {
        this.state.cardId = await withRetry(() => this.api.createCard(op.cardJson))
      } else if (op.type === 'send') {
        await withRetry(() => this.api.sendCardMessage(this.chatId, this.state.cardId!))
      } else if (op.type === 'update') {
        await withRetry(() => this.api.updateCardElement(this.state.cardId!, CARD_ELEMENT_ID, op.content, op.sequence))
      } else if (op.type === 'settings') {
        await withRetry(() => this.api.setCardStreaming(this.state.cardId!, op.streaming, op.sequence))
      } else {
        await withRetry(() => this.api.replaceCard(this.state.cardId!, op.cardJson, op.sequence))
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
