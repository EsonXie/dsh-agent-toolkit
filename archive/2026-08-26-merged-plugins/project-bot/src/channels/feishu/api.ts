/** 飞书 OpenAPI 的结构化端口：reply/channel 只依赖本接口，SDK 类型不外泄。 */
import type * as lark from '@larksuiteoapi/node-sdk'

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
  }
}
