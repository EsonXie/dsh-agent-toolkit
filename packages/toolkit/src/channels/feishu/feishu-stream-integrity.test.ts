import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { FeishuReplyHandle } from './reply.ts'
import { Outbound } from '../outbound.ts'
import type { FeishuApi } from './api.ts'
import type { SessionRuntime } from '../ports.ts'

/** 构造一个 chunk 帧（attemptId/revision/time 宿主细节对 outbound 不消费，用占位；chunk 帧无 turn/step，由 start 帧建基线）。 */
function chunkFrame(chunk: StreamChunk): AssistantStreamFrame {
  return { type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 0, time: 0, chunk }
}

/** 构造一个 start 帧（attempt 的 turn/step 基线来源）。 */
function startFrame(turn: number, step: number): AssistantStreamFrame {
  return { type: 'start', attemptId: 'a1' as never, revision: 1, turn, step }
}

/** 模拟飞书服务端：卡片实体表 + 元素表，支持按调用序号注入错误；全部卡片 op 记录进 calls 供断言。 */
function fakeFeishu(failures: Map<string, number[]>) {
  // key = 'updateCardElement' 等 op 名，value = 第 N 次调用（1 起）注入 200860；空 = 全成功
  const cards = new Map<string, { elements: Map<string, string>; order: string[]; streaming: boolean; sent: boolean }>()
  const counters = new Map<string, number>()
  const calls: Array<{ op: string; args: unknown[] }> = []
  const record = (op: string, args: unknown[]): void => { calls.push({ op, args }) }
  const shouldFail = (op: string): boolean => {
    const n = (counters.get(op) ?? 0) + 1
    counters.set(op, n)
    return (failures.get(op) ?? []).includes(n)
  }
  const biz = (code: number) => Object.assign(new Error(`biz ${code}`), { response: { data: { code } } })
  let cardSeq = 0
  const api: FeishuApi = {
    createCard: async (cardJson) => {
      record('createCard', [cardJson])
      const id = `card_${++cardSeq}`
      cards.set(id, { elements: new Map([['status', '⏳ 输出中…']]), order: ['status'], streaming: true, sent: false })
      return id
    },
    sendCardMessage: async (_chat, cardId) => {
      record('sendCardMessage', [cardId])
      cards.get(cardId)!.sent = true
    },
    updateCardElement: async (cardId, elementId, content, sequence) => {
      record('updateCardElement', [cardId, elementId, content, sequence])
      if (shouldFail('updateCardElement')) throw biz(200860)
      if (!cards.get(cardId)!.streaming) throw biz(200850)
      cards.get(cardId)!.elements.set(elementId, content)
    },
    insertElement: async (cardId, elementJson, target, sequence) => {
      record('insertElement', [cardId, elementJson, target, sequence])
      if (shouldFail('insertElement')) throw biz(200860)
      if (!cards.get(cardId)!.streaming) throw biz(200850)
      const el = JSON.parse(elementJson)
      const id = el.tag === 'collapsible_panel' ? el.elements[0].element_id : el.element_id
      const content = el.tag === 'collapsible_panel' ? el.elements[0].content : el.content
      const card = cards.get(cardId)!
      card.order.splice(card.order.indexOf(target), 0, id)
      card.elements.set(id, content)
    },
    setCardStreaming: async (cardId, streaming, sequence, summary) => {
      record('setCardStreaming', [cardId, streaming, sequence, summary])
      cards.get(cardId)!.streaming = streaming
    },
    replaceCard: async (cardId, cardJson, sequence) => {
      record('replaceCard', [cardId, cardJson, sequence])
      // 全量重放：以 replace 负载重建卡片实体表（与增量 update/insert 同口径，重放内容参与渲染拼接断言）
      const card = cards.get(cardId)
      if (card === undefined) return
      const parsed = JSON.parse(cardJson) as {
        body: { elements: Array<{ tag: string; content?: string; element_id?: string; elements?: Array<{ content: string; element_id: string }> }> }
      }
      const elements = new Map<string, string>()
      const order: string[] = []
      for (const el of parsed.body.elements) {
        const id = el.tag === 'collapsible_panel' ? el.elements![0].element_id : el.element_id!
        const content = el.tag === 'collapsible_panel' ? el.elements![0].content : el.content!
        elements.set(id, content)
        order.push(id)
      }
      card.elements = elements
      card.order = order
    },
    sendText: async (_chat, text) => { record('sendText', [text]) },
    addReaction: async () => 'r1',
    removeReaction: async () => undefined,
    downloadImage: async () => ({ data: new Uint8Array(), mediaType: 'image/png' }),
    getBotOpenId: async () => 'ou_bot',
    uploadFile: async () => 'file_v3_xxx',
    sendFile: async () => undefined,
  }
  return { api, cards, calls }
}

type Feed = { kind: 'session'; event: { type: string; data: Record<string, unknown> } } | { kind: 'frame'; frame: AssistantStreamFrame }

