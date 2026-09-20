# Token 用量 UI 重设计实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** token 用量插件 UI 优化：入口迁到会话标题栏 utilities 区、热力图美化并支持点击跳单日、「单日」tab 升级为「趋势」范围查询（单日按小时 / 多日按天堆叠柱状图 + 聚合明细）。

**Architecture:** 纯函数层（`packages/usage/src/usage/heatmap.ts`）扩展范围参数解析与跨日聚合；Node 半 range 路由支持 `from`/`to` 并返回聚合块；浏览器半模态框重构为「活动 / 趋势」两 tab，入口 slot 从 `sidebar.footer.action` 迁到 `conversation.session.header.utilities`。

**Tech Stack:** React + recharts + vitest（node 环境纯函数/路由，`// @vitest-environment jsdom` + @testing-library/react 客户端），pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-09-20-usage-ui-redesign-design.md`（已批准）

## Global Constraints

- 注释与 UI 文案用中文，沿用现有文件风格；文件头保留一行用途注释。
- 不新增第三方依赖；日期选择用原生 `<input type="date">`。
- 图表颜色一律走 `chart.module.css` 的 `--chart-1/--chart-2/--chart-label/--chart-empty` 令牌。
- 跨度上限 366 天；`days` 与 `from`/`to` 参数互斥。
- daily 端点（`/dsh-agent-toolkit/api/usage/daily`）保留不动；前端不再调用它。
- 存储格式、`/token-usage` 命令、启动回填不改。
- 测试命令：`pnpm --filter @dsh-agent-toolkit/token-usage test`；类型检查 `pnpm --filter @dsh-agent-toolkit/token-usage typecheck`。
- 改 usage src 后、跑 toolkit 测试前必须先 `pnpm --filter @dsh-agent-toolkit/token-usage bundle`（toolkit vitest 经 node_modules 解析 usage 的 lib/）。

---

### Task 1: 纯函数层扩展（heatmap.ts）

**Files:**
- Modify: `packages/usage/src/usage/heatmap.ts`
- Test: `packages/usage/src/usage/heatmap.test.ts`

**Interfaces:**
- Consumes: 现有 `billedOf`/`shiftDate`/`emptyBucket`/`emptyDaily`（`aggregate.ts`）、`cacheSplit`（本文件）、`Bucket`/`DailyRecord`（`store.ts`）。
- Produces（后续任务依赖的确切签名）:
  - `HeatmapDay { date: string; billed: number; calls: number; fresh: number; cached: number }`（新增 fresh/cached 两字段）
  - `parseRangeParams(params: { days: string | null; from: string | null; to: string | null }, today: string): { from: string; to: string } | null`
  - `datesBetween(from: string, to: string): string[]`（升序，含端点；调用方保证 from <= to）
  - `rangeSummaries(get: (date: string) => DailyRecord | undefined, from: string, to: string): HeatmapDay[]`（**签名变更**：原 `(get, today, days)`）
  - `RangeAggregate { totals: Bucket & { estimatedCalls: number }; byModel: Record<string, Bucket>; byProject: Record<string, Bucket>; compaction: Bucket }`
  - `aggregateRange(records: DailyRecord[]): RangeAggregate`

- [ ] **Step 1: 写失败测试（追加到 heatmap.test.ts）**

```ts
// 文件顶部 import 追加：parseRangeParams, datesBetween, aggregateRange, type RangeAggregate
// 现有 rangeSummaries 测试改为新签名（见 Step 4 说明），本步先追加新测试：

test('parseRangeParams：缺省近 91 天；days 合法；days 与 from/to 互斥', () => {
  expect(parseRangeParams({ days: null, from: null, to: null }, '2026-08-18'))
    .toEqual({ from: '2026-05-20', to: '2026-08-18' })
  expect(parseRangeParams({ days: '7', from: null, to: null }, '2026-08-18'))
    .toEqual({ from: '2026-08-12', to: '2026-08-18' })
  expect(parseRangeParams({ days: '7', from: '2026-08-01', to: null }, '2026-08-18')).toBeNull()
  expect(parseRangeParams({ days: 'abc', from: null, to: null }, '2026-08-18')).toBeNull()
})

test('parseRangeParams：from/to 需成对、合法日期、起<=止、跨度<=366', () => {
  expect(parseRangeParams({ days: null, from: '2026-08-01', to: null }, '2026-08-18')).toBeNull()
  expect(parseRangeParams({ days: null, from: null, to: '2026-08-01' }, '2026-08-18')).toBeNull()
  expect(parseRangeParams({ days: null, from: '2026-8-1', to: '2026-08-18' }, '2026-08-18')).toBeNull()
  expect(parseRangeParams({ days: null, from: '2026-08-18', to: '2026-08-01' }, '2026-08-18')).toBeNull()
  expect(parseRangeParams({ days: null, from: '2025-08-18', to: '2026-08-18' }, '2026-08-18'))
    .toEqual({ from: '2025-08-18', to: '2026-08-18' }) // 366 天整，合法
  expect(parseRangeParams({ days: null, from: '2025-08-17', to: '2026-08-18' }, '2026-08-18')).toBeNull() // 367 天，非法
  expect(parseRangeParams({ days: null, from: '2026-08-01', to: '2026-08-03' }, '2026-08-18'))
    .toEqual({ from: '2026-08-01', to: '2026-08-03' })
})

test('datesBetween：升序含端点', () => {
  expect(datesBetween('2026-08-17', '2026-08-19')).toEqual(['2026-08-17', '2026-08-18', '2026-08-19'])
  expect(datesBetween('2026-08-18', '2026-08-18')).toEqual(['2026-08-18'])
})

test('rangeSummaries 新签名：from/to 区间升序，缺失日记 0 且带 fresh/cached', () => {
  const rec = emptyDaily('2026-08-17')
  rec.totals = { input: 100, output: 50, cacheRead: 30, cacheWrite: 0, estimated: 0, calls: 2, estimatedCalls: 0 }
  const days = rangeSummaries((d) => (d === '2026-08-17' ? rec : undefined), '2026-08-16', '2026-08-18')
  expect(days).toEqual([
    { date: '2026-08-16', billed: 0, calls: 0, fresh: 0, cached: 0 },
    { date: '2026-08-17', billed: 180, calls: 2, fresh: 150, cached: 30 },
    { date: '2026-08-18', billed: 0, calls: 0, fresh: 0, cached: 0 },
  ])
})

test('aggregateRange：多日记账求和，byModel/byProject/compaction 合并', () => {
  const a = emptyDaily('2026-08-17')
  a.totals = { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, estimated: 3, calls: 2, estimatedCalls: 1 }
  a.byModel = { 'deepseek/chat': { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, estimated: 3, calls: 2 } }
  a.byProject = { '/p1': { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, estimated: 3, calls: 2 } }
  a.compaction = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 1 }
  const b = emptyDaily('2026-08-18')
  b.totals = { input: 200, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 1, estimatedCalls: 0 }
  b.byModel = {
    'deepseek/chat': { input: 150, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 1 },
    'openai/gpt': { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 1 },
  }
  const agg = aggregateRange([a, b])
  expect(agg.totals).toEqual({ input: 300, output: 50, cacheRead: 20, cacheWrite: 5, estimated: 3, calls: 3, estimatedCalls: 1 })
  expect(agg.byModel['deepseek/chat']).toEqual({ input: 250, output: 50, cacheRead: 20, cacheWrite: 5, estimated: 3, calls: 3 })
  expect(agg.byModel['openai/gpt']).toEqual({ input: 50, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 1 })
  expect(agg.byProject['/p1']).toEqual({ input: 100, output: 50, cacheRead: 20, cacheWrite: 5, estimated: 3, calls: 2 })
  expect(agg.compaction).toEqual({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 1 })
})

