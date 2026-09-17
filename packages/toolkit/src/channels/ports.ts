/** 核心对宿主 agents 服务 / 绑定表的结构化端口（测试用 fake 注入）。 */
import type { BotRecord } from '../bots/store.ts'
import type { Disposer, ReplyHandle, TurnSegment } from './channel.ts'

export interface AgentPort {
  readonly sessionId: string
  /** 入参须为 @deepseek-ai/dsh-llm 的 createUserMessage 产物（裸字符串缺 source，turn 管线读 source.kind 崩溃）。 */
  followup(message: unknown): void
  cancel(): void
  whenIdle(): Promise<void>
  /** 释放宿主写句柄（AgentHandle.dispose）：停止 loop、注销 agent。摘除 runtime 时必须调用，否则会话永远 already owned。 */
  dispose(): Promise<void>
}

/** 一个创作期注册到 agent 系统提示的提示段（name/order/text 与 LayerConfig 同构）。 */
export interface AgentSection {
  name: string
  order: number
  text: string
}

/** 创作期注入（真实适配器里映射为 setup(agentCtx) 内的 mount/section/restrict）。 */
export interface AgentHooks {
  persona?: string
  tools?: readonly string[]
  /** 工具拒绝名单（restrict deny；与 tools 白名单可并用）。只接受会话真实可见面内的名字，未知名 warn-drop。 */
  denyTools?: readonly string[]
  /** 绑定角色时逐层注册的提示段（name = `dsh-agent-toolkit:agent:<layer>`）。 */
  sections?: readonly AgentSection[]
}

export interface AgentsPort {
  create(input: {
    sessionId: string
    cwd: string
    agentOptions?: { provider?: string; model?: string }
    hooks: AgentHooks
  }): Promise<AgentPort>
  resume(input: {
    sessionId: string
    agentOptions?: { provider?: string; model?: string }
    hooks: AgentHooks
  }): Promise<AgentPort>
  /**
   * 宿主内存中已存活的 agent（web 界面等持有写句柄）：接管复用（宿主 session-controller
   * createOrAdopt 同款 live 复用），保持其当前装配（setup 不重跑）；其 dispose 为空操作（句柄归原主）。
   */
  get(sessionId: string): AgentPort | undefined
}

/** main 形态会话（bot 未自配 agentOptions 时）与未配置模型的角色的模型来源（取 {provider, model}）。 */
export type DefaultModelAccessor = () => { provider: string; model: string }

/** 会话归属：把 session 挂到 cwd 对应 workspace（宿主侧幂等；无则自动建）。 */
export interface WorkspacePort {
  attach(cwd: string, sessionId: string): Promise<void>
}

export interface BindingStore {
  get(botId: string, chatId: string): string | undefined
  set(botId: string, chatId: string, sessionId: string): Promise<void>
  delete(botId: string, chatId: string): Promise<void>
  /** 删除某 bot 的全部绑定（bot 被删除时）。 */
  deleteBot(botId: string): Promise<void>
}

/** /sessions 候选会话项（title 取不到时缺省，渲染层显示 (无标题)）。 */
export interface SessionCatalogEntry {
  sessionId: string
  title?: string
}

/** 候选会话目录端口：列出 bot 项目 workspace 下的可切换会话（真实适配器在 session-catalog.ts）。 */
export interface SessionCatalogPort {
  list(project: string): Promise<readonly SessionCatalogEntry[]>
}

/** 一个活跃会话的运行时状态（inbound/outbound 共享）。 */
export interface SessionRuntime {
  readonly botId: string
  readonly chatId: string
  readonly sessionId: string
  /** 会话发起人的渠道 open_id（审批卡片越权校验用；ensure/reset 的 userId 落入）。 */
  readonly initiatorOpenId: string
  agent: AgentPort
  /** 最近一次入站消息携带的回复句柄（回复永远回到 chat）。 */
  reply: ReplyHandle | undefined
  /** 单会话单 in-flight 槽；ack = 表情回复的 disposer。 */
  inflight: { ack: Disposer | undefined } | undefined
  /** 出站操作串行化 Promise 链（保序）。 */
  tail: Promise<unknown>
  /** 当前 turn 归集状态；无进行中 turn 为 undefined。 */
  turn: {
    n: number; segments: TurnSegment[]; began: boolean; lastTextStep?: number; attemptStep?: number
    /** 帧统计（frame-stats debug 事件；turn/end 输出后随 turn 销毁）。 */
    stats?: { starts: number; textDeltas: number; reasoningDeltas: number; droppedNoBaseline: number }
  } | undefined
  /**
   * retire 后仍在 sessions 中收尾（等 whenIdle + tail 落定才摘除，让旧卡 finalize）期间为 true：
   * ensure 不得复用收尾中的 runtime（其 agent 已 cancel），重绑窗口须 resume + adopt 重建。
   */
  retiring: boolean
}

/** 从 bot 记录提取创作期注入（主 Agent 绑定形态）。 */
export function hooksOf(bot: BotRecord): AgentHooks {
  return {
    ...(bot.persona !== undefined ? { persona: bot.persona } : {}),
    ...(bot.tools !== undefined ? { tools: bot.tools } : {}),
  }
}
