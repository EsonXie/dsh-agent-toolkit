/** 飞书卡片纯函数：JSON 2.0 构建、UTF-8 字节切分、段序列流式操作规划（拆卡决策全在这里）。 */
import type { TurnSegment, TurnStatus } from '../channel.ts'

export type { TurnSegment }

export const STATUS_ELEMENT_ID = 'status'

/** create 未返回真实 card_id 前的占位哨兵（executor 赋值；防并发 flush 重复建卡）。 */
export const PENDING_CARD_ID = '__pending__'

/** 过程区截尾后的头部省略标记。 */
export const PROCESS_OMITTED = '…（已省略前文）\n'

/** 输出中状态行文案。 */
const STATUS_STREAMING = '⏳ 输出中…'

/** 定格状态行文案。 */
const STATUS_FINAL: Record<TurnStatus, string> = {
  done: '✅ 输出完成',
  error: '❌ 输出出错',
  cancelled: '⏹ 已取消',
}

/** 拆卡定格状态行文案（旧卡内容已接续到下一张卡片）。 */
export const STATUS_CONTINUED = '📦 内容较长，已接续到下一张卡片'

/** 单卡组件数安全上限（飞书硬上限 200；面板按 2 计：面板 + 内嵌 markdown）。 */
const CARD_ELEMENT_LIMIT = 190

/** 按 UTF-8 字节上限截头（保留头部），不劈开多字节字符与代理对。 */
export function sliceByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid
    else hi = mid - 1
  }
  let cut = lo
  if (cut > 0) {
    const code = text.charCodeAt(cut - 1)
    if (code >= 0xd8_00 && code <= 0xdb_ff) cut -= 1   // 高位代理在末尾：整对移除
  }
  return text.slice(0, cut)
}

/** 按 UTF-8 字节上限截尾（保留尾部），不劈开多字节字符与代理对；截断时头部加省略标记。 */
export function sliceTailByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const budget = maxBytes - Buffer.byteLength(PROCESS_OMITTED, 'utf8')
  if (budget <= 0) throw new Error(`processMaxBytes=${maxBytes} 过小，连省略标记都容纳不了`)
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (Buffer.byteLength(text.slice(mid), 'utf8') <= budget) hi = mid
    else lo = mid + 1
  }
  let cut = lo
  if (cut < text.length) {
    const code = text.charCodeAt(cut)
    if (code >= 0xdc_00 && code <= 0xdf_ff) cut += 1   // 低位代理在开头：整对移除
  }
  return PROCESS_OMITTED + text.slice(cut)
}

/** JSON 串内内容的转义后字节数（去首尾引号）；卡片 DSL 真实字节记账用。 */
export function escapedLen(s: string): number {
  return Buffer.byteLength(JSON.stringify(s), 'utf8') - 2
}

/** 按转义后字节上限截头（保留头部），不劈开多字节字符与代理对。 */
export function sliceByEscapedBytes(text: string, maxBytes: number): string {
  if (escapedLen(text) <= maxBytes) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (escapedLen(text.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  let cut = lo
  if (cut > 0) {
    const code = text.charCodeAt(cut - 1)
    if (code >= 0xd8_00 && code <= 0xdb_ff) cut -= 1
  }
  return text.slice(0, cut)
}

/** 新卡：仅状态行的流式卡；段后续经插入组件 API 动态加入。 */
export function buildCardJson(printStep: number): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: '生成中…' },
      streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: printStep }, print_strategy: 'fast' },
    },
    body: { elements: [{ tag: 'markdown', content: STATUS_STREAMING, element_id: STATUS_ELEMENT_ID }] },
  })
}

/** 段元素 JSON（insert op 负载）：process = 默认收起折叠面板；text = 纯 markdown。 */
export function buildSegmentJson(kind: 'text' | 'process', elementId: string, content: string): string {
  if (kind === 'process') {
    return JSON.stringify({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: '思考与工具调用过程' } },
      elements: [{ tag: 'markdown', content, element_id: elementId }],
    })
  }
  return JSON.stringify({ tag: 'markdown', content, element_id: elementId })
}

