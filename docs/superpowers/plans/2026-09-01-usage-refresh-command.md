# token-usage 用量刷新命令实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/token-usage refresh [天数]` 子命令：以会话日志为权威，对最近 N 天（默认 30）逐日整体重建 daily 记录并替换，修复策略 A 启动回填"部分记录日永久残缺"的盲区。

**Architecture:** 重构 `packages/usage/src/usage/backfill.ts` 抽出共享聚合核 `aggregateLogs`（list → 逐会话 readFrom → sampleFromEvent/addSample）；`backfillMissingDays`（策略 A，不变）与新增 `refreshUsageRange`（范围内整日重建替换 + 无事件日删除）共用。`usage/index.ts` 的 `/token-usage` handler 扩 rawInput 解析接线 refresh 分支。

**Tech Stack:** TypeScript ESM、vitest。

**Spec:** `docs/superpowers/specs/2026-09-01-usage-refresh-command-design.md`

## Global Constraints

- 不执行任何 git mutation（add/commit/push 等）——用户未授权，本计划不含 commit 步骤。
- `sessionPersistence` 是可选服务：只能 `ctx.get('sessionPersistence')`，绝不进 `inject`，绝不进 dependencies/peerDependencies。
- 尽力而为：任何异常 warn / 错误文案收尾；`aggregateLogs`/`refreshUsageRange`/`backfillMissingDays` **永不 reject**。
- 所有 daily/meta 写必须排进 `setupUsage` 的 `tail` 串行链（沿用既有不变式）。
- 不改 `aggregate.ts` / `store.ts` / 浏览器半 / Config schema / `inject`（`src/index.test.ts` 的 `inject` 断言必须保持绿）。
- 启动回填语义不变：策略 A（只补整日缺失）、`backfill_done` 标记、零扫描短路——Task 1 重构后既有 9 个测试必须全绿。
- 刷新语义：范围内日志有事件的日期**整体替换**；范围内已有记录但日志无事件的日期**删除**（KvTable 无键枚举，按日期区间逐日 get 探测）；范围外一律不动。
- 任何 src 改动后按仓库约定跑验证链：usage test+typecheck+bundle → toolkit test+typecheck+bundle。

---

### Task 1: 重构 backfill.ts（aggregateLogs + refreshUsageRange）+ 单元测试

**Files:**
- Modify: `packages/usage/src/usage/backfill.ts`（整体重写为下述结构）
- Test: `packages/usage/src/usage/backfill.test.ts`（追加 6 个单元用例；既有 9 个用例不动）

**Interfaces:**
- Consumes: `addSample`/`emptyDaily`/`sampleFromEvent`/`shiftDate`（`./aggregate.ts`，已存在；`shiftDate(date: string, days: number): string`）；`DailyRecord`（`./store.ts`）；`BackfillPersistence`/`BackfillDeps`/`BACKFILL_DONE_KEY`（本文件既有，签名不变）。
- Produces（Task 2 接线依赖的确切签名）:

```ts
export function aggregateLogs(
  persistence: BackfillPersistence,
  timezone: string,
  estimate: (message: Message) => number,
  warn: (msg: string) => void,
): Promise<Map<string, DailyRecord> | undefined> // undefined = list 整体失败（已 warn）

export interface RefreshDeps {
  persistence: BackfillPersistence
  timezone: string
  daily: KvTable<string, DailyRecord>
  estimate: (message: Message) => number
  enqueue: (job: () => Promise<unknown>) => Promise<unknown>
  warn: (msg: string) => void
}
export interface RefreshDayChange { date: string; before: number; after: number }
export interface RefreshResult { changed: RefreshDayChange[]; unchanged: number; failed: boolean }
export function refreshUsageRange(deps: RefreshDeps, days: number, today: string): Promise<RefreshResult>
```

- [ ] **Step 1: 追加 6 个失败测试**

在 `packages/usage/src/usage/backfill.test.ts` 末尾（setupUsage 组合级用例之前，即 `// ===== setupUsage 组合级（接线）用例 =====` 注释行之前）追加。import 区追加 `refreshUsageRange`（从 `./backfill.ts`）：

```ts
// ===== refreshUsageRange 单元用例 =====

/** 由 makeDeps 的零件组装 RefreshDeps（无 meta）。 */
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

test('刷新：写入异常被捕获为 failed=true，永不 reject', async () => {
  const { daily, warn, refresh } = makeRefreshDeps([usageEvent(T1, { inputTokens: 1, outputTokens: 1 })])
  daily.put.mockRejectedValueOnce(new Error('disk full'))
  const result = await refreshUsageRange(refresh, 30, '2026-08-28')
  expect(result.failed).toBe(true)
  expect(warn).toHaveBeenCalled()
})
```

同时把 import 行改为：

