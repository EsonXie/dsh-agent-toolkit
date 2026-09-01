import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { emptyDaily } from './aggregate.ts'
import type { DailyRecord } from './store.ts'
import { BACKFILL_DONE_KEY, backfillMissingDays, refreshUsageRange, type BackfillPersistence } from './backfill.ts'
import { setupUsage } from './index.ts'

/** Map 假 KvTable（meter-owner.test.ts 同款）。 */
function fakeTable() {
  const records = new Map<string, unknown>()
  return {
    records,
    get: (k: string) => records.get(k),
    put: vi.fn(async (k: string, v: unknown) => { records.set(k, v) }),
    delete: async (k: string) => records.delete(k),
  }
}

const HEADER: SessionHeader = { version: 0, id: 'sess-1' as SessionId, createdAt: 0, cwd: 'D:\\proj' }

/** 2026-08-27 12:00 Asia/Shanghai；usage 可省略（省略即走估算路径）。 */
function usageEvent(time: number, usage?: { inputTokens: number; outputTokens: number }): SessionEvent {
  return {
    type: 'assistant/message', seq: 1, time,
    data: {
      turn: 0, step: 0,
      message: { source: { provider: 'p', model: 'm' } },
      ...(usage === undefined ? {} : { usage }),
    },
  } as unknown as SessionEvent
}

const T1 = Date.parse('2026-08-27T12:00:00+08:00')
const T2 = Date.parse('2026-08-28T13:00:00+08:00')

function makeDeps(events: SessionEvent[], opts: {
  persistence?: Partial<BackfillPersistence>
  estimate?: (m: unknown) => number
} = {}) {
  const daily = fakeTable()
  const meta = fakeTable()
  const warn = vi.fn()
  const persistence: BackfillPersistence = {
    list: vi.fn(async () => [HEADER]),
    readFrom: vi.fn(async () => ({ meta: HEADER, events })),
    ...opts.persistence,
  }
  const enqueue = (job: () => Promise<unknown>) => job()
  return {
    daily, meta, warn, persistence,
    deps: {
      persistence, timezone: 'Asia/Shanghai',
      daily: daily as never, meta: meta as never,
      estimate: (opts.estimate ?? (() => 0)) as never,
      enqueue, warn,
    },
  }
}

test('缺失日期被补齐：按日聚合进 daily，含 byModel/hours', async () => {
  const { daily, deps } = makeDeps([usageEvent(T1, { inputTokens: 100, outputTokens: 10 })])
  await backfillMissingDays(deps)
  const rec = daily.records.get('2026-08-27') as DailyRecord
  expect(rec.totals.input).toBe(100)
  expect(rec.totals.calls).toBe(1)
  expect(rec.hours[12].input).toBe(100)
  expect(rec.byModel['p/m'].output).toBe(10)
  expect(rec.bySession['sess-1'].cwd).toBe('D:\\proj')
})

test('已有记录的日期跳过，不被覆盖', async () => {
  const { daily, deps } = makeDeps([usageEvent(T1, { inputTokens: 100, outputTokens: 10 })])
  const existing = emptyDaily('2026-08-27')
  daily.records.set('2026-08-27', existing)
  await backfillMissingDays(deps)
  expect(daily.records.get('2026-08-27')).toBe(existing) // 原对象未被替换
})

test('全部完成后落地 backfill_done 标记', async () => {
  const { meta, deps } = makeDeps([usageEvent(T1)])
  await backfillMissingDays(deps)
  expect(meta.records.get(BACKFILL_DONE_KEY)).toEqual({ value: expect.any(String) })
})

test('标记已存在：不调用 sessionPersistence，直接返回', async () => {
  const { meta, persistence, deps } = makeDeps([])
  meta.records.set(BACKFILL_DONE_KEY, { value: '2026-09-01T00:00:00.000Z' })
  await backfillMissingDays(deps)
  expect(persistence.list).not.toHaveBeenCalled()
})

test('无 usage 的 assistant/message 走估算路径', async () => {
  const { daily, deps } = makeDeps([usageEvent(T1)], { estimate: () => 42 })
  await backfillMissingDays(deps)
  const rec = daily.records.get('2026-08-27') as DailyRecord
  expect(rec.totals.estimated).toBe(42)
  expect(rec.totals.estimatedCalls).toBe(1)
})

