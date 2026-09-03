/** BotRuntime：bot 名册 → 渠道生命周期；聚合 router/inbound/outbound。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentRegistry } from '../agents/registry.ts'
import { bindingKey, type Binding, type BotRecord } from '../bots/store.ts'
import type { BotChannel, ChannelHandle, ChannelStatus, ChannelTunables } from './channel.ts'
import { Inbound } from './inbound.ts'
import { Outbound } from './outbound.ts'
import type { AgentsPort, BindingStore, DefaultModelAccessor, SessionRuntime, WorkspacePort } from './ports.ts'
import { Router } from './router.ts'

export interface RuntimeDeps {
  bots: KvTable<string, BotRecord>
  bindings: KvTable<string, Binding>
  agents: AgentsPort
  /** Agent 注册表（agentRef → main/角色），Router 会话创建时决定 persona/工具/模型装配。 */
  registry: AgentRegistry
  /** 存量 bot 无 agentOptions 时回退宿主默认模型。 */
  defaultModel: DefaultModelAccessor
  /** 会话归入 bot 项目 workspace。 */
  workspace: WorkspacePort
  channels: ReadonlyMap<string, BotChannel>
  tunables: ChannelTunables
  /** 回传渠道的错误摘要最大字符数。 */
  maxErrorDetailChars: number
  resolveSecret(ref: string): Promise<string | undefined>
  validateProject(path: string): boolean
  log: { warn(message: string): void; info(message: string): void }
}

export type BotStatus = ChannelStatus | 'not-running'

export class BotRuntime {
  readonly sessions = new Map<string, SessionRuntime>()
  readonly router: Router
  readonly inbound: Inbound
  readonly outbound: Outbound
  private readonly handles = new Map<string, ChannelHandle>()

  constructor(private readonly deps: RuntimeDeps) {
    const bindingStore = this.bindingStore()
    this.router = new Router(deps.agents, bindingStore, this.sessions, deps.defaultModel, deps.workspace, (m) => deps.log.warn(m), deps.registry)
    this.inbound = new Inbound({ router: this.router, bots: deps.bots, maxErrorDetailChars: deps.maxErrorDetailChars, onError: (m) => deps.log.warn(m) })
    this.outbound = new Outbound(this.sessions, (m) => deps.log.warn(m), deps.maxErrorDetailChars)
  }

  async startAll(): Promise<void> {
    for (const botId of [...this.deps.bots.keys()]) await this.reconcile(botId)
  }

  /** 按最新记录重建该 bot 的渠道（创建/更新后调用；记录已删则纯停止）。 */
  async reconcile(botId: string): Promise<void> {
    await this.stopChannel(botId)
    const record = this.deps.bots.get(botId)
    if (record === undefined) return
    if (!this.deps.validateProject(record.project)) {
      this.deps.log.warn(`[project-bot] bot "${botId}" 的项目路径不可用：${record.project}`)
      return
    }
    const secret = await this.deps.resolveSecret(record.feishu.appSecretRef)
    if (secret === undefined) {
      this.deps.log.warn(`[project-bot] bot "${botId}" 的密钥 ${record.feishu.appSecretRef} 未配置`)
      return
    }
    const channel = this.deps.channels.get(record.channel)
    if (channel === undefined) {
      this.deps.log.warn(`[project-bot] bot "${botId}" 的渠道 "${record.channel}" 未实现`)
      return
    }
    try {
      const handle = await channel.start(
        { record, secret },
        { onMessage: (msg) => this.inbound.onMessage(msg) },
        this.deps.tunables,
        (m) => this.deps.log.warn(m),
      )
      this.handles.set(botId, handle)
    } catch (error) {
      this.deps.log.warn(`[project-bot] bot "${botId}" 渠道启动失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 删除 bot：停渠道、取消会话、清绑定。 */
  async stopBot(botId: string): Promise<void> {
    await this.stopChannel(botId)
    for (const [sessionId, rt] of [...this.sessions]) {
      if (rt.botId === botId) {
        rt.agent.cancel()
        this.sessions.delete(sessionId)
      }
    }
    await this.bindingStore().deleteBot(botId)
  }

  statusOf(botId: string): BotStatus {
    return this.handles.get(botId)?.status() ?? 'not-running'
  }

  /** 卸载时序：取消在飞会话 → 等 idle → drain 出站链（卡片定格）→ 断全部渠道。 */
  async stopAll(): Promise<void> {
    for (const rt of this.sessions.values()) rt.agent.cancel()
    await Promise.allSettled([...this.sessions.values()].map(async (rt) => {
      await rt.agent.whenIdle().catch(() => undefined)
      await rt.tail
    }))
    await Promise.allSettled([...this.handles.values()].map((h) => h.close()))
    this.handles.clear()
  }

  private async stopChannel(botId: string): Promise<void> {
    const handle = this.handles.get(botId)
    if (handle === undefined) return
    this.handles.delete(botId)
    await handle.close().catch((error) => {
      this.deps.log.warn(`[project-bot] bot "${botId}" 渠道关闭异常：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private bindingStore(): BindingStore {
    const { bindings } = this.deps
    return {
      get: (b, c) => bindings.get(bindingKey(b, c))?.sessionId,
      set: async (b, c, s) => { await bindings.put(bindingKey(b, c), { sessionId: s }) },
      delete: async (b, c) => { await bindings.delete(bindingKey(b, c)) },
      deleteBot: async (b) => {
        for (const key of [...bindings.keys()]) {
          if (key.startsWith(`${b}:`)) await bindings.delete(key)
        }
      },
    }
  }
}
