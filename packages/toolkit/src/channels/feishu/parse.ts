/** im.message.receive_v1 事件解析：窄化为渠道无关的 ParsedMessage；message_id 去重。 */
import type { DebugSink } from '../channel.ts'
import { stripMentionPlaceholders } from '../directive.ts'

export interface ParsedMessage {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  userId: string
  text: string
  /** 消息携带的图片 key（post 富文本节点与 image 消息），按出现顺序；文本下载经渠道懒加载。 */
  imageKeys: readonly string[]
  /** 话题群消息的话题 ID（omt_*）；非话题消息缺席。 */
  threadId?: string
}

/** 不支持的消息类型标记（渠道层据此回提示，不进核心）。 */
export interface ParsedUnsupported {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  userId: string
  messageType: string
  /** 话题群消息的话题 ID；非话题缺席。 */
  threadId?: string
}

/** parseMessageEvent 三态：可入核心的消息 / 不支持的类型（渠道回提示） / null（忽略）。 */
export type ParseResult =
  | { kind: 'message'; message: ParsedMessage }
  | { kind: 'unsupported'; unsupported: ParsedUnsupported }

/** unsupported 消息的用户提示文案（渠道层直接回发）。 */
export function unsupportedNoticeText(messageType: string): string {
  switch (messageType) {
    case 'file': return '暂不支持文件消息，请发送文字或截图'
    case 'media': return '暂不支持视频消息'
    case 'audio': return '暂不支持语音消息'
    case 'merge_forward': return '暂不支持合并转发消息'
    default: return `暂不支持该类型消息（${messageType}）`
  }
}

interface RawEvent {
  sender?: { sender_type?: unknown; sender_id?: { open_id?: unknown } }
  message?: {
    message_id?: unknown
    chat_id?: unknown
    chat_type?: unknown
    message_type?: unknown
    thread_id?: unknown
    content?: unknown
    mentions?: readonly { mentioned_type?: unknown; id?: { open_id?: unknown } }[]
  }
}

/** code_block language 数字枚举 → 语言名（常用子集；表外与 PlainText(1) 省略语言名）。 */
const CODE_LANG: Readonly<Record<number, string>> = {
  7: 'bash', 8: 'csharp', 9: 'cpp', 10: 'c', 12: 'css', 15: 'dart', 18: 'dockerfile',
  22: 'go', 24: 'html', 28: 'json', 29: 'java', 30: 'javascript', 32: 'kotlin', 36: 'lua',
  38: 'makefile', 39: 'markdown', 40: 'nginx', 43: 'php', 46: 'powershell', 49: 'python',
  52: 'ruby', 53: 'rust', 56: 'sql', 60: 'shell', 61: 'swift', 63: 'typescript', 66: 'xml',
  68: 'yaml', 69: 'diff',
}

/** post 富文本节点：text/a 取文本，img 收 image_key，code_block 成围栏块，media 占位；其余跳过 + 日志。 */
interface PostNode {
  tag?: unknown
  text?: unknown
  href?: unknown
  image_key?: unknown
  language?: unknown
  file_name?: unknown
}

/** 从 post content 抽取文本与图片 key；title 非空作首行，段落间以换行连接。 */
function parsePostContent(content: string, messageId: string, sink?: DebugSink): { text: string; imageKeys: string[] } {
  const imageKeys: string[] = []
  const paragraphs: string[] = []
  try {
    const parsed = JSON.parse(content) as { title?: unknown; content?: unknown }
    if (typeof parsed.title === 'string' && parsed.title.trim().length > 0) paragraphs.push(parsed.title.trim())
    const list = Array.isArray(parsed.content) ? parsed.content : []
    for (const paragraph of list) {
      if (!Array.isArray(paragraph)) continue
      let parts: string[] = []
      // 冲刷行内 parts 为独立段落；空 parts 不产生空行（纯图片段落）。
      const flush = (): void => {
        const joined = parts.join('')
        parts = []
        if (joined.length > 0) paragraphs.push(joined)
      }
      for (const node of paragraph as PostNode[]) {
        if (node === null || typeof node !== 'object') continue
        if (node.tag === 'img') {
          if (typeof node.image_key === 'string' && node.image_key.length > 0) imageKeys.push(node.image_key)
        } else if (node.tag === 'text' && typeof node.text === 'string') {
          parts.push(node.text)
        } else if (node.tag === 'a' && typeof node.text === 'string') {
          const href = typeof node.href === 'string' ? node.href : ''
          parts.push(href.length > 0 && href !== node.text ? `[${node.text}](${href})` : node.text)
        } else if (node.tag === 'code_block' && typeof node.text === 'string') {
          // 围栏块独立成段：先冲刷行内 parts，后续文本另起新段，避免与代码粘同一行。
          flush()
          const lang = typeof node.language === 'number' ? CODE_LANG[node.language] ?? '' : ''
          paragraphs.push(`\`\`\`${lang}\n${node.text}\n\`\`\``)
        } else if (node.tag === 'media') {
          const name = typeof node.file_name === 'string' && node.file_name.length > 0 ? `: ${node.file_name}` : ''
          parts.push(`[附件${name}]`)
        } else {
          sink?.({ event: 'feishu.parse.skip-tag', tag: String(node.tag), messageId })
        }
      }
      flush()
    }
  } catch {
    return { text: '', imageKeys: [] }
  }
  return { text: paragraphs.join('\n'), imageKeys }
}

