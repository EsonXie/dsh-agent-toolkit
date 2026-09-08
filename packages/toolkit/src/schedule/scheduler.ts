/** 调度引擎：启动 rearm + 周期 tick + 重叠保护 + 触发后推进。计时由接线层（ctx.interval 30s）驱动。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { advanceAfterTrigger, rearmTask, recomputeTask } from './timing.ts'
import { trimRuns, type CronRun, type CronTask } from './store.ts'

export interface SchedulerDeps {
  tasks: KvTable<string, CronTask>
  runs: KvTable<string, CronRun>
  runHistoryLimit: number
  /** executor.trigger：契约上永不抛错（异常已落 run 记录）；仍 catch 兜底。 */
  execute(task: CronTask): Promise<unknown>
  now(): number
  newRunId(): string
  warn(msg: string): void
}

export interface Scheduler {
  /** 启动 rearm：全部任务按 catchup 语义重算（写回有变化的行）。 */
  rearmAll(): Promise<void>
  /** 一次 tick：触发全部到期任务（执行异步进行，不阻塞 tick 返回）。 */
  tick(): Promise<void>
  /** 创建/更新后 fresh 重算 nextRunAt（不执行、不落库——调用方负责 put）。 */
  recompute(task: CronTask): CronTask
  /** 手动触发一次（不受 enabled 影响；不存在/运行中抛错）。不改变 nextRunAt。 */
  triggerManual(taskId: string): Promise<CronRun>
  isRunning(taskId: string): boolean
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  /** 内存重叠锁：同任务上次未结束则本次记 skipped-overlap，不并发执行。 */
  const running = new Set<string>()

  async function recordSkipped(task: CronTask): Promise<void> {
    const nowIso = new Date(deps.now()).toISOString()
    const run: CronRun = {
      id: deps.newRunId(), taskId: task.id,
      triggeredAt: nowIso, finishedAt: nowIso,
      status: 'skipped-overlap',
    }
    await deps.runs.put(run.id, run)
    await trimRuns(deps.runs, task.id, deps.runHistoryLimit)
  }

  function launch(task: CronTask): void {
    running.add(task.id)
    void deps.execute(task)
      .catch((error) => deps.warn(`[schedule] 任务 "${task.id}" 执行器异常：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        running.delete(task.id)
        // 触发后推进：任务可能已被删除/停用 → 只在仍存在且启用时写回。
        const current = deps.tasks.get(task.id)
        if (current === undefined || !current.enabled) return
        void deps.tasks.put(task.id, advanceAfterTrigger(current, deps.now()))
      })
  }

  return {
    async rearmAll() {
      for (const [id, task] of deps.tasks.entries()) {
        const rearmed = rearmTask(task, deps.now())
        if (rearmed !== task) await deps.tasks.put(id, rearmed)
      }
    },
    async tick() {
      for (const [, task] of deps.tasks.entries()) {
        if (!task.enabled || task.nextRunAt === null) continue
        if (Date.parse(task.nextRunAt) > deps.now()) continue
        if (running.has(task.id)) {
          // 重叠保护：记 skipped-overlap 并把 nextRunAt 推到未来（避免每个 tick 重复记跳过）。
          await recordSkipped(task)
          await deps.tasks.put(task.id, advanceAfterTrigger(task, deps.now()))
          continue
        }
        launch(task)
      }
    },
    recompute: (task) => recomputeTask(task, deps.now()),
    async triggerManual(taskId) {
      const task = deps.tasks.get(taskId)
      if (task === undefined) throw new Error(`定时任务 "${taskId}" 不存在`)
      if (running.has(taskId)) throw new Error(`定时任务 "${task.name}" 正在运行中，本次手动触发已跳过`)
      running.add(taskId)
      try {
        return await deps.execute(task) as CronRun
      } finally {
        running.delete(taskId)
      }
    },
    isRunning: (taskId) => running.has(taskId),
  }
}
