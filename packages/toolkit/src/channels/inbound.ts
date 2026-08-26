/** 入站：指令分流 → 路由 → 单 in-flight 准入 → 表情回复 → followup 投递。 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { BotRecord } from '../bots/store.ts'
import type { InboundMessage } from './channel.ts'
import { parseDirective } from './directive.ts'
import type { Router } from './router.ts'

export interface InboundDeps {
  router: Router
  bots: { get(botId: string): BotRecord | undefined }
  onError(message: string): void
}

export class Inbound {
  constructor(private readonly deps: InboundDeps) {}

  onMessage(msg: InboundMessage): void {
    void this.handle(msg).catch(async (error) => {
      this.deps.onError(`[project-bot] 入站处理失败：${error instanceof Error ? error.message : String(error)}`)
      await msg.reply.notice('处理失败，请稍后再试').catch(() => undefined)
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
    const message = createUserMessage({
      content: [{ type: 'text', text: msg.text }],
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