/**
 * SDK handler 收到的 data 即事件体（README 示例 `data.message` 直接解构）；
 * 兼容包一层 { event } 的形态。过滤：机器人消息、群内未 @机器人、无文本且无图片；
 * 非 text/post/image 类型回 unsupported 标记（sticker 静默忽略、仅留日志）。
 * 群消息 @ 校验身份：mention 的 open_id 必须等于本机器人（应用若持全部群消息权限，
 * 会收到 @ 其他机器人的消息，不能误触发）。
 */
export function parseMessageEvent(data: unknown, botOpenId: string, sink?: DebugSink): ParseResult | null {
  const wrapped = data as { event?: RawEvent } & RawEvent
  const event: RawEvent = wrapped.event ?? wrapped
  if (event.sender?.sender_type !== 'user') return null
  const userId = event.sender.sender_id?.open_id
  const msg = event.message
  if (typeof userId !== 'string' || msg === undefined) return null
  if (typeof msg.message_type !== 'string') return null
  if (typeof msg.message_id !== 'string' || typeof msg.chat_id !== 'string') return null
  if (msg.chat_type !== 'p2p' && msg.chat_type !== 'group') return null
  if (msg.chat_type === 'group'
    && !(msg.mentions ?? []).some((m) => m.mentioned_type === 'bot' && m.id?.open_id === botOpenId)) return null

  const threadId = typeof msg.thread_id === 'string' && msg.thread_id.length > 0 ? msg.thread_id : undefined
  const withThread = threadId !== undefined ? { threadId } : {}

  if (msg.message_type !== 'text' && msg.message_type !== 'post' && msg.message_type !== 'image') {
    if (msg.message_type === 'sticker') {
      // 表情贴图无语义价值：静默跳过，仅留日志可反查。
      sink?.({ event: 'feishu.parse.ignored', reason: 'sticker', messageId: msg.message_id, chatId: msg.chat_id })
      return null
    }
    return {
      kind: 'unsupported',
      unsupported: { messageId: msg.message_id, chatId: msg.chat_id, chatType: msg.chat_type, userId, messageType: msg.message_type, ...withThread },
    }
  }
  if (typeof msg.content !== 'string') return null

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
    const post = parsePostContent(msg.content, msg.message_id, sink)
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

  return {
    kind: 'message',
    message: { messageId: msg.message_id, chatId: msg.chat_id, chatType: msg.chat_type, userId, text, imageKeys, ...withThread },
  }
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

export interface ParsedRecall {
  messageId: string
  chatId: string
}

/** im.message.recalled_v1 事件解析：窄化为渠道无关的 ParsedRecall（兼容 { event } 包裹）；字段缺失返回 null。 */
export function parseRecallEvent(data: unknown): ParsedRecall | null {
  const wrapped = data as { event?: { message_id?: unknown; chat_id?: unknown } } & { message_id?: unknown; chat_id?: unknown }
  const event = wrapped.event ?? wrapped
  if (typeof event.message_id !== 'string' || typeof event.chat_id !== 'string') return null
  return { messageId: event.message_id, chatId: event.chat_id }
}
