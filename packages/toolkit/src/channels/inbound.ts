/** 入站：指令分流 → 路由 → 单 in-flight 准入 → 表情回复 → 图片落附件库 → followup 投递。 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { BotRecord } from '../bots/store.ts'
import type { InboundMessage } from './channel.ts'
import { parseDirective } from './directive.ts'
import { docRejectText, readDocFile, resolveDocPath } from './doc-command.ts'
import { formatLsText, listProjectDir, lsRejectText, searchProjectTree } from './ls-command.ts'
import { truncateDetail } from './outbound.ts'
import type { Router } from './router.ts'
import type { SessionCatalogEntry, SessionCatalogPort, SessionRuntime } from './ports.ts'

/** 图片附件库端口（宿主 ctx.attachments 的窄化；缺席时图片降级为提示）。 */
export interface AttachmentsPort {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]): Promise<readonly ImageAttachmentRef[]>
}

export interface InboundDeps {
  router: Router
  bots: { get(botId: string): BotRecord | undefined }
  maxErrorDetailChars: number
  /** /doc 发送文件的大小上限（字节）。 */
  docMaxBytes: number
  /** 可选：宿主附件服务的惰性取用器（消息时解析；apply 期服务注册未必就绪）。 */
  attachments?: () => AttachmentsPort | undefined
  /** 可选：候选会话目录的惰性取用器（attachments 同款"消息时解析"）；缺席 = /sessions、/switch 降级文案。 */
  catalog?: () => SessionCatalogPort | undefined
  /** 可选：开放题文本作答消费器（发起人纯文本作为 pending 问答答案）；返回 true = 已消费、不触发新 turn。 */
  consumeAnswer?: (botId: string, chatId: string, userId: string, text: string) => boolean
  onError(message: string): void
}

/** /help 输出文本。 */
const HELP_TEXT = [
  '可用指令：',
  '/new 开启新会话（旧会话保留，可用 /switch 切回）',
  '/stop 停止当前任务',
  '/status 查看项目与会话状态',
  '/sessions 列出本项目可切换的会话',
  '/switch <序号|id前缀> 切换到指定会话',
  '/doc <相对路径> 发送项目内文件（如对话产出的 Markdown 文档）',
  '/ls [相对路径] [关键字] 列出项目目录内容（图标 + 大小；带关键字时递归按名称搜索）',
  '/help 显示本帮助',
  '排队：任务执行中发送的消息自动排队，撤回原消息可取消排队',
].join('\n')

export class Inbound {
  constructor(private readonly deps: InboundDeps) {}

  /** 最近一次 /sessions 输出（per chat 序号缓存；进程重启即失效）。 */
  private readonly lastLists = new Map<string, readonly string[]>()

  /** 排队消息（per chat；任务执行中收到的消息在此排队，turn 落定后按序排水）。 */
  private readonly queues = new Map<string, InboundMessage[]>()

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
    if (directive?.name === 'new') {
      await this.deps.router.reset(bot, msg.chatId, msg.reply, msg.userId)
      await msg.reply.notice('已开启新会话')
      // 队列是 chat 级：/new 不换队列；旧 rt 无 turn/end（空闲时 /new）时由此兜底排水。
      this.drain(bot.id, msg.chatId)
      return
    }
    if (directive?.name === 'stop') {
      const rt = this.deps.router.lookup(bot.id, msg.chatId)
      if (rt?.inflight !== undefined) {
        rt.agent.cancel()
        await msg.reply.notice('已请求停止当前任务')
      } else {
        const count = this.queues.get(`${bot.id}:${msg.chatId}`)?.length ?? 0
        await msg.reply.notice(count > 0
          ? `当前没有进行中的任务（${count} 条排队中，撤回原消息可取消）`
          : '当前没有进行中的任务')
      }
      return
    }
    if (directive?.name === 'status') {
      const rt = this.deps.router.lookup(bot.id, msg.chatId)
      if (rt === undefined) {
        await msg.reply.notice(`项目：${bot.project}\n会话：未创建（发送消息即创建）`)
        return
      }
      const lines = [
        `项目：${bot.project}`,
        `会话：${rt.sessionId}`,
        `状态：${rt.inflight !== undefined ? '处理中' : '空闲'}`,
      ]
      const queue = this.queues.get(`${bot.id}:${msg.chatId}`) ?? []
      if (queue.length > 0) {
        lines.push(`排队（${queue.length}）：`)
        queue.forEach((m, i) => lines.push(`${i + 1}. ${queuedPreview(m)}`))
      }
      await msg.reply.notice(lines.join('\n'))
      return
    }
    if (directive?.name === 'help') {
      await msg.reply.notice(HELP_TEXT)
      return
    }
    if (directive?.name === 'doc') {
      await this.sendDoc(bot, msg, directive.arg)
      return
    }
    if (directive?.name === 'ls') {
      await this.sendLs(bot, msg, directive.arg)
      return
    }
    if (directive?.name === 'sessions') {
      await this.listSessions(bot, msg)
      return
    }
    if (directive?.name === 'switch') {
      await this.switchSession(bot, msg, directive.arg)
      return
    }

