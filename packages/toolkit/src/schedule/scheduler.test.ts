import { describe, expect, test, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { createScheduler, type SchedulerDeps } from './scheduler.ts'
import type { CronRun, CronTask } from './store.ts'

const T0 = Date.parse('2026-09-07T00:00:00.000Z')

const task = (over: Partial<CronTask>): CronTask => ({
  id: 't1', name: 'n', prompt: 'p', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' },
  target: { kind: 'main' }, catchup: false, enabled: true,
  nextRunAt: null, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
  ...over,
})

function fakeTable<V>(init: [string, V][] = []): KvTable<string, V> & { data: Map<string, V> } {
  const data = new Map<string, V>(init)
  return {
    data,
    get: (k: string) => data.get(k),
    put: async (k: string, v: V) => { data.set(k, v) },
    delete: async (k: string) => data.delete(k),
    entries: () => data.entries(),
  } as unknown as KvTable<string, V> & { data: Map<string, V> }
}

function makeDeps(over: {
  tasks?: KvTable<string, CronTask> & { data: Map<string, CronTask> }
  execute?: (task: CronTask) => Promise<unknown>
  now?: () => number
} = {}) {
  const tasks = over.tasks ?? fakeTable<CronTask>()
  const runs = fakeTable<CronRun>()
  let runN = 0
  const deps: SchedulerDeps = {
    tasks, runs,
    runHistoryLimit: 20,
    execute: over.execute ?? (async () => undefined),
    now: over.now ?? (() => T0),
    newRunId: () => `run-${++runN}`,
    warn: vi.fn(),
  }
  return { deps, tasks, runs }
}

describe('rearmAll', () => {
  test('未来保持 / 过期 catchup 立即 / 过期不 catchup 重算 / 过期 at 作废 / disabled 归 null', async () => {
    const tasks = fakeTable<CronTask>([
      ['future', task({ id: 'future', nextRunAt: '2026-09-08T00:00:00.000Z' })],
      ['catchup', task({ id: 'catchup', catchup: true, nextRunAt: '2026-09-06T09:00:00.000Z' })],
      ['skip', task({ id: 'skip', nextRunAt: '2026-09-06T09:00:00.000Z' })],
      ['at', task({ id: 'at', schedule: { kind: 'at', at: '2026-09-06T00:00:00Z' }, nextRunAt: '2026-09-06T00:00:00.000Z' })],
      ['off', task({ id: 'off', enabled: false, nextRunAt: '2026-09-06T09:00:00.000Z' })],
    ])
    const { deps } = makeDeps({ tasks })
    await createScheduler(deps).rearmAll()
    expect(tasks.data.get('future')?.nextRunAt).toBe('2026-09-08T00:00:00.000Z')
    expect(tasks.data.get('catchup')?.nextRunAt).toBe(new Date(T0).toISOString())
    expect(tasks.data.get('skip')?.nextRunAt).toBe('2026-09-07T09:00:00.000Z')
    expect(tasks.data.get('at')).toMatchObject({ enabled: false, nextRunAt: null })
    expect(tasks.data.get('off')).toMatchObject({ enabled: false, nextRunAt: null })
  })
})

describe('tick', () => {
  test('到期任务触发执行；settle 后推进 nextRunAt 到下一 occurrence', async () => {
    const fired: string[] = []
    const tasks = fakeTable<CronTask>([['t1', task({ nextRunAt: new Date(T0).toISOString() })]])
    const { deps } = makeDeps({ tasks, execute: async (t) => { fired.push(t.id) } })
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    expect(fired).toEqual(['t1'])
    await vi.waitFor(() => {
      expect(tasks.data.get('t1')?.nextRunAt).toBe('2026-09-07T09:00:00.000Z')
    })
  })

  test('未到期 / disabled / nextRunAt=null 不触发', async () => {
    const execute = vi.fn(async () => undefined)
    const tasks = fakeTable<CronTask>([
      ['future', task({ id: 'future', nextRunAt: '2026-09-08T00:00:00.000Z' })],
      ['off', task({ id: 'off', enabled: false, nextRunAt: new Date(T0).toISOString() })],
      ['null', task({ id: 'null', nextRunAt: null })],
    ])
    const { deps } = makeDeps({ tasks, execute })
    await createScheduler(deps).tick()
    expect(execute).not.toHaveBeenCalled()
  })

  test('重叠保护：上次未结束 → 记 skipped-overlap 并推进 nextRunAt，不并发执行', async () => {
    let resolveRun: (() => void) | undefined
    const execute = vi.fn(() => new Promise<void>((resolve) => { resolveRun = () => resolve() }))
    const tasks = fakeTable<CronTask>([['t1', task({ nextRunAt: new Date(T0).toISOString() })]])
    const { deps, runs } = makeDeps({ tasks, execute })
    const scheduler = createScheduler(deps)
    await scheduler.tick()               // 启动首次执行（不结束）
    expect(execute).toHaveBeenCalledTimes(1)
    await scheduler.tick()               // 仍在跑 → 跳过
    expect(execute).toHaveBeenCalledTimes(1)
    const skipped = [...runs.data.values()].filter((r) => r.status === 'skipped-overlap')
    expect(skipped).toHaveLength(1)
    expect(tasks.data.get('t1')?.nextRunAt).toBe('2026-09-07T09:00:00.000Z')
    resolveRun!()
  })

  test('at 一次性：触发 settle 后作废（enabled=false, nextRunAt=null）', async () => {
    const at = '2026-09-07T00:00:00.000Z'
    const tasks = fakeTable<CronTask>([['t1', task({ schedule: { kind: 'at', at }, nextRunAt: at })]])
    const { deps } = makeDeps({ tasks })
    await createScheduler(deps).tick()
    await vi.waitFor(() => {
      expect(tasks.data.get('t1')).toMatchObject({ enabled: false, nextRunAt: null })
    })
  })

  test('执行中被删除：settle 后不回写（不复活）', async () => {
    let resolveRun: (() => void) | undefined
    const execute = vi.fn(() => new Promise<void>((resolve) => { resolveRun = () => resolve() }))
    const tasks = fakeTable<CronTask>([['t1', task({ nextRunAt: new Date(T0).toISOString() })]])
    const { deps } = makeDeps({ tasks, execute })
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    await tasks.delete('t1')
    resolveRun!()
    await vi.waitFor(() => { expect(scheduler.isRunning('t1')).toBe(false) })
    expect(tasks.data.has('t1')).toBe(false)
  })
})

describe('triggerManual', () => {
  test('立即执行（disabled 也可），不推进 nextRunAt', async () => {
    const run: CronRun = { id: 'run-x', taskId: 't1', triggeredAt: new Date(T0).toISOString(), status: 'ok' }
    const tasks = fakeTable<CronTask>([['t1', task({ enabled: false, nextRunAt: '2026-09-08T00:00:00.000Z' })]])
    const { deps } = makeDeps({ tasks, execute: async () => run })
    const result = await createScheduler(deps).triggerManual('t1')
    expect(result).toBe(run)
    expect(tasks.data.get('t1')?.nextRunAt).toBe('2026-09-08T00:00:00.000Z')
  })

  test('不存在 / 运行中 → 抛错', async () => {
    let resolveRun: (() => void) | undefined
    const execute = vi.fn(() => new Promise<void>((resolve) => { resolveRun = () => resolve() }))
    const tasks = fakeTable<CronTask>([['t1', task({ nextRunAt: new Date(T0).toISOString() })]])
    const { deps } = makeDeps({ tasks, execute })
    const scheduler = createScheduler(deps)
    await expect(scheduler.triggerManual('ghost')).rejects.toThrow(/不存在/)
    const p = scheduler.triggerManual('t1')
    await expect(scheduler.triggerManual('t1')).rejects.toThrow(/正在运行/)
    expect(scheduler.isRunning('t1')).toBe(true)
    resolveRun!()
    await p
    expect(scheduler.isRunning('t1')).toBe(false)
  })
})

describe('recompute', () => {
  test('创建/更新后 fresh 重算（不经 catchup）', () => {
    const { deps } = makeDeps()
    const scheduler = createScheduler(deps)
    expect(scheduler.recompute(task({})).nextRunAt).toBe('2026-09-07T09:00:00.000Z')
    expect(scheduler.recompute(task({ enabled: false })).nextRunAt).toBeNull()
  })
})
