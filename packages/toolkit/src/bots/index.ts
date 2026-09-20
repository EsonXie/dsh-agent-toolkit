/** bots 模块：项目机器人（飞书渠道）——多 bot 作为项目 agent 的交互入口（project-bot Node 半迁移，去 preset 化）。 */
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
// type-only 导入激活各包对 cordis Context 的声明合并（inject 的服务属性）。
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
// Side-effect type import: declaration-merges the `approval/request` waterfall event
// answered below（照 host api-proxy.ts L87-90 同款；type-only，bundle 期擦除无运行时依赖）。
import type {} from '@deepseek-ai/dsh-user-approval'
// type-only：激活 user-questions/request waterfall 的声明合并（approval/request 同款先例）。
import type {} from '@deepseek-ai/dsh-user-questions'
// type-only：激活 permissionPresets 服务在 Context 上的声明合并（ctx.get 可选服务读取）。
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { AgentRegistry } from '../agents/registry.ts'
import { registerOptionalRoutes } from '../shared/webserver.ts'
import { createAgentsPort } from '../channels/agents-port.ts'
import type { BotChannel, ChannelTunables } from '../channels/channel.ts'
import { createFeishuDebugLogger, DEFAULT_DEBUG_LOG_DIR } from '../channels/feishu/debug-log.ts'
import { feishuChannel } from '../channels/feishu/index.ts'
import type { AttachmentsPort } from '../channels/inbound.ts'
import type { SessionCatalogPort } from '../channels/ports.ts'
import { createSessionCatalog, type CatalogSessionProjectionCache, type CatalogSessionProjections, type CatalogSessionQuery, type CatalogSessionTitle, type CatalogSessions, type CatalogWorkspaceRegistry } from '../channels/session-catalog.ts'
import type { WorkspacePort } from '../channels/ports.ts'
import { BotRuntime } from '../channels/runtime.ts'
import { createScopeJoiner, type ScopeJoiner } from '../channels/scope-joiner.ts'
import { createToolsScope } from '../channels/tool-scope.ts'
import { createApprovalAnswerer } from '../channels/approval/answerer.ts'
import { createQuestionAnswerer } from '../channels/questions/answerer.ts'
import { createPresetApplier } from './permission-preset.ts'
import { createApiHandler } from './api.ts'
import { RegisterAppService } from './register-app.ts'
import type { Binding, BotRecord } from './store.ts'

/** project-bot Config 的 14 个全局可调参数：9 个字段名不变（schemastery 定义与默认值源：archive/2026-08-26-merged-plugins/project-bot/src/index.ts:38-45，由 Task 15 平移进 suite Config）；docMaxBytes 与 debugLog/debugLogDir/debugLogRetentionDays 为 Task 5 新增（非 archive 平移）。 */
export interface BotsModuleConfig {
  /** 卡片流式更新节流间隔（毫秒）。 */
  cardUpdateThrottleMs: number
  /** 单卡真实 DSL 字节上限（含结构与转义；平台硬上限 30KB）。 */
  cardMaxBytes: number
  /** 飞书流式打字机每次打印字符数。 */
  cardPrintStep: number
  /** 过程区（思考 + 工具调用）字节上限（截尾保留最近内容）。 */
  processMaxBytes: number
  /** 扫码创建应用的轮询超时（毫秒）。 */
  registerAppTimeoutMs: number
  /** 「处理中」表情回复的 emoji_type。 */
  processingReactionEmoji: string
  /** 回传飞书的错误摘要最大字符数。 */
  errorDetailMaxChars: number
  /** 会话创建/恢复时注入「渠道 + 发起人 open_id」提示段（dsh-agent-toolkit:channel:sender）。 */
  injectSender: boolean
  /** 飞书审批卡片：bot 会话的工具提权申请改由飞书卡片审批（仅会话发起人可点）。 */
  approval: boolean
  /** 飞书问答卡：bot 会话的 ask_user_question / plan 评审改由飞书卡片作答（仅会话发起人可答）。 */
  questions: boolean
  /** bot 会话建账即应用的宿主权限预设名（缺省维持宿主默认；danger-full-access 风险见 Config 注释）。 */
  permissionPreset?: string
  /** /doc 发送文件的大小上限（字节）。 */
  docMaxBytes: number
  /** 生产调试文件日志开关（JSONL，按日滚动）。 */
  debugLog: boolean
  /** 日志目录（空 = <os.homedir()>/.dsh/logs/feishu-debug/）。 */
  debugLogDir: string
  /** 日志保留天数（按文件名日期清理）。 */
  debugLogRetentionDays: number
}

/** setupBots 的宿主接线依赖（registry 供运行时委派/API 消费；bots/bindings 为插件入口打开的 project_bot 表句柄）。 */
export interface BotsDeps {
  registry: AgentRegistry
  /** bot 会话挂载的 preset id（agent-team；agentTeamPreset 开启时下达；undefined = 直接 toolsScope）。 */
  presetId?: string
  /** project_bot.bots 表句柄（domain 由插件入口打开，模块不再自开）。 */
  bots: KvTable<string, BotRecord>
  /** project_bot.bindings 表句柄（domain 由插件入口打开，模块不再自开）。 */
  bindings: KvTable<string, Binding>
}