test('aggregateRange：空数组返回全零聚合', () => {
  const agg = aggregateRange([])
  expect(agg.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 })
  expect(agg.byModel).toEqual({})
  expect(agg.byProject).toEqual({})
  expect(agg.compaction).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test -- heatmap`
Expected: FAIL（parseRangeParams/datesBetween/aggregateRange 未定义；rangeSummaries 新签名测试失败）

- [ ] **Step 3: 实现 heatmap.ts 扩展**

在 `heatmap.ts` 中：

```ts
// 顶部 import 追加 emptyBucket：
import { billedOf, emptyBucket, shiftDate } from './aggregate.ts'

/** range 端点与热力图共用的每日紧凑摘要。 */
export interface HeatmapDay { date: string; billed: number; calls: number; fresh: number; cached: number }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_SPAN = 366

/** from/to（YYYY-MM-DD，含端点）的跨度天数。 */
function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS) + 1
}

/** 解析 range 端点参数：days（相对 today 向前）或 from/to 成对出现，互斥；非法返回 null。 */
export function parseRangeParams(
  params: { days: string | null; from: string | null; to: string | null },
  today: string,
): { from: string; to: string } | null {
  const { days, from, to } = params
  if (days !== null) {
    if (from !== null || to !== null) return null
    const n = parseDaysParam(days)
    return n === null ? null : { from: shiftDate(today, -(n - 1)), to: today }
  }
  if (from === null && to === null) return { from: shiftDate(today, -90), to: today }
  if (from === null || to === null) return null
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return null
  if (from > to || spanDays(from, to) > MAX_SPAN) return null
  return { from, to }
}

/** 升序日期串列表（含端点）；调用方保证 from <= to。 */
export function datesBetween(from: string, to: string): string[] {
  const n = spanDays(from, to)
  return Array.from({ length: n }, (_, i) => shiftDate(from, i))
}

/** 区间每日紧凑摘要（缺失日记 0），日期升序。 */
export function rangeSummaries(get: (date: string) => DailyRecord | undefined, from: string, to: string): HeatmapDay[] {
  return datesBetween(from, to).map((date) => {
    const rec = get(date)
    if (rec === undefined) return { date, billed: 0, calls: 0, fresh: 0, cached: 0 }
    const { fresh, cached } = cacheSplit(rec.totals)
    return { date, billed: billedOf(rec.totals), calls: rec.totals.calls, fresh, cached }
  })
}

/** 跨日聚合块：totals 含 estimatedCalls；byModel/byProject/compaction 与 DailyRecord 同构。 */
export interface RangeAggregate {
  totals: Bucket & { estimatedCalls: number }
  byModel: Record<string, Bucket>
  byProject: Record<string, Bucket>
  compaction: Bucket
}

function addBucket(a: Bucket, b: Bucket): Bucket {
  return {
    input: a.input + b.input, output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    calls: a.calls + b.calls, estimated: a.estimated + b.estimated,
  }
}

function mergeBuckets(into: Record<string, Bucket>, from: Record<string, Bucket>): Record<string, Bucket> {
  const out = { ...into }
  for (const [key, b] of Object.entries(from)) out[key] = addBucket(out[key] ?? emptyBucket(), b)
  return out
}

/** 聚合多日记账（调用方只传存在的记录；缺日天然跳过）。 */
export function aggregateRange(records: DailyRecord[]): RangeAggregate {
  let totals: Bucket & { estimatedCalls: number } = { ...emptyBucket(), estimatedCalls: 0 }
  let byModel: Record<string, Bucket> = {}
  let byProject: Record<string, Bucket> = {}
  let compaction = emptyBucket()
  for (const rec of records) {
    totals = { ...addBucket(totals, rec.totals), estimatedCalls: totals.estimatedCalls + rec.totals.estimatedCalls }
    byModel = mergeBuckets(byModel, rec.byModel)
    byProject = mergeBuckets(byProject, rec.byProject)
    compaction = addBucket(compaction, rec.compaction)
  }
  return { totals, byModel, byProject, compaction }
}
```

注意：原 `rangeSummaries(get, today, days)` 被新签名取代，删除旧实现；`parseDaysParam`、`levelOf`、`heatmapGrid`、`cacheSplit`、`cacheHitRate` 保持不动。

- [ ] **Step 4: 更新既有测试到新签名并全绿**

`heatmap.test.ts` 中两处既有测试需改：
- `'rangeSummaries：以 today 为终点升序，缺失日记 0'` → 整段替换为 Step 1 的新签名版本（原测试删除）。
- `'heatmapGrid：13 列 × 7 行…'` 中的 `HeatmapDay` 字面量补 `fresh`/`cached`：`{ date: today, billed: 1000, calls: 3, fresh: 1000, cached: 0 }`，断言同步。

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test -- heatmap`
Expected: PASS

- [ ] **Step 5: 修 typecheck 并提交**

`rangeSummaries` 签名变更会打断 `usage/index.ts`（Task 2 才改），本步只对 heatmap.ts 局部跑测试通过即可提交；typecheck 留到 Task 2 完成后统一跑。

```bash
git add packages/usage/src/usage/heatmap.ts packages/usage/src/usage/heatmap.test.ts
git commit -m "feat(usage): 纯函数层扩展——范围参数解析、区间摘要带 fresh/cached、跨日聚合"
```

---

### Task 2: range 路由支持 from/to 与聚合块

**Files:**
- Modify: `packages/usage/src/usage/index.ts:223-241`（range 路由 handler）
- Test: `packages/usage/src/usage/routes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseRangeParams`/`datesBetween`/`rangeSummaries`/`aggregateRange`/`RangeAggregate`；`emptyDaily`（aggregate.ts）。
- Produces: range 端点响应形状 `{ today: string; from: string; to: string; days: HeatmapDay[]; aggregate: RangeAggregate; hours?: Bucket[] }`（`hours` 仅 from === to 时携带，长度 24）——Task 4 前端消费。

- [ ] **Step 1: 写失败测试（追加到 routes.test.ts）**

`makeCtx` 需支持注入记录与调用 handler：把 `registered` 的元素类型放宽为 `{ kind: string; path: string; handler?: (req: unknown, res: unknown) => Promise<void> }`，并给 domain 的 `get` 传入可配置实现：

```ts
function makeCtx(records: Record<string, DailyRecord> = {}) {
  // ...同现有，除了：
  // domain.table 的 get: vi.fn((date: string) => records[date])
  // registered 推入完整 r（含 handler）
}
```

新增假 req/res 助手与测试：

