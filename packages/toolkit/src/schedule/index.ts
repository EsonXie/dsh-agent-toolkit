/** schedule 模块接线：存储域 → executor/scheduler/service → cron_* 工具 + HTTP API + 30s tick。 */
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { AgentRegistry } from '../agents/registry.ts'
import { createAgentsPort } from '../channels/agents-port.ts'
import type { WorkspacePort } from '../channels/ports.ts'
import { createScopeJoiner, type ScopeJoiner } from '../channels/scope-joiner.ts'
import { createToolsScope } from '../channels/tool-scope.ts'
import { openDomainSafely } from '../shared/storage.ts'
import { registerOptionalRoutes } from '../shared/webserver.ts'
import { createCronApiHandler } from './api.ts'
import { createExecutor } from './executor.ts'
import { createScheduler, type Scheduler } from './scheduler.ts'
import { createCronService } from './service.ts'
import { scheduleDomain, type CronRun, type CronTask } from './store.ts'
import { createCronTools, setupCronTools } from './tools.ts'

export interface ScheduleModuleConfig {
  /** 单次运行 followup→whenIdle 超时（分钟），超时 cancel + run 记 error('timeout')。 */
  runTimeoutMinutes: number
  /** 每任务环形保留的最近运行数。 */
  runHistoryLimit: number
}

export interface ScheduleDeps {
  registry: AgentRegistry
  /** 任务会话挂载的 preset id（agentTeamPreset 开启时下达；undefined = 直接 toolsScope）。 */
  botPresetId?: string
  /** 插件自有会话 id 集（与 bots 共享；cron_* 工具注册门控排除用）。 */
  ownedSessions: Set<string>
}

/** tick 间隔固定 30s（spec §8：不进 Config——YAGNI）。 */
const TICK_MS = 30_000

export function setupSchedule(ctx: Context, config: ScheduleModuleConfig, deps: ScheduleDeps): void {
  const warn = (m: string): void => ctx.logger.warn(m)
  // 与 setupBots 同款 joiner 栈：preset 优先（委派子会话 composeFrom 认父）+ toolsScope 回退。
  const toolsScope = createToolsScope(ctx)
  const joiner: ScopeJoiner = deps.botPresetId !== undefined
    ? createScopeJoiner(ctx, deps.botPresetId, toolsScope, warn)
    : toolsScope
  const agentsPort = createAgentsPort(ctx, joiner, deps.ownedSessions)

  // workspaceRegistry 可选服务，惰性解析（attachments 教训：apply 期一次性捕获会吃到未注册的 undefined）。
  interface WorkspaceRegistryLike {
    create(path: string): Promise<{ attachSession(sessionId: SessionId): Promise<void> }>
    list(): { path: string }[]
  }
  const workspaceRegistryOf = (): WorkspaceRegistryLike | undefined =>
    ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
  const workspacePort: WorkspacePort = {
    async attach(cwd, sessionId) {
      const registry = workspaceRegistryOf()
      if (registry === undefined) throw new Error('workspaceRegistry 服务不可用')
      const workspace = await registry.create(cwd)
      await workspace.attachSession(SessionId(sessionId))
    },
  }

  let scheduler: Scheduler | undefined
  const started = openDomainSafely(ctx, scheduleDomain, warn).then(async (domain) => {
    const tasks = domain.table('tasks') as KvTable<string, CronTask>
    const runs = domain.table('runs') as KvTable<string, CronRun>
    const executor = createExecutor({
      agents: agentsPort,
      registry: deps.registry,
      defaultModel: () => {
        const selection = ctx.agentDefaultModel.currentSelection()
        return { provider: selection.provider, model: selection.model }
      },
      workspace: workspacePort,
      runs,
      runHistoryLimit: config.runHistoryLimit,
      runTimeoutMs: config.runTimeoutMinutes * 60_000,
      warn,
      now: () => Date.now(),
      newSessionId: () => randomUUID(),
      newRunId: () => randomUUID(),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
    scheduler = createScheduler({
      tasks, runs,
      runHistoryLimit: config.runHistoryLimit,
      execute: (task) => executor.trigger(task),
      now: () => Date.now(),
      newRunId: () => randomUUID(),
      warn,
    })
    const service = createCronService({
      tasks, runs,
      scheduler,
      registry: deps.registry,
      validateProject: (path) => existsSync(path),
      now: () => Date.now(),
      newTaskId: () => randomUUID(),
    })
    setupCronTools(ctx, createCronTools(service), deps.ownedSessions)
    // webServer 可选（headless 惰性不抛错）；handler 请求时才构造（启动链落定前不捕获 service）。
    registerOptionalRoutes(ctx, (webCtx) => {
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-agent-toolkit/api/cron',
        handler: async (req, res) => {
          try {
            await started
            await createCronApiHandler({
              service,
              listProjects: () => workspaceRegistryOf()?.list().map((w) => w.path) ?? [],
              runHistoryLimit: config.runHistoryLimit,
            })(req, res)
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        },
      })
      return () => dispose()
    })
    await scheduler.rearmAll()
  })
  started.catch((error) => {
    warn(`[schedule] 启动失败：${error instanceof Error ? error.message : String(error)}`)
  })

  // 周期 tick：启动链落定后扫描到期任务。裸 setInterval 而非 ctx.interval——
  // timer mixin 受 cordis inject 门控，而本插件 inject 列表按约束不加新服务；
  // ctx.effect 卸载时自动 clearInterval，与 ctx.interval 清理语义等价。
  ctx.effect(() => {
    const timer = setInterval(() => { void started.then(() => scheduler?.tick()) }, TICK_MS)
    return () => clearInterval(timer)
  })

  ctx.effect(() => async () => { await toolsScope.dispose() })
}