    // 开放题作答拦截：该 chat 有 pending 问答且为发起人纯文本 → 作为答案消费，
    // 不进队列、不触发新 turn（拦截点必须在排队逻辑之前）。
    if (msg.loadImages === undefined && msg.text.length > 0
      && this.deps.consumeAnswer?.(msg.botId, msg.chatId, msg.userId, msg.text) === true) {
      return
    }

    const rt = await this.deps.router.ensure(bot, msg.chatId, msg.reply, msg.userId)
    if (rt.inflight !== undefined) {
      const key = `${bot.id}:${msg.chatId}`
      const queue = this.queues.get(key) ?? []
      queue.push(msg)
      this.queues.set(key, queue)
      await msg.reply.notice(`已排队（第 ${queue.length} 位），撤回原消息可取消执行`)
      return
    }
    await this.dispatch(rt, msg)
  }

  /** 执行一条消息：占槽 → 刷新 reply → 表情 → 图片落附件库 → followup 投递。直接执行与排水共用。 */
  private async dispatch(rt: SessionRuntime, msg: InboundMessage): Promise<void> {
    // 准入：先占槽再异步；表情回复失败不阻塞处理。
    // reply 句柄只在准入通过后刷新——忙时/排队消息不抢走运行中 turn 的出站。
    rt.inflight = { ack: undefined }
    rt.reply = msg.reply
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
      // 占槽期间可能已有新消息入队：回滚释放后继续排水，不滞留。
      // 排水先于 ack：占槽转移须与释放同同步段完成（inflight 空 ⇒ 队列空 不变量），
      // 否则 await ack 让出事件循环期间新到消息会插队到更早的排队消息之前。
      this.drain(rt.botId, rt.chatId)
      await ack?.()
      throw error
    }
  }

  /**
   * 幂等排水：当前绑定 rt 空闲且该 chat 队列非空时 shift 队首立即执行。
   * 触发点：Outbound onTurnIdle（turn/end、agent/error 释放槽位）、/new、/switch、followup 回滚。
   * 不变量：inflight 空 ⇒ 队列空——占槽转移与释放在同一同步段，无并发窗口。
   */
  drain(botId: string, chatId: string): void {
    const key = `${botId}:${chatId}`
    const queue = this.queues.get(key)
    if (queue === undefined || queue.length === 0) return
    const rt = this.deps.router.lookup(botId, chatId)
    if (rt === undefined || rt.retiring || rt.inflight !== undefined) return
    const msg = queue.shift()!
    if (queue.length === 0) this.queues.delete(key)
    void this.dispatch(rt, msg).catch(async (error) => {
      // 与 onMessage 同款错误路径：摘要回传渠道 + onError（drain 是 fire-and-forget，自行兜底）。
      const detail = truncateDetail(error instanceof Error ? error.message : String(error), this.deps.maxErrorDetailChars)
      this.deps.onError(`[project-bot] 入站处理失败：${detail}`)
      await msg.reply.notice(`处理失败：${detail}`).catch(() => undefined)
    })
  }

  /**
   * 清空某 bot 全部 chat 的排队队列（bot 停止/解绑/删除时由 BotRuntime 调用）。
   * 队列条目持有渠道 reply 句柄（含 lark.Client 与 appSecret），不清理会随 bot 删除永久残留、消息静默卡死。
   * 静默丢弃、不发 notice：删除/解绑路径上渠道可能已关闭，通知会失败且无意义。
   */
  clearQueues(botId: string): void {
    const prefix = `${botId}:`
    for (const key of [...this.queues.keys()]) {
      if (key.startsWith(prefix)) this.queues.delete(key)
    }
  }

  /** 撤回原消息 = 撤销排队条目；已执行/不存在/正在执行的静默忽略（幂等，重推安全）。 */
  revokeQueued(botId: string, chatId: string, messageId: string): void {
    const key = `${botId}:${chatId}`
    const queue = this.queues.get(key)
    if (queue === undefined) return
    const index = queue.findIndex((m) => m.messageId === messageId)
    if (index < 0) return
    const [removed] = queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(key)
    void removed!.reply.notice(`已撤销排队消息：${queuedPreview(removed!)}`).catch(() => undefined)
  }

  private async listSessions(bot: BotRecord, msg: InboundMessage): Promise<void> {
    const catalog = this.deps.catalog?.()
    if (catalog === undefined) {
      await msg.reply.notice('会话切换在当前环境不可用')
      return
    }
    const entries = await catalog.list(bot.project)
    if (entries.length === 0) {
      await msg.reply.notice('当前项目下还没有可切换的会话（发消息即创建）')
      return
    }
    const current = this.deps.router.boundSessionId(bot.id, msg.chatId)
    this.lastLists.set(`${bot.id}:${msg.chatId}`, entries.map((e) => e.sessionId))
    const lines = entries.map((e, i) =>
      `${i + 1}. ${e.sessionId === current ? '✓ ' : ''}${e.title ?? '(无标题)'}（${e.sessionId.slice(0, 8)}）`)
    await msg.reply.notice(`会话列表（/switch <序号|id前缀> 切换）：\n${lines.join('\n')}`)
  }

  private async switchSession(bot: BotRecord, msg: InboundMessage, arg: string | undefined): Promise<void> {
    const catalog = this.deps.catalog?.()
    if (catalog === undefined) {
      await msg.reply.notice('会话切换在当前环境不可用')
      return
    }
    if (arg === undefined || arg.length === 0) {
      await msg.reply.notice('用法：/switch <序号|id前缀>（序号见 /sessions）')
      return
    }
    const entries = await catalog.list(bot.project)
    let target: SessionCatalogEntry | undefined
    if (/^\d+$/.test(arg)) {
      const ids = this.lastLists.get(`${bot.id}:${msg.chatId}`)
      const id = ids?.[Number(arg) - 1]
      target = id !== undefined ? entries.find((e) => e.sessionId === id) : undefined
      if (target === undefined) {
        await msg.reply.notice('序号无效或列表已过期，请先发送 /sessions 查看最新列表')
        return
      }
    } else {
      const matches = entries.filter((e) => e.sessionId.startsWith(arg))
      if (matches.length === 0) {
        await msg.reply.notice(`没有 id 前缀为 "${arg}" 的会话`)
        return
      }
      if (matches.length > 1) {
        await msg.reply.notice(`id 前缀 "${arg}" 命中多个会话，请加长前缀`)
        return
      }
      target = matches[0]
    }
    if (target.sessionId === this.deps.router.boundSessionId(bot.id, msg.chatId)) {
      await msg.reply.notice('已是当前会话')
      return
    }
    try {
      await this.deps.router.switchTo(bot, msg.chatId, target.sessionId, msg.reply, msg.userId)
    } catch (error) {
      // 目标会话写句柄被占用（web 界面打开中或正收尾）：绑定不变，提示占用而非「处理失败」。
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        await msg.reply.notice('该会话正被占用（可能在 web 界面打开中），请关闭后重试')
        return
      }
      throw error
    }
    await msg.reply.notice(`已切换到会话：${target.title ?? '(无标题)'}（${target.sessionId.slice(0, 8)}）`)
    this.drain(bot.id, msg.chatId)
  }

  private async sendDoc(bot: BotRecord, msg: InboundMessage, arg: string | undefined): Promise<void> {
    if (arg === undefined || arg.length === 0) {
      await msg.reply.notice('用法：/doc <相对路径>（相对项目目录，如 docs/report.md）')
      return
    }
    const res = await resolveDocPath(bot.project, arg, this.deps.docMaxBytes)
    if (!res.ok) {
      await msg.reply.notice(docRejectText(res.reason, arg, this.deps.docMaxBytes))
      return
    }
    const sendFile = msg.reply.sendFile?.bind(msg.reply)
    if (sendFile === undefined) {
      await msg.reply.notice('当前渠道不支持发送文件')
      return
    }
    // 护栏判定后的读取失败（如竞态删除）抛给 onMessage 统一错误路径。
    const data = await readDocFile(res.path)
    try {
      await sendFile(res.name, data)
    } catch (error) {
      const detail = truncateDetail(error instanceof Error ? error.message : String(error), this.deps.maxErrorDetailChars)
      await msg.reply.notice(`发送文件失败：${detail}`)
    }
  }

  /** /ls：arg 缺省/空 = 列项目根；单 token = 路径；其余 token join 为递归搜索关键字。 */
  private async sendLs(bot: BotRecord, msg: InboundMessage, arg: string | undefined): Promise<void> {
    const tokens = arg === undefined || arg.length === 0 ? [] : arg.split(/\s+/)
    const dirArg = tokens[0] ?? '.'
    const keyword = tokens.length > 1 ? tokens.slice(1).join(' ') : undefined
    const res = keyword === undefined
      ? await listProjectDir(bot.project, dirArg)
      : await searchProjectTree(bot.project, dirArg, keyword)
    if (!res.ok) {
      await msg.reply.notice(lsRejectText(res.reason, dirArg))
      return
    }
    await msg.reply.notice(formatLsText(res, dirArg, keyword))
  }
}

/** 排队消息预览：text 前 20 字（超出 …）；纯图片显示 [图片]；文+图混排只取文字。 */
export function queuedPreview(msg: InboundMessage): string {
  if (msg.text.length > 0) return truncateDetail(msg.text, 20)
  return '[图片]'
}
