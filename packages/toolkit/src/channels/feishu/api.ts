/** 飞书 OpenAPI 的结构化端口：reply/channel 只依赖本接口，SDK 类型不外泄。 */
import type * as lark from '@larksuiteoapi/node-sdk'
import type { InboundImage } from '../channel.ts'

export interface FeishuApi {
  createCard(cardJson: string): Promise<string>
  /** 发送卡片消息；replyToMessageId 提供时锚定回复该消息（im.message.reply），否则发到会话（im.message.create）。 */
  sendCardMessage(chatId: string, cardId: string, replyToMessageId?: string): Promise<void>
  updateCardElement(cardId: string, elementId: string, content: string, sequence: number): Promise<void>
  insertElement(cardId: string, elementJson: string, targetElementId: string, sequence: number): Promise<void>
  setCardStreaming(cardId: string, streaming: boolean, sequence: number, summary?: string): Promise<void>
  replaceCard(cardId: string, cardJson: string, sequence: number): Promise<void>
  /** 发送文本消息；replyToMessageId 提供时锚定回复该消息（im.message.reply），否则发到会话（im.message.create）。 */
  sendText(chatId: string, text: string, replyToMessageId?: string): Promise<void>
  addReaction(messageId: string, emojiType: string): Promise<string>
  removeReaction(messageId: string, reactionId: string): Promise<void>
  /** 下载消息内图片资源（im/v1 resources，type=image）；媒体类型按魔数判定、响应头兜底。 */
  downloadImage(messageId: string, fileKey: string): Promise<InboundImage>
  /** 本机器人的 open_id（bot/v3/info）；群消息 @ 身份校验用。 */
  getBotOpenId(): Promise<string>
  /** 上传文件到消息资源库（im/v1 files，file_type=stream），返回 file_key。 */
  uploadFile(name: string, data: Uint8Array): Promise<string>
  /** 发送文件消息（msg_type=file）；replyToMessageId 提供时锚定回复该消息（im.message.reply），否则发到会话（im.message.create）。 */
  sendFile(chatId: string, fileKey: string, replyToMessageId?: string): Promise<void>
}

/** 从 lark SDK 抛出的 axios 错误提取飞书业务错误码（无则 undefined）。 */
export function feishuErrorCode(error: unknown): number | undefined {
  const data = (error as { response?: { data?: unknown } } | null | undefined)?.response?.data
  if (typeof data !== 'object' || data === null) return undefined
  const code = (data as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

/** 附件服务接受的图片媒体类型（与宿主 attachment v1 一致）。 */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type SniffedImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]

/** 按魔数判定图片媒体类型；未知字节时回退响应头 content-type（限接受集合），否则 undefined。 */
export function sniffImageMediaType(data: Uint8Array, contentType?: unknown): SniffedImageMediaType | undefined {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif'
  if (data.length >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  const declared = typeof contentType === 'string' ? contentType.split(';')[0]!.trim().toLowerCase() : ''
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(declared)
    ? declared as SniffedImageMediaType
    : undefined
}

/** 出站消息统一入口：带 replyToMessageId 时锚定回复该消息（im.message.reply），否则发到会话（im.message.create）。 */
async function sendMessage(client: lark.Client, chatId: string, replyToMessageId: string | undefined, msgType: string, content: string): Promise<void> {
  if (replyToMessageId !== undefined) {
    await client.im.message.reply({ path: { message_id: replyToMessageId }, data: { msg_type: msgType, content } })
    return
  }
  await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: msgType, content } })
}

