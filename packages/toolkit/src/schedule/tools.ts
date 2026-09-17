/** cron_* 模型工具：注册在主 Agent scope（不进 subagent/cron 执行会话）+ 宿主 schedule 互斥探测。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { CronService, CronTaskInput, CronTaskPatch } from './service.ts'
import type { CronSchedule, CronTarget } from './store.ts'

/** 互斥探测目标：宿主 @deepseek-ai/dsh-schedule 的会话内提醒工具。 */
const HOST_SCHEDULE_TOOL = 'schedule_create'

/** 扁平参数 → CronSchedule（缺 kind 对应字段抛错——模型可读的自描述消息）。 */
function scheduleOf(args: Record<string, unknown>): CronSchedule {
  const kind = args.scheduleKind
  if (kind === 'cron') {
    if (typeof args.cronExpr !== 'string' || args.cronExpr.trim() === '') throw new Error('scheduleKind=cron 需要 cronExpr（5 字段 cron 表达式）')
    return {
      kind: 'cron', expr: args.cronExpr,
      ...(typeof args.timeZone === 'string' && args.timeZone !== '' ? { timeZone: args.timeZone } : {}),
    }
  }
  if (kind === 'at') {
    if (typeof args.atTime !== 'string' || args.atTime === '') throw new Error('scheduleKind=at 需要 atTime（RFC 3339 时间）')
    return { kind: 'at', at: args.atTime }
  }
  if (kind === 'every') {
    if (typeof args.everySeconds !== 'number') throw new Error('scheduleKind=every 需要 everySeconds（≥60 的秒数）')
    return { kind: 'every', seconds: args.everySeconds }
  }
  throw new Error(`未知 scheduleKind：${String(kind)}（可选 cron / at / every）`)
}

function targetOf(args: Record<string, unknown>): CronTarget {
  if (args.targetKind === 'role') {
    if (typeof args.roleId !== 'string' || args.roleId === '') throw new Error('targetKind=role 需要 roleId')
    return { kind: 'role', roleId: args.roleId }
  }
  return { kind: 'main' }
}

