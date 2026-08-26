/** im.message.receive_v1 事件解析：窄化为渠道无关的 ParsedMessage；message_id 去重。 */
import { stripMentionPlaceholders } from '../directive.ts'

export interface ParsedMessage {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  userId: string
  text: string
}

interface RawEvent {
  sender?: { sender_type?: unknown; sender_id?: { open_id?: unknown } }
  message?: {
    message_id?: unknown
    chat_id?: unknown
    chat_type?: unknown
    message_type?: unknown
    content?: unknown
    mentions?: readonly { mentioned_type?: unknown }[]
  }
}

/**
 * SDK handler 收到的 data 即事件体（README 示例 `data.message` 直接解构）；
 * 兼容包一层 { event } 的形态。过滤：机器人消息、非文本、群内未 @机器人、空文本。
 */
export function parseMessageEvent(data: unknown): ParsedMessage | null {
  const wrapped = data as { event?: RawEvent } & RawEvent
  const event: RawEvent = wrapped.event ?? wrapped
  if (event.sender?.sender_type !== 'user') return null
  const userId = event.sender.sender_id?.open_id
  const msg = event.message
  if (typeof userId !== 'string' || msg === undefined) return null
  if (msg.message_type !== 'text' || typeof msg.content !== 'string') return null
  if (typeof msg.message_id !== 'string' || typeof msg.chat_id !== 'string') return null
  if (msg.chat_type !== 'p2p' && msg.chat_type !== 'group') return null
  if (msg.chat_type === 'group' && !(msg.mentions ?? []).some((m) => m.mentioned_type === 'bot')) return null

  let text: string
  try {
    const parsed = JSON.parse(msg.content) as { text?: unknown }
    if (typeof parsed.text !== 'string') return null
    text = stripMentionPlaceholders(parsed.text)
  } catch {
    return null
  }
  if (text.length === 0) return null

  return { messageId: msg.message_id, chatId: msg.chat_id, chatType: msg.chat_type, userId, text }
}

/** message_id 去重（飞书会重推）；FIFO 容量淘汰。 */
export class MessageDedup {
  private readonly seen = new Set<string>()
  private readonly order: string[] = []

  constructor(private readonly cap = 1000) {}

  /** true = 新消息。 */
  check(id: string): boolean {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    this.order.push(id)
    if (this.order.length > this.cap) this.seen.delete(this.order.shift()!)
    return true
  }
}
