/** bots 模块：项目机器人（飞书渠道）——多 bot 作为项目 agent 的交互入口（project-bot Node 半迁移，去 preset 化）。 */
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
// type-only 导入激活各包对 cordis Context 的声明合并（inject 的服务属性）。
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { AgentRegistry } from '../agents/registry.ts'
import type { LayerConfig, Rule } from '../prompt/types.ts'
import { openDomainSafely } from '../shared/storage.ts'
import { registerOptionalRoutes } from '../shared/webserver.ts'
import { setupAgentScope } from '../channels/agent-setup.ts'
import type { BotChannel, ChannelTunables } from '../channels/channel.ts'
import { feishuChannel } from '../channels/feishu/index.ts'
import type { AgentPort, AgentsPort, WorkspacePort } from '../channels/ports.ts'
import { BotRuntime } from '../channels/runtime.ts'
import { createAgentsApiHandler } from '../agents/api.ts'
import { createApiHandler } from './api.ts'
import { RegisterAppService } from './register-app.ts'
import { projectBotDomain, type Binding, type BotRecord } from './store.ts'

/** project-bot Config 的 6 个全局可调参数（字段名不变；schemastery 定义与默认值源：archive/2026-08-26-merged-plugins/project-bot/src/index.ts:38-45，由 Task 15 平移进 suite Config）。 */
export interface BotsModuleConfig {
  /** 卡片流式更新节流间隔（毫秒）。 */
  cardUpdateThrottleMs: number
  /** 单张卡片内容字节上限（飞书硬上限 30KB，留余量）。 */
  cardMaxBytes: number
  /** 过程区（思考 + 工具调用）字节上限（截尾保留最近内容）。 */
  processMaxBytes: number
  /** 扫码创建应用的轮询超时（毫秒）。 */
  registerAppTimeoutMs: number
  /** 「处理中」表情回复的 emoji_type。 */
  processingReactionEmoji: string
  /** 回传飞书的错误摘要最大字符数。 */
  errorDetailMaxChars: number
}

/** setupBots 的宿主接线依赖（registry / prompt 供 Task 13 的角色 persona 装配消费；本任务只声明接口）。 */
export interface BotsDeps {
  registry: AgentRegistry
  prompt: { layers: LayerConfig[]; rules: Rule[] }
}

