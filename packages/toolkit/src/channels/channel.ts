/** 渠道抽象：飞书是第一个实现；核心只依赖本文件，不感知任何飞书 SDK 类型。 */
import type { BotRecord } from '../bots/store.ts'
import type { ApprovalPresenter, CardActionAck, CardActionInput } from './approval/center.ts'
import type { QuestionPresenter } from './questions/center.ts'

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
  /** 发送文件消息（可选能力；渠道不支持时缺省，由核心降级提示）。错误向调用方传播。 */
  sendFile?(name: string, data: Uint8Array): Promise<void>
  /** 定格当前流式卡（关流 + 整卡重放，状态行定格「⏸ 已暂停，后续输出见下方新卡片」），后续 update 开新卡续写；无卡/已 finalize 时空操作。问答卡 settle 后调用。 */
  breakCard?(): Promise<void>
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
  /** 会话形态：p2p 单聊 / group 群聊（话题群以 threadId 判别，chatType 恒为 group）。 */
  chatType: 'p2p' | 'group'
  /** 话题群话题 ID；非话题缺席。 */
  threadId?: string
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
  /** 卡片按钮回调入核（审批）；渠道无交互卡片时可不实现。返回值经渠道应答帧回执（toast）。 */
  onCardAction?(action: CardActionInput): CardActionAck | undefined
  /** 消息撤回事件入核（撤销排队消息；仅排队中生效）；渠道不支持撤回事件时可不实现。 */
  onMessageRecalled?(botId: string, chatId: string, messageId: string): void
}

export type ChannelStatus = 'connected' | 'connecting' | 'reconnecting' | 'idle' | 'failed'

export interface ChannelHandle {
  close(): Promise<void>
  status(): ChannelStatus
  /** 该渠道的审批卡片能力（有交互卡片的渠道实现；缺席 = ask 回退其他审批通道）。 */
  approval?: ApprovalPresenter
  /** 该渠道的问答卡能力（user-questions 应答端；缺席 = ask 回退其他应答通道）。 */
  questions?: QuestionPresenter
}

/** 生产调试事件 sink（JSONL 文件日志等；undefined = 不记录）。 */
export type DebugSink = (event: { event: string; [key: string]: unknown }) => void

/** 全局可调参数（Config 快照，渠道层只读消费）。 */
export interface ChannelTunables {
  cardUpdateThrottleMs: number
  cardMaxBytes: number
  /** 过程区（思考 + 工具调用）字节上限（截尾保留最近内容）。 */
  processMaxBytes: number
  /** 飞书流式打字机每次打印字符数。 */
  cardPrintStep: number
  processingReactionEmoji: string
  /** 生产调试日志 sink（feishu/debug-log.ts 装配；缺省不记录）。 */
  debugLog?: DebugSink
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