test('单会话 readFrom 失败：warn 跳过，其余会话仍补齐，标记仍落地', async () => {
  const other: SessionHeader = { ...HEADER, id: 'sess-2' as SessionId }
  const { daily, meta, warn, deps } = makeDeps([], {
    persistence: {
      list: vi.fn(async () => [HEADER, other]),
      readFrom: vi.fn(async (id: SessionId) => {
        if (id === HEADER.id) throw new Error('corrupt')
        return { meta: other, events: [usageEvent(T2, { inputTokens: 7, outputTokens: 3 })] }
      }),
    },
  })
  await backfillMissingDays(deps)
  expect(warn).toHaveBeenCalled()
  expect(daily.records.has('2026-08-28')).toBe(true)
  expect(meta.records.has(BACKFILL_DONE_KEY)).toBe(true)
})

// ===== refreshUsageRange 单元用例 =====

/** 用 makeDeps 的零件组装 RefreshDeps（无 meta）。 */
function makeRefreshDeps(events: SessionEvent[], opts: Parameters<typeof makeDeps>[1] = {}) {
  const h = makeDeps(events, opts)
  return {
    ...h,
    refresh: {
      persistence: h.persistence, timezone: h.deps.timezone,
      daily: h.deps.daily, estimate: h.deps.estimate,
      enqueue: h.deps.enqueue, warn: h.warn,
    },
  }
}

test('刷新：已有记录被日志整体重建替换', async () => {
  const { daily, refresh } = makeRefreshDeps([
    usageEvent(T1, { inputTokens: 100, outputTokens: 10 }),
    usageEvent(T1, { inputTokens: 200, outputTokens: 20 }),
  ])
  const existing = emptyDaily('2026-08-27')
  daily.records.set('2026-08-27', existing)
  const result = await refreshUsageRange(refresh, 30, '2026-08-28')
  expect(result.failed).toBe(false)
  const rec = daily.records.get('2026-08-27') as DailyRecord
  expect(rec).not.toBe(existing) // 整体替换，不是原地改
  expect(rec.totals.calls).toBe(2)
  expect(rec.totals.input).toBe(300)
  expect(result.changed).toEqual([{ date: '2026-08-27', before: 0, after: 2 }])
})

test('刷新：范围外日期不动（日志事件不写入、已有记录保持原对象）', async () => {
  const { daily, refresh } = makeRefreshDeps([usageEvent(T1, { inputTokens: 5, outputTokens: 1 })])
  const outside = emptyDaily('2026-08-20')
  daily.records.set('2026-08-20', outside)
  const result = await refreshUsageRange(refresh, 1, '2026-08-28') // 范围仅 2026-08-28
  expect(result.failed).toBe(false)
  expect(daily.records.has('2026-08-27')).toBe(false) // T1 事件在范围外
  expect(daily.records.get('2026-08-20')).toBe(outside)
  expect(result.changed).toEqual([])
})

test('刷新：范围内日志无事件的已有记录被删除', async () => {
  const { daily, refresh } = makeRefreshDeps([usageEvent(T2, { inputTokens: 7, outputTokens: 3 })])
  const stale = emptyDaily('2026-08-27')
  stale.totals.calls = 3
  daily.records.set('2026-08-27', stale) // 日志无 08-27 事件
  const result = await refreshUsageRange(refresh, 2, '2026-08-28') // 范围 08-27..08-28
  expect(result.failed).toBe(false)
  expect(daily.records.has('2026-08-27')).toBe(false)
  expect((daily.records.get('2026-08-28') as DailyRecord).totals.calls).toBe(1)
  expect(result.changed).toEqual([
    { date: '2026-08-27', before: 3, after: 0 },
    { date: '2026-08-28', before: 0, after: 1 },
  ])
})

