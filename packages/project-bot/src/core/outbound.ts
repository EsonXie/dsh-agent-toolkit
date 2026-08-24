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

export function mapTurnEnd(reason: string): TurnStatus {
  if (reason === 'completed') return 'done'
  if (reason === 'aborted' || reason === 'interrupted') return 'cancelled'
  return 'error'
}

export class Outbound {
  constructor(
    private readonly sessions: Map<string, SessionRuntime>,
    private readonly onError: (message: string) => void,
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
      const status = mapTurnEnd(event.data.reason as string)
      this.enqueue(rt, async () => {
        if (turn.began && rt.reply !== undefined) await rt.reply.finalize(status)
        const ack = rt.inflight?.ack
        rt.inflight = undefined
        if (ack !== undefined) await ack()
      })
      rt.turn = undefined
    }
  }

  private enqueue(rt: SessionRuntime, task: () => Promise<void>): void {
    rt.tail = rt.tail.then(task).catch((error) => {
      this.onError(`[project-bot] 出站处理失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
