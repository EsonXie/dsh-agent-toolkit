/** cron 任务 CRUD 服务：模型工具与 HTTP API 双入口共用（校验、落库、重算、连带清理）。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentRegistry } from '../agents/registry.ts'
import type { Scheduler } from './scheduler.ts'
import { CronTaskSchema, deleteRunsOf, listRuns, type CronRun, type CronSchedule, type CronTarget, type CronTask } from './store.ts'
import { validateSchedule } from './timing.ts'

/** 创建输入（全字段必填；更新用 Partial）。 */
export interface CronTaskInput {
  name: string
  prompt: string
  cwd: string
  schedule: CronSchedule
  target: CronTarget
  catchup: boolean
  enabled: boolean
}
export type CronTaskPatch = Partial<CronTaskInput>

/** 列表视图：任务 + 最近一次运行摘要。 */
export type CronTaskView = CronTask & { lastRun?: Pick<CronRun, 'status' | 'triggeredAt'> }

export type CronResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface CronServiceDeps {
  tasks: KvTable<string, CronTask>
  runs: KvTable<string, CronRun>
  scheduler: Scheduler
  registry: AgentRegistry
  validateProject(path: string): boolean
  now(): number
  newTaskId(): string
}

export interface CronService {
  list(): CronTaskView[]
  get(id: string): CronTask | undefined
  create(input: CronTaskInput): Promise<CronResult<CronTask>>
  update(id: string, patch: CronTaskPatch): Promise<CronResult<CronTask>>
  /** 删除任务并连带清运行历史。 */
  remove(id: string): Promise<CronResult<null>>
  /** 立即手动触发一次（不受 enabled 影响；不存在/运行中 ok:false）。 */
  trigger(id: string): Promise<CronResult<CronRun>>
  /** 运行历史（新 → 旧，最多 limit 条）。 */
  runsOf(id: string, limit: number): CronRun[]
}

export function createCronService(deps: CronServiceDeps): CronService {
  /** 创建/更新共用校验：schedule 语法与时值 → cwd → roleId 存在性。 */
  const validateIO = (input: Pick<CronTaskInput, 'cwd' | 'schedule' | 'target'>): string | undefined => {
    const scheduleError = validateSchedule(input.schedule, deps.now())
    if (scheduleError !== undefined) return scheduleError
    if (!deps.validateProject(input.cwd)) return `项目路径不可用：${input.cwd}`
    if (input.target.kind === 'role' && deps.registry.get(input.target.roleId) === undefined) {
      return `角色 "${input.target.roleId}" 不存在`
    }
    return undefined
  }

  return {
    list() {
      return [...deps.tasks.entries()].map(([, task]) => {
        const last = listRuns(deps.runs, task.id)[0]
        const view: CronTaskView = last === undefined
          ? task
          : { ...task, lastRun: { status: last.status, triggeredAt: last.triggeredAt } }
        return view
      })
    },
    get: (id) => deps.tasks.get(id),
    async create(input) {
      const invalid = validateIO(input)
      if (invalid !== undefined) return { ok: false, error: invalid }
      const nowIso = new Date(deps.now()).toISOString()
      const parsed = CronTaskSchema.safeParse({
        id: deps.newTaskId(), ...input,
        nextRunAt: null, createdAt: nowIso, updatedAt: nowIso,
      })
      if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid task' }
      const task = deps.scheduler.recompute(parsed.data)
      await deps.tasks.put(task.id, task)
      return { ok: true, value: task }
    },
    async update(id, patch) {
      const existing = deps.tasks.get(id)
      if (existing === undefined) return { ok: false, error: `定时任务 "${id}" 不存在` }
      const merged = {
        ...existing,
        ...(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))),
        id: existing.id,
        updatedAt: new Date(deps.now()).toISOString(),
      }
      const invalid = validateIO(merged)
      if (invalid !== undefined) return { ok: false, error: invalid }
      const parsed = CronTaskSchema.safeParse(merged)
      if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid task' }
      const task = deps.scheduler.recompute(parsed.data)
      await deps.tasks.put(id, task)
      return { ok: true, value: task }
    },
    async remove(id) {
      if (deps.tasks.get(id) === undefined) return { ok: false, error: `定时任务 "${id}" 不存在` }
      await deps.tasks.delete(id)
      await deleteRunsOf(deps.runs, id)
      return { ok: true, value: null }
    },
    async trigger(id) {
      try {
        return { ok: true, value: await deps.scheduler.triggerManual(id) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    runsOf: (id, limit) => listRuns(deps.runs, id).slice(0, limit),
  }
}