export interface StreamState {
  /** 当前卡片 id（PENDING_CARD_ID = 创建中）；null = 下一张卡待创建。 */
  cardId: string | null
  /** 当前卡片已消耗的 sequence 计数（create/send 不占）。 */
  seq: number
  /** 当前卡已提交内容字节数（段内容 + 固定开销合计）。 */
  cardBytes: number
  /** 当前卡组件数（含状态行；面板按 2 计）。 */
  cardElements: number
  /** 全局段计数（element_id 生成用，跨卡递增）。 */
  segCounter: number
  /** 已在历史卡封闭、不再关注的段数（段 0..closedSegCount-1）。 */
  closedSegCount: number
  /** 当前卡上打开的段（永远是最新的有内容段）；base = 元素内容在该段 content 中的 char 起始偏移（process 恒 0）。 */
  tail: { segIndex: number; elementId: string; base: number; shownText: string } | undefined
  /** text 段跨卡续写基准（char offset into 该段 content）。 */
  carry: { segIndex: number; base: number } | undefined
}

export const initialStreamState = (): StreamState => ({
  cardId: null, seq: 0, cardBytes: 0, cardElements: 0, segCounter: 0,
  closedSegCount: 0, tail: undefined, carry: undefined,
})

export type CardOp =
  | { type: 'create'; cardJson: string }
  | { type: 'send' }
  | { type: 'insert'; elementJson: string; sequence: number }
  | { type: 'update'; elementId: string; content: string; sequence: number }
  | { type: 'settings'; streaming: boolean; sequence: number; summary?: string }
  | { type: 'noop' }

export interface PlannedOp {
  op: CardOp
  /** 该 op 成功后的状态迁移（快照整体替换）。 */
  commit: (s: StreamState) => StreamState
}