/** SDK 薄封装：tenant_access_token 由 SDK 自动管理；错误带 code/msg 上下文。 */
export function createFeishuApi(client: lark.Client): FeishuApi {
  return {
    async createCard(cardJson) {
      const res = await client.cardkit.v1.card.create({ data: { type: 'card_json', data: cardJson } })
      const cardId = res.data?.card_id
      if (typeof cardId !== 'string' || cardId.length === 0) {
        throw new Error(`cardkit 建卡失败：code=${res.code} msg=${res.msg}`)
      }
      return cardId
    },
    async sendCardMessage(chatId, cardId, replyToMessageId) {
      await sendMessage(client, chatId, replyToMessageId, 'interactive', JSON.stringify({ type: 'card', data: { card_id: cardId } }))
    },
    async updateCardElement(cardId, elementId, content, sequence) {
      await client.cardkit.v1.cardElement.content({ path: { card_id: cardId, element_id: elementId }, data: { content, sequence } })
    },
    async insertElement(cardId, elementJson, targetElementId, sequence) {
      await client.cardkit.v1.cardElement.create({
        path: { card_id: cardId },
        data: { type: 'insert_before', target_element_id: targetElementId, elements: `[${elementJson}]`, sequence },
      })
    },
    async setCardStreaming(cardId, streaming, sequence, summary) {
      await client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({
            config: {
              streaming_mode: streaming,
              ...(summary !== undefined ? { summary: { content: summary } } : {}),
            },
          }),
          sequence,
        },
      })
    },
    async replaceCard(cardId, cardJson, sequence) {
      await client.cardkit.v1.card.update({ path: { card_id: cardId }, data: { card: { type: 'card_json', data: cardJson }, sequence } })
    },
    async sendText(chatId, text, replyToMessageId) {
      await sendMessage(client, chatId, replyToMessageId, 'text', JSON.stringify({ text }))
    },
    async addReaction(messageId, emojiType) {
      const res = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
      const reactionId = res.data?.reaction_id
      if (typeof reactionId !== 'string') throw new Error(`加表情失败：code=${res.code} msg=${res.msg}`)
      return reactionId
    },
    async removeReaction(messageId, reactionId) {
      await client.im.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } })
    },
    async downloadImage(messageId, fileKey) {
      const res = await client.im.messageResource.get({
        params: { type: 'image' },
        path: { message_id: messageId, file_key: fileKey },
      })
      const chunks: Buffer[] = []
      await new Promise<void>((resolve, reject) => {
        const stream = res.getReadableStream()
        stream.on('data', (chunk) => { chunks.push(chunk as Buffer) })
        stream.on('end', () => resolve())
        stream.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))))
      })
      const data = new Uint8Array(Buffer.concat(chunks))
      const mediaType = sniffImageMediaType(data, res.headers?.['content-type'])
      if (mediaType === undefined) {
        throw new Error(`图片资源格式不受支持（file_key=${fileKey}，content-type=${String(res.headers?.['content-type'] ?? '未知')}）`)
      }
      return { data, mediaType }
    },
    async getBotOpenId() {
      // bot/v3/info 无 SDK 类型化方法，走通用 request；响应顶层挂 bot（非 data.bot）。
      const res = await client.request<{ code?: number; msg?: string; bot?: { open_id?: unknown } }>({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      })
      const openId = res.bot?.open_id
      if (typeof openId !== 'string' || openId.length === 0) {
        throw new Error(`获取机器人信息失败：code=${res.code} msg=${res.msg}`)
      }
      return openId
    },
    async uploadFile(name, data) {
      const res = await client.im.file.create({ data: { file_type: 'stream', file_name: name, file: Buffer.from(data) } })
      // SDK 该端点在响应拦截器（剥 axios 层）之后再剥一层信封（lib: `return res?.data || null`），
      // resolve 的是内层 data（{ file_key } 或 null）——typegen 类型本来就是对的，信封 code/msg 已被 SDK 丢弃。
      // （2026-09-11 实测：上一版按信封取数导致上传成功也误判失败。）
      const fileKey = res?.file_key
      if (typeof fileKey !== 'string' || fileKey.length === 0) {
        throw new Error('文件上传失败：飞书接口未返回 file_key（可能缺 im:resource 权限、文件超 30 MB 或为空文件）')
      }
      return fileKey
    },
    async sendFile(chatId, fileKey, replyToMessageId) {
      await sendMessage(client, chatId, replyToMessageId, 'file', JSON.stringify({ file_key: fileKey }))
    },
  }
}
