/** schedule 模块存储域声明：CronTask/CronRun 记录 schema + domain 布局的单一来源。*/
import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'

/** 调度规则三选一：cron（5 字段，可选 IANA 时区，省略 = 进程时区）/ at（RFC 3339 一次性）/ every（≥60s，创建时间为锚）。*/
export const CronScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), expr: z.string().min(1), timeZone: z.string().min(1).optional() }),
  z.object({ kind: z.literal('at'), at: z.string().min(1) }),
  z.object({ kind: z.literal('every'), seconds: z.number().int().min(60) }),
])
export type CronSchedule = z.infer<typeof CronScheduleSchema>

/** 执行目标：主 Agent（宿主默认模型，无 persona/restrict）或注册表角色（persona/model/工具白名单随角色）。*/
export const CronTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main') }),
  z.object({ kind: z.literal('role'), roleId: z.string().min(1) }),
])
export type CronTarget = z.infer<typeof CronTargetSchema>

export const CronTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  prompt: z.string().min(1).max(8000),
  cwd: z.string().min(1),
  schedule: CronScheduleSchema,
  target: CronTargetSchema,
  catchup: z.boolean(),
  enabled: z.boolean(),
  /** 调度器维护的持久缓存（重启 rearm 依据），UTC ISO 串。*/
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CronTask = z.infer<typeof CronTaskSchema>

export const CronRunSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  triggeredAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(['running', 'ok', 'error', 'skipped-overlap']),
  /** 本次执行新建的会话 id（skipped-overlap 无会话）。*/
  sessionId: z.string().optional(),
  /** 错误摘要（截断）。*/
  error: z.string().optional(),
})
export type CronRun = z.infer<typeof CronRunSchema>

/** domain 名/表名均受 UNIT_NAME_RE 约束（^[a-z][a-z0-9_]*$），不允许连字符。*/
export const scheduleDomain = defineDomain({
  name: 'dsh_agent_toolkit_schedule',
  version: 1,
  tables: {
    tasks: domainTable<string, CronTask>(CronTaskSchema),
    runs: domainTable<string, CronRun>(CronRunSchema),
    // 一次性标记位（沿用 agents store 的 meta 模式；当前无标记消费者，保留表位）。
    meta: domainTable<string, { value: string }>(z.object({ value: z.string() })),
  },
})

/** 某任务的 run 列表（新 → 旧；同刻按 id 倒序稳定化）。*/
export function listRuns(runs: KvTable<string, CronRun>, taskId: string): CronRun[] {
  return [...runs.entries()]
    .map(([, run]) => run)
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt) || b.id.localeCompare(a.id))
}

/** 环形保留某任务最近 limit 条 run，超出删最旧。*/
export async function trimRuns(runs: KvTable<string, CronRun>, taskId: string, limit: number): Promise<void> {
  const mine = listRuns(runs, taskId)
  for (const run of mine.slice(limit)) await runs.delete(run.id)
}

/** 删除任务连带清运行历史。*/
export async function deleteRunsOf(runs: KvTable<string, CronRun>, taskId: string): Promise<void> {
  for (const run of listRuns(runs, taskId)) await runs.delete(run.id)
}