/** 服务结果展开：ok:false → 抛错（defineTool 约定：抛错即工具错误结果）。 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
} as const

const SCHEDULE_PARAMS_REQUIRED = {
  scheduleKind: { type: 'string', required: true, description: 'One of: cron / at / every' },
} as const

const SCHEDULE_PARAMS_OPTIONAL = {
  scheduleKind: { type: 'string', description: 'Replace schedule kind: cron / at / every (provide the matching fields too)' },
} as const

const SCHEDULE_FIELD_PARAMS = {
  cronExpr: { type: 'string', description: 'Required when scheduleKind=cron: 5-field cron expression "minute hour day-of-month month day-of-week" (seconds/years not supported)' },
  timeZone: { type: 'string', description: 'Optional IANA time zone for cron (e.g. "Asia/Shanghai"); default: server process time zone' },
  atTime: { type: 'string', description: 'Required when scheduleKind=at: one-shot RFC 3339 time (e.g. "2026-09-08T09:00:00+08:00")' },
  everySeconds: { type: 'number', description: 'Required when scheduleKind=every: interval seconds (>= 60), anchored at creation time' },
} as const

const TARGET_PARAMS_REQUIRED = {
  targetKind: { type: 'string', required: true, description: 'One of: main (main agent, default model) / role (registry role with its persona/model/tool allowlist)' },
} as const

const TARGET_PARAMS_OPTIONAL = {
  targetKind: { type: 'string', description: 'Replace target: main / role' },
} as const

const ROLE_ID_PARAM = { roleId: { type: 'string', description: 'Required when targetKind=role: registry role id' } } as const

export function createCronTools(service: CronService): ToolDefinition[] {
  return [
    defineTool({
      name: 'cron_task_create',
      description:
        'Create a scheduled task that runs a prompt in a NEW standalone session (main agent or a registry role) '
        + 'on a cron/at/every schedule. The task survives restarts; a run missed while stopped is caught up once '
        + 'when catchup=true. Use cron_task_list to see existing tasks.',
      parameters: {
        name: { type: 'string', required: true, description: 'Task name (display)' },
        prompt: { type: 'string', required: true, description: 'The prompt sent as the user message when the task fires. Self-contained: the session has no other context.' },
        cwd: { type: 'string', required: true, description: 'Working directory of the new session (must be a valid project path)' },
        ...SCHEDULE_PARAMS_REQUIRED,
        ...SCHEDULE_FIELD_PARAMS,
        ...TARGET_PARAMS_REQUIRED,
        ...ROLE_ID_PARAM,
        catchup: { type: 'boolean', required: true, description: 'true: run once immediately after restart if a run was missed while stopped; false: skip to the next future occurrence' },
        enabled: { type: 'boolean', required: true, description: 'false: create paused (nextRunAt stays null until enabled via cron_task_update)' },
      },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(rawArgs) {
        const args = rawArgs as Record<string, unknown>
        const input: CronTaskInput = {
          name: args.name as string,
          prompt: args.prompt as string,
          cwd: args.cwd as string,
          schedule: scheduleOf(args),
          target: targetOf(args),
          catchup: args.catchup as boolean,
          enabled: args.enabled as boolean,
        }
        return unwrap(await service.create(input))
      },
    }),
    defineTool({
      name: 'cron_task_list',
      description: 'List all scheduled tasks with enabled flag, next run time and last run status.',
      parameters: {},
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      async execute() {
        return service.list()
      },
    }),
    defineTool({
      name: 'cron_task_update',
      description: 'Update any fields of a scheduled task by id. nextRunAt is recomputed.',
      parameters: {
        id: { type: 'string', required: true, description: 'Task id' },
        name: { type: 'string', description: 'New name' },
        prompt: { type: 'string', description: 'New prompt' },
        cwd: { type: 'string', description: 'New working directory' },
        ...SCHEDULE_PARAMS_OPTIONAL,
        ...SCHEDULE_FIELD_PARAMS,
        ...TARGET_PARAMS_OPTIONAL,
        ...ROLE_ID_PARAM,
        catchup: { type: 'boolean', description: 'New catchup flag' },
        enabled: { type: 'boolean', description: 'Enable/disable the task' },
      },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(rawArgs) {
        const args = rawArgs as Record<string, unknown>
        const patch: CronTaskPatch = {}
        if (args.name !== undefined) patch.name = args.name as string
        if (args.prompt !== undefined) patch.prompt = args.prompt as string
        if (args.cwd !== undefined) patch.cwd = args.cwd as string
        if (args.scheduleKind !== undefined) patch.schedule = scheduleOf(args)
        if (args.targetKind !== undefined) patch.target = targetOf(args)
        if (args.catchup !== undefined) patch.catchup = args.catchup as boolean
        if (args.enabled !== undefined) patch.enabled = args.enabled as boolean
        return unwrap(await service.update(args.id as string, patch))
      },
    }),
    defineTool({
      name: 'cron_task_delete',
      description: 'Delete a scheduled task by id, including its run history.',
      parameters: { id: { type: 'string', required: true, description: 'Task id' } },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(rawArgs) {
        return unwrap(await service.remove((rawArgs as Record<string, unknown>).id as string))
      },
    }),
    defineTool({
      name: 'cron_task_trigger',
      description: 'Trigger a scheduled task once right now (works even when disabled; fails with an error if the task is already running).',
      parameters: { id: { type: 'string', required: true, description: 'Task id' } },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(rawArgs) {
        return unwrap(await service.trigger((rawArgs as Record<string, unknown>).id as string))
      },
    }),
  ]
}

/**
 * 注册 cron_* 工具到主 Agent scope 并探测宿主 schedule 互斥（spec §1/§5）。
 * 门控：跳过 subagent（session.header.origin === 'subagent'）与 cron 执行会话（cronExcludedSessions）——
 * dsh-schedule src/index.ts:45-49 同款 agent/created 模式，
 * 外加存量 roots 立即注册（HMR 重挂后当前主会话不丢工具）。
 * HMR 安全：镜像 dsh-schedule src/index.ts:44-76——attached 身份表防同一 agent 二次挂载，
 * toolkit 级 ctx.effect 卸载时 Promise.allSettled 摘下所有 agent 上挂的工具
 * （agent.ctx 属宿主、长于 toolkit fiber，仅靠 agent.ctx.effect 会在重挂时残留）。
 */
export function setupCronTools(ctx: Context, tools: ToolDefinition[], cronExcludedSessions: ReadonlySet<string>): void {
  const attached = new Map<Agent, () => void>()
  let stopping = false

  ctx.effect(() => {
    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (stopping || attached.has(agent)) return
      attach(agent)
    })
    for (const agent of ctx.agents.roots()) attach(agent)

    return async () => {
      stopping = true
      stopCreated()
      const cleanups = [...attached.values()]
      attached.clear()
      await Promise.allSettled(cleanups.map((cleanup) => Promise.resolve(cleanup())))
    }
  }, 'dsh-agent-toolkit.cron-tools()')

  function attach(agent: Agent): void {
    if (attached.has(agent)) return
    if (agent.session.header.origin === 'subagent') return
    if (cronExcludedSessions.has(String(agent.session.id))) return
    const cleanup = agent.ctx.effect(() => {
      const scope = scopeOf(agent.ctx)
      const hostPresent = scope !== undefined
        ? ctx.tools.get(HOST_SCHEDULE_TOOL, scope) !== undefined
        : ctx.tools.get(HOST_SCHEDULE_TOOL) !== undefined
      if (hostPresent) {
        ctx.logger.warn(
          'dsh-agent-toolkit: 检测到宿主 @deepseek-ai/dsh-schedule 的 schedule_create 与 cron_* 并存——'
          + '两套调度工具并存会显著提高模型误选率，且会话内提醒在会话冷时静默失败；'
          + '请从组合中移除 @deepseek-ai/dsh-schedule（二选一）',
        )
      }
      const disposers = tools.map((tool) => agent.ctx.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose()
        if (attached.get(agent) === cleanup) attached.delete(agent)
      }
    }, 'dsh-agent-toolkit.cron-tools.attach()')
    attached.set(agent, cleanup)
  }
}
