/** project-bot 插件：项目机器人（飞书渠道）——多 bot 作为项目 agent 的交互入口。 */
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
// type-only 导入激活各包对 cordis Context 的声明合并（inject 的服务属性）。
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createApiHandler } from './api.ts'
import { feishuChannel } from './channels/feishu/index.ts'
import type { BotChannel, ChannelTunables } from './core/channel.ts'
import type { AgentHooks, AgentPort, AgentsPort } from './core/ports.ts'
import { BotRuntime } from './core/runtime.ts'
import { RegisterAppService } from './register-app.ts'
import { projectBotDomain, type Binding, type BotRecord } from './store.ts'

export interface Config {
  /** 卡片流式更新节流间隔（毫秒）。 */
  cardUpdateThrottleMs: number
  /** 单张卡片内容字节上限（飞书硬上限 30KB，留余量）。 */
  cardMaxBytes: number
  /** 扫码创建应用的轮询超时（毫秒）。 */
  registerAppTimeoutMs: number
  /** 「处理中」表情回复的 emoji_type。 */
  processingReactionEmoji: string
}

export const Config: z<Config> = z.object({
  cardUpdateThrottleMs: z.number().default(500),
  cardMaxBytes: z.number().default(28_000),
  registerAppTimeoutMs: z.number().default(600_000),
  processingReactionEmoji: z.string().default('OneSecond'),
})

export const name = 'project-bot'

export const inject = ['agents', 'credentials', 'storageDomain', 'tools', 'llm', 'agentDefaultModel']

export function apply(ctx: Context, config: Config): void {
  const log = { warn: (m: string) => ctx.logger.warn(m), info: (m: string) => ctx.logger.info(m) }
  const channels: ReadonlyMap<string, BotChannel> = new Map([['feishu', feishuChannel]])
  const tunables: ChannelTunables = {
    cardUpdateThrottleMs: config.cardUpdateThrottleMs,
    cardMaxBytes: config.cardMaxBytes,
    processingReactionEmoji: config.processingReactionEmoji,
  }

  const storeSecret = async (key: string, secret: string): Promise<string> => {
    const ref = `project_bot_${key.replace(/[^A-Za-z0-9_]/g, '_')}`
    await ctx.credentials.set(credentialRef(ref), secret)
    return ref
  }

  /** 创作期注入：persona 提示段（order 0 惯例）+ 工具白名单（未命中已注册名时 restrict 响亮失败）。 */
  const applyHooks = (agentCtx: Context, hooks: AgentHooks): void => {
    if (hooks.persona !== undefined) {
      agentCtx.systemPrompt.section({ name: 'project-bot:persona', order: 0, text: hooks.persona })
    }
    if (hooks.tools !== undefined) {
      agentCtx.tools.restrict({ allow: hooks.tools })
    }
  }

  const agentsPort: AgentsPort = {
    async create(input) {
      const handle: AgentHandle = await ctx.agents.create({
        sessionId: SessionId(input.sessionId),
        meta: { cwd: input.cwd },
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        setup: (agentCtx) => applyHooks(agentCtx, input.hooks),
      })
      return adaptAgent(handle)
    },
    async resume(input) {
      const handle: AgentHandle = await ctx.agents.resume({
        resumeSessionId: SessionId(input.sessionId),
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        setup: (agentCtx) => applyHooks(agentCtx, input.hooks),
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

  // 存储域：open 失败挂 rejection handler 防次生崩溃，调用方仍感知失败（token-usage 同款）。
  let botsTable: import('@deepseek-ai/dsh-storage-domain').KvTable<string, BotRecord> | undefined
  let bindingsTable: import('@deepseek-ai/dsh-storage-domain').KvTable<string, Binding> | undefined
  const domainReady = ctx.storageDomain.open(projectBotDomain).then((domain) => {
    botsTable = domain.table('bots')
    bindingsTable = domain.table('bindings')
    return domain
  })
  domainReady.catch((error) => {
    log.warn(`[project-bot] 存储域打开失败，插件不可用：${error instanceof Error ? error.message : String(error)}`)
  })

  let runtime: BotRuntime | undefined
  const registerAppService = new RegisterAppService({
    registerApp: (options) => import('@larksuiteoapi/node-sdk').then((lark) => lark.registerApp(options)),
    storeSecret,
    timeoutMs: config.registerAppTimeoutMs,
  })

  const started = domainReady.then(() => {
    runtime = new BotRuntime({
      bots: botsTable!,
      bindings: bindingsTable!,
      agents: agentsPort,
      defaultModel: () => {
        const selection = ctx.agentDefaultModel.currentSelection()
        return { provider: selection.provider, model: selection.model }
      },
      channels,
      tunables,
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

  // webServer 是可选能力（headless 无此服务）：ctx.inject 子 fiber + effect 接线 disposer（token-usage 同款）。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/project-bot/api',
      handler: async (req, res) => {
        try {
          await started
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
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    }), 'project-bot: /project-bot/api route')
  })

  // 卸载：取消在飞会话 → 定格卡片 → 断渠道 → 中断扫码轮询 → 关存储域。
  ctx.effect(() => async () => {
    registerAppService.dispose()
    if (runtime !== undefined) await runtime.stopAll()
    await started.catch(() => undefined)
    await domainReady.then((domain) => domain.close()).catch(() => undefined)
  })
}