test('刷新：单会话读失败 warn 跳过，其余日期照常重建，failed=false', async () => {
  const other: SessionHeader = { ...HEADER, id: 'sess-2' as SessionId }
  const { daily, warn, refresh } = makeRefreshDeps([], {
    persistence: {
      list: vi.fn(async () => [HEADER, other]),
      readFrom: vi.fn(async (id: SessionId) => {
        if (id === HEADER.id) throw new Error('corrupt')
        return { meta: other, events: [usageEvent(T2, { inputTokens: 7, outputTokens: 3 })] }
      }),
    },
  })
  const result = await refreshUsageRange(refresh, 2, '2026-08-28')
  expect(warn).toHaveBeenCalled()
  expect(result.failed).toBe(false)
  expect((daily.records.get('2026-08-28') as DailyRecord).totals.input).toBe(7)
})

test('刷新：单会话读失败跳过删除 pass，读不出的日期旧记录保留，其余日期照常重建', async () => {
  const other: SessionHeader = { ...HEADER, id: 'sess-2' as SessionId }
  const { daily, warn, refresh } = makeRefreshDeps([], {
    persistence: {
      list: vi.fn(async () => [HEADER, other]),
      readFrom: vi.fn(async (id: SessionId) => {
        if (id === HEADER.id) throw new Error('corrupt')
        return { meta: other, events: [usageEvent(T2, { inputTokens: 7, outputTokens: 3 })] }
      }),
    },
  })
  // 失败会话若可读可能拥有的日期 08-27 上有既有记录：聚合不完整时不得按"无事件"整删。
  const stale = emptyDaily('2026-08-27')
  stale.totals.calls = 3
  daily.records.set('2026-08-27', stale)
  const result = await refreshUsageRange(refresh, 2, '2026-08-28') // 范围 08-27..08-28
  expect(warn).toHaveBeenCalled()
  expect(result.failed).toBe(false)
  expect(daily.records.get('2026-08-27')).toBe(stale) // 删除 pass 被跳过，旧记录原样保留
  expect((daily.records.get('2026-08-28') as DailyRecord).totals.input).toBe(7) // 可读会话照常重建
  expect(result.changed).toEqual([{ date: '2026-08-28', before: 0, after: 1 }])
})

test('刷新：日志列表读取失败时 failed=true 且不写任何数据', async () => {
  const { daily, warn, refresh } = makeRefreshDeps([], {
    persistence: { list: vi.fn(async () => { throw new Error('io') }) },
  })
  const result = await refreshUsageRange(refresh, 30, '2026-08-28')
  expect(result.failed).toBe(true)
  expect(result.changed).toEqual([])
  expect(warn).toHaveBeenCalled()
  expect(daily.put).not.toHaveBeenCalled()
})

test('刷新：写入异常被捕获后 failed=true，永不 reject', async () => {
  const { daily, warn, refresh } = makeRefreshDeps([usageEvent(T1, { inputTokens: 1, outputTokens: 1 })])
  daily.put.mockRejectedValueOnce(new Error('disk full'))
  const result = await refreshUsageRange(refresh, 30, '2026-08-28')
  expect(result.failed).toBe(true)
  expect(warn).toHaveBeenCalled()
})

// ===== setupUsage 组合级（接线）用例 =====

/** meter-owner.test.ts 同款假上下文，额外支持 ctx.get('sessionPersistence')。 */
function makeSetupCtx(persistence: unknown, opts: { alreadyOpen?: boolean; seedMeta?: Record<string, unknown> } = {}) {
  const tables = new Map<string, Map<string, unknown>>()
  const domain = {
    table: (name: string) => {
      let records = tables.get(name)
      if (records === undefined) {
        records = new Map(name === 'meta' ? Object.entries(opts.seedMeta ?? {}) : [])
        tables.set(name, records)
      }
      return {
        get: (k: string) => records!.get(k),
        put: async (k: string, v: unknown) => { records!.set(k, v) },
        delete: async (k: string) => records!.delete(k),
      }
    },
    close: async () => {},
  }
  const warn = vi.fn()
  const open = opts.alreadyOpen === true
    ? () => Promise.reject(Object.assign(new Error('already open'), { code: 'already-open' }))
    : () => Promise.resolve(domain)
  const ctx = {
    logger: { warn },
    tokenMeter: { estimateMessage: () => 0 },
    storageDomain: { open },
    effect: (fn: () => unknown) => { void fn() },
    on: vi.fn(),
    commands: { register: vi.fn() },
    inject: vi.fn(),
    get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined),
  }
  return { ctx: ctx as unknown as Context, tables, warn }
}