```ts
function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(code: number) { this.status = code; return this },
    end(body?: string) { this.body = body ?? ''; return this },
  }
}

async function callRoute(registered: { kind: string; path: string; handler?: ... }[], path: string, url: string) {
  const route = registered.find((r) => r.path === path)!
  const res = fakeRes()
  await route.handler!({ method: 'GET', url }, res as never)
  return res
}

test('range：from/to 区间返回摘要、聚合块，单日附带 hours', async () => {
  const rec = emptyDaily('2026-08-17')
  rec.totals = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 2, estimatedCalls: 0 }
  const { ctx, registered } = makeCtx({ '2026-08-17': rec })
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  const res = await callRoute(registered, '/dsh-agent-toolkit/api/usage/range',
    '/dsh-agent-toolkit/api/usage/range?from=2026-08-16&to=2026-08-17')
  expect(res.status).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.from).toBe('2026-08-16')
  expect(body.to).toBe('2026-08-17')
  expect(body.days).toHaveLength(2)
  expect(body.days[1]).toEqual({ date: '2026-08-17', billed: 150, calls: 2, fresh: 150, cached: 0 })
  expect(body.aggregate.totals.input).toBe(100)
  expect(body.hours).toBeUndefined() // 多日不带 hours
})

test('range：from === to 时附带 24 小时桶', async () => {
  const { ctx, registered } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  const res = await callRoute(registered, '/dsh-agent-toolkit/api/usage/range',
    '/dsh-agent-toolkit/api/usage/range?from=2026-08-17&to=2026-08-17')
  const body = JSON.parse(res.body)
  expect(body.hours).toHaveLength(24)
})

test('range：days 与 from/to 互斥、倒置区间、超上限均 400', async () => {
  const { ctx, registered } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  for (const url of [
    '/dsh-agent-toolkit/api/usage/range?days=7&from=2026-08-01&to=2026-08-03',
    '/dsh-agent-toolkit/api/usage/range?from=2026-08-18&to=2026-08-01',
    '/dsh-agent-toolkit/api/usage/range?from=2025-08-17&to=2026-08-18',
    '/dsh-agent-toolkit/api/usage/range?from=2026-8-1&to=2026-08-03',
  ]) {
    const res = await callRoute(registered, '/dsh-agent-toolkit/api/usage/range', url)
    expect(res.status).toBe(400)
  }
})

test('range：days 参数保持兼容', async () => {
  const { ctx, registered } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  const res = await callRoute(registered, '/dsh-agent-toolkit/api/usage/range',
    '/dsh-agent-toolkit/api/usage/range?days=7')
  expect(res.status).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.days).toHaveLength(7)
})
```

（`emptyDaily`/`DailyRecord` import 从 `aggregate.ts`/`store.ts` 引入。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test -- routes`
Expected: FAIL（handler 仍按旧 days-only 逻辑；from/to URL 走 parseDaysParam(null)=91 的默认分支，断言不符）

- [ ] **Step 3: 重写 range handler**

`usage/index.ts`：

```ts
// import 行改为：
import { addSample, dayParts, emptyDaily, sampleFromEvent } from './aggregate.ts'
import { aggregateRange, datesBetween, parseRangeParams, rangeSummaries } from './heatmap.ts'

// range 路由 handler 整体替换为：
handler: async (req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405).end()
    return
  }
  const params = new URL(req.url ?? '', 'http://127.0.0.1').searchParams
  const today = dayParts(Date.now(), config.timezone).date
  const range = parseRangeParams({ days: params.get('days'), from: params.get('from'), to: params.get('to') }, today)
  if (range === null) {
    res.writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify({ error: 'bad range, want days=1..366 or from/to=YYYY-MM-DD within 366 days' }))
    return
  }
  const table = await domainReady.then(() => daily!)
  const records = datesBetween(range.from, range.to)
    .map((d) => table.get(d))
    .filter((r): r is DailyRecord => r !== undefined)
  const single = range.from === range.to
  res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({
      today,
      from: range.from,
      to: range.to,
      days: rangeSummaries((d) => table.get(d), range.from, range.to),
      aggregate: aggregateRange(records),
      ...(single ? { hours: (table.get(range.from) ?? emptyDaily(range.from)).hours } : {}),
    }))
},
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test`（全量，确认无回归）
Run: `pnpm --filter @dsh-agent-toolkit/token-usage typecheck`
Expected: 全 PASS；typecheck 无错

- [ ] **Step 5: Commit**

```bash
git add packages/usage/src/usage/index.ts packages/usage/src/usage/routes.test.ts
git commit -m "feat(usage): range 端点支持 from/to、聚合块与单日 hours"
```

---

### Task 3: DailyBarChart 收窄 + 新增 RangeBarChart

**Files:**
- Modify: `packages/usage/src/client/usage/DailyBarChart.tsx`（props `record` → `hours`）
- Modify: `packages/usage/src/client/usage/daily-bar-chart.client.spec.tsx`
- Create: `packages/usage/src/client/usage/RangeBarChart.tsx`
- Test: `packages/usage/src/client/usage/range-bar-chart.client.spec.tsx`

**Interfaces:**
- Consumes: `HeatmapDay`（Task 1）；`cacheSplit`/`formatTokens`；recharts 与 `chart.module.css`（现有）。
- Produces:
  - `DailyBarChart({ hours: Bucket[] })`（**props 变更**；Task 4 消费）
  - `RangeBarChart({ days: HeatmapDay[] })`（Task 4 消费）

- [ ] **Step 1: 改 DailyBarChart props 并更新其测试**

`DailyBarChart.tsx` 改动：

```tsx
/** 单日 24 小时堆叠柱状图：下段「新增」+ 上段「缓存」，shadcn 风格（极简轴、圆角柱、自定义 tooltip）。 */
import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatTokens } from '../../usage/aggregate.ts'
import { cacheSplit } from '../../usage/heatmap.ts'
import type { Bucket } from '../../usage/store.ts'
import css from './chart.module.css'

// HourRow / ChartTooltip 保持不变

export function DailyBarChart({ hours }: { hours: Bucket[] }): ReactNode {
  const data: HourRow[] = hours.map((b, hour) => ({ hour, ...cacheSplit(b), calls: b.calls }))
  // 其余 JSX 不变
}
```

`daily-bar-chart.client.spec.tsx` 两处调用改为 `render(<DailyBarChart hours={record.hours} />)` / `render(<DailyBarChart hours={emptyDaily('2026-08-18').hours} />)`。

- [ ] **Step 2: 写 RangeBarChart 失败测试**

`range-bar-chart.client.spec.tsx`：

```tsx
// @vitest-environment jsdom
import { cloneElement, type ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('./chart.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children, { width: 600, height: 160 }),
  }
})

import { RangeBarChart } from './RangeBarChart.tsx'

afterEach(cleanup)

const DAYS = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-08-1${i + 2}`, billed: 0, calls: i, fresh: 100 * i, cached: 10 * i,
}))

test('渲染 SVG 图表与新增/缓存图例，X 轴为 MM-DD', () => {
  const { container } = render(<RangeBarChart days={DAYS} />)
  expect(container.querySelector('svg')).not.toBeNull()
  expect(screen.getByText('新增')).toBeTruthy()
  expect(screen.getByText('缓存')).toBeTruthy()
  expect(screen.getByText('08-12')).toBeTruthy()
})

test('全零范围也渲染（空柱不崩）', () => {
  const zero = DAYS.map((d) => ({ ...d, fresh: 0, cached: 0, calls: 0 }))
  const { container } = render(<RangeBarChart days={zero} />)
  expect(container.querySelector('svg')).not.toBeNull()
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test -- bar-chart`
Expected: RangeBarChart 测试 FAIL（模块不存在）；daily 测试 PASS

