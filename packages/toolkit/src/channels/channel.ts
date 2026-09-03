/** 渠道抽象：飞书是第一个实现；核心只依赖本文件，不感知任何飞书 SDK 类型。 */
import type { BotRecord } from '../bots/store.ts'

export type Disposer = () => void | Promise<void>

export type TurnStatus = 'done' | 'error' | 'cancelled'

/** 一段按时间线排列的输出：text = 正文 markdown 段；process = 思考/工具折叠面板段。 */
export interface TurnSegment { kind: 'text' | 'process'; content: string }

/** 一次回复的出站句柄（chat 作用域；turn 级卡片流 + 普通文本通知）。 */
export interface ReplyHandle {
  /** 开新一轮 turn 的卡片（惰性实现允许空操作，首次 update 建卡）。 */
  beginTurn(): Promise<void>
  /** 全量替换当前卡片的段序列视图（渠道内部节流、拆卡、插入新段）。 */
  update(segments: readonly TurnSegment[]): Promise<void>
  /** turn 定格：关闭流式、按状态着色；无卡且带 detail 时降级为文本。 */
  finalize(status: TurnStatus, detail?: string): Promise<void>
  /** 普通文本消息（准入拒绝、/status 应答等）。 */
  notice(text: string): Promise<void>
}

/** 渠道图片下载产物（媒体类型为渠道侧判定的 MIME 子集；核心侧不感知宿主类型）。 */
export interface InboundImage {
  data: Uint8Array
  mediaType: string
  name?: string
}

/** 一条入站消息（渠道已解析成渠道无关形态）。 */
export interface InboundMessage {
  botId: string
  chatId: string
  userId: string
  messageId: string
  text: string
  /** 懒加载图片字节（无图片消息省略）。在核心侧的 in-flight 窗口内调用，失败走统一错误路径。 */
  loadImages?: () => Promise<InboundImage[]>
  reply: ReplyHandle
  /** 给该用户消息加「处理中」表情回复；返回的 disposer 删除表情。失败返回 undefined。 */
  ackProcessing(): Promise<Disposer | undefined>
}

export interface ChannelIO {
  /** fire-and-forget：渠道 handler 须快速返回（飞书 WS 3 秒限制），业务异步消化。 */
  onMessage(msg: InboundMessage): void
}

export type ChannelStatus = 'connected' | 'connecting' | 'reconnecting' | 'idle' | 'failed'

export interface ChannelHandle {
  close(): Promise<void>
  status(): ChannelStatus
}

/** 全局可调参数（Config 快照，渠道层只读消费）。 */
export interface ChannelTunables {
  cardUpdateThrottleMs: number
  cardMaxBytes: number
  /** 过程区（思考 + 工具调用）字节上限（截尾保留最近内容）。 */
  processMaxBytes: number
  processingReactionEmoji: string
}

/** 密钥已现场解析的 bot 配置。 */
export interface ResolvedBot {
  record: BotRecord
  secret: string
}

export interface BotChannel {
  readonly type: string
  start(bot: ResolvedBot, io: ChannelIO, tunables: ChannelTunables, log: (message: string) => void): Promise<ChannelHandle>
}
