/** 飞书渠道：WSClient 长连接收事件 → 解析 → 核心；出站走 FeishuReplyHandle。 */
import * as lark from '@larksuiteoapi/node-sdk'
import type { BotChannel, ChannelHandle } from '../channel.ts'
import { createFeishuApi } from './api.ts'
import { MessageDedup, parseMessageEvent } from './parse.ts'
import { FeishuReplyHandle, makeAck } from './reply.ts'
import { FeishuApprovalPresenter } from '../approval/feishu.ts'
import { toCardActionInput, toastResponse } from './card-action.ts'

export const feishuChannel: BotChannel = {
  type: 'feishu',

  async start(bot, io, tunables, log): Promise<ChannelHandle> {
    // runtime 仅对已绑定记录启动渠道（reconcile 的 feishu guard），此处安全。
    const { appId } = bot.record.feishu!
    const client = new lark.Client({ appId, appSecret: bot.secret })
    const api = createFeishuApi(client)
    // 群消息 @ 身份校验依赖本机器人 open_id；取不到则启动失败（reconcile 记录原因），不降级放行。
    const botOpenId = await api.getBotOpenId()
    const dedup = new MessageDedup()

    const dispatcher = new lark.EventDispatcher({}).register<{ 'card.action.trigger': (raw: unknown) => unknown }>({
      // 已读回执无动作；显式 no-op 消掉 EventDispatcher 的 "no ... handle" 告警噪音。
      'im.message.message_read_v1': async () => undefined,
      // WS 事件须 3 秒内返回：解析同步完成，业务投递 fire-and-forget（含图片懒下载）。
      'im.message.receive_v1': async (data: unknown) => {
        const parsed = parseMessageEvent(data, botOpenId)
        if (parsed === null || !dedup.check(parsed.messageId)) return
        const reply = new FeishuReplyHandle(api, parsed.chatId, tunables, log)
        const loadImages = parsed.imageKeys.length > 0
          ? async () => Promise.all(parsed.imageKeys.map(async (key) => api.downloadImage(parsed.messageId, key)))
          : undefined
        io.onMessage({
          botId: bot.record.id,
          chatId: parsed.chatId,
          userId: parsed.userId,
          messageId: parsed.messageId,
          text: parsed.text,
          ...(loadImages !== undefined ? { loadImages } : {}),
          reply,
          ackProcessing: makeAck(api, parsed.messageId, tunables.processingReactionEmoji),
        })
      },
      // 卡片按钮回调（审批）：同步入核，toast 经 WS 应答帧回执。
      'card.action.trigger': (raw: unknown) => {
        if (io.onCardAction === undefined) return undefined
        const action = toCardActionInput(raw)
        if (action === undefined) return undefined
        return toastResponse(io.onCardAction(action)) ?? undefined
      },
    })

    const ws = new lark.WSClient({ appId, appSecret: bot.secret, loggerLevel: lark.LoggerLevel.warn })
    await ws.start({ eventDispatcher: dispatcher })

    return {
      approval: new FeishuApprovalPresenter(api, log),
      close: () => {
        ws.close({ force: true })
        return Promise.resolve()
      },
      status: () => ws.getConnectionStatus().state,
    }
  },
}