export function setupBots(ctx: Context, config: BotsModuleConfig, deps: BotsDeps): void {
  const log = { warn: (m: string) => ctx.logger.warn(m), info: (m: string) => ctx.logger.info(m) }
  const channels: ReadonlyMap<string, BotChannel> = new Map([['feishu', feishuChannel]])
  const tunables: ChannelTunables = {
    cardUpdateThrottleMs: config.cardUpdateThrottleMs,
    cardMaxBytes: config.cardMaxBytes,
    processMaxBytes: config.processMaxBytes,
    processingReactionEmoji: config.processingReactionEmoji,
  }

  const storeSecret = async (key: string, secret: string): Promise<string> => {
    const ref = `project_bot_${key.replace(/[^A-Za-z0-9_]/g, '_')}`
    await ctx.credentials.set(credentialRef(ref), secret)
    return ref
  }

  /** 创作期注入已迁至 agent-setup.ts（基础工具 scoped 挂载 + persona/tools），preset 机制整体移除。 */

  const agentsPort: AgentsPort = {
    async create(input) {
      const handle: AgentHandle = await ctx.agents.create({
        sessionId: SessionId(input.sessionId),
        meta: { cwd: input.cwd },
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        setup: (agentCtx) => setupAgentScope(agentCtx, input.hooks),
      })
      return adaptAgent(handle)
    },
    async resume(input) {
      const handle: AgentHandle = await ctx.agents.resume({
        resumeSessionId: SessionId(input.sessionId),
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        setup: (agentCtx) => setupAgentScope(agentCtx, input.hooks),
      })
      return adaptAgent(handle)
    },
  }

  function adaptAgent(handle: AgentHandle): AgentPort {
    const { agent } = handle
    return {
      sessionId: String(agent.id),
      followup: (message) => agent.followup(message as Parameters<typeof agent.followup>[0]),
      cancel: () => agent.cancel({ kind: 'user' }),
      whenIdle: () => agent.whenIdle(),
    }
  }

  // workspaceRegistry 是可选服务（ctx.get 非严格模式）：缺失时 attach 抛错，
  // 由 Router 捕获降级为"未分组 + 告警"，不阻塞消息处理。
  interface WorkspaceRegistryLike {
    create(path: string): Promise<{ attachSession(sessionId: SessionId): Promise<void> }>
  }
  const workspaceRegistry = ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
  const workspacePort: WorkspacePort = {
    async attach(cwd, sessionId) {
      if (workspaceRegistry === undefined) throw new Error('workspaceRegistry 服务不可用')
      const workspace = await workspaceRegistry.create(cwd)
      await workspace.attachSession(SessionId(sessionId))
    },
  }

  // 存储域：open 失败挂 rejection handler 防次生崩溃，调用方仍感知失败（token-usage 同款）。
  // 卸载顺序由 openDomainSafely 的 beforeClose 保证：先等启动链落定、排空在飞会话与出站链
  // （stopAll 内含卡片定格 drain），再关存储域——close 一旦开始就拒绝新入队的写。
  let botsTable: import('@deepseek-ai/dsh-storage-domain').KvTable<string, BotRecord> | undefined
  let bindingsTable: import('@deepseek-ai/dsh-storage-domain').KvTable<string, Binding> | undefined
  let runtime: BotRuntime | undefined
  let started: Promise<void> = Promise.resolve()
  const domainReady = openDomainSafely(
    ctx,
    projectBotDomain,
    (msg) => log.warn(msg),
    async () => {
      await started.catch(() => undefined)
      await runtime?.stopAll()
    },
  ).then((domain) => {
    botsTable = domain.table('bots') as import('@deepseek-ai/dsh-storage-domain').KvTable<string, BotRecord>
    bindingsTable = domain.table('bindings') as import('@deepseek-ai/dsh-storage-domain').KvTable<string, Binding>
    return domain
  })

  const registerAppService = new RegisterAppService({
    registerApp: (options) => import('@larksuiteoapi/node-sdk').then((lark) => lark.registerApp(options)),
    storeSecret,
    timeoutMs: config.registerAppTimeoutMs,
  })

  started = domainReady.then(() => {
    runtime = new BotRuntime({
      bots: botsTable!,
      bindings: bindingsTable!,
      agents: agentsPort,
      registry: deps.registry,
      defaultModel: () => {
        const selection = ctx.agentDefaultModel.currentSelection()
        return { provider: selection.provider, model: selection.model }
      },
      workspace: workspacePort,
      channels,
      tunables,
      maxErrorDetailChars: config.errorDetailMaxChars,
      resolveSecret: async (ref) => (await ctx.credentials.resolve(credentialRef(ref)))?.value,
      validateProject: (path) => existsSync(path),
      log,
    })
    return runtime.startAll()
  })
  started.catch((error) => {
    log.warn(`[project-bot] 启动失败：${error instanceof Error ? error.message : String(error)}`)
  })

  // 出站：持久会话事件 → runtime.outbound（session id 匹配自有 runtime，其余忽略）。
  ctx.on('session/event', (session, event) => {
    runtime?.outbound.handleSessionEvent(String(session.header.id), event as { type: string; data: Record<string, unknown> })
  })

  // turn 外错误（无 turn/end 兜底）：agent/error → notice 错误摘要 + 释放 inflight（outbound 内去重）。
  ctx.on('agent/error', ({ agent, error }) => {
    const text = error instanceof Error
      ? error.message
      : String((error as { message?: unknown } | null)?.message ?? error)
    runtime?.outbound.handleAgentError(String(agent.session.id), text)
  })

  // webServer 是可选能力（headless 无此服务）：经 registerOptionalRoutes 子 fiber 惰性注册
  // （token-usage 同款）；子 fiber 未激活时惰性、随父 fiber 卸载而清理。
  // 统一挂载点：单前缀 /dsh-agent-toolkit/api，内部按路径空间分发（/usage/* 由 usage 模块
  // 自己的 exact 路由优先接管，webServer match 先精确后最长前缀，不会落到这里）。
  registerOptionalRoutes(ctx, (webCtx) => {
    // bots handler 请求时才构造：runtime 在 started 落定后才赋值，注册期捕获会拿到 undefined。
    const botsHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void> = async (req, res) => {
      if (runtime === undefined) throw new Error('runtime unavailable')
      await createApiHandler({
        bots: botsTable!,
        runtime,
        registerApp: registerAppService,
        listTools: () => ctx.tools.schemas().map((s) => s.name),
        listProviders: () => ctx.llm.listProviders().map(({ id, name }) => ({ id, name })),
        listModels: (provider) => ctx.llm.listModels(provider).then((models) => models.map(({ id, name }) => ({ id, name }))),
        storeSecret,
        deleteSecret: async (ref) => ctx.credentials.unset(credentialRef(ref)),
        validateProject: (path) => existsSync(path),
        now: () => Date.now(),
      })(req, res)
    }
    const agentsHandler = createAgentsApiHandler({
      registry: deps.registry,
      listTools: () => ctx.tools.schemas().map((s) => s.name),
      listProviders: () => ctx.llm.listProviders().map(({ id, name }) => ({ id, name })),
      listModels: (provider) => ctx.llm.listModels(provider).then((models) => models.map(({ id, name }) => ({ id, name }))),
    })
    const dispose = webCtx.webServer.register({
      kind: 'prefix',
      path: '/dsh-agent-toolkit/api',
      handler: async (req, res) => {
        try {
          const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
          if (pathname.startsWith('/dsh-agent-toolkit/api/bots')) {
            // bots 分支才等待自身启动链：agents/providers/tools 不依赖 bots 域，避免连带 500。
            await started
            await botsHandler(req, res)
            return
          }
          if (pathname.startsWith('/dsh-agent-toolkit/api/agents')
            || pathname.startsWith('/dsh-agent-toolkit/api/providers')
            || pathname === '/dsh-agent-toolkit/api/tools') {
            await agentsHandler(req, res)
            return
          }
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }))
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })
    return () => dispose()
  })

  // 卸载：中断扫码轮询；runtime drain（stopAll）与关存储域的顺序由 openDomainSafely 的 beforeClose 保证。
  ctx.effect(() => async () => {
    registerAppService.dispose()
  })
}