/** 把段序列的新增部分同步到卡片；新段 insert 到状态行之前，尾段增长走元素 update，满卡关流开续卡。 */
export function planSync(
  state: StreamState,
  segments: readonly TurnSegment[],
  maxBytes: number,
  processMaxBytes: number,
  printStep: number,
): { ops: PlannedOp[] } {
  const ops: PlannedOp[] = []
  let { cardId, seq, cardBytes, cardElements, segCounter, closedSegCount, tail, carry } = state

  /** 约定：先改规划局部变量再 push——commit 捕获该 op 完成后的状态快照。 */
  const push = (op: CardOp): void => {
    const snap = { cardId, seq, cardBytes, cardElements, segCounter, closedSegCount, tail, carry }
    ops.push({ op, commit: () => ({ ...snap }) })
  }

  const ensureCard = (): void => {
    if (cardId !== null) return
    const cardJson = buildCardJson(printStep)
    cardId = PENDING_CARD_ID
    seq = 0
    cardBytes = Buffer.byteLength(cardJson, 'utf8')   // 真实 DSL 字节
    cardElements = 1
    push({ type: 'create', cardJson })
    push({ type: 'send' })
  }

  const closeCard = (): void => {
    // 先定格状态行（流式还开着，组件 content API 需要流式模式），再关流 + summary。
    seq += 1
    push({ type: 'update', elementId: STATUS_ELEMENT_ID, content: STATUS_CONTINUED, sequence: seq })
    seq += 1
    cardId = null
    tail = undefined
    push({ type: 'settings', streaming: false, sequence: seq, summary: STATUS_CONTINUED })
  }

  let i = tail?.segIndex ?? closedSegCount
  while (i < segments.length) {
    const seg = segments[i]
    const content = seg.kind === 'process' ? sliceTailByBytes(seg.content, processMaxBytes) : seg.content
    const base = tail !== undefined && tail.segIndex === i
      ? tail.base
      : carry?.segIndex === i ? carry.base : 0
    const elementContent = seg.kind === 'text' ? content.slice(base) : content

    if (tail !== undefined && tail.segIndex === i) {
      // 当前卡上的打开段：内容增长走 update
      if (elementContent !== tail.shownText) {
        const delta = escapedLen(elementContent) - escapedLen(tail.shownText)
        if (cardBytes + delta <= maxBytes) {
          seq += 1
          cardBytes += delta
          tail = { ...tail, shownText: elementContent }
          push({ type: 'update', elementId: tail.elementId, content: elementContent, sequence: seq })
        } else if (seg.kind === 'text') {
          // 部分更新到满 → 拆卡，剩余经 carry 续写（预算按转义后字节）
          const piece = sliceByEscapedBytes(elementContent, escapedLen(tail.shownText) + (maxBytes - cardBytes))
          if (piece.length > tail.shownText.length) {
            seq += 1
            cardBytes += escapedLen(piece) - escapedLen(tail.shownText)
            tail = { ...tail, shownText: piece }
            push({ type: 'update', elementId: tail.elementId, content: piece, sequence: seq })
          }
          carry = { segIndex: i, base: tail.base + tail.shownText.length }
          closeCard()
          continue
        } else {
          // process：旧卡定格，续卡整窗重放
          closeCard()
          continue
        }
      }
      // 已完整同步：是最新段则保活收尾；有更新段则封闭前段
      if (i === segments.length - 1) break
      tail = undefined
      closedSegCount = i + 1
      carry = undefined
      i += 1
      continue
    }

    // 当前卡上还没有该段的元素 → insert
    if (seg.kind === 'process') {
      const elementId = `seg_${segCounter + 1}`
      const elementJson = buildSegmentJson('process', elementId, elementContent)
      const elBytes = Buffer.byteLength(elementJson, 'utf8')
      if (cardId !== null && (cardBytes + elBytes > maxBytes || cardElements + 2 > CARD_ELEMENT_LIMIT)) {
        closeCard()
        continue
      }
      ensureCard()
      // 过程窗口由 processMaxBytes 兜底（sliceTailByBytes 已截尾）；新卡整窗插入，不再受卡预算约束。
      segCounter += 1
      seq += 1
      cardBytes += elBytes
      cardElements += 2
      tail = { segIndex: i, elementId, base: 0, shownText: elementContent }
      push({ type: 'insert', elementJson, sequence: seq })
    } else {
      if (elementContent.length === 0) {   // 空 text 段不占卡
        closedSegCount = i + 1
        carry = undefined
        i += 1
        continue
      }
      if (cardId !== null && cardElements + 1 > CARD_ELEMENT_LIMIT) {
        closeCard()
        continue
      }
      ensureCard()
      const elementId = `seg_${segCounter + 1}`
      const overhead = Buffer.byteLength(buildSegmentJson('text', elementId, ''), 'utf8')
      const piece = sliceByEscapedBytes(elementContent, maxBytes - cardBytes - overhead)
      if (piece.length === 0) {
        throw new Error(`cardMaxBytes=${maxBytes} 过小，扣基础卡与元素开销后连一个字符都容纳不了`)
      }
      segCounter += 1
      const elementJson = buildSegmentJson('text', elementId, piece)
      seq += 1
      cardBytes += Buffer.byteLength(elementJson, 'utf8')
      cardElements += 1
      tail = { segIndex: i, elementId, base, shownText: piece }
      push({ type: 'insert', elementJson, sequence: seq })
      if (piece.length < elementContent.length) {
        carry = { segIndex: i, base: base + piece.length }
        closeCard()
        continue
      }
    }
    carry = undefined
    if (i === segments.length - 1) break
    tail = undefined
    closedSegCount = i + 1
    i += 1
  }
  // 段封闭/进位等纯状态推进也要交还执行侧：无 op 或末 op 之后状态仍有差异时补一个空操作 commit。
  // 简单起见：恒追加一个 no-op 规划项携带末态（执行侧对 type:'noop' 直接 commit，不调 API）。
  const snap = { cardId, seq, cardBytes, cardElements, segCounter, closedSegCount, tail, carry }
  ops.push({ op: { type: 'noop' }, commit: () => ({ ...snap }) })
  return { ops }
}

/** 定格：先 update 状态行（流式还开着），再关闭 + summary。 */
export function planFinalize(state: StreamState, status: TurnStatus): { ops: CardOp[] } {
  if (state.cardId === null) return { ops: [] }
  return {
    ops: [
      { type: 'update', elementId: STATUS_ELEMENT_ID, content: STATUS_FINAL[status], sequence: state.seq + 1 },
      { type: 'settings', streaming: false, sequence: state.seq + 2, summary: STATUS_FINAL[status] },
    ],
  }
}
