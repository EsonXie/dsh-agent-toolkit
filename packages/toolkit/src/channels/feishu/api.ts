/** 飞书 OpenAPI 的结构化端口：reply/channel 只依赖本接口，SDK 类型不外泄。 */
import type * as lark from '@larksuiteoapi/node-sdk'
import type { InboundImage } from '../channel.ts'

export interface FeishuApi {
  createCard(cardJson: string): Promise<string>
  sendCardMessage(chatId: string, cardId: string): Promise<void>
  updateCardElement(cardId: string, elementId: string, content: string, sequence: number): Promise<void>
  insertElement(cardId: string, elementJson: string, targetElementId: string, sequence: number): Promise<void>
  setCardStreaming(cardId: string, streaming: boolean, sequence: number, summary?: string): Promise<void>
  replaceCard(cardId: string, cardJson: string, sequence: number): Promise<void>
  sendText(chatId: string, text: string): Promise<void>
  addReaction(messageId: string, emojiType: string): Promise<string>
  removeReaction(messageId: string, reactionId: string): Promise<void>
  /** 下载消息内图片资源（im/v1 resources，type=image）；媒体类型按魔数判定、响应头兜底。 */
  downloadImage(messageId: string, fileKey: string): Promise<InboundImage>
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
    async sendCardMessage(chatId, cardId) {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }) },
      })
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
    async sendText(chatId, text) {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
      })
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
  }
}
