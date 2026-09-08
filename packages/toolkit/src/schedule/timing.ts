/** cron/at/every 纯时间运算：校验、下一触发点、预览、启动 rearm。全部注入 now，无隐藏时钟。*/
import { Cron } from 'croner'
import type { CronSchedule, CronTask } from './store.ts'

/** croner 选项：paused 仅做解析与预测，不注册真实定时器（计时由调度器 tick 驱动）。*/
function cronerOptions(schedule: Extract<CronSchedule, { kind: 'cron' }>): { paused: true; timezone?: string } {
  return { paused: true, ...(schedule.timeZone !== undefined ? { timezone: schedule.timeZone } : {}) }
}

/** 创建/更新即校验；合法返回 undefined，非法返回错误消息（不入库由调用方保证）。*/
export function validateSchedule(schedule: CronSchedule, nowMs: number): string | undefined {
  switch (schedule.kind) {
    case 'cron': {
      const fields = schedule.expr.trim().split(/\s+/)
      if (fields.length !== 5) return `cron 表达式须为 5 字段（分 时 日 月 周），收到 ${fields.length} 字段；秒级/年字段暂不开放`
      if (schedule.timeZone !== undefined) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone })
        } catch {
          return `未知时区：${schedule.timeZone}`
        }
      }
      try {
        new Cron(schedule.expr, cronerOptions(schedule))
      } catch (error) {
        return `非法 cron 表达式"${schedule.expr}"：${error instanceof Error ? error.message : String(error)}`
      }
      return undefined
    }
    case 'at': {
      const t = Date.parse(schedule.at)
      if (Number.isNaN(t)) return `非法 at 时间（须 RFC 3339）：${schedule.at}`
      if (t <= nowMs) return `at 时间须在未来：${schedule.at}`
      return undefined
    }
    case 'every':
      return undefined // seconds ≥ 60 整数由 schema 保证
  }
}

/** 下一触发点（epoch ms）；无未来触发点（at 过期等）返回 null。*/
export function nextOccurrence(schedule: CronSchedule, createdAtMs: number, nowMs: number): number | null {
  switch (schedule.kind) {
    case 'cron': {
      const next = new Cron(schedule.expr, cronerOptions(schedule)).nextRun(new Date(nowMs))
      return next === null ? null : next.getTime()
    }
    case 'at': {
      const t = Date.parse(schedule.at)
      return t > nowMs ? t : null
    }
    case 'every': {
      const intervalMs = schedule.seconds * 1000
      if (nowMs < createdAtMs) return createdAtMs
      // 创建锚点对齐的下一间隔：跳过中间错过的，不枚举积压。
      const k = Math.floor((nowMs - createdAtMs) / intervalMs) + 1
      return createdAtMs + k * intervalMs
    }
  }
}

/** 「未来 count 次触发」预览（epoch ms 数组，长度 ≤ count；供 UI 表单与调试）。*/
export function previewOccurrences(schedule: CronSchedule, count: number, createdAtMs: number, nowMs: number): number[] {
  const out: number[] = []
  let cursor = nowMs
  for (let i = 0; i < count; i++) {
    const next = nextOccurrence(schedule, createdAtMs, cursor)
    if (next === null) break
    out.push(next)
    cursor = next + 1
  }
  return out
}

/**
 * 启动 rearm：对一条持久化任务重算 enabled/nextRunAt（无变化返回原引用，调用方按引用决定是否写回）。
 * - nextRunAt 仍在未来 → 保持；
 * - 已过期且 catchup → 设为「立即」（首个 tick 补跑一次）；
 * - 已过期且非 catchup → 下一未来触发点；没有（at 一次性）→ enabled=false、nextRunAt=null（过期即作废）。
 */
export function rearmTask(task: CronTask, nowMs: number): CronTask {
  if (!task.enabled) return task.nextRunAt === null ? task : { ...task, nextRunAt: null }
  const persisted = task.nextRunAt === null ? null : Date.parse(task.nextRunAt)
  if (persisted !== null && persisted > nowMs) return task
  if (persisted !== null && task.catchup) return { ...task, nextRunAt: new Date(nowMs).toISOString() }
  const next = nextOccurrence(task.schedule, Date.parse(task.createdAt), nowMs)
  return next === null
    ? { ...task, enabled: false, nextRunAt: null }
    : { ...task, nextRunAt: new Date(next).toISOString() }
}

/** 创建/更新后的 fresh 重算（catchup 是停机补跑语义，不适用于编辑路径）。*/
export function recomputeTask(task: CronTask, nowMs: number): CronTask {
  if (!task.enabled) return { ...task, nextRunAt: null }
  const next = nextOccurrence(task.schedule, Date.parse(task.createdAt), nowMs)
  return next === null
    ? { ...task, enabled: false, nextRunAt: null }
    : { ...task, nextRunAt: new Date(next).toISOString() }
}

/** 触发/跳过后推进：cron/every 取 now 之后下一触发点；at 一次性作废。*/
export function advanceAfterTrigger(task: CronTask, nowMs: number): CronTask {
  if (task.schedule.kind === 'at') return { ...task, enabled: false, nextRunAt: null }
  const next = nextOccurrence(task.schedule, Date.parse(task.createdAt), nowMs)
  return next === null
    ? { ...task, enabled: false, nextRunAt: null }
    : { ...task, nextRunAt: new Date(next).toISOString() }
}