- [ ] **Step 4: 实现 RangeBarChart**

`RangeBarChart.tsx`：

```tsx
/** 日期范围按天堆叠柱状图：每天一根柱，下段「新增」+ 上段「缓存」，X 轴 MM-DD 稀疏刻度。 */
import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatTokens } from '../../usage/aggregate.ts'
import type { HeatmapDay } from '../../usage/heatmap.ts'
import css from './chart.module.css'

interface DayRow { date: string; label: string; fresh: number; cached: number; calls: number }

interface ChartTooltipProps { active?: boolean; payload?: { payload: DayRow }[] }

function ChartTooltip({ active, payload }: ChartTooltipProps): ReactNode {
  if (!active || payload === undefined || payload.length === 0) return null
  const row = payload[0].payload
  return (
    <div className={css.tooltip}>
      <div className={css.tooltipTitle}>{row.date}</div>
      <div>新增 {formatTokens(row.fresh)}</div>
      <div>缓存 {formatTokens(row.cached)}</div>
      <div className={css.tooltipTotal}>合计 {formatTokens(row.fresh + row.cached)} · {row.calls} 次</div>
    </div>
  )
}

export function RangeBarChart({ days }: { days: HeatmapDay[] }): ReactNode {
  const data: DayRow[] = days.map((d) => ({
    date: d.date, label: d.date.slice(5), fresh: d.fresh, cached: d.cached, calls: d.calls,
  }))
  return (
    <div className={css.chartTheme}>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--chart-label)" strokeOpacity={0.2} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={24}
            fontSize={11}
            stroke="var(--chart-label)"
          />
          <YAxis hide />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--dsw-alias-interactive-bg-hover)' }} />
          <Bar dataKey="fresh" stackId="t" fill="var(--chart-1)" />
          <Bar dataKey="cached" stackId="t" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <div className={css.legend}>
        <span><i className={css.swatchFresh} />新增</span>
        <span><i className={css.swatchCached} />缓存</span>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test -- bar-chart`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/usage/src/client/usage/DailyBarChart.tsx packages/usage/src/client/usage/daily-bar-chart.client.spec.tsx packages/usage/src/client/usage/RangeBarChart.tsx packages/usage/src/client/usage/range-bar-chart.client.spec.tsx
git commit -m "feat(usage): DailyBarChart 收窄为 hours props，新增按天 RangeBarChart"
```

---

### Task 4: UsageModal 重构——「趋势」tab 范围查询

**Files:**
- Modify: `packages/usage/src/client/usage/UsageModal.tsx`（整体重写 body）
- Modify: `packages/usage/src/client/usage/UsageModal.module.css`（pager 样式删除，新增范围选择器样式）
- Test: `packages/usage/src/client/usage/usage-modal.client.spec.tsx`

**Interfaces:**
- Consumes: Task 2 响应形状 `{ today, from, to, days, aggregate, hours? }`；Task 3 的 `DailyBarChart({ hours })` 与 `RangeBarChart({ days })`；`RangeAggregate`/`HeatmapDay` 类型。
- Produces:
  - `UsageModal({ open, onClose, initialDate })`——`initialDate` 语义：非 null = 打开「趋势」tab 且范围为该单日。
  - tab 顺序「活动 | 趋势」；「趋势」tab 内部状态形状 `preset: 7 | 30 | 90 | 'custom'` + `custom: { from, to } | null`（Task 5 热力图点击复用同一跳转路径）。

- [ ] **Step 1: 重写 usage-modal.client.spec.tsx（失败测试）**

整体替换为：

```tsx
// @vitest-environment jsdom
import { cloneElement, type ReactElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('./UsageModal.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('./ActivityHeatmap.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('./chart.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children, { width: 600, height: 160 }),
  }
})

import { shiftDate } from '../../usage/aggregate.ts'
import { UsageModal } from './UsageModal.tsx'

const TODAY = '2026-08-18'

const HEATMAP_PAYLOAD = {
  today: TODAY,
  from: shiftDate(TODAY, -90),
  to: TODAY,
  days: Array.from({ length: 91 }, (_, i) => ({
    date: shiftDate(TODAY, i - 90), billed: i === 90 ? 14500 : 0, calls: i === 90 ? 1 : 0, fresh: 0, cached: 0,
  })),
  aggregate: {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 },
    byModel: {}, byProject: {},
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 },
  },
}

const SINGLE_DAY_PAYLOAD = {
  today: TODAY,
  from: TODAY,
  to: TODAY,
  days: [{ date: TODAY, billed: 70500, calls: 1, fresh: 14500, cached: 56000 }],
  aggregate: {
    totals: { input: 14000, output: 500, cacheRead: 56000, cacheWrite: 0, estimated: 0, calls: 1, estimatedCalls: 0 },
    byModel: { 'deepseek/deepseek-chat': { input: 14000, output: 500, cacheRead: 56000, cacheWrite: 0, estimated: 0, calls: 1 } },
    byProject: {},
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 },
  },
  hours: Array.from({ length: 24 }, () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 })),
}

const MULTI_DAY_PAYLOAD = {
  today: TODAY,
  from: '2026-08-12',
  to: TODAY,
  days: Array.from({ length: 7 }, (_, i) => ({
    date: shiftDate(TODAY, i - 6), billed: 100, calls: 1, fresh: 80, cached: 20,
  })),
  aggregate: {
    totals: { input: 560, output: 0, cacheRead: 140, cacheWrite: 0, estimated: 0, calls: 7, estimatedCalls: 0 },
    byModel: {}, byProject: {},
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 },
  },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.includes('days=91') ? HEATMAP_PAYLOAD
      : url.includes(`from=${TODAY}&to=${TODAY}`) ? SINGLE_DAY_PAYLOAD
      : MULTI_DAY_PAYLOAD
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('initialDate 为 null 时默认打开活动 tab', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  expect(await screen.findByText('近 13 周活动')).toBeTruthy()
  expect(screen.getByRole('tab', { name: '活动' }).getAttribute('aria-selected')).toBe('true')
})

test('initialDate 非 null 时打开趋势 tab 且按单日拉取（from=to）', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  expect(await screen.findByText('按模型')).toBeTruthy()
  expect(screen.getByRole('tab', { name: '趋势' }).getAttribute('aria-selected')).toBe('true')
  expect(vi.mocked(fetch)).toHaveBeenCalledWith(`/dsh-agent-toolkit/api/usage/range?from=${TODAY}&to=${TODAY}`)
})

test('切到趋势 tab 默认近 30 天（days=30），渲染按天柱状图', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  await screen.findByText('近 13 周活动')
  fireEvent.click(screen.getByRole('tab', { name: '趋势' }))
  expect(await screen.findByText('范围总量', { exact: false })).toBeTruthy()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/dsh-agent-toolkit/api/usage/range?days=30')
})

test('单日范围显示「当日总量」与缓存命中率（56000/(14000+56000)=80%）', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  expect(await screen.findByText(/当日总量/)).toBeTruthy()
  expect(await screen.findByText(/缓存命中率 80%/)).toBeTruthy()
})