```ts
import { BACKFILL_DONE_KEY, backfillMissingDays, refreshUsageRange, type BackfillPersistence } from './backfill.ts'
```

- [ ] **Step 2: 跑测试确认 6 个新用例红**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run src/usage/backfill.test.ts`
Expected: 既有 9 个仍绿；新 6 个失败（`refreshUsageRange` 未导出，模块解析/类型错误）。

- [ ] **Step 3: 重写 backfill.ts（抽 aggregateLogs + 新增 refreshUsageRange）**

`packages/usage/src/usage/backfill.ts` 全文替换为：

```ts
/** token-usage 历史扫描：共享日志聚合核、一次性启动回填（策略 A）与手动范围刷新（整日重建）。 */
import type { Message } from '@deepseek-ai/dsh-llm/types'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { addSample, emptyDaily, sampleFromEvent, shiftDate } from './aggregate.ts'
import type { DailyRecord } from './store.ts'

export const BACKFILL_DONE_KEY = 'backfill_done'

/** ctx.sessionPersistence 的最小消费面（结构子类型，详见 dsh-session-persistence 的 Service Definition）。 */
export interface BackfillPersistence {
  list(signal?: AbortSignal): Promise<SessionHeader[]>
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }>
}

/**
 * 扫描全部会话日志聚合为按日记录：list → 逐会话 readFrom → 逐事件 sampleFromEvent/addSample。
 * 尽力而为：单会话读失败 warn 跳过该会话；list 整体失败 warn 并返回 undefined
 *（调用方据此决定是否落地完成标记/是否报失败）。本函数不抛错。
 */
export async function aggregateLogs(
  persistence: BackfillPersistence,
  timezone: string,
  estimate: (message: Message) => number,
  warn: (msg: string) => void,
): Promise<Map<string, DailyRecord> | undefined> {
  let headers: SessionHeader[]
  try {
    headers = await persistence.list()
  } catch (error) {
    warn(`用量日志列表读取失败：${String(error)}`)
    return undefined
  }
  const byDate = new Map<string, DailyRecord>()
  for (const header of headers) {
    let events: readonly SessionEvent[]
    try {
      events = (await persistence.readFrom(header.id, 0)).events
    } catch (error) {
      warn(`用量日志扫描跳过会话 ${String(header.id)}：读取失败 ${String(error)}`)
      continue
    }
    // sampleFromEvent 只读 session.header 的 id/cwd：给最小会话形态。
    const stub = { header } as unknown as Session
    for (const event of events) {
      const sample = sampleFromEvent(stub, event, timezone, estimate)
      if (sample === undefined) continue
      byDate.set(sample.date, addSample(byDate.get(sample.date) ?? emptyDaily(sample.date), sample))
    }
  }
  return byDate
}

export interface BackfillDeps {
  persistence: BackfillPersistence
  timezone: string
  daily: KvTable<string, DailyRecord>
  meta: KvTable<string, { value: string }>
  estimate: (message: Message) => number
  /** 把读改写排进与实时采集共享的串行链；返回该次写入的完成 promise。 */
  enqueue: (job: () => Promise<unknown>) => Promise<unknown>
  warn: (msg: string) => void
}

/**
 * 一次性补齐 daily 表完全缺失的日期：已有记录的日期视为权威（策略 A），跳过即幂等。
 * 尽力而为：单会话异常 warn 跳过；扫描未完整走完（aggregateLogs 返回 undefined）
 * 不落地 backfill_done，下次启动重试。本函数永不 reject（不次生 unhandled rejection 不变式）。
 */
export async function backfillMissingDays(deps: BackfillDeps): Promise<void> {
  const { persistence, timezone, daily, meta, estimate, enqueue, warn } = deps
  if (meta.get(BACKFILL_DONE_KEY) !== undefined) return
  try {
    const byDate = await aggregateLogs(persistence, timezone, estimate, warn)
    if (byDate === undefined) {
      warn('历史用量回填未完成（下次启动重试）')
      return
    }
    // 写入前再查一次：扫描期间被实时采集创建的日期（如今日）跳过，天然防双计。
    for (const [date, record] of byDate) {
      await enqueue(async () => {
        if (daily.get(date) === undefined) await daily.put(date, record)
      })
    }
    await enqueue(() => meta.put(BACKFILL_DONE_KEY, { value: new Date().toISOString() }))
  } catch (error) {
    warn(`历史用量回填未完成（下次启动重试）：${String(error)}`)
  }
}

export interface RefreshDeps {
  persistence: BackfillPersistence
  timezone: string
  daily: KvTable<string, DailyRecord>
  estimate: (message: Message) => number
  /** 把读改写排进与实时采集共享的串行链；返回该次写入的完成 promise。 */
  enqueue: (job: () => Promise<unknown>) => Promise<unknown>
  warn: (msg: string) => void
}

