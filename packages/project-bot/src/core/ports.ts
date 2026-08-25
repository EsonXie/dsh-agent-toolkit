/** 核心对宿主 agents 服务 / 绑定表的结构化端口（测试用 fake 注入）。 */
import type { BotRecord } from '../store.ts'
import type { Disposer, ReplyHandle } from './channel.ts'

export interface AgentPort {
  readonly sessionId: string
  followup(message: unknown): void
  cancel(): void
  whenIdle(): Promise<void>
}

/** 创作期注入（真实适配器里映射为 setup(agentCtx) 内的 mount/section/restrict）。 */
export interface AgentHooks {
  persona?: string
  tools?: readonly string[]
  /** 挂载的 agent preset id（缺省 = 名册默认）。 */
  preset?: string
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
}

/** 无 agentOptions 的存量 bot 回退宿主默认模型（取 {provider, model}）。 */
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

/** 一个活跃会话的运行时状态（inbound/outbound 共享）。 */
export interface SessionRuntime {
  readonly botId: string
  readonly chatId: string
  readonly sessionId: string
  agent: AgentPort
  /** 最近一次入站消息携带的回复句柄（回复永远回到 chat）。 */
  reply: ReplyHandle | undefined
  /** 单会话单 in-flight 槽；ack = 表情回复的 disposer。 */
  inflight: { ack: Disposer | undefined } | undefined
  /** 出站操作串行化 Promise 链（保序）。 */
  tail: Promise<unknown>
  /** 当前 turn 归集状态；无进行中 turn 为 undefined。 */
  turn: { n: number; buffer: string; began: boolean } | undefined
}

/** 从 bot 记录提取创作期注入。 */
export function hooksOf(bot: BotRecord): AgentHooks {
  return {
    ...(bot.persona !== undefined ? { persona: bot.persona } : {}),
    ...(bot.tools !== undefined ? { tools: bot.tools } : {}),
    ...(bot.preset !== undefined ? { preset: bot.preset } : {}),
  }
}
