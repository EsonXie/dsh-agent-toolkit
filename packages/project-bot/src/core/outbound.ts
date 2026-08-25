/** 出站：持久会话事件 → turn 级回复驱动（per-session Promise 链保序）。 */
import type { TurnSegment, TurnStatus } from './channel.ts'
import type { SessionRuntime } from './ports.ts'

/** 窄化的事件信封：核心只读 type/data。 */
export interface SessionEventLike {
  type: string
  data: Record<string, unknown>
}

/** 从 assistant 消息内容块提取正文纯文本（只取 text 块进正文；reasoning/tool_call 由 processOf 进过程区）。 */
export function textOf(content: readonly unknown[]): string {
  return (content as readonly { type?: unknown; text?: unknown }[])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** 工具调用参数摘要最大字符数。 */
export const TOOL_ARGS_MAX_CHARS = 120

/** 向段序列追加内容：与尾段同类则合并，异类开新段。 */
export function appendToSegments(segments: TurnSegment[], kind: 'text' | 'process', text: string): void {
  const tail = segments[segments.length - 1]
  if (tail !== undefined && tail.kind === kind) tail.content += text
  else segments.push({ kind, content: text })
}

/** （保留供测试）从组装消息提取过程输出：reasoning 全文 + tool_call 摘要行（段落间空行分隔）。 */
export function processOf(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const b of content as readonly { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown }[]) {
    if (b.type === 'reasoning' && typeof b.text === 'string' && b.text.length > 0) {
      parts.push(b.text)
    } else if (b.type === 'tool_call' && typeof b.name === 'string') {
      const args = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {})
      parts.push(`🔧 ${b.name} — ${truncateDetail(args, TOOL_ARGS_MAX_CHARS)}`)
    }
  }
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n\n`
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
      rt.turn = { n: event.data.turn as number, segments: [], began: false }
      return
    }

    if (event.type === 'assistant/chunk') {
      const turn = rt.turn
      if (turn === undefined || turn.n !== (event.data.turn as number)) return
      const chunk = event.data.chunk as { type: string; text?: string; block?: { type?: unknown } }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        appendToSegments(turn.segments, 'text', chunk.text)
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        appendToSegments(turn.segments, 'process', chunk.text)
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'reasoning' && turn.segments[turn.segments.length - 1]?.kind === 'process') {
        appendToSegments(turn.segments, 'process', '\n\n')   // 推理块段落分隔
      } else {
        return
      }
      const snapshot = turn.segments.map((s) => ({ ...s }))
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

    if (event.type === 'tool/call') {
      const turn = rt.turn
      if (turn === undefined || turn.n !== (event.data.turn as number)) return
      const name = event.data.name as string
      const args = typeof event.data.arguments === 'string' ? event.data.arguments : JSON.stringify(event.data.arguments ?? {})
      appendToSegments(turn.segments, 'process', `🔧 ${name} — ${truncateDetail(args, TOOL_ARGS_MAX_CHARS)}\n\n`)
      const snapshot = turn.segments.map((s) => ({ ...s }))
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