test('多日范围显示聚合 breakdown（按模型/按项目）', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  await screen.findByText('近 13 周活动')
  fireEvent.click(screen.getByRole('tab', { name: '趋势' }))
  expect(await screen.findByText('按模型')).toBeTruthy()
  expect(screen.getByText('按项目')).toBeTruthy()
})

test('自定义起止日期倒置时不发请求并提示', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  await screen.findByText('按模型')
  const calls = vi.mocked(fetch).mock.calls.length
  const [fromInput, toInput] = screen.getAllByLabelText(/起始日期|截止日期/)
  fireEvent.change(fromInput, { target: { value: '2026-08-18' } })
  fireEvent.change(toInput, { target: { value: '2026-08-01' } })
  expect(await screen.findByText(/起始日期不能晚于截止日期/)).toBeTruthy()
  expect(vi.mocked(fetch).mock.calls.length).toBe(calls)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test -- usage-modal`
Expected: FAIL（tab「趋势」不存在等）

- [ ] **Step 3: 重写 UsageModal.tsx**

```tsx
/** Token 用量模态框：活动热力图（近 13 周）与趋势范围查询双 tab；趋势 tab 单日按小时、多日按天。 */
import { useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { billedOf, formatTokens } from '../../usage/aggregate.ts'
import { cacheHitRate, type HeatmapDay, type RangeAggregate } from '../../usage/heatmap.ts'
import type { Bucket } from '../../usage/store.ts'
import { useLoadState } from '../shared/load-state.ts'
import { ActivityHeatmap } from './ActivityHeatmap.tsx'
import { DailyBarChart } from './DailyBarChart.tsx'
import { RangeBarChart } from './RangeBarChart.tsx'
import css from './UsageModal.module.css'

export interface UsageModalProps {
  open: boolean
  onClose: () => void
  /** 初始日期 YYYY-MM-DD；非 null = 默认打开趋势 tab 并定位到该单日；缺省/null = 默认活动 tab。 */
  initialDate?: string | null
}

type Tab = 'activity' | 'trend'
type Preset = 7 | 30 | 90

interface HeatmapPayload { today: string; days: HeatmapDay[] }
interface RangePayload {
  today: string
  from: string
  to: string
  days: HeatmapDay[]
  aggregate: RangeAggregate
  /** 仅 from === to 时携带：24 小时桶。 */
  hours?: Bucket[]
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as T
}

const PENDING = new Promise<never>(() => {})
const DAY_MS = 86_400_000

function Breakdown({ title, rows }: { title: string; rows: [string, Bucket][] }) {
  if (rows.length === 0) return null
  return (
    <section>
      <h3 className={css.sectionTitle}>{title}</h3>
      {rows.map(([name, b]) => (
        <div key={name} className={css.row}>
          <span className={css.rowName}>{name}</span>
          <span>{formatTokens(billedOf(b))}</span>
          <span className={css.rowCalls}>{b.calls} 次</span>
        </div>
      ))}
    </section>
  )
}

export function UsageModal({ open, onClose, initialDate }: UsageModalProps): ReactNode {
  return (
    <Modal open={open} onClose={onClose} title="Token 用量" closeLabel="关闭" className={css.dialog}>
      {open && <UsageModalBody initialDate={initialDate ?? null} />}
    </Modal>
  )
}

function UsageModalBody({ initialDate }: { initialDate: string | null }): ReactNode {
  const [tab, setTab] = useState<Tab>(initialDate === null ? 'activity' : 'trend')
  const [preset, setPreset] = useState<Preset | 'custom'>(initialDate === null ? 30 : 'custom')
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(
    initialDate === null ? null : { from: initialDate, to: initialDate })

  const heatmap = useLoadState<HeatmapPayload>(
    () => fetchJson<HeatmapPayload>('/dsh-agent-toolkit/api/usage/range?days=91'),
    [])

  /** 自定义区间非法（倒置/超 366 天）时不发请求，内联提示。 */
  const customInvalid = custom !== null
    && (custom.from > custom.to
      || (Date.parse(`${custom.to}T12:00:00Z`) - Date.parse(`${custom.from}T12:00:00Z`)) / DAY_MS + 1 > 366)
  const query = preset === 'custom'
    ? (custom === null || customInvalid ? null : `from=${custom.from}&to=${custom.to}`)
    : `days=${preset}`
  const range = useLoadState<RangePayload>(() => {
    if (query === null) return PENDING
    return fetchJson<RangePayload>(`/dsh-agent-toolkit/api/usage/range?${query}`)
  }, [query])

  const payload = range.state.kind === 'ok' ? range.state.data : undefined
  const singleDay = payload !== undefined && payload.from === payload.to && payload.hours !== undefined
  const hit = payload === undefined ? null : cacheHitRate(payload.aggregate.totals)

  /** 热力图点击某天：跳趋势 tab 并定位该单日。 */
  const selectDay = (date: string) => {
    setPreset('custom')
    setCustom({ from: date, to: date })
    setTab('trend')
  }

  return (
    <>
      <div className={css.tabs} role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'activity'}
          className={tab === 'activity' ? `${css.tab} ${css.tabActive}` : css.tab}
          onClick={() => { setTab('activity') }}>活动</button>
        <button type="button" role="tab" aria-selected={tab === 'trend'}
          className={tab === 'trend' ? `${css.tab} ${css.tabActive}` : css.tab}
          onClick={() => { setTab('trend') }}>趋势</button>
      </div>
      {tab === 'activity' ? (
        <>
          {heatmap.state.kind === 'loading' && <p>加载中…</p>}
          {heatmap.state.kind === 'error' && <p>加载失败，请重试</p>}
          {heatmap.state.kind === 'ok' && (
            <>
              <h3 className={css.sectionTitle}>近 13 周活动</h3>
              <ActivityHeatmap today={heatmap.state.data.today} days={heatmap.state.data.days} onSelectDay={selectDay} />
            </>
          )}
        </>
      ) : (
        <>
          <div className={css.rangeBar}>
            {([7, 30, 90] as const).map((n) => (
              <button key={n} type="button"
                className={preset === n ? `${css.preset} ${css.presetActive}` : css.preset}
                onClick={() => { setPreset(n) }}>近 {n} 天</button>
            ))}
            <input type="date" aria-label="起始日期" className={css.dateInput}
              value={preset === 'custom' ? custom?.from ?? '' : ''}
              onChange={(e) => {
                const from = e.target.value
                setPreset('custom')
                setCustom((c) => ({ from, to: c?.to ?? from }))
              }} />
            <span className={css.rangeSep}>至</span>
            <input type="date" aria-label="截止日期" className={css.dateInput}
              value={preset === 'custom' ? custom?.to ?? '' : ''}
              onChange={(e) => {
                const to = e.target.value
                setPreset('custom')
                setCustom((c) => ({ from: c?.from ?? to, to }))
              }} />
          </div>
          {customInvalid && <p className={css.rangeError}>起始日期不能晚于截止日期，且跨度不超过 366 天</p>}
          {range.state.kind === 'loading' && !customInvalid && <p>加载中…</p>}
          {range.state.kind === 'error' && <p>加载失败，请重试</p>}
          {payload !== undefined && (
            <>
              {singleDay ? <DailyBarChart hours={payload.hours!} /> : <RangeBarChart days={payload.days} />}
              <p className={css.total}>
                {singleDay ? '当日总量' : '范围总量'} {formatTokens(billedOf(payload.aggregate.totals))} · {payload.aggregate.totals.calls} 次调用
                {payload.aggregate.totals.estimated > 0 && `（含估算 ${formatTokens(payload.aggregate.totals.estimated)}）`}
                {hit !== null && `（缓存命中率 ${Math.round(hit * 100)}%）`}
                {payload.aggregate.totals.calls === 0 && ' · 无用量'}
              </p>
              <Breakdown title="按模型" rows={Object.entries(payload.aggregate.byModel).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
              <Breakdown title="按项目" rows={Object.entries(payload.aggregate.byProject).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
              {payload.aggregate.compaction.calls > 0 && (
                <p className={css.compaction}>上下文压缩 {formatTokens(billedOf(payload.aggregate.compaction))} · {payload.aggregate.compaction.calls} 次</p>
              )}
            </>
          )}
        </>
      )}
    </>
  )
}
```

- [ ] **Step 4: 更新 UsageModal.module.css**

删除 `.pager`/`.pagerButton`/`.dateLabel`（翻页器移除），追加：

```css
/* 趋势 tab 范围选择器：预设分段按钮 + 原生日期输入。 */
.rangeBar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.preset {
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
}
.preset:hover { background: var(--dsw-alias-interactive-bg-hover); }
.presetActive { background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); }
.presetActive:hover { background: var(--dsw-alias-bg-overlay); }
.dateInput {
  height: 26px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 12px;
  color-scheme: light dark; /* 原生日期图标跟随宿主深浅色 */
}
.rangeSep { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.rangeError { margin: 4px 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
```

（`--dsw-alias-border-l1` 与 `--dsw-alias-state-error-primary` 均为宿主 ui-theme 深浅色双定义的既有令牌，见 `deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css`。）

- [ ] **Step 5: 跑测试确认通过**

注意 ActivityHeatmap 此刻还没有 `onSelectDay` prop（Task 5 才加），本步先在 `ActivityHeatmap.tsx` 的 props 接口加 `onSelectDay: (date: string) => void` 并给格子临时接上 `onClick`（格子仍是 div 即可，Task 5 做完整美化）——否则 Task 4 typecheck 不过。

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test -- usage-modal`
Expected: PASS
Run: `pnpm --filter @dsh-agent-toolkit/token-usage typecheck`
Expected: 无错（若 entry/其他文件因 daily 端点停用残留引用报错，一并清理）

- [ ] **Step 6: Commit**

```bash
git add packages/usage/src/client/usage/UsageModal.tsx packages/usage/src/client/usage/UsageModal.module.css packages/usage/src/client/usage/usage-modal.client.spec.tsx packages/usage/src/client/usage/ActivityHeatmap.tsx
git commit -m "feat(usage): 模态框「单日」tab 升级为「趋势」范围查询（单日按小时/多日按天 + 聚合明细）"
```

---

### Task 5: ActivityHeatmap 美化 + 点击跳单日

**Files:**
- Modify: `packages/usage/src/client/usage/ActivityHeatmap.tsx`
- Modify: `packages/usage/src/client/usage/ActivityHeatmap.module.css`
- Test: `packages/usage/src/client/usage/activity-heatmap.client.spec.tsx`

**Interfaces:**
- Consumes: `heatmapGrid`/`HeatmapCell`/`formatTokens`（不变）。
- Produces: `ActivityHeatmap({ today, days, onSelectDay }: { today: string; days: HeatmapDay[]; onSelectDay: (date: string) => void })`——`onSelectDay` 已在 Task 4 接线。

- [ ] **Step 1: 重写 activity-heatmap.client.spec.tsx（失败测试）**

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('./ActivityHeatmap.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('./chart.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

import { shiftDate } from '../../usage/aggregate.ts'
import { ActivityHeatmap } from './ActivityHeatmap.tsx'

const TODAY = '2026-08-18'
const DAYS = Array.from({ length: 91 }, (_, i) => ({
  date: shiftDate(TODAY, i - 90), billed: i === 90 ? 14500 : 0, calls: i === 90 ? 2 : 0, fresh: 0, cached: 0,
}))

afterEach(cleanup)

test('渲染 91 个格子按钮，未来格禁用且无点击', () => {
  const onSelectDay = vi.fn()
  const { container } = render(<ActivityHeatmap today={TODAY} days={DAYS} onSelectDay={onSelectDay} />)
  const cells = container.querySelectorAll('.week > button')
  expect(cells).toHaveLength(91)
  expect(container.querySelectorAll('.week > button:disabled')).toHaveLength(4)
})

test('点击非未来格回调该日期；未来格不可点', () => {
  const onSelectDay = vi.fn()
  const { container } = render(<ActivityHeatmap today={TODAY} days={DAYS} onSelectDay={onSelectDay} />)
  const todayCell = Array.from(container.querySelectorAll('.week > button'))
    .find((c) => c.getAttribute('data-date') === TODAY)!
  fireEvent.click(todayCell)
  expect(onSelectDay).toHaveBeenCalledWith(TODAY)
})

test('悬停格子显示自定义 tooltip 卡片（日期 + 用量 + 次数）', () => {
  const { container, getByText } = render(<ActivityHeatmap today={TODAY} days={DAYS} onSelectDay={() => {}} />)
  const todayCell = Array.from(container.querySelectorAll('.week > button'))
    .find((c) => c.getAttribute('data-date') === TODAY)!
  fireEvent.mouseEnter(todayCell)
  expect(getByText(TODAY)).toBeTruthy()
  expect(getByText(/14\.5K/)).toBeTruthy()
  expect(getByText(/2 次/)).toBeTruthy()
})

test('星期标签（一/三/五）与少多图例', () => {
  const { getByText } = render(<ActivityHeatmap today={TODAY} days={DAYS} onSelectDay={() => {}} />)
  expect(getByText('一')).toBeTruthy()
  expect(getByText('三')).toBeTruthy()
  expect(getByText('五')).toBeTruthy()
  expect(getByText('少')).toBeTruthy()
  expect(getByText('多')).toBeTruthy()
})

test('跨月列渲染月份标签', () => {
  const { container } = render(<ActivityHeatmap today={TODAY} days={DAYS} onSelectDay={() => {}} />)
  const labels = Array.from(container.querySelectorAll('span')).map((s) => s.textContent)
  expect(labels).toContain('6月')
  expect(labels).toContain('7月')
  expect(labels).toContain('8月')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test -- activity-heatmap`
Expected: FAIL（格子还是 div、无 onSelectDay 行为、无星期/图例）

- [ ] **Step 3: 重写 ActivityHeatmap.tsx**

```tsx
/** 13 周活动热力图：7 行（周日在上）× 13 列；格子按钮可点击跳单日，悬停显示自定义 tooltip 卡片。 */
import { useState, type ReactNode } from 'react'
import { formatTokens } from '../../usage/aggregate.ts'
import { heatmapGrid, type HeatmapDay } from '../../usage/heatmap.ts'
import theme from './chart.module.css'
import css from './ActivityHeatmap.module.css'

export interface ActivityHeatmapProps {
  today: string
  days: HeatmapDay[]
  /** 点击非未来格回调该日期（模态框跳趋势 tab 单日视图）。 */
  onSelectDay: (date: string) => void
}

/** 行索引（周日=0）→ 星期标签；只标一/三/五行。 */
const WEEKDAYS: Record<number, string> = { 1: '一', 3: '三', 5: '五' }

export function ActivityHeatmap({ today, days, onSelectDay }: ActivityHeatmapProps): ReactNode {
  const columns = heatmapGrid(today, days)
  const [hover, setHover] = useState<string | null>(null)
  return (
    <div className={theme.chartTheme}>
      <div className={css.body}>
        <div className={css.weekdays}>
          {Array.from({ length: 7 }, (_, r) => <span key={r}>{WEEKDAYS[r] ?? ''}</span>)}
        </div>
        <div className={css.main}>
          <div className={css.months}>
            {columns.map((col, c) => {
              const first = col.find((cell) => cell.date.endsWith('-01'))
              return <span key={c}>{first === undefined ? '' : `${Number(first.date.slice(5, 7))}月`}</span>
            })}
          </div>
          <div className={css.grid}>
            {columns.map((col, c) => (
              <div key={c} className={css.week}>
                {col.map((cell) => (
                  <span key={cell.date} className={css.cellWrap}>
                    <button
                      type="button"
                      data-date={cell.date}
                      className={css[`level${cell.level}`]}
                      disabled={cell.future}
                      aria-label={cell.future ? undefined : `${cell.date} 用量`}
                      onClick={() => { onSelectDay(cell.date) }}
                      onMouseEnter={() => { if (!cell.future) setHover(cell.date) }}
                      onMouseLeave={() => { setHover(null) }}
                      onFocus={() => { if (!cell.future) setHover(cell.date) }}
                      onBlur={() => { setHover(null) }}
                    />
                    {hover === cell.date && (
                      <span className={css.tip} role="tooltip">
                        <span className={css.tipDate}>{cell.date}</span>
                        <span>{formatTokens(cell.day?.billed ?? 0)} · {cell.day?.calls ?? 0} 次</span>
                      </span>
                    )}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div className={css.scale}>
            <span>少</span>
            {[0, 1, 2, 3, 4].map((n) => <i key={n} className={css[`level${n}`]} />)}
            <span>多</span>
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 重写 ActivityHeatmap.module.css**

```css
/* GitHub/Codex 式周列日行格子；档位色 = --chart-1 单色渐进（shadcn 惯例）。
   格子可点击跳单日；悬停/聚焦显示自定义 tooltip 卡片。 */
.body { display: flex; gap: 4px; }
.weekdays {
  display: grid;
  grid-template-rows: repeat(7, 1fr);
  gap: 3px;
  margin-top: 20px; /* 与月份标签行对齐 */
  font-size: 10px;
  line-height: 1;
  color: var(--dsw-alias-label-tertiary);
}
.main { flex: 1; min-width: 0; }
.months {
  display: grid;
  grid-template-columns: repeat(13, 1fr);
  gap: 3px;
  margin-bottom: 4px;
  height: 16px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.grid { display: grid; grid-template-columns: repeat(13, 1fr); gap: 3px; }
.week { display: grid; grid-template-rows: repeat(7, 1fr); gap: 3px; }
.cellWrap { position: relative; display: block; }
.week button {
  display: block;
  aspect-ratio: 1 / 1;
  width: 100%;
  padding: 0;
  border: none;
  border-radius: 3px;
  cursor: pointer;
}
.week button:hover:not(:disabled), .week button:focus-visible {
  outline: 2px solid var(--chart-1);
  outline-offset: 1px;
}
.week button:disabled { opacity: 0.35; cursor: default; }
.level0 { background: var(--chart-empty); }
.level1 { background: color-mix(in srgb, var(--chart-1) 25%, transparent); }
.level2 { background: color-mix(in srgb, var(--chart-1) 50%, transparent); }
.level3 { background: color-mix(in srgb, var(--chart-1) 75%, transparent); }
.level4 { background: var(--chart-1); }
.tip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  flex-direction: column;
  white-space: nowrap;
  background: var(--dsw-alias-bg-overlay);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  pointer-events: none;
}
.tipDate { color: var(--dsw-alias-label-secondary); }
.scale {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  margin-top: 6px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.scale i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test`（全量：modal/entry 里旧 heatmap 断言同步检查）
Expected: PASS（usage-modal spec 里 `findByText('近 13 周活动')` 不受影响；若有旧 title tooltip 断言残留则删除）

- [ ] **Step 6: Commit**

```bash
git add packages/usage/src/client/usage/ActivityHeatmap.tsx packages/usage/src/client/usage/ActivityHeatmap.module.css packages/usage/src/client/usage/activity-heatmap.client.spec.tsx
git commit -m "feat(usage): 热力图美化——圆角格子、悬停 tooltip 卡片、星期标签、色阶图例、点击跳单日"
```

---

### Task 6: 入口迁移到会话标题栏 utilities 区

**Files:**
- Modify: `packages/usage/src/client/usage/entry.tsx`（重写）
- Modify: `packages/usage/src/client/usage/index.ts`（注册到 utilities）
- Modify: `packages/usage/src/client/index.ts`（注释/文案）
- Create: `packages/usage/src/client/usage/entry.module.css`
- Delete: `packages/usage/src/client/shared/entry.tsx`、`packages/usage/src/client/shared/entry.module.css`、`packages/usage/src/client/shared/entry.spec.tsx`
- Test: `packages/usage/src/client/usage/usage-entry.client.spec.tsx`（重写）、`packages/usage/src/client/usage/duplicate-guard.spec.ts`（改槽名）、`packages/toolkit/src/client/duplicate-guard.spec.ts`（改槽名）

**Interfaces:**
- Consumes: `UsageModal`（Task 4 后签名不变）；宿主 slot `conversation.session.header.utilities`（list/session，additive）。
- Produces: `UsageEntry(props: PropsRuntime<'conversation.session.header.utilities'>)`（不消费任何 prop）；注册 id 保持 `dsh-agent-toolkit:usage`，order 100。

- [ ] **Step 1: 重写 usage-entry.client.spec.tsx（失败测试）**

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { shiftDate } from '../../usage/aggregate.ts'
import { UsageEntry } from './entry.tsx'

const TODAY = '2026-08-18'

// utilities 槽组件不消费任何 prop（owner props 为空 marker，standard props 用不上），空对象强转即可。
const PROPS = {} as unknown as PropsRuntime<'conversation.session.header.utilities'>

const HEATMAP_PAYLOAD = {
  today: TODAY,
  from: shiftDate(TODAY, -90),
  to: TODAY,
  days: Array.from({ length: 91 }, (_, i) => ({
    date: shiftDate(TODAY, i - 90), billed: 0, calls: 0, fresh: 0, cached: 0,
  })),
  aggregate: {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 },
    byModel: {}, byProject: {},
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 },
  },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(HEATMAP_PAYLOAD), {
    status: 200, headers: { 'content-type': 'application/json' },
  })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('入口为仅图标按钮（aria-label 提供可访问名）', () => {
  render(<UsageEntry {...PROPS} />)
  const button = screen.getByRole('button', { name: 'Token 用量' })
  expect(button.textContent).not.toContain('Token 用量')
})

test('点击打开用量模态框，默认进入活动视图并拉取 91 天范围数据', async () => {
  render(<UsageEntry {...PROPS} />)
  screen.getByRole('button', { name: 'Token 用量' }).click()
  expect(await screen.findByText('近 13 周活动')).toBeTruthy()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/dsh-agent-toolkit/api/usage/range?days=91')
})
```

同时更新 `duplicate-guard.spec.ts`（usage 包）与 `packages/toolkit/src/client/duplicate-guard.spec.ts` 中的错误文案槽名：

```ts
throw new Error('list slot "conversation.session.header.utilities" already has an entry with id "dsh-agent-toolkit:usage"')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test -- usage-entry`
Expected: FAIL（UsageEntry 还需要 `wide` prop / 结构不符）

- [ ] **Step 3: 重写 entry.tsx 并新建 entry.module.css**

`entry.tsx`：

```tsx
/** usage 会话标题栏入口：utilities 区图标按钮（Tooltip「Token 用量」），点击打开用量模态框。 */
import { useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 触发 ui-conversation 对 SlotMap 的声明合并（conversation.session.header.utilities 键）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconDataOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { UsageModal } from './UsageModal.tsx'
import css from './entry.module.css'

export function UsageEntry(_props: PropsRuntime<'conversation.session.header.utilities'>): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip label="Token 用量" delayMs={500}>
        <button type="button" className={css.trigger} aria-label="Token 用量" onClick={() => { setOpen(true) }}>
          <IconDataOutline16 size={18} />
        </button>
      </Tooltip>
      <UsageModal open={open} onClose={() => { setOpen(false) }} />
    </>
  )
}
```

`entry.module.css`：

```css
/* 会话标题栏 utilities 图标按钮：28px 方、悬停底色（与宿主 header action 观感一致）。 */
.trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
}
.trigger:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
```

- [ ] **Step 4: 更新注册与守卫文案，删除 shared 工厂**

`packages/usage/src/client/usage/index.ts`：

```ts
/** dsh-agent-toolkit usage 浏览器半：注册会话标题栏 utilities 入口。 */
import type { Context } from '@deepseek-ai/cordis'
// 触发 ui-conversation 对 SlotMap 的声明合并（conversation.session.header.utilities 键）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// 触发 ui-renderer 对 Context.slots 的声明合并（0.1.5 起由 client-runtime 迁入）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UsageEntry } from './entry.tsx'

export function setupUsageClient(ctx: Context): void {
  // inject() 等 slot 被 ui-conversation 声明后再注册，声明消失自动回滚。
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.utilities', id: 'dsh-agent-toolkit:usage', order: 100 },
      UsageEntry,
    ))
}
```

`packages/usage/src/client/index.ts` 注释与 warn 文案中的「侧边栏」改为「会话标题栏」。

删除三个 shared 文件：

```bash
git rm packages/usage/src/client/shared/entry.tsx packages/usage/src/client/shared/entry.module.css packages/usage/src/client/shared/entry.spec.tsx
```

（删除前确认 `packages/usage/src/client/shared/` 只剩 `load-state.ts` 且无其他文件引用 `createSidebarEntry`：`grep -r createSidebarEntry packages/` 应无结果。）

- [ ] **Step 5: 检查 @deepseek-ai/dsh-client-ui-conversation 依赖声明**

`entry.tsx`/`index.ts` 新增的 `import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'` 需要该包在 `packages/usage/package.json` 的 devDependencies 里可解析（type-only，不进 dependencies）。检查：

Run: `grep -n "ui-conversation" packages/usage/package.json`
若无，参照既有 `@deepseek-ai/dsh-client-ui-sidebar` 的声明方式补一条 devDependency（link 到 deepseek-harness 源码路径，与邻居一致），然后 `pnpm install`。

- [ ] **Step 6: 全量测试 + typecheck + Commit**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test`
Run: `pnpm --filter @dsh-agent-toolkit/token-usage typecheck`
Expected: 全 PASS、无错

```bash
git add packages/usage/src/client packages/toolkit/src/client/duplicate-guard.spec.ts packages/usage/package.json pnpm-lock.yaml
git commit -m "feat(usage): 入口迁移到会话标题栏 utilities 区，移除侧栏底栏入口"
```

---

### Task 7: 文档同步 + 全量验证

**Files:**
- Modify: `packages/usage/README.md:7`（入口描述）
- Modify: `packages/usage/src/index.ts:1`（头注释「侧边栏面板」→「会话标题栏面板」）
- Modify: `docs/usage/README.md:11,16,18`（入口表格行 + 收编注记）
- Modify: `docs/usage/token-usage.md:28` 起（模态框两 tab 描述改写：活动热力图可点击跳单日；趋势 tab 范围选择 + 单日按小时/多日按天 + 聚合明细）
- Modify: `AGENTS.md`（「usage（token 用量）底栏入口保留不动」一句改为「usage 入口在会话标题栏右上角」）

**Interfaces:**
- Consumes: Task 1-6 全部产物。
- Produces: 无代码接口。

- [ ] **Step 1: 同步四处文档**

- `packages/usage/README.md:7`：改为「13 周活动热力图（点击跳单日）+ 趋势范围查询（单日按小时/多日按天堆叠图，按模型/按项目/压缩聚合），会话标题栏右上角「Token 用量」打开」。
- `packages/usage/src/index.ts:1` 头注释：「侧边栏面板」→「会话标题栏面板」。
- `docs/usage/README.md`：表格 Token 用量行入口改为「会话标题栏右上角「Token 用量」+ `/token-usage` 命令」；2026-09-17 收编注记末句「仅 Token 用量底栏入口保留」改为「Token 用量入口已迁至会话标题栏右上角（2026-09-20）」；截图待补拍清单追加「Token 用量新入口与趋势 tab」。
- `docs/usage/token-usage.md`：模态框描述改写为两 tab 现行行为（活动：美化热力图 + 点击跳单日；趋势：预设 7/30/90 天 + 自定义起止、单日 24 小时图、多日按天图、聚合 breakdown、366 天上限）。
- `AGENTS.md`：「usage（token 用量）底栏入口保留不动」→「usage（token 用量）入口在会话标题栏右上角 utilities 区」。

- [ ] **Step 2: usage 三产物 bundle + 两包全量验证**

```bash
pnpm --filter @dsh-agent-toolkit/token-usage bundle
pnpm --filter @dsh-agent-toolkit/token-usage test
pnpm --filter @dsh-agent-toolkit/token-usage typecheck
pnpm --filter dsh-agent-toolkit test
pnpm --filter dsh-agent-toolkit typecheck
pnpm --filter dsh-agent-toolkit bundle
```

Expected: usage 78 全过（含新增用例）、toolkit 842 全过、两包 typecheck 无错、bundle 成功。

- [ ] **Step 3: 开发回路冒烟（人工确认点）**

提示执行者或用户：`pnpm dsh web --patch ...` 启动后确认：① 会话标题栏右上角出现图标且点击开模态框；② 底栏入口消失；③ 热力图点击跳趋势单日；④ 趋势 tab 预设/自定义/倒置校验正常。

- [ ] **Step 4: Commit**

```bash
git add packages/usage/README.md packages/usage/src/index.ts docs/usage/README.md docs/usage/token-usage.md AGENTS.md
git commit -m "docs: token 用量入口迁移与趋势 tab 文档同步"
```