/** 生成 40 轮「思考×8 + 工具行 + 正文×10 增量」的会话事件 + 帧流（driver 逐条喂 Outbound）。 */
function* events(turn: number): Generator<Feed> {
  yield { kind: 'session', event: { type: 'turn/start', data: { turn } } }
  for (let round = 0; round < 40; round++) {
    yield { kind: 'frame', frame: startFrame(turn, round * 2 + 1) }
    for (let i = 0; i < 8; i++) {
      yield { kind: 'frame', frame: chunkFrame({ type: 'reasoning-delta', index: 0, text: `思考片段 r${round}.${i}。` }) }
    }
    const text = `第 ${round} 轮正文输出。`.repeat(80)
    for (let i = 1; i <= 10; i++) {
      const piece = text.slice(Math.floor((i - 1) * text.length / 10), Math.floor(i * text.length / 10))
      yield { kind: 'frame', frame: chunkFrame({ type: 'text-delta', index: 1, text: piece }) }
    }
    yield { kind: 'session', event: { type: 'assistant/message', data: { turn, step: round * 2 + 1, message: { content: [{ type: 'text', text }] } } } }
    yield { kind: 'session', event: { type: 'tool/call', data: { turn, step: round * 2 + 1, name: 'fs_read', arguments: '{"path":"src/main.ts"}' } } }
  }
  yield { kind: 'session', event: { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } } }
}

const TUNABLES = { cardUpdateThrottleMs: 50, cardMaxBytes: 26_000, cardPrintStep: 5, processMaxBytes: 8_000, processingReactionEmoji: 'OneSecond' }

async function drive(failures: Map<string, number[]>) {
  vi.useFakeTimers()
  const { api, cards, calls } = fakeFeishu(failures)
  const reply = new FeishuReplyHandle(api, 'oc_1', TUNABLES, () => undefined)
  const rt = {
    botId: 'b', chatId: 'oc_1', sessionId: 's1', initiatorOpenId: 'ou_1',
    agent: { sessionId: 's1', followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined, dispose: async () => undefined },
    reply, inflight: undefined, tail: Promise.resolve(), turn: undefined, retiring: false,
  } as SessionRuntime
  const sessions = new Map([['s1', rt]])
  const outbound = new Outbound(sessions, () => undefined)
  for (const feed of events(1)) {
    if (feed.kind === 'session') outbound.handleSessionEvent('s1', feed.event)
    else outbound.handleAssistantFrame('s1', feed.frame)
    await vi.advanceTimersByTimeAsync(60)   // 越过 50ms 节流
  }
  await vi.advanceTimersByTimeAsync(10_000) // 收尾退避
  vi.useRealTimers()
  return { cards, calls }
}

function renderedText(cards: Awaited<ReturnType<typeof drive>>['cards']): string {
  const parts: string[] = []
  for (const card of cards.values()) {
    if (!card.sent) continue
    for (const id of card.order) {
      if (id === 'status') continue
      const c = card.elements.get(id)!
      if (!(c.includes('思考') || c.includes('🔧') || c.startsWith('…（已省略前文）'))) parts.push(c)
    }
  }
  return parts.join('')
}

const FULL_TEXT = Array.from({ length: 40 }, (_, r) => `第 ${r} 轮正文输出。`.repeat(80)).join('')

describe('端到端内容完整性守护', () => {
  test('无失败：正文逐字节完整，旧卡状态行全部定格', async () => {
    const { cards, calls } = await drive(new Map())
    expect(renderedText(cards)).toBe(FULL_TEXT)
    const arr = [...cards.values()]
    expect(arr.length).toBeGreaterThan(1)   // 确认发生了拆卡
    for (const card of arr.slice(0, -1)) {
      expect(card.elements.get('status')).toBe('📦 内容较长，已接续到下一张卡片')
    }
    expect(arr[arr.length - 1].elements.get('status')).toBe('✅ 输出完成')
    // 每张关流的卡都有一次全量重放（replaceCard 次数 === setCardStreaming(false) 次数）
    const closes = calls.filter((c) => c.op === 'setCardStreaming' && c.args[1] === false)
    const replaces = calls.filter((c) => c.op === 'replaceCard')
    expect(replaces.length).toBe(closes.length)
    // 末卡重放内容含最终文本（与既有「渲染拼接 == 模型全量输出」互补，钉住 streaming_mode 已关）
    const lastReplace = replaces[replaces.length - 1]!
    const card = JSON.parse(String(lastReplace.args[1])) as { config: { streaming_mode: boolean } }
    expect(card.config.streaming_mode).toBe(false)
  })

  test('注入 200860 / 200850 抖动：正文仍逐字节完整（拆卡定格 + 跳过头段无重复）', async () => {
    const { cards } = await drive(new Map([
      ['updateCardElement', [3, 7]],     // 第 3、7 次 update 注入 200860
      ['insertElement', [4]],            // 第 4 次 insert 注入 200860
    ]))
    const rendered = renderedText(cards)
    // 200860 分支为「跳过头段已显示部分」严格无重复 → 精确断言（不落到弱断言）
    expect(rendered).toBe(FULL_TEXT)
  })
})
