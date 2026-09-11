/** BotRuntime：bot 名册 → 渠道生命周期；聚合 router/inbound/outbound。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentRegistry } from '../agents/registry.ts'
import { bindingKey, type Binding, type BotRecord } from '../bots/store.ts'
import type { BotChannel, ChannelHandle, ChannelStatus, ChannelTunables } from './channel.ts'
import { Inbound } from './inbound.ts'
import { Outbound } from './outbound.ts'
import type { AgentsPort, BindingStore, DefaultModelAccessor, SessionCatalogPort, SessionRuntime, WorkspacePort } from './ports.ts'
import { Router } from './router.ts'
import type { AttachmentsPort } from './inbound.ts'
import { ApprovalCenter } from './approval/center.ts'

export interface RuntimeDeps {
  bots: KvTable<string, BotRecord>
  bindings: KvTable<string, Binding>
  agents: AgentsPort
  /** Agent 注册表（agentRef → main/角色），Router 会话创建时决定 persona/工具/模型装配。 */
  registry: AgentRegistry
  /** main 形态会话（bot 未自配 agentOptions 时）与未配置模型的角色回退宿主默认模型。 */
  defaultModel: DefaultModelAccessor
  /** 会话归入 bot 项目 workspace。 */
  workspace: WorkspacePort
  channels: ReadonlyMap<string, BotChannel>
  tunables: ChannelTunables
  /** 回传渠道的错误摘要最大字符数。 */
  maxErrorDetailChars: number
  /** /doc 发送文件的大小上限（字节）。 */
  docMaxBytes: number
  /** 可选：宿主附件服务的惰性取用器（消息时解析；返回 undefined = 图片降级提示）。 */
  attachments?: () => AttachmentsPort | undefined
  /** 可选：候选会话目录的惰性取用器（/sessions、/switch；缺席时两指令降级文案）。 */
  catalog?: () => SessionCatalogPort | undefined
  /** 发起人提示段开关（缺省 true；见 Config feishu.injectSender）。 */
  injectSender?: boolean
  resolveSecret(ref: string): Promise<string | undefined>
  validateProject(path: string): boolean
  log: { warn(message: string): void; info(message: string): void }
}

export type BotStatus = ChannelStatus | 'not-running' | 'unbound'

export class BotRuntime {
  readonly sessions = new Map<string, SessionRuntime>()
  readonly router: Router
  readonly inbound: Inbound
  readonly outbound: Outbound
  readonly approval: ApprovalCenter
  private readonly handles = new Map<string, ChannelHandle>()

  constructor(private readonly deps: RuntimeDeps) {
    const bindingStore = this.bindingStore()
    this.router = new Router(deps.agents, bindingStore, this.sessions, deps.defaultModel, deps.workspace, (m) => deps.log.warn(m), deps.registry, deps.injectSender ?? true)
    this.inbound = new Inbound({
      router: this.router,
      bots: deps.bots,
      maxErrorDetailChars: deps.maxErrorDetailChars,
      docMaxBytes: deps.docMaxBytes,
      ...(deps.attachments !== undefined ? { attachments: deps.attachments } : {}),
      ...(deps.catalog !== undefined ? { catalog: deps.catalog } : {}),
      onError: (m) => deps.log.warn(m),
    })
    this.outbound = new Outbound(this.sessions, (m) => deps.log.warn(m), deps.maxErrorDetailChars)
    this.approval = new ApprovalCenter(
      this.sessions,
      (botId) => {
        const presenter = this.handles.get(botId)?.approval
        if (presenter === undefined) return undefined
        return { presenter, botName: this.deps.bots.get(botId)?.name ?? botId }
      },
      (m) => deps.log.warn(m),
    )
  }

  async startAll(): Promise<void> {
    for (const botId of [...this.deps.bots.keys()]) await this.reconcile(botId)
  }

  /** 按最新记录重建该 bot 的渠道（创建/更新后调用；记录已删或未绑定则纯停止）。 */
  async reconcile(botId: string): Promise<void> {
    await this.stopChannel(botId)
    const record = this.deps.bots.get(botId)
    if (record === undefined) return
    // 未绑定（channel/feishu 均缺省）的 bot：停渠道即止，不启动不告警。
    if (record.feishu === undefined || record.channel === undefined) return
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
        { onMessage: (msg) => this.inbound.onMessage(msg), onCardAction: (action) => this.approval.handleCardAction(action) },
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
      if (rt.botId === botId) this.retire(sessionId, rt)
    }
    await this.bindingStore().deleteBot(botId)
  }

  /** 解绑渠道：停渠道、取消在飞会话；绑定表与持久会话保留（重绑后 resume 接续）。 */
  async unbindBot(botId: string): Promise<void> {
    await this.stopChannel(botId)
    for (const [sessionId, rt] of [...this.sessions]) {
      if (rt.botId === botId) this.retire(sessionId, rt)
    }
  }

  /** 取消会话并等出站链落定后摘出 sessions（让在飞 turn 的 turn/end 正常 finalize 旧卡），随后 dispose 释放写句柄（重绑 resume 前提）。 */
  private retire(sessionId: string, rt: SessionRuntime): void {
    rt.retiring = true
    rt.agent.cancel()
    void (async () => {
      await rt.agent.whenIdle().catch(() => undefined)
      await rt.tail.catch(() => undefined)
      if (this.sessions.get(sessionId) !== rt) return
      this.sessions.delete(sessionId)
      await rt.agent.dispose().catch((error) => {
        this.deps.log.warn(`[project-bot] 会话 ${sessionId} 的 agent 释放失败：${error instanceof Error ? error.message : String(error)}`)
      })
    })()
  }

  statusOf(botId: string): BotStatus {
    const record = this.deps.bots.get(botId)
    if (record !== undefined && record.feishu === undefined) return 'unbound'
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
    this.approval.dispose()
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