/** 等 domainReady/metering/backfill 微任务链落地（多轮 flush 覆盖链式 enqueue）。 */
async function flushAll() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

test('接线：计量主启动后自动回填缺失日期并落地标记', async () => {
  const persistence = {
    list: vi.fn(async () => [HEADER]),
    readFrom: vi.fn(async () => ({ meta: HEADER, events: [usageEvent(T1, { inputTokens: 5, outputTokens: 1 })] })),
  }
  const { ctx, tables } = makeSetupCtx(persistence)
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flushAll()
  expect(persistence.list).toHaveBeenCalled()
  const rec = tables.get('daily')?.get('2026-08-27') as DailyRecord
  expect(rec.totals.input).toBe(5)
  expect(tables.get('meta')?.has(BACKFILL_DONE_KEY)).toBe(true)
})

test('接线：sessionPersistence 缺失时 warn 跳过且不落地标记', async () => {
  const { ctx, tables, warn } = makeSetupCtx(undefined)
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flushAll()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('sessionPersistence'))
  expect(tables.get('meta')?.has(BACKFILL_DONE_KEY)).toBe(false)
})

test('接线：already-open 停用方不回填', async () => {
  const persistence = { list: vi.fn(), readFrom: vi.fn() }
  const { ctx } = makeSetupCtx(persistence, { alreadyOpen: true })
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-b')
  await flushAll()
  expect(persistence.list).not.toHaveBeenCalled()
})

test('接线：/token-usage refresh 重建范围内日期并输出逐日对照', async () => {
  // 启动回填先填 1 call；随后日志变到 2 条事件，refresh 重建后是 2 calls。
  let extra = false
  const persistence = {
    list: vi.fn(async () => [HEADER]),
    readFrom: vi.fn(async () => ({
      meta: HEADER,
      events: [
        usageEvent(T1, { inputTokens: 100, outputTokens: 10 }),
        ...(extra ? [usageEvent(T1, { inputTokens: 200, outputTokens: 20 })] : []),
      ],
    })),
  }
  const { ctx, tables } = makeSetupCtx(persistence)
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flushAll()
  expect((tables.get('daily')?.get('2026-08-27') as DailyRecord).totals.calls).toBe(1)
  extra = true
  const handler = (ctx.commands.register as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].handler
  const res = await handler({ rawInput: 'refresh 366' })
  expect(res.kind).toBe('success')
  expect(res.text).toContain('2026-08-27: 1 → 2 calls')
  expect(res.text).toContain('刷新完成')
  expect((tables.get('daily')?.get('2026-08-27') as DailyRecord).totals.calls).toBe(2)
  expect((tables.get('daily')?.get('2026-08-27') as DailyRecord).totals.input).toBe(300)
  expect(tables.get('meta')?.has(BACKFILL_DONE_KEY)).toBe(true) // 回填标记不受刷新影响
})

test('接线：refresh 在 sessionPersistence 缺失时返回错误文案且不落数据', async () => {
  const { ctx, tables } = makeSetupCtx(undefined)
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flushAll()
  const handler = (ctx.commands.register as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].handler
  const res = await handler({ rawInput: 'refresh' })
  expect(res.kind).toBe('error')
  expect(res.text).toContain('sessionPersistence')
  expect(tables.get('daily')?.size ?? 0).toBe(0)
})

test('接线：refresh 在非计量主实例被拒绝', async () => {
  const persistence = { list: vi.fn(), readFrom: vi.fn() }
  const { ctx } = makeSetupCtx(persistence, { seedMeta: { meter_owner: { value: 'other-pkg' } } })
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flushAll()
  const handler = (ctx.commands.register as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].handler
  const res = await handler({ rawInput: 'refresh' })
  expect(res.kind).toBe('error')
  expect(res.text).toContain('其他实例')
  expect(persistence.list).not.toHaveBeenCalled()
})
