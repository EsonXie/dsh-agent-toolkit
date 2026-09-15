/** 出站：持久会话事件 + 瞬态流式帧 → turn 级回复驱动（per-session Promise 链保序）。 */
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { TurnSegment, TurnStatus, DebugSink } from './channel.ts'
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

/** 从 assistant 消息内容块取最后一个 text 块的纯文本；无 text 块返回 ''（非 undefined）。 */
export function lastTextOf(content: readonly unknown[]): string {
  const texts = (content as readonly { type?: unknown; text?: unknown }[])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
  return texts.length === 0 ? '' : texts[texts.length - 1]!
}

/** 工具调用参数摘要最大字符数。 */
export const TOOL_ARGS_MAX_CHARS = 120

/** 向段序列追加内容：与尾段同类则合并，异类开新段。 */
export function appendToSegments(segments: TurnSegment[], kind: 'text' | 'process', text: string): void {
  const tail = segments[segments.length - 1]
  if (tail !== undefined && tail.kind === kind) tail.content += text
  else segments.push({ kind, content: text })
}

/** 向段序列应用一个流式 chunk：text-delta → text、reasoning-delta → process、reasoning block-end → 过程段段落分隔；其余类型不消费返回 false。 */
export function applyStreamChunk(segments: TurnSegment[], chunk: StreamChunk): boolean {
  if (chunk.type === 'text-delta') {
    appendToSegments(segments, 'text', chunk.text)
  } else if (chunk.type === 'reasoning-delta') {
    appendToSegments(segments, 'process', chunk.text)
  } else if (chunk.type === 'block-end' && chunk.block?.type === 'reasoning' && segments[segments.length - 1]?.kind === 'process') {
    appendToSegments(segments, 'process', '\n\n')
  } else {
    return false
  }
  return true
}

/**
 * 对账尾 text 段：把最后一个 text 段的内容替换为权威全文（丢帧补齐）。
 * 前置条件：调用方已保证尾 text 段归属本结算 step（lastTextStep 命中结算 step）。
 * 返回是否发生替换；authoritative 为空、无 text 段或内容已相等时返回 false。
 */
