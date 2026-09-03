/** im.message.receive_v1 事件解析：窄化为渠道无关的 ParsedMessage；message_id 去重。 */
import { stripMentionPlaceholders } from '../directive.ts'

export interface ParsedMessage {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  userId: string
  text: string
  /** 消息携带的图片 key（post 富文本节点与 image 消息），按出现顺序；文本下载经渠道懒加载。 */
  imageKeys: readonly string[]
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

/** post 富文本节点：text/a 取文本，img 收 image_key，at（@占位）与其余标签跳过。 */
interface PostNode {
  tag?: unknown
  text?: unknown
  image_key?: unknown
}

/** 从 post content（段落数组）抽取文本与图片 key；段落间以换行连接。 */
function parsePostContent(content: string): { text: string; imageKeys: string[] } {
  const imageKeys: string[] = []
  const paragraphs: string[] = []
  try {
    const parsed = JSON.parse(content) as { content?: unknown }
    const list = Array.isArray(parsed.content) ? parsed.content : []
    for (const paragraph of list) {
      if (!Array.isArray(paragraph)) continue
      const parts: string[] = []
      for (const node of paragraph as PostNode[]) {
        if (node === null || typeof node !== 'object') continue
        if (node.tag === 'img') {
          if (typeof node.image_key === 'string' && node.image_key.length > 0) imageKeys.push(node.image_key)
        } else if ((node.tag === 'text' || node.tag === 'a') && typeof node.text === 'string') {
          parts.push(node.text)
        }
      }
      paragraphs.push(parts.join(''))
    }
  } catch {
    return { text: '', imageKeys: [] }
  }
  return { text: paragraphs.join('\n'), imageKeys }
}

/**
 * SDK handler 收到的 data 即事件体（README 示例 `data.message` 直接解构）；
 * 兼容包一层 { event } 的形态。过滤：机器人消息、非 text/post/image 类型、
 * 群内未 @机器人、无文本且无图片。
 */
export function parseMessageEvent(data: unknown): ParsedMessage | null {
  const wrapped = data as { event?: RawEvent } & RawEvent
  const event: RawEvent = wrapped.event ?? wrapped
  if (event.sender?.sender_type !== 'user') return null
  const userId = event.sender.sender_id?.open_id
  const msg = event.message
  if (typeof userId !== 'string' || msg === undefined) return null
  if (msg.message_type !== 'text' && msg.message_type !== 'post' && msg.message_type !== 'image') return null
  if (typeof msg.content !== 'string') return null
  if (typeof msg.message_id !== 'string' || typeof msg.chat_id !== 'string') return null
  if (msg.chat_type !== 'p2p' && msg.chat_type !== 'group') return null
  if (msg.chat_type === 'group' && !(msg.mentions ?? []).some((m) => m.mentioned_type === 'bot')) return null

  let text = ''
  let imageKeys: string[] = []
  if (msg.message_type === 'text') {
    try {
      const parsed = JSON.parse(msg.content) as { text?: unknown }
      if (typeof parsed.text !== 'string') return null
      text = stripMentionPlaceholders(parsed.text)
    } catch {
      return null
    }
  } else if (msg.message_type === 'post') {
    const post = parsePostContent(msg.content)
    text = stripMentionPlaceholders(post.text)
    imageKeys = post.imageKeys
  } else {
    try {
      const parsed = JSON.parse(msg.content) as { image_key?: unknown }
      if (typeof parsed.image_key === 'string' && parsed.image_key.length > 0) imageKeys.push(parsed.image_key)
    } catch {
      return null
    }
  }
  if (text.length === 0 && imageKeys.length === 0) return null

  return { messageId: msg.message_id, chatId: msg.chat_id, chatType: msg.chat_type, userId, text, imageKeys }
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