/**
 * 装配 bot 运行时。返回值是卸载排空句柄（等启动链落定 + stopAll 排空在飞会话与出站链）：
 * 插件入口必须把它作为 project_bot domain 的 `openDomainSafely` beforeClose 传入——cordis
 * 的 disposer 并发执行（`Fiber._unload` = `Promise.all`），单靠注册顺序无法保证 drain 先于
 * 关域；只有同一 effect 内串行 await drain 再 close，才能避免 drain 期间的写被 closed 拒绝。
 */
export function setupBots(ctx: Context, config: BotsModuleConfig, deps: BotsDeps): () => Promise<void> {
  const log = { warn: (m: string) => ctx.logger.warn(m), info: (m: string) => ctx.logger.info(m) }
  const channels: ReadonlyMap<string, BotChannel> = new Map([['feishu', feishuChannel]])
  const debugLog = config.debugLog
    ? createFeishuDebugLogger(config.debugLogDir === '' ? DEFAULT_DEBUG_LOG_DIR() : config.debugLogDir, config.debugLogRetentionDays)
    : undefined
  const tunables: ChannelTunables = {
    cardUpdateThrottleMs: config.cardUpdateThrottleMs,
    cardMaxBytes: config.cardMaxBytes,
    processMaxBytes: config.processMaxBytes,
    cardPrintStep: config.cardPrintStep,
    processingReactionEmoji: config.processingReactionEmoji,
    ...(debugLog !== undefined ? { debugLog } : {}),
  }

  const storeSecret = async (key: string, secret: string): Promise<string> => {
    const ref = `project_bot_${key.replace(/[^A-Za-z0-9_]/g, '_')}`
    await ctx.credentials.set(credentialRef(ref), secret)
    return ref
  }

  /** 创作期注入已迁至 agent-setup.ts + tool-scope.ts（基础工具行 standing scope 挂载 + persona/tools）。
   *  preset 优先 joiner（agent-team 组合）：mount 成功后委派子会话 composeFrom 认父（spec: docs/superpowers/specs/archive/2026-09-07-bot-delegation-preset-mount-design.md）。 */
  const toolsScope = createToolsScope(ctx)
  // preset 优先：mount 成功后委派子会话 composeFrom 认父；未下达 id 时维持 toolsScope 直挂。
  const scopeJoiner: ScopeJoiner = deps.presetId !== undefined
    ? createScopeJoiner(ctx, deps.presetId, toolsScope, log.warn)
    : toolsScope

  // 权限预设：配置后 create/resume/接管三路径统一应用（agents-port 内调用点）；
  // 活跃复用与 /switch 内存复用不经过 agents.get，天然不翻转存量会话。
  const presetName = config.permissionPreset
  const applyPreset = presetName === undefined ? undefined
    : createPresetApplier(() => ctx.get('permissionPresets'), presetName, log.warn)
  // 第三参（cronExcludedSessions）仅 schedule 使用：bot 聊天会话不登记排除集，
  // 与 web 主会话同档，可建定时任务（2026-09-16 门控收窄）。
  const agentsPort = createAgentsPort(ctx, scopeJoiner, undefined, applyPreset)

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

  // attachments 是可选服务：**消息到达时惰性解析**（宿主 read-image 同款"执行时再查"）。
  // apply 期一次性捕获不可靠——attachment-local 的 fiber 可能尚未注册完服务，
  // 启动期 ctx.get 拿到 undefined 会让图片消息永远走降级提示（2026-09-03 实测踩坑）。
  interface AttachmentsStoreLike {
    saveImages(inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]): Promise<readonly ImageAttachmentRef[]>
  }
  const attachmentsOf = (): AttachmentsPort | undefined => {
    const store = ctx.get('attachments', false) as AttachmentsStoreLike | undefined
    if (store === undefined) return undefined
    return {
      async saveImages(inputs) {
        // 保存时再取一次（与可用性判断同刻）；mediaType 已由渠道按魔数判定为接受的
        // 图片类型，store.saveImages 内部按解码字节再验证。
        const current = ctx.get('attachments', false) as AttachmentsStoreLike | undefined
        if (current === undefined) throw new Error('attachments 服务不可用')
        return current.saveImages(inputs.map(({ data, mediaType, name }) => ({
          data,
          mediaType: mediaType as ImageMediaType,
          ...(name !== undefined ? { name } : {}),
        })))
      },
    }
  }

  // 候选会话目录（/sessions、/switch）：六服务均为可选，取用与 list 时惰性解析（attachments 同款）。
  // 标题与 web 端同源：live 走 sessionProjections 投影，冷会话走 sessionQuery header +
  // sessionProjectionCache 持久化投影（不 resume 会话），统一 displayTitle 回退链。
  const catalogOf = (): SessionCatalogPort | undefined =>
    createSessionCatalog(() => ({
      workspaceRegistry: ctx.get('workspaceRegistry', false) as CatalogWorkspaceRegistry | undefined,
      sessions: ctx.get('sessions', false) as CatalogSessions | undefined,
      sessionProjections: ctx.get('sessionProjections', false) as CatalogSessionProjections | undefined,
      sessionTitle: ctx.get('sessionTitle', false) as CatalogSessionTitle | undefined,
      sessionQuery: ctx.get('sessionQuery', false) as CatalogSessionQuery | undefined,
      sessionProjectionCache: ctx.get('sessionProjectionCache', false) as CatalogSessionProjectionCache | undefined,
    }))

  // project_bot 存储域由插件入口打开（domain 句柄经 deps 下达），本模块不再自开；
  // 卸载时先等启动链落定、排空在飞会话与出站链（stopAll 内含卡片定格 drain），
  // 再让插件入口的 openDomainSafely 关域——close 一旦开始就拒绝新入队的写。
  let runtime: BotRuntime | undefined
  let started: Promise<void> = Promise.resolve()

  const registerAppService = new RegisterAppService({
    registerApp: (options) => import('@larksuiteoapi/node-sdk').then((lark) => lark.registerApp(options)),
    storeSecret,
    timeoutMs: config.registerAppTimeoutMs,
  })

  started = Promise.resolve().then(() => {
    runtime = new BotRuntime({
      bots: deps.bots,
      bindings: deps.bindings,
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
      docMaxBytes: config.docMaxBytes,
      ...(debugLog !== undefined ? { debugLog } : {}),
      attachments: attachmentsOf,
      catalog: catalogOf,
      injectSender: config.injectSender,
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

  // 出站：瞬态流式帧 → runtime.outbound（agent scoped emit，app 级订阅收到全部 agent，按自有 session 过滤）。
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    runtime?.outbound.handleAssistantFrame(String(agent.session.id), frame)
  })

  // 审批 answerer：prepend 抢在 web api-proxy 全局 answerer 之前（其从不 next 让出）；
  // runtime 未启动/非自有会话/发卡失败时 createApprovalAnswerer 内部 next() 透传，行为回到现状。
  if (config.approval) {
    ctx.on('approval/request', createApprovalAnswerer(() => runtime?.approval), { prepend: true })
  }

  // 问答 answerer：prepend 与审批同款；runtime 未启动/非自有会话/发卡失败时 next() 透传（web 浏览器应答）。
  // debugLog 一并下达：fall-through 的 warn 在 dsh web 不可见，回退原因靠 debugLog 事件分辨。
  if (config.questions) {
    ctx.on('user-questions/request', createQuestionAnswerer(() => runtime?.questions, debugLog), { prepend: true })
  }

  // turn 外错误（无 turn/end 兜底）：agent/error → notice 错误摘要 + 释放 inflight（outbound 内去重）。
  ctx.on('agent/error', ({ agent, error }) => {
    const text = error instanceof Error
      ? error.message
      : String((error as { message?: unknown } | null)?.message ?? error)
    runtime?.outbound.handleAgentError(String(agent.session.id), text)
  })

  // webServer 是可选能力（headless 无此服务）：经 registerOptionalRoutes 子 fiber 惰性注册
  // （token-usage 同款）；子 fiber 未激活时惰性、随父 fiber 卸载而清理。
  // 仅注册本模块自己的 /dsh-agent-toolkit/api/bots 前缀；agents/providers/tools 核心端点由
  // setupAgentsApi 恒启用注册（同前缀下 longest-prefix 匹配、路径互不重叠），本分支不涉足。
  registerOptionalRoutes(ctx, (webCtx) => {
    // bots handler 请求时才构造：runtime 在 started 落定后才赋值，注册期捕获会拿到 undefined。
    const botsHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void> = async (req, res) => {
      if (runtime === undefined) throw new Error('runtime unavailable')
      await createApiHandler({
        bots: deps.bots,
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
    const dispose = webCtx.webServer.register({
      kind: 'prefix',
      path: '/dsh-agent-toolkit/api/bots',
      handler: async (req, res) => {
        try {
          // 请求时才等待自身启动链：避免连带失败与注册期捕获 undefined runtime。
          await started
          await botsHandler(req, res)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    })
    return () => dispose()
  })

  // 卸载：释放工具行 standing scope；中断扫码轮询。运行时 drain（stopAll）由插件入口经
  // 返回值作为 project_bot domain 的 beforeClose 串行执行（见函数 JSDoc），不在此注册 effect。
  ctx.effect(() => async () => {
    await toolsScope.dispose()
  })
  ctx.effect(() => async () => {
    registerAppService.dispose()
  })

  return async () => {
    await started.catch(() => undefined)
    await runtime?.stopAll()
  }
}
