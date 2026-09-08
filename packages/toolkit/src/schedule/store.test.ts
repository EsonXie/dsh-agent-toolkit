import { describe, expect, test } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  CronRunSchema, CronScheduleSchema, CronTaskSchema, deleteRunsOf, listRuns, scheduleDomain, trimRuns,
  type CronRun,
} from './store.ts'

const VALID_TASK = {
  id: 't1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' },
  target: { kind: 'main' },
  catchup: true, enabled: true, nextRunAt: '2026-09-08T01:00:00.000Z',
  createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
}

/** Map 假表（bots/api.test.ts 已有套路）。*/
function fakeTable<V>(): KvTable<string, V> & { data: Map<string, V> } {
  const data = new Map<string, V>()
  return {
    data,
    get: (k: string) => data.get(k),
    put: async (k: string, v: V) => { data.set(k, v) },
    delete: async (k: string) => data.delete(k),
    entries: () => data.entries(),
  } as unknown as KvTable<string, V> & { data: Map<string, V> }
}

describe('scheduleDomain', () => {
  test('域名、版本与表布局', () => {
    expect(scheduleDomain.name).toBe('dsh_agent_toolkit_schedule')
    expect(scheduleDomain.version).toBe(1)
    expect(Object.keys(scheduleDomain.tables)).toEqual(['tasks', 'runs', 'meta'])
  })
})

describe('CronScheduleSchema', () => {
  test('三选一判别联合：cron/at/every', () => {
    expect(CronScheduleSchema.safeParse({ kind: 'cron', expr: '0 9 * * *' }).success).toBe(true)
    expect(CronScheduleSchema.safeParse({ kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' }).success).toBe(true)
    expect(CronScheduleSchema.safeParse({ kind: 'at', at: '2026-09-08T01:00:00Z' }).success).toBe(true)
    expect(CronScheduleSchema.safeParse({ kind: 'every', seconds: 3600 }).success).toBe(true)
  })
  test('拒绝：未知 kind / 空 expr / every < 60s / 非整数 seconds', () => {
    expect(CronScheduleSchema.safeParse({ kind: 'weekly' }).success).toBe(false)
    expect(CronScheduleSchema.safeParse({ kind: 'cron', expr: '' }).success).toBe(false)
    expect(CronScheduleSchema.safeParse({ kind: 'every', seconds: 59 }).success).toBe(false)
    expect(CronScheduleSchema.safeParse({ kind: 'every', seconds: 60 }).success).toBe(true)
    expect(CronScheduleSchema.safeParse({ kind: 'every', seconds: 90.5 }).success).toBe(false)
  })
})

describe('CronTaskSchema', () => {
  test('接受完整合法记录（三种 schedule × 两种 target）', () => {
    expect(CronTaskSchema.safeParse(VALID_TASK).success).toBe(true)
    expect(CronTaskSchema.safeParse({ ...VALID_TASK, schedule: { kind: 'at', at: '2026-09-08T01:00:00Z' } }).success).toBe(true)
    expect(CronTaskSchema.safeParse({ ...VALID_TASK, target: { kind: 'role', roleId: 'explorer' } }).success).toBe(true)
  })
  test('nextRunAt 可空；拒绝空 name/prompt/cwd', () => {
    expect(CronTaskSchema.safeParse({ ...VALID_TASK, nextRunAt: null }).success).toBe(true)
    expect(CronTaskSchema.safeParse({ ...VALID_TASK, name: '' }).success).toBe(false)
    expect(CronTaskSchema.safeParse({ ...VALID_TASK, prompt: '' }).success).toBe(false)
    expect(CronTaskSchema.safeParse({ ...VALID_TASK, cwd: '' }).success).toBe(false)
  })
})

describe('CronRunSchema', () => {
  test('status 四值枚举；finishedAt/sessionId/error 可选', () => {
    const base = { id: 'r1', taskId: 't1', triggeredAt: '2026-09-07T01:00:00.000Z' }
    for (const status of ['running', 'ok', 'error', 'skipped-overlap']) {
      expect(CronRunSchema.safeParse({ ...base, status }).success).toBe(true)
    }
    expect(CronRunSchema.safeParse({ ...base, status: 'cancelled' }).success).toBe(false)
  })
})

describe('runs 助手', () => {
  const run = (id: string, triggeredAt: string): CronRun => ({ id, taskId: 't1', triggeredAt, status: 'ok' })

  test('listRuns 新→旧排序且只含本任务', async () => {
    const runs = fakeTable<CronRun>()
    await runs.put('r1', run('r1', '2026-09-07T01:00:00.000Z'))
    await runs.put('r2', run('r2', '2026-09-07T02:00:00.000Z'))
    await runs.put('r3', { ...run('r3', '2026-09-07T03:00:00.000Z'), taskId: 'other' })
    expect(listRuns(runs, 't1').map((r) => r.id)).toEqual(['r2', 'r1'])
  })

  test('trimRuns 环形保留最近 N 条，删最旧', async () => {
    const runs = fakeTable<CronRun>()
    for (let i = 1; i <= 5; i++) await runs.put(`r${i}`, run(`r${i}`, `2026-09-07T0${i}:00:00.000Z`))
    await trimRuns(runs, 't1', 2)
    expect([...runs.data.keys()].sort()).toEqual(['r4', 'r5'])
  })

  test('deleteRunsOf 只清本任务历史', async () => {
    const runs = fakeTable<CronRun>()
    await runs.put('r1', run('r1', '2026-09-07T01:00:00.000Z'))
    await runs.put('r2', { ...run('r2', '2026-09-07T02:00:00.000Z'), taskId: 'other' })
    await deleteRunsOf(runs, 't1')
    expect([...runs.data.keys()]).toEqual(['r2'])
  })
})
