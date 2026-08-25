/** 出站：持久会话事件 → turn 级回复驱动（per-session Promise 链保序）。 */
import type { TurnStatus } from './channel.ts'
import type { SessionRuntime } from './ports.ts'

/** 窄化的事件信封：核心只读 type/data。 */
export interface SessionEventLike {
  type: string
  data: Record<string, unknown>
}

/** 从 assistant 消息内容块提取纯文本（只取 text 块；工具调用等不进卡片）。 */
export function textOf(content: readonly unknown[]): string {
  return (content as readonly { type?: unknown; text?: unknown }[])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** turn/end 的 reason 形状（宿主 TurnEndReason 的窄化视图：核心只读 kind 与 error.message）。 */
export interface TurnEndReasonLike {
  kind: string
  error?: { message?: unknown }
}

export function mapTurnEnd(reason: TurnEndReasonLike): TurnStatus {
  if (reason.kind === 'completed') return 'done'
  if (reason.kind === 'aborted' || reason.kind === 'interrupted') return 'cancelled'
  return 'error'
}

/** 截断错误摘要到 max 字符，超出追加省略号。 */
export function truncateDetail(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 从 turn/end reason 提取错误摘要；非 error 或无 message 返回 undefined。 */
function errorDetailOf(reason: TurnEndReasonLike, max: number): string | undefined {
  if (reason.kind !== 'error') return undefined
  const message = reason.error?.message
  const text = typeof message === 'string' && message.length > 0 ? message : '未知错误'
  return truncateDetail(text, max)
}

export class Outbound {
  constructor(
    private readonly sessions: Map<string, SessionRuntime>,
    private readonly onError: (message: string) => void,
    /** 回传渠道的错误摘要最大字符数。 */
    private readonly maxErrorDetailChars = 500,
  ) {}

  handleSessionEvent(sessionId: string, event: SessionEventLike): void {
    const rt = this.sessions.get(sessionId)
    if (rt === undefined) return

    if (event.type === 'turn/start') {
      rt.turn = { n: event.data.turn as number, buffer: '', began: false }
      return
    }

    if (event.type === 'assistant/message') {
      const turn = rt.turn
      if (turn === undefined || turn.n !== (event.data.turn as number)) return
      const text = textOf((event.data.message as { content: readonly unknown[] }).content)
      if (text.length === 0) return
      turn.buffer += text
      const snapshot = turn.buffer
      this.enqueue(rt, async () => {
        if (rt.reply === undefined) return
        if (!turn.began) {
          await rt.reply.beginTurn()
          turn.began = true
        }
        await rt.reply.update(snapshot)
      })
      return
    }

    if (event.type === 'turn/end') {
      const turn = rt.turn
      if (turn === undefined || turn.n !== (event.data.turn as number)) return
      const reason = event.data.reason as TurnEndReasonLike
      const status = mapTurnEnd(reason)
      const detail = errorDetailOf(reason, this.maxErrorDetailChars)
      this.enqueue(rt, async () => {
        // 有卡定格；无卡但有错误 detail 时也要调 finalize（渠道降级为文本送出）。
        if ((turn.began || detail !== undefined) && rt.reply !== undefined) await rt.reply.finalize(status, detail)
        const ack = rt.inflight?.ack
        rt.inflight = undefined
        if (ack !== undefined) await ack()
      })
      rt.turn = undefined
    }
  }

  /**
   * turn 外错误（agent/error：resume/驱动边界失败等没有 turn/end 的场景）：
   * notice 错误摘要并释放 inflight 槽 + 删除表情；turn 进行中的错误由 turn/end 报告，跳过防双发。
   */
  handleAgentError(sessionId: string, errorText: string): void {
    const rt = this.sessions.get(sessionId)
    if (rt === undefined || rt.turn !== undefined) return
    const detail = truncateDetail(errorText, this.maxErrorDetailChars)
    this.enqueue(rt, async () => {
      if (rt.reply !== undefined) await rt.reply.notice(`出错了：${detail}`)
      const ack = rt.inflight?.ack
      rt.inflight = undefined
      if (ack !== undefined) await ack()
    })
  }

  private enqueue(rt: SessionRuntime, task: () => Promise<void>): void {
    rt.tail = rt.tail.then(task).catch((error) => {
      this.onError(`[project-bot] 出站处理失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
