/** 入站：指令分流 → 路由 → 单 in-flight 准入 → 表情回复 → 图片落附件库 → followup 投递。 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { BotRecord } from '../bots/store.ts'
import type { InboundMessage } from './channel.ts'
import { parseDirective } from './directive.ts'
import { truncateDetail } from './outbound.ts'
import type { Router } from './router.ts'

/** 图片附件库端口（宿主 ctx.attachments 的窄化；缺席时图片降级为提示）。 */
export interface AttachmentsPort {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]): Promise<readonly ImageAttachmentRef[]>
}

export interface InboundDeps {
  router: Router
  bots: { get(botId: string): BotRecord | undefined }
  maxErrorDetailChars: number
  /** 可选：宿主附件服务的惰性取用器（消息时解析；apply 期服务注册未必就绪）。 */
  attachments?: () => AttachmentsPort | undefined
  onError(message: string): void
}

export class Inbound {
  constructor(private readonly deps: InboundDeps) {}

  onMessage(msg: InboundMessage): void {
    void this.handle(msg).catch(async (error) => {
      // 摘要一并回传渠道：dsh web 终端不展示插件 warn，通用文案无法定位（2026-09-03 /new 事故）。
      const detail = truncateDetail(error instanceof Error ? error.message : String(error), this.deps.maxErrorDetailChars)
      this.deps.onError(`[project-bot] 入站处理失败：${detail}`)
      await msg.reply.notice(`处理失败：${detail}`).catch(() => undefined)
    })
  }

  private async handle(msg: InboundMessage): Promise<void> {
    const bot = this.deps.bots.get(msg.botId)
    if (bot === undefined) return

    const directive = parseDirective(msg.text)
    if (directive === 'new') {
      await this.deps.router.reset(bot, msg.chatId, msg.reply)
      await msg.reply.notice('已开启新会话')
      return
    }
    if (directive === 'stop') {
      const rt = this.deps.router.lookup(bot.id, msg.chatId)
      if (rt?.inflight !== undefined) {
        rt.agent.cancel()
        await msg.reply.notice('已请求停止当前任务')
      } else {
        await msg.reply.notice('当前没有进行中的任务')
      }
      return
    }
    if (directive === 'status') {
      const rt = this.deps.router.lookup(bot.id, msg.chatId)
      await msg.reply.notice(rt === undefined
        ? `项目：${bot.project}\n会话：未创建（发送消息即创建）`
        : `项目：${bot.project}\n会话：${rt.sessionId}\n状态：${rt.inflight !== undefined ? '处理中' : '空闲'}`)
      return
    }

    const rt = await this.deps.router.ensure(bot, msg.chatId, msg.reply)
    if (rt.inflight !== undefined) {
      await msg.reply.notice('上一条还在处理中，请稍候（或发送 /stop 取消）')
      return
    }
    // 准入：先占槽再异步；表情回复失败不阻塞处理。
    rt.inflight = { ack: undefined }
    rt.inflight.ack = (await msg.ackProcessing().catch(() => undefined)) ?? undefined
    // source kind 用 'user'（与 ACP 同款）：dsh sessionTitle 服务只接纳 user 消息生成会话标题。
    // 图片：in-flight 窗口内懒下载（不占飞书 WS 3 秒窗口）→ 落附件库 → image 内容块。
    const imageRefs: ImageAttachmentRef[] = []
    if (msg.loadImages !== undefined) {
      const images = await msg.loadImages()
      if (images.length > 0) {
        const attachments = this.deps.attachments?.()
        if (attachments === undefined) {
          await msg.reply.notice('当前环境暂不支持图片消息（附件服务不可用），已按文字部分处理')
        } else {
          imageRefs.push(...await attachments.saveImages(images))
        }
      }
    }
    const message = createUserMessage({
      content: [
        ...(msg.text.length > 0 ? [{ type: 'text' as const, text: msg.text }] : []),
        ...imageRefs.map((ref) => ({ type: 'image' as const, attachment: ref })),
      ],
      source: { kind: 'user' },
    })
    try {
      rt.agent.followup(message)
    } catch (error) {
      const ack = rt.inflight.ack
      rt.inflight = undefined
      await ack?.()
      throw error
    }
  }
}
