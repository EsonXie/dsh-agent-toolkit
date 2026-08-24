/** 飞书卡片纯函数：JSON 2.0 构建、UTF-8 字节切分、流式操作规划（拆卡决策全在这里）。 */
import type { TurnStatus } from '../../core/channel.ts'

export const CARD_ELEMENT_ID = 'md'

/** create 未返回真实 card_id 前的占位哨兵（executor 赋值；防并发 flush 重复建卡）。 */
export const PENDING_CARD_ID = '__pending__'

/** 按 UTF-8 字节上限截断，不劈开多字节字符与代理对。 */
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

export type CardTemplate = 'blue' | 'green' | 'red' | 'grey'

export function buildCardJson(opts: { title: string; content: string; streaming: boolean; template: CardTemplate }): string {
  return JSON.stringify({
    schema: '2.0',
    header: { template: opts.template, title: { content: opts.title, tag: 'plain_text' } },
    config: {
      streaming_mode: opts.streaming,
      ...(opts.streaming
        ? { summary: { content: '生成中…' }, streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: 'fast' } }
        : {}),
    },
    body: { elements: [{ tag: 'markdown', content: opts.content, element_id: CARD_ELEMENT_ID }] },
  })
}

export interface StreamState {
  /** 当前卡片 id（PENDING_CARD_ID = 创建中）；null = 下一张卡待创建。 */
  cardId: string | null
  /** 当前卡片已消耗的 sequence 计数（create/send 不占）。 */
  seq: number
  /** 当前卡片内容在 fullText 中的起始偏移（跨卡累计）。 */
  offset: number
  /** fullText 已提交到卡片的前缀长度（跨卡累计）。 */
  shownLen: number
}

export const initialStreamState = (): StreamState => ({ cardId: null, seq: 0, offset: 0, shownLen: 0 })

export type CardOp =
  | { type: 'create'; cardJson: string }
  | { type: 'send' }
  | { type: 'update'; content: string; sequence: number }
  | { type: 'settings'; streaming: boolean; sequence: number }
  | { type: 'replace'; cardJson: string; sequence: number }

/** 把 fullText 的新增部分同步到卡片；满卡自动关流并开续卡。 */
export function planSync(state: StreamState, fullText: string, maxBytes: number, title: string): { state: StreamState; ops: CardOp[] } {
  if (fullText.length <= state.shownLen) return { state, ops: [] }
  const ops: CardOp[] = []
  let { cardId, seq, offset, shownLen } = state
  while (shownLen < fullText.length) {
    const capacity = sliceByBytes(fullText.slice(offset), maxBytes).length
    if (capacity <= 0) throw new Error(`cardMaxBytes=${maxBytes} 过小，连一个字符都容纳不了`)
    const fits = fullText.length - offset <= capacity
    const content = fits ? fullText.slice(offset) : fullText.slice(offset, offset + capacity)
    if (cardId === null) {
      ops.push({ type: 'create', cardJson: buildCardJson({ title, content, streaming: true, template: 'blue' }) })
      ops.push({ type: 'send' })
      cardId = PENDING_CARD_ID
      seq = 0
    } else if (content.length > shownLen - offset) {
      seq += 1
      ops.push({ type: 'update', content, sequence: seq })
    }
    shownLen = offset + content.length
    if (fits) break
    seq += 1
    ops.push({ type: 'settings', streaming: false, sequence: seq })
    cardId = null
    offset = shownLen
  }
  return { state: { cardId, seq, offset, shownLen }, ops }
}

/** 定格：关流式 + 按状态换头色（全量替换保持正文不变）。 */
export function planFinalize(state: StreamState, currentContent: string, status: TurnStatus, title: string): { ops: CardOp[] } {
  if (state.cardId === null) return { ops: [] }
  const template: CardTemplate = status === 'done' ? 'green' : status === 'error' ? 'red' : 'grey'
  return {
    ops: [
      { type: 'settings', streaming: false, sequence: state.seq + 1 },
      { type: 'replace', cardJson: buildCardJson({ title, content: currentContent, streaming: false, template }), sequence: state.seq + 2 },
    ],
  }
}