/** 刷新对照行：before/after 为该日 totals.calls。 */
export interface RefreshDayChange { date: string; before: number; after: number }

export interface RefreshResult {
  /** calls 数有变化或被删除的日期（按日期升序）。 */
  changed: RefreshDayChange[]
  /** 范围内被重建但 calls 数不变的日期数（内部明细不同的行仍已替换）。 */
  unchanged: number
  /** 整体失败（list 抛错 / 写入抛错）：已 warn，数据尽力保留。 */
  failed: boolean
}

/**
 * 以会话日志为权威，整日重建 [today-(days-1) .. today] 范围内的 daily 记录：
 * 范围内日志有事件的日期整体替换；范围内已有记录但日志无事件的日期删除
 *（KvTable 无键枚举，按日期区间逐日 get 探测）。范围外一律不动。
 * 本函数永不 reject（命令 handler 的 failed 分支据此回报）。
 */
export async function refreshUsageRange(deps: RefreshDeps, days: number, today: string): Promise<RefreshResult> {
  const { persistence, timezone, daily, estimate, enqueue, warn } = deps
  try {
    const byDate = await aggregateLogs(persistence, timezone, estimate, warn)
    if (byDate === undefined) return { changed: [], unchanged: 0, failed: true }
    const from = shiftDate(today, -(days - 1))
    const changed: RefreshDayChange[] = []
    let unchanged = 0
    for (const [date, record] of byDate) {
      if (date < from || date > today) continue
      const before = daily.get(date)?.totals.calls ?? 0
      await enqueue(() => daily.put(date, record))
      if (before === record.totals.calls) unchanged++
      else changed.push({ date, before, after: record.totals.calls })
    }
    // 范围内已有记录但日志无事件的日期：删除（日志即事实——会话被删则用量随之消失）。
    for (let i = 0; i < days; i++) {
      const date = shiftDate(from, i)
      if (byDate.has(date)) continue
      const existing = daily.get(date)
      if (existing === undefined) continue
      await enqueue(() => daily.delete(date))
      changed.push({ date, before: existing.totals.calls, after: 0 })
    }
    changed.sort((a, b) => (a.date < b.date ? -1 : 1))
    return { changed, unchanged, failed: false }
  } catch (error) {
    warn(`用量刷新失败：${String(error)}`)
    return { changed: [], unchanged: 0, failed: true }
  }
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run src/usage/backfill.test.ts`
Expected: 15/15 PASS（既有 9 + 新 6；既有用例验证重构无行为回归）。

- [ ] **Step 5: 跑 usage 全量测试 + typecheck**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test; if ($?) { pnpm --filter @dsh-agent-toolkit/token-usage typecheck }`
Expected: 全部通过，tsc 无错。

---

### Task 2: `/token-usage refresh` 子命令接线 + 组合测试

**Files:**
- Modify: `packages/usage/src/usage/index.ts`（import 行 + 命令 description/hint + handler refresh 分支 + 删除 `void today`）
- Test: `packages/usage/src/usage/backfill.test.ts`（追加 3 个组合用例；`makeSetupCtx` 加 `seedMeta` 选项）

**Interfaces:**
- Consumes: Task 1 的 `refreshUsageRange` / `RefreshResult`；`parseDaysParam`（`./heatmap.ts`，已 import）；`dayParts`（`./aggregate.ts`，已 import）；模块内既有 `ownsMeter` / `tail` / `domainReady`。
- Produces: 无新导出；`/token-usage refresh [天数]` 行为。

- [ ] **Step 1: 追加 3 个失败测试 + makeSetupCtx 加 seedMeta**

`packages/usage/src/usage/backfill.test.ts` 的 `makeSetupCtx` 签名与 domain.table 创建处改为（其余不动）：

```ts
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
  // ……其余与现状完全一致……
}
```

在文件末尾追加（import 区无需新增；用既有 `setupUsage`/`BACKFILL_DONE_KEY`/`vi`/`expect`/`test`）：

```ts
test('接线：/token-usage refresh 重建范围内日期并输出逐日对照', async () => {
  // 启动回填先填 1 call；随后日志变为 2 条事件，refresh 重建为 2 calls。
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
```

- [ ] **Step 2: 跑测试确认 3 个新用例红**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run src/usage/backfill.test.ts`
Expected: 前 15 个仍绿；新 3 个失败（refresh 分支不存在：`refresh 366` 落入 DATE_RE 校验返回用法错误文案，断言的 kind/文案均不符）。

- [ ] **Step 3: 接线 usage/index.ts**

3.1 import 区第 24 行附近，把

```ts
import { BACKFILL_DONE_KEY, backfillMissingDays } from './backfill.ts'
```

改为

```ts
import { BACKFILL_DONE_KEY, backfillMissingDays, refreshUsageRange } from './backfill.ts'
```

3.2 命令注册的 description/hint 改为：

```ts
    ctx.commands.register({
      name: 'token-usage',
      description: '查看 token 用量（今日+近7日，或指定日期）；refresh [天数] 按会话日志重建近 N 天',
      input: { hint: 'YYYY-MM-DD 或 refresh [天数]，可空' },
```

3.3 handler 内 `const today = ...` 行之后、既有 `if (arg !== '')` 分支之前，插入 refresh 分支：

```ts
      if (arg === 'refresh' || arg.startsWith('refresh ')) {
        // 手动刷新：以会话日志为权威整日重建最近 N 天（默认 30）。仅计量主可写；
        // 写全部排进与实时采集共享的 tail 串行链（读改写不交错）。
        if (!ownsMeter) return { kind: 'error' as const, text: 'token 计量由其他实例挂载，无法刷新' }
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) return { kind: 'error' as const, text: 'sessionPersistence 服务缺失，无法刷新用量' }
        const daysArg = arg.slice('refresh'.length).trim()
        const days = daysArg === '' ? 30 : parseDaysParam(daysArg)
        if (days === null) return { kind: 'error' as const, text: '用法：/token-usage refresh [天数 1..366，默认 30]' }
        const enqueue = (job: () => Promise<unknown>): Promise<unknown> => {
          const write = tail.then(job)
          tail = write.then(() => undefined, () => undefined)
          return write
        }
        const result = await refreshUsageRange({
          persistence,
          timezone: config.timezone,
          daily: table,
          estimate: (m) => ctx.tokenMeter.estimateMessage(m),
          enqueue,
          warn: (m) => ctx.logger.warn(m),
        }, days, today)
        if (result.failed) return { kind: 'error' as const, text: '刷新失败（详见日志），数据未变' }
        const lines = result.changed.map((c) => `${c.date}: ${c.before} → ${c.after} calls`)
        lines.push(`刷新完成：${result.changed.length} 天有变化，${result.unchanged} 天无变化`)
        return { kind: 'success' as const, text: lines.join('\n') }
      }
```

3.4 删除 handler 尾部的 `void today` 行（`today` 现已被 refresh 分支消费）。

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run src/usage/backfill.test.ts`
Expected: 18/18 PASS。

- [ ] **Step 5: 跑 usage 全量测试 + typecheck**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test; if ($?) { pnpm --filter @dsh-agent-toolkit/token-usage typecheck }`
Expected: 全部通过（含 `src/index.test.ts` inject 断言、meter-owner 用例不变）；tsc 无错。

---

### Task 3: 全量验证链 + 使用手册同步

**Files:**
- Modify: `docs/usage/token-usage.md`（「命令行」一节）

- [ ] **Step 1: 手册补充 refresh 子命令**

`docs/usage/token-usage.md` 的「命令行」一节代码块改为：

````
```
/token-usage              # 今日详情 + 近 7 日概览
/token-usage 2026-08-27   # 指定日期的单日详情（按模型/按项目/压缩）
/token-usage refresh      # 以会话日志为权威，整日重建最近 30 天用量
/token-usage refresh 7    # 重建最近 7 天
```
````

并把该节末尾的「参数必须是 `YYYY-MM-DD` 格式，否则返回用法提示。」改为：

```markdown
查询参数必须是 `YYYY-MM-DD` 格式，否则返回用法提示。数量以 K/M/B 格式化（10 进制，1 位小数）。

`refresh` 用于修复统计缺失（例如多实例并行时后到实例不计量导致的漏记）：它重新扫描全部会话日志，对范围内每一天**整体重建并替换**已有记录；范围内已有记录但日志中已无对应会话事件的日期会被删除。天数取 1..366，缺省 30。仅计量主实例可执行；扫描瞬间在途未落盘的调用可能被覆盖，再刷一次即可收敛。
```

- [ ] **Step 2: usage 三产物 bundle（toolkit 测试经 node_modules 吃 usage lib，必须先刷新）**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage bundle`
Expected: node/client-module/client 三产物构建成功。

- [ ] **Step 3: toolkit 全量测试 + typecheck**

Run: `pnpm --filter dsh-agent-toolkit test; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }`
Expected: 全部通过，tsc 无错。

- [ ] **Step 4: toolkit bundle**

Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: Node 半 + 浏览器半构建成功。

- [ ] **Step 5: 人工验收提示（告知用户，不自动执行）**

重启 dsh 后执行 `/token-usage refresh`：输出应列出 2026-08-18（1 → 2 calls）与今日（1 → 47 calls）等变化行；随后 `/token-usage` 与侧边栏面板数字与会话日志一致。