export function reconcileTrailingText(segments: TurnSegment[], authoritative: string): boolean {
  if (authoritative === '') return false
  let tail: TurnSegment | undefined
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]!.kind === 'text') {
      tail = segments[i]!
      break
    }
  }
  if (tail === undefined || tail.content === authoritative) return false
  tail.content = authoritative
  return true
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
    /** 槽位释放后同步触发（核心侧排水排队消息）；实现须同步完成占槽转移，先于删表情返回。 */
    private readonly onTurnIdle?: (rt: SessionRuntime) => void,
    /** 生产调试事件 sink（reconcile/frame-stats；缺省不记录）。 */
    private readonly debugLog?: DebugSink,
  ) {}

  handleSessionEvent(sessionId: string, event: SessionEventLike): void {
    const rt = this.sessions.get(sessionId)
    if (rt === undefined) return

    if (event.type === 'turn/start') {
      rt.turn = { n: event.data.turn as number, segments: [], began: false, stats: { starts: 0, textDeltas: 0, reasoningDeltas: 0, droppedNoBaseline: 0 } }
      return
    }

    if (event.type === 'assistant/message') {
      const turn = rt.turn
      if (turn === undefined || turn.n !== (event.data.turn as number)) return
      const step = event.data.step as number
      const content = (event.data.message as { content?: readonly unknown[] }).content ?? []
      // 权威文本 = 全部 text 块拼接（与流式合并语义对齐；多 text 块消息不丢前块）。
      const authoritative = textOf(content)
      let tailLen: number | undefined
      for (let i = turn.segments.length - 1; i >= 0; i--) {
        if (turn.segments[i]!.kind === 'text') { tailLen = turn.segments[i]!.content.length; break }
      }
      let result: 'replaced' | 'appended' | 'skipped-noop' | 'skipped-empty'
      if (turn.lastTextStep === step) {
        // 防护（必需）：尾 text 段归属本结算 step 才替换，否则篡改上一步已提交正文（宁缺勿错）。
        result = reconcileTrailingText(turn.segments, authoritative) ? 'replaced' : 'skipped-noop'
      } else if (authoritative !== '') {
        // 本 step 正文一帧没应用（start 帧丢/帧全丢）：append 新段补回，不篡改已显示内容。
        appendToSegments(turn.segments, 'text', authoritative)
        result = 'appended'
      } else {
        result = 'skipped-empty'
      }
      this.debugLog?.({ event: 'reconcile', sessionId, chatId: rt.chatId, turn: turn.n, step, result, tailLen, authoritativeLen: authoritative.length })
      if (result === 'skipped-noop' || result === 'skipped-empty') return
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

    // assistant/attempt：该 attempt 无表面消息（失败/重试/取消无内容/流错误），不消费；
    // 已通过帧显示的过程区内容留在段里，由 turn/end 兜底定格。

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
      if (turn.stats !== undefined) {
        this.debugLog?.({ event: 'frame-stats', sessionId, chatId: rt.chatId, turn: turn.n, ...turn.stats, lastTextStep: turn.lastTextStep })
      }
      const reason = event.data.reason as TurnEndReasonLike
      const status = mapTurnEnd(reason)
      const detail = errorDetailOf(reason, this.maxErrorDetailChars)
      this.enqueue(rt, async () => {
        // 有卡定格；无卡但有错误 detail 时也要调 finalize（渠道降级为文本送出）。
        if ((turn.began || detail !== undefined) && rt.reply !== undefined) await rt.reply.finalize(status, detail)
        const ack = rt.inflight?.ack
        rt.inflight = undefined
        // 排水先于删表情：占槽转移须同步完成（inflight 空 ⇒ 队列空 不变量），否则与新到消息双发。
        this.onTurnIdle?.(rt)
        if (ack !== undefined) await ack()
      })
      rt.turn = undefined
    }
  }

  /**
   * 出站：瞬态流式帧 → 段构建 + 打字机。chunk 帧不携带 turn/step，由 start 帧建 attempt 基线
   * （turn/step，宿主 accumulator 同款取数）；end 帧不消费；生命周期仍由 turn/start、turn/end 驱动。
   * 帧为 fire-and-forget，丢帧后无重传，正文由 assistant/message 结算对账有界恢复。
   */
  handleAssistantFrame(sessionId: string, frame: AssistantStreamFrame): void {
    const rt = this.sessions.get(sessionId)
    if (rt === undefined) return
    const turn = rt.turn
    if (turn === undefined) return
    if (frame.type === 'start') {
      if (turn.n !== frame.turn) return
      turn.attemptStep = frame.step
      if (turn.stats !== undefined) turn.stats.starts += 1
      return
    }
    if (frame.type !== 'chunk') return
    // start 帧丢失 → attemptStep 基线缺失，chunk 帧全部忽略：本 attempt 的正文+过程区同时缺席
    // （比对账「只缺正文」的降级更广，assistant/message 对账因 lastTextStep 不匹配同样跳过）。
    // 方向安全：不伪造内容，宁缺勿错（spec「防护的覆盖范围」段）。
    const step = turn.attemptStep
    if (step === undefined) {
      if (turn.stats !== undefined && (frame.chunk.type === 'text-delta' || frame.chunk.type === 'reasoning-delta')) turn.stats.droppedNoBaseline += 1
      return
    }
    if (!applyStreamChunk(turn.segments, frame.chunk)) return
    if (turn.stats !== undefined) {
      if (frame.chunk.type === 'text-delta') turn.stats.textDeltas += 1
      else if (frame.chunk.type === 'reasoning-delta') turn.stats.reasoningDeltas += 1
    }
    if (frame.chunk.type === 'text-delta') turn.lastTextStep = step   // 对账防护：尾 text 段的归属 step
    const snapshot = turn.segments.map((s) => ({ ...s }))
    this.enqueue(rt, async () => {
      if (rt.reply === undefined) return
      if (!turn.began) {
        await rt.reply.beginTurn()
        turn.began = true
      }
      await rt.reply.update(snapshot)
    })
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
      this.onTurnIdle?.(rt)
      if (ack !== undefined) await ack()
    })
  }

  private enqueue(rt: SessionRuntime, task: () => Promise<void>): void {
    rt.tail = rt.tail.then(task).catch((error) => {
      this.onError(`[project-bot] 出站处理失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
