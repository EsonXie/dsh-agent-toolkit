import { describe, expect, test, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { createCronService, type CronServiceDeps, type CronTaskInput } from './service.ts'
import { createScheduler } from './scheduler.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import type { CronRun, CronTask } from './store.ts'

const T0 = Date.parse('2026-09-07T00:00:00.000Z')

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

const EMPTY_REGISTRY: AgentRegistry = {
  list: () => [], get: () => undefined,
  upsert: async () => undefined, remove: async () => undefined, subscribe: () => () => undefined,
}

const INPUT: CronTaskInput = {
  name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' },
  target: { kind: 'main' }, catchup: true, enabled: true,
}

function makeDeps(over: Partial<{
  registry: AgentRegistry
  validateProject: (path: string) => boolean
}> = {}) {
  const tasks = fakeTable<CronTask>()
  const runs = fakeTable<CronRun>()
  const execute = vi.fn(async () => undefined)
  const scheduler = createScheduler({
    tasks, runs, runHistoryLimit: 20, execute, now: () => T0, newRunId: () => 'run-1', warn: vi.fn(),
  })
  let idN = 0
  const deps: CronServiceDeps = {
    tasks, runs, scheduler,
    registry: over.registry ?? EMPTY_REGISTRY,
    validateProject: over.validateProject ?? (() => true),
    now: () => T0,
    newTaskId: () => `task-${++idN}`,
  }
  return { deps, tasks, runs, execute }
}

describe('create', () => {
  test('合法输入：落库并算好 nextRunAt', async () => {
    const { deps, tasks } = makeDeps()
    const result = await createCronService(deps).create(INPUT)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.id).toBe('task-1')
      expect(result.value.nextRunAt).toBe('2026-09-07T09:00:00.000Z')
      expect(result.value.createdAt).toBe(new Date(T0).toISOString())
    }
    expect(tasks.data.size).toBe(1)
  })

  test('校验失败拒绝入库：非法 cron / 未知时区 / cwd 不可用 / roleId 不存在 / at 过去', async () => {
    const { deps, tasks } = makeDeps({ validateProject: (p) => p === 'D:\\work' })
    const service = createCronService(deps)
    const cases: CronTaskInput[] = [
      { ...INPUT, schedule: { kind: 'cron', expr: '99 9 * * *' } },
      { ...INPUT, schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'Mars/Olympus' } },
      { ...INPUT, cwd: 'D:\\nope' },
      { ...INPUT, target: { kind: 'role', roleId: 'ghost' } },
      { ...INPUT, schedule: { kind: 'at', at: '2026-09-06T00:00:00Z' } },
    ]
    for (const input of cases) {
      const result = await service.create(input)
      expect(result.ok).toBe(false)
    }
    expect(tasks.data.size).toBe(0)
  })

  test('disabled 创建：nextRunAt=null', async () => {
    const { deps } = makeDeps()
    const result = await createCronService(deps).create({ ...INPUT, enabled: false })
    expect(result.ok && result.value.nextRunAt).toBeNull()
  })
})

describe('update', () => {
  test('改任意字段并重算 nextRunAt；不存在 → ok:false', async () => {
    const { deps, tasks } = makeDeps()
    const service = createCronService(deps)
    await service.create(INPUT)
    const result = await service.update('task-1', { name: '晚报', schedule: { kind: 'every', seconds: 3600 } })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.name).toBe('晚报')
      expect(result.value.prompt).toBe('写日报') // 未改字段保留
      expect(result.value.nextRunAt).toBe('2026-09-07T01:00:00.000Z') // every 锚 = createdAt
    }
    expect((await service.update('ghost', { name: 'x' })).ok).toBe(false)
    expect(tasks.data.get('task-1')?.updatedAt).toBe(new Date(T0).toISOString())
  })

  test('更新携带非法字段 → ok:false 且不改库', async () => {
    const { deps, tasks } = makeDeps()
    const service = createCronService(deps)
    await service.create(INPUT)
    const before = tasks.data.get('task-1')
    const result = await service.update('task-1', { schedule: { kind: 'cron', expr: 'bad expr here now' } })
    expect(result.ok).toBe(false)
    expect(tasks.data.get('task-1')).toBe(before)
  })
})

describe('remove / list / runsOf / trigger', () => {
  test('remove 连带清运行历史；不存在 → ok:false', async () => {
    const { deps, tasks, runs } = makeDeps()
    const service = createCronService(deps)
    await service.create(INPUT)
    await runs.put('r1', { id: 'r1', taskId: 'task-1', triggeredAt: new Date(T0).toISOString(), status: 'ok' })
    const result = await service.remove('task-1')
    expect(result.ok).toBe(true)
    expect(tasks.data.size).toBe(0)
    expect(runs.data.size).toBe(0)
    expect((await service.remove('task-1')).ok).toBe(false)
  })

  test('list 携带 lastRun 摘要（最近一次运行状态）', async () => {
    const { deps, runs } = makeDeps()
    const service = createCronService(deps)
    await service.create(INPUT)
    expect(service.list()[0].lastRun).toBeUndefined()
    await runs.put('r1', { id: 'r1', taskId: 'task-1', triggeredAt: '2026-09-07T01:00:00.000Z', status: 'ok' })
    await runs.put('r2', { id: 'r2', taskId: 'task-1', triggeredAt: '2026-09-07T02:00:00.000Z', status: 'error' })
    expect(service.list()[0].lastRun).toEqual({ status: 'error', triggeredAt: '2026-09-07T02:00:00.000Z' })
    expect(service.runsOf('task-1', 20)).toHaveLength(2)
  })

  test('trigger 手动触发：经 scheduler（不存在/运行中错误透传为 ok:false）', async () => {
    const { deps, execute } = makeDeps()
    const service = createCronService(deps)
    await service.create(INPUT)
    const result = await service.trigger('task-1')
    expect(result.ok).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await service.trigger('ghost')).ok).toBe(false)
  })
})
