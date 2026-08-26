# token-usage 图表化改造实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** token-usage 插件引入 Recharts，新增 13 周活动热力图视图，单日柱状图改为缓存/新增堆叠柱，整体样式对齐 shadcn 风格。

**Architecture:** 纯函数下沉到 `src/heatmap.ts`（Node/浏览器两半共用）；Node 半新增轻量 `/token-usage/api/range` 端点；浏览器半拆出 `DailyBarChart`（Recharts 封装）与 `ActivityHeatmap`（自绘格子）两个组件，`UsageModal` 改为活动/单日双视图容器。样式用 CSS Modules + 宿主 `--dsw-alias-*` 主题令牌平移 shadcn 观感，不引 Tailwind。

**Tech Stack:** Recharts（v3，进 dependencies 打进 client bundle）、vitest + jsdom + @testing-library/react、tsdown（既有打包链路不动）。

**Spec:** `docs/superpowers/specs/2026-08-21-token-usage-charts-design.md`

## Global Constraints

- 任何 `src` 改动后、提交前必须跑 `pnpm --filter @dsh-agent-toolkit/token-usage bundle`（AGENTS.md 硬规则）
- 纯净度门禁：client bundle 禁止 `@deepseek-ai/*` 跨插件值导入（`recharts` 不受影响）；react/react-dom 保持 external
- 宿主主题令牌只用已验证存在的：`--dsw-alias-state-business-primary`、`--dsw-alias-state-business-tertiary`、`--dsw-alias-label-primary/secondary/tertiary/dimmed`、`--dsw-alias-bg-overlay`、`--dsw-alias-bg-skeleton`、`--dsw-alias-interactive-bg-hover`
- 数据口径：缓存段 = `cacheRead`；新增段 = `input+output+cacheWrite+estimated`；热力图格子 = 当日 `billedOf(totals)`
- 存储记录禁止就地修改（`addSample` 风格，返回新对象）
- 提交信息沿用仓库风格：`feat(token-usage): <中文描述>`

---

### Task 1: 纯函数模块 `src/heatmap.ts`

**Files:**
- Create: `packages/token-usage/src/heatmap.ts`
- Test: `packages/token-usage/tests/heatmap.test.ts`

**Interfaces:**
- Consumes: `billedOf`、`shiftDate`（来自 `src/aggregate.ts`）；`Bucket`、`DailyRecord`（来自 `src/store.ts`）
- Produces（后续任务依赖这些精确签名）:
  - `interface HeatmapDay { date: string; billed: number; calls: number }`
  - `parseDaysParam(raw: string | null): number | null` — null 入参 → 91；合法 1..366；非法 → null
  - `rangeSummaries(get: (date: string) => DailyRecord | undefined, today: string, days: number): HeatmapDay[]` — 以 today 为终点向前 days 天，日期升序
  - `type HeatmapLevel = 0 | 1 | 2 | 3 | 4`；`levelOf(billed: number, max: number): HeatmapLevel`
  - `interface HeatmapCell { date: string; day: HeatmapDay | undefined; level: HeatmapLevel; future: boolean }`
  - `heatmapGrid(today: string, days: HeatmapDay[]): HeatmapCell[][]` — 返回 13 列 × 每列 7 格（周日在上），末列为 today 所在周
  - `cacheSplit(b: Bucket): { fresh: number; cached: number }`
  - `cacheHitRate(totals: Bucket): number | null`

- [ ] **Step 1: 写失败测试**

创建 `packages/token-usage/tests/heatmap.test.ts`：

```ts
import { expect, test } from 'vitest'
import { emptyDaily } from '../src/aggregate.ts'
import {
  cacheHitRate, cacheSplit, heatmapGrid, levelOf, parseDaysParam, rangeSummaries,
  type HeatmapDay,
} from '../src/heatmap.ts'

test('parseDaysParam：缺省 91，合法 1..366，其余非法', () => {
  expect(parseDaysParam(null)).toBe(91)
  expect(parseDaysParam('1')).toBe(1)
  expect(parseDaysParam('366')).toBe(366)
  expect(parseDaysParam('0')).toBeNull()
  expect(parseDaysParam('367')).toBeNull()
  expect(parseDaysParam('abc')).toBeNull()
  expect(parseDaysParam('1.5')).toBeNull()
})

test('rangeSummaries：以 today 为终点升序，缺失日记 0', () => {
  const rec = emptyDaily('2026-08-17')
  rec.totals = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 2, estimatedCalls: 0 }
  const days = rangeSummaries((d) => (d === '2026-08-17' ? rec : undefined), '2026-08-18', 3)
  expect(days).toEqual([
    { date: '2026-08-16', billed: 0, calls: 0 },
    { date: '2026-08-17', billed: 150, calls: 2 },
    { date: '2026-08-18', billed: 0, calls: 0 },
  ])
})

test('levelOf：0 用量 0 档，非零按 max 线性 1..4', () => {
  expect(levelOf(0, 100)).toBe(0)
  expect(levelOf(25, 100)).toBe(1)
  expect(levelOf(26, 100)).toBe(2)
  expect(levelOf(50, 100)).toBe(2)
  expect(levelOf(51, 100)).toBe(3)
  expect(levelOf(76, 100)).toBe(4)
  expect(levelOf(100, 100)).toBe(4)
  expect(levelOf(5, 0)).toBe(1) // max 异常兜底
})

// 2026-08-18 是周二；其所在周为 2026-08-16（周日）至 2026-08-22（周六）；
// 网格起点 2026-05-24 是周日。
test('heatmapGrid：13 列 × 7 行，周日在上，末列含 4 个未来格', () => {
  const today = '2026-08-18'
  const days: HeatmapDay[] = [{ date: today, billed: 1000, calls: 3 }]
  const grid = heatmapGrid(today, days)
  expect(grid).toHaveLength(13)
  for (const col of grid) expect(col).toHaveLength(7)
  expect(grid[0][0].date).toBe('2026-05-24')
  expect(grid[12][0].date).toBe('2026-08-16')
  expect(grid[12][6].date).toBe('2026-08-22')
  const todayCell = grid[12][2]
  expect(todayCell.date).toBe(today)
  expect(todayCell.future).toBe(false)
  expect(todayCell.level).toBe(4) // 唯一非零日即 max
  expect(todayCell.day).toEqual({ date: today, billed: 1000, calls: 3 })
  for (const r of [3, 4, 5, 6]) expect(grid[12][r].future).toBe(true)
  expect(grid[11][6].future).toBe(false)
  expect(grid[0][0].level).toBe(0) // 无数据日 0 档
})

test('cacheSplit：缓存 = cacheRead，新增 = input+output+cacheWrite+estimated', () => {
  expect(cacheSplit({ input: 10, output: 5, cacheRead: 7, cacheWrite: 3, estimated: 2, calls: 1 }))
    .toEqual({ fresh: 20, cached: 7 })
})

test('cacheHitRate：cacheRead/(input+cacheRead)，分母 0 返回 null', () => {
  expect(cacheHitRate({ input: 30, output: 0, cacheRead: 70, cacheWrite: 0, estimated: 0, calls: 1 })).toBeCloseTo(0.7)
  expect(cacheHitRate({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 1 })).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run tests/heatmap.test.ts`
Expected: FAIL（`../src/heatmap.ts` 不存在）

- [ ] **Step 3: 写最小实现**

创建 `packages/token-usage/src/heatmap.ts`：

```ts
/** token-usage 纯函数：range 端点参数与摘要、13 周热力图网格、缓存/新增拆分。无运行时依赖，两半共用。 */
import { billedOf, shiftDate } from './aggregate.ts'
import type { Bucket, DailyRecord } from './store.ts'

/** range 端点与热力图共用的每日紧凑摘要。 */
export interface HeatmapDay { date: string; billed: number; calls: number }

const DAY_MS = 86_400_000

/** 解析 range 端点 days 参数：null → 默认 91；1..366 合法；其余返回 null（非法）。 */
export function parseDaysParam(raw: string | null): number | null {
  if (raw === null) return 91
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= 366 ? n : null
}

/** 以 today 为终点向前取 days 天的紧凑摘要（缺失日记 0），日期升序。 */
export function rangeSummaries(get: (date: string) => DailyRecord | undefined, today: string, days: number): HeatmapDay[] {
  return Array.from({ length: days }, (_, i) => {
    const date = shiftDate(today, i - (days - 1))
    const rec = get(date)
    return rec === undefined
      ? { date, billed: 0, calls: 0 }
      : { date, billed: billedOf(rec.totals), calls: rec.totals.calls }
  })
}

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4

/** 分档：0 用量 → 0；非零按 max 线性 1..4 档（max <= 0 时兜底 1）。 */
export function levelOf(billed: number, max: number): HeatmapLevel {
  if (billed <= 0) return 0
  if (max <= 0) return 1
  return Math.min(4, Math.max(1, Math.ceil((billed / max) * 4))) as HeatmapLevel
}

export interface HeatmapCell {
  date: string
  day: HeatmapDay | undefined
  level: HeatmapLevel
  /** today 之后的格子：禁用、不计档位。 */
  future: boolean
}

/** 13 列 × 每列 7 格（周日在上）；末列为 today 所在周（周六结束）。 */
export function heatmapGrid(today: string, days: HeatmapDay[]): HeatmapCell[][] {
  const byDate = new Map(days.map((d) => [d.date, d]))
  const todayMs = Date.parse(`${today}T12:00:00Z`)
  const endMs = todayMs + (6 - new Date(todayMs).getUTCDay()) * DAY_MS
  const startMs = endMs - 90 * DAY_MS
  const max = Math.max(0, ...days.map((d) => d.billed))
  return Array.from({ length: 13 }, (_, c) =>
    Array.from({ length: 7 }, (_, r) => {
      const ms = startMs + (c * 7 + r) * DAY_MS
      const date = new Date(ms).toISOString().slice(0, 10)
      const day = byDate.get(date)
      const future = ms > todayMs
      return { date, day, level: future || day === undefined ? 0 : levelOf(day.billed, max), future }
    }))
}

/** 缓存/新增拆分：缓存 = cacheRead；新增 = input+output+cacheWrite+estimated。 */
export function cacheSplit(b: Bucket): { fresh: number; cached: number } {
  return { fresh: b.input + b.output + b.cacheWrite + b.estimated, cached: b.cacheRead }
}

/** 缓存命中率 = cacheRead/(input+cacheRead)；分母为 0 返回 null。 */
export function cacheHitRate(totals: Bucket): number | null {
  const denom = totals.input + totals.cacheRead
  return denom === 0 ? null : totals.cacheRead / denom
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run tests/heatmap.test.ts`
Expected: PASS（6 个测试）

- [ ] **Step 5: 提交**

```bash
git add packages/token-usage/src/heatmap.ts packages/token-usage/tests/heatmap.test.ts
git commit -m "feat(token-usage): heatmap 纯函数——range 摘要/参数解析、13 周网格、缓存拆分"
```

---

### Task 2: Node 半 range 端点

**Files:**
- Modify: `packages/token-usage/src/index.ts:84-105`（在现有 `ctx.inject(['webServer'])` 块内追加第二条路由注册）

**Interfaces:**
- Consumes: `parseDaysParam`、`rangeSummaries`、`HeatmapDay`（Task 1）；既有 `dayParts`、`domainReady`、`daily`
- Produces: `GET /token-usage/api/range?days=N` → `{ today: string, days: HeatmapDay[] }`（Task 5 的浏览器半按此契约 fetch）

纯函数已在 Task 1 覆盖（参数校验、日期循环、空表全零），本任务是薄接线，按现有代码风格不新增 mock ctx 测试。

- [ ] **Step 1: 修改 import 与注册路由**

`packages/token-usage/src/index.ts` 第 9 行 import 块后追加：

```ts
import { parseDaysParam, rangeSummaries } from './heatmap.ts'
```

在现有 `webCtx.effect(() => webCtx.webServer.register({ ... '/token-usage/api/daily' ... }))` 语句**之后**、同一 `ctx.inject(['webServer'])` 回调内追加：

```ts
  webCtx.effect(() => webCtx.webServer.register({
    kind: 'exact',
    path: '/token-usage/api/range',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      const days = parseDaysParam(new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('days'))
      if (days === null) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad days, want integer 1..366' }))
        return
      }
      const table = await domainReady.then(() => daily!)
      const today = dayParts(Date.now(), config.timezone).date
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ today, days: rangeSummaries((d) => table.get(d), today, days) }))
    },
  }), 'token-usage: /token-usage/api/range route')
```

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage typecheck; pnpm --filter @dsh-agent-toolkit/token-usage test`
Expected: typecheck 无错误；全部测试 PASS

- [ ] **Step 3: 提交**

```bash
git add packages/token-usage/src/index.ts
git commit -m "feat(token-usage): /token-usage/api/range 端点——N 日紧凑摘要（date/billed/calls）"
```

---

### Task 3: Recharts 依赖 + shadcn 风格主题 + DailyBarChart

**Files:**
- Modify: `packages/token-usage/package.json`（经 `pnpm add`）
- Create: `packages/token-usage/src/client/chart.module.css`
- Create: `packages/token-usage/src/client/DailyBarChart.tsx`
- Test: `packages/token-usage/tests/daily-bar-chart.client.spec.tsx`

**Interfaces:**
- Consumes: `cacheSplit`（Task 1）；`formatTokens`（`src/aggregate.ts`）；`DailyRecord`（`src/store.ts`）
- Produces:
  - `DailyBarChart({ record }: { record: DailyRecord }): ReactNode` — Task 5 在单日视图使用
  - `chart.module.css` 导出类：`chartTheme`（提供 `--chart-1/--chart-2/--chart-label/--chart-empty`）、`tooltip`、`tooltipTitle`、`tooltipTotal`、`legend`、`swatchFresh`、`swatchCached` — Task 4 的 ActivityHeatmap 复用 `chartTheme`

- [ ] **Step 1: 安装 recharts**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage add recharts`
Expected: `package.json` dependencies 新增 `recharts`（v3.x）。tsdown 的 `alwaysBundle` 会自动把它内联进 `lib/client.js`，无需改打包配置。

- [ ] **Step 2: 写失败测试**

创建 `packages/token-usage/tests/daily-bar-chart.client.spec.tsx`：

```tsx
// @vitest-environment jsdom
import { cloneElement, type ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('../src/client/chart.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
// jsdom 无布局，ResponsiveContainer 量不出尺寸就不渲染子树；mock 成固定尺寸克隆。
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children, { width: 600, height: 160 }),
  }
})

import { emptyDaily } from '../src/aggregate.ts'
import { DailyBarChart } from '../src/client/DailyBarChart.tsx'

afterEach(cleanup)

test('渲染 SVG 图表与新增/缓存图例', () => {
  const record = emptyDaily('2026-08-18')
  record.hours[10] = { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0, estimated: 0, calls: 2 }
  const { container } = render(<DailyBarChart record={record} />)
  expect(container.querySelector('svg')).not.toBeNull()
  expect(screen.getByText('新增')).toBeTruthy()
  expect(screen.getByText('缓存')).toBeTruthy()
})

test('全零日也渲染（空柱不崩）', () => {
  const { container } = render(<DailyBarChart record={emptyDaily('2026-08-18')} />)
  expect(container.querySelector('svg')).not.toBeNull()
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run tests/daily-bar-chart.client.spec.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 写 chart.module.css**

创建 `packages/token-usage/src/client/chart.module.css`：

```css
/* shadcn 风格图表主题：颜色一律解析到宿主 ui-theme 的 --dsw-alias-* 令牌，
   深浅色主题自动跟随。--chart-1 新增（主色），--chart-2 缓存（同色系浅色）。 */
.chartTheme {
  --chart-1: var(--dsw-alias-state-business-primary);
  --chart-2: var(--dsw-alias-state-business-tertiary);
  --chart-label: var(--dsw-alias-label-tertiary);
  --chart-empty: var(--dsw-alias-bg-skeleton);
}
.tooltip {
  background: var(--dsw-alias-bg-overlay);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}
.tooltipTitle { color: var(--dsw-alias-label-secondary); }
.tooltipTotal { margin-top: 2px; font-weight: 600; }
.legend {
  display: flex;
  gap: 16px;
  justify-content: center;
  margin-top: 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
.swatchFresh { background: var(--chart-1); }
.swatchCached { background: var(--chart-2); }
```

- [ ] **Step 5: 写 DailyBarChart 组件**

创建 `packages/token-usage/src/client/DailyBarChart.tsx`：

```tsx
/** 单日 24 小时堆叠柱状图：下段「新增」+ 上段「缓存」，shadcn 风格（极简轴、圆角柱、自定义 tooltip）。 */
import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatTokens } from '../aggregate.ts'
import { cacheSplit } from '../heatmap.ts'
import type { DailyRecord } from '../store.ts'
import css from './chart.module.css'

interface HourRow { hour: number; fresh: number; cached: number; calls: number }

interface ChartTooltipProps { active?: boolean; label?: number; payload?: { payload: HourRow }[] }

function ChartTooltip({ active, label, payload }: ChartTooltipProps): ReactNode {
  if (!active || payload === undefined || payload.length === 0) return null
  const row = payload[0].payload
  return (
    <div className={css.tooltip}>
      <div className={css.tooltipTitle}>{label}:00</div>
      <div>新增 {formatTokens(row.fresh)}</div>
      <div>缓存 {formatTokens(row.cached)}</div>
      <div className={css.tooltipTotal}>合计 {formatTokens(row.fresh + row.cached)} · {row.calls} 次</div>
    </div>
  )
}

export function DailyBarChart({ record }: { record: DailyRecord }): ReactNode {
  const data: HourRow[] = record.hours.map((b, hour) => ({ hour, ...cacheSplit(b), calls: b.calls }))
  return (
    <div className={css.chartTheme}>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--chart-label)" strokeOpacity={0.2} strokeDasharray="3 3" />
          <XAxis
            dataKey="hour"
            tickLine={false}
            axisLine={false}
            ticks={[0, 6, 12, 18]}
            tickFormatter={(h: number) => `${h}:00`}
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

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run tests/daily-bar-chart.client.spec.tsx`
Expected: PASS（2 个测试）

- [ ] **Step 7: 提交**

```bash
git add packages/token-usage/package.json packages/token-usage/src/client/chart.module.css packages/token-usage/src/client/DailyBarChart.tsx packages/token-usage/tests/daily-bar-chart.client.spec.tsx pnpm-lock.yaml
git commit -m "feat(token-usage): Recharts 堆叠柱状图组件（缓存/新增）+ shadcn 风格图表主题"
```

---

### Task 4: ActivityHeatmap 组件

**Files:**
- Create: `packages/token-usage/src/client/ActivityHeatmap.tsx`
- Create: `packages/token-usage/src/client/ActivityHeatmap.module.css`
- Test: `packages/token-usage/tests/activity-heatmap.client.spec.tsx`

**Interfaces:**
- Consumes: `heatmapGrid`、`HeatmapDay`（Task 1）；`formatTokens`（`src/aggregate.ts`）；`chart.module.css` 的 `chartTheme`（Task 3）
- Produces: `ActivityHeatmap({ today, days, onSelect }: { today: string; days: HeatmapDay[]; onSelect: (date: string) => void }): ReactNode` — Task 5 在活动视图使用
- CSS 类：`months`、`grid`、`week`、`level0..level4`

- [ ] **Step 1: 写失败测试**

创建 `packages/token-usage/tests/activity-heatmap.client.spec.tsx`：

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('../src/client/ActivityHeatmap.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('../src/client/chart.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

import { shiftDate } from '../src/aggregate.ts'
import { ActivityHeatmap } from '../src/client/ActivityHeatmap.tsx'

// 2026-08-18 是周二：末列含 4 个未来格（周三~周六）。
const TODAY = '2026-08-18'
const DAYS = Array.from({ length: 91 }, (_, i) => ({ date: shiftDate(TODAY, i - 90), billed: 0, calls: 0 }))

afterEach(cleanup)

test('渲染 91 格，未来格禁用', () => {
  render(<ActivityHeatmap today={TODAY} days={DAYS} onSelect={() => {}} />)
  const cells = screen.getAllByRole('button') as HTMLButtonElement[]
  expect(cells).toHaveLength(91)
  expect(cells.filter((c) => c.disabled)).toHaveLength(4)
})

test('点击格子回调该格日期', () => {
  const selected: string[] = []
  render(<ActivityHeatmap today={TODAY} days={DAYS} onSelect={(d) => selected.push(d)} />)
  fireEvent.click(screen.getByRole('button', { name: TODAY }))
  expect(selected).toEqual([TODAY])
})

test('跨月列渲染月份标签', () => {
  const { container } = render(<ActivityHeatmap today={TODAY} days={DAYS} onSelect={() => {}} />)
  // 2026-05-24 ~ 2026-08-22 跨 5/6/7/8 四个月，至少出现 6/7/8 三个标签
  const labels = Array.from(container.querySelectorAll('span')).map((s) => s.textContent)
  expect(labels).toContain('6月')
  expect(labels).toContain('7月')
  expect(labels).toContain('8月')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run tests/activity-heatmap.client.spec.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写组件与样式**

创建 `packages/token-usage/src/client/ActivityHeatmap.tsx`：

```tsx
/** 13 周活动热力图：7 行（周日在上）× 13 列；格子颜色 = 当日计费总量档位；点击选中日期的单日视图。 */
import type { ReactNode } from 'react'
import { formatTokens } from '../aggregate.ts'
import { heatmapGrid, type HeatmapDay } from '../heatmap.ts'
import theme from './chart.module.css'
import css from './ActivityHeatmap.module.css'

export interface ActivityHeatmapProps {
  today: string
  days: HeatmapDay[]
  onSelect: (date: string) => void
}

export function ActivityHeatmap({ today, days, onSelect }: ActivityHeatmapProps): ReactNode {
  const columns = heatmapGrid(today, days)
  return (
    <div className={theme.chartTheme}>
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
              <button
                key={cell.date}
                type="button"
                className={css[`level${cell.level}`]}
                disabled={cell.future}
                title={cell.future ? undefined : `${cell.date}  ${formatTokens(cell.day?.billed ?? 0)} · ${cell.day?.calls ?? 0} 次`}
                aria-label={cell.date}
                onClick={() => { onSelect(cell.date) }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
```

创建 `packages/token-usage/src/client/ActivityHeatmap.module.css`：

```css
/* GitHub/Codex 式周列日行格子；档位色 = --chart-1 单色渐进（shadcn 惯例）。 */
.months {
  display: grid;
  grid-template-columns: repeat(13, 1fr);
  gap: 3px;
  margin-bottom: 4px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.grid { display: grid; grid-template-columns: repeat(13, 1fr); gap: 3px; }
.week { display: grid; grid-template-rows: repeat(7, 1fr); gap: 3px; }
.week > button {
  aspect-ratio: 1 / 1;
  width: 100%;
  border: none;
  border-radius: 2px;
  padding: 0;
  cursor: pointer;
}
.week > button:disabled { cursor: default; opacity: 0.35; }
.week > button:hover:not(:disabled) { outline: 1px solid var(--dsw-alias-label-dimmed); outline-offset: 1px; }
.week > .level0 { background: var(--chart-empty); }
.week > .level1 { background: color-mix(in srgb, var(--chart-1) 25%, transparent); }
.week > .level2 { background: color-mix(in srgb, var(--chart-1) 50%, transparent); }
.week > .level3 { background: color-mix(in srgb, var(--chart-1) 75%, transparent); }
.week > .level4 { background: var(--chart-1); }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run tests/activity-heatmap.client.spec.tsx`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交**

```bash
git add packages/token-usage/src/client/ActivityHeatmap.tsx packages/token-usage/src/client/ActivityHeatmap.module.css packages/token-usage/tests/activity-heatmap.client.spec.tsx
git commit -m "feat(token-usage): 13 周活动热力图组件（GitHub 式格子，点击跳单日）"
```

---

### Task 5: UsageModal 双视图改造

**Files:**
- Modify: `packages/token-usage/src/client/UsageModal.tsx`（整体重写）
- Modify: `packages/token-usage/src/client/UsageModal.module.css`（删除手搓柱状图样式，加 `.backButton`）
- Modify: `packages/token-usage/tests/usage-modal.client.spec.tsx`（fetch 按 URL 分流；新增视图切换断言）

**Interfaces:**
- Consumes: `ActivityHeatmap`（Task 4）、`DailyBarChart`（Task 3）、`cacheHitRate`、`HeatmapDay`（Task 1）
- Produces: `UsageModal` props 不变（`{ open, onClose, initialDate }`），但 `initialDate: null` 的语义从"今天"变为"活动视图"——`UsageEntry.tsx` 传 `null` 不用改

注意：`initialDate` 非 null 时直接进单日视图（既有行为保留，测试用它直达单日视图）。

- [ ] **Step 1: 先改测试（含新行为的失败测试）**

整体替换 `packages/token-usage/tests/usage-modal.client.spec.tsx`：

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// Deterministic class names: the width-override assertion must not depend on
// the bundler's hashed output.
vi.mock('../src/client/UsageModal.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('../src/client/ActivityHeatmap.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('../src/client/chart.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

import { shiftDate } from '../src/aggregate.ts'
import { UsageModal } from '../src/client/UsageModal.tsx'

// 2026-08-18 是周二。
const TODAY = '2026-08-18'

const RANGE_PAYLOAD = {
  today: TODAY,
  days: Array.from({ length: 91 }, (_, i) => ({
    date: shiftDate(TODAY, i - 90),
    billed: i === 90 ? 14500 : 0,
    calls: i === 90 ? 1 : 0,
  })),
}

const DAY_PAYLOAD = {
  today: TODAY,
  record: {
    date: TODAY,
    hours: Array.from({ length: 24 }, () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 })),
    totals: { input: 14000, output: 500, cacheRead: 56000, cacheWrite: 0, estimated: 0, calls: 1, estimatedCalls: 0 },
    byModel: { 'deepseek/deepseek-chat': { input: 14000, output: 500, cacheRead: 56000, cacheWrite: 0, estimated: 0, calls: 1, estimatedCalls: 0 } },
    byProject: {},
    bySession: {
      'session-76afe15b-21dc-4280-8b11-f0da78695596': {
        input: 14000, output: 500, cacheRead: 56000, cacheWrite: 0, estimated: 0, calls: 1, estimatedCalls: 0,
        cwd: 'D:/work/laiye/work/github/LeaderAgent',
      },
    },
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 },
  },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.startsWith('/token-usage/api/range') ? RANGE_PAYLOAD : DAY_PAYLOAD
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('对话框携带加宽覆盖类（Modal 默认 380px 会裁切图表与行）', () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  const dialog = screen.getByRole('dialog')
  expect(dialog.classList.contains('dialog')).toBe(true)
})

test('initialDate 为 null 时默认打开活动视图', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  expect(await screen.findByText('近 13 周活动')).toBeTruthy()
})

test('点击热力图格子进入该日单日视图', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  await screen.findByText('近 13 周活动')
  fireEvent.click(await screen.findByRole('button', { name: TODAY }))
  expect(await screen.findByText('按模型')).toBeTruthy()
})

test('不渲染按会话细分（数据存在也不展示）', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  expect(await screen.findByText('按模型')).toBeTruthy()
  expect(screen.queryByText('按会话')).toBeNull()
  expect(screen.queryByText(/session-76afe15b/)).toBeNull()
})

test('总量行显示缓存命中率（56000/(14000+56000)=80%）', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  expect(await screen.findByText(/缓存命中率 80%/)).toBeTruthy()
})

test('单日视图可返回活动视图', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  await screen.findByText('按模型')
  fireEvent.click(screen.getByRole('button', { name: '返回活动视图' }))
  expect(await screen.findByText('近 13 周活动')).toBeTruthy()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run tests/usage-modal.client.spec.tsx`
Expected: FAIL（`近 13 周活动`、`返回活动视图`、缓存命中率等尚不存在）

- [ ] **Step 3: 重写 UsageModal.tsx**

整体替换 `packages/token-usage/src/client/UsageModal.tsx`：

```tsx
/** Token 用量模态框：活动热力图（近 13 周）与单日详情双视图。 */
import { useEffect, useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { billedOf, formatTokens, shiftDate } from '../aggregate.ts'
import { cacheHitRate, type HeatmapDay } from '../heatmap.ts'
import type { Bucket, DailyRecord } from '../store.ts'
import { ActivityHeatmap } from './ActivityHeatmap.tsx'
import { DailyBarChart } from './DailyBarChart.tsx'
import css from './UsageModal.module.css'

export interface UsageModalProps {
  open: boolean
  onClose: () => void
  /** 初始日期 YYYY-MM-DD；null = 打开活动视图。 */
  initialDate: string | null
}

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; value: T }

interface RangePayload { today: string; days: HeatmapDay[] }
interface DayPayload { today: string; record: DailyRecord }

async function fetchJson<T>(url: string): Promise<LoadState<T>> {
  try {
    const res = await fetch(url)
    if (!res.ok) return { status: 'error' }
    return { status: 'ok', value: await res.json() as T }
  } catch {
    return { status: 'error' }
  }
}

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
  /** null = 活动视图；否则为单日视图日期。 */
  const [date, setDate] = useState<string | null>(initialDate)
  const [range, setRange] = useState<LoadState<RangePayload>>({ status: 'loading' })
  const [day, setDay] = useState<LoadState<DayPayload>>({ status: 'loading' })

  useEffect(() => { if (open) setDate(initialDate) }, [open, initialDate])
  // 打开即取 91 天范围数据；缓存在 state，活动/单日来回切换不重取。
  useEffect(() => {
    if (!open) return
    let stale = false
    setRange({ status: 'loading' })
    void fetchJson<RangePayload>('/token-usage/api/range?days=91').then((s) => { if (!stale) setRange(s) })
    return () => { stale = true }
  }, [open])
  useEffect(() => {
    if (!open || date === null) return
    let stale = false
    setDay({ status: 'loading' })
    void fetchJson<DayPayload>(`/token-usage/api/daily?date=${date}`).then((s) => { if (!stale) setDay(s) })
    return () => { stale = true }
  }, [open, date])

  const today = range.status === 'ok' ? range.value.today
    : day.status === 'ok' ? day.value.today : undefined
  const record = date !== null && day.status === 'ok' ? day.value.record : undefined
  const hit = record === undefined ? null : cacheHitRate(record.totals)

  return (
    <Modal open={open} onClose={onClose} title="Token 用量" closeLabel="关闭" className={css.dialog}>
      {date === null ? (
        <>
          {range.status === 'loading' && <p>加载中…</p>}
          {range.status === 'error' && <p>加载失败，请重试</p>}
          {range.status === 'ok' && (
            <>
              <h3 className={css.sectionTitle}>近 13 周活动</h3>
              <ActivityHeatmap today={range.value.today} days={range.value.days} onSelect={(d) => { setDate(d) }} />
            </>
          )}
        </>
      ) : (
        <>
          <div className={css.pager}>
            <button type="button" className={css.backButton} aria-label="返回活动视图" onClick={() => { setDate(null) }}>活动</button>
            <button type="button" className={css.pagerButton} aria-label="前一天" onClick={() => { setDate(shiftDate(date, -1)) }}>←</button>
            <span className={css.dateLabel}>{date}</span>
            <button type="button" className={css.pagerButton} aria-label="后一天" disabled={today === undefined || shiftDate(date, 1) > today}
              onClick={() => { setDate(shiftDate(date, 1)) }}>→</button>
          </div>
          {day.status === 'loading' && <p>加载中…</p>}
          {day.status === 'error' && <p>加载失败，请重试</p>}
          {record !== undefined && (
            <>
              <DailyBarChart record={record} />
              <p className={css.total}>
                当日总量 {formatTokens(billedOf(record.totals))} · {record.totals.calls} 次调用
                {record.totals.estimated > 0 && `（含估算 ${formatTokens(record.totals.estimated)}）`}
                {hit !== null && `（缓存命中率 ${Math.round(hit * 100)}%）`}
                {record.totals.calls === 0 && ' · 当日无用量'}
              </p>
              <Breakdown title="按模型" rows={Object.entries(record.byModel).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
              <Breakdown title="按项目" rows={Object.entries(record.byProject).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
              {record.compaction.calls > 0 && (
                <p className={css.compaction}>上下文压缩 {formatTokens(billedOf(record.compaction))} · {record.compaction.calls} 次</p>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  )
}
```

- [ ] **Step 4: 更新 UsageModal.module.css**

删除 `.chart`、`.barSlot`、`.bar`、`.hourLabels` 四条规则（手搓柱状图已移除），在 `.pagerButton` 规则后追加：

```css
.backButton {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
}
.backButton:hover { background: var(--dsw-alias-interactive-bg-hover); }
```

同时把 `.pager` 的 `justify-content: center` 改为 `justify-content: flex-start`（返回按钮靠左）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run tests/usage-modal.client.spec.tsx`
Expected: PASS（6 个测试）

- [ ] **Step 6: 提交**

```bash
git add packages/token-usage/src/client/UsageModal.tsx packages/token-usage/src/client/UsageModal.module.css packages/token-usage/tests/usage-modal.client.spec.tsx
git commit -m "feat(token-usage): 模态框双视图——默认活动热力图，点击格子进单日堆叠柱状图"
```

---

### Task 6: 全量回归 + 打包

**Files:**
- Modify: `packages/token-usage/lib/*`（构建产物，bundle 命令重新生成）

- [ ] **Step 1: 全量测试 + 类型检查**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test; pnpm --filter @dsh-agent-toolkit/token-usage typecheck`
Expected: 全部测试 PASS（约 26 个）；typecheck 无错误

- [ ] **Step 2: 打包（AGENTS.md 硬规则：src 改动后必须 bundle）**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage bundle`
Expected: `lib/index.js` 与 `lib/client.js` 重新生成；`lib/client.js` 包含 recharts 代码（体积预期上涨 150-300KB）

验证：`git diff --stat packages/token-usage/lib/` 显示两个 bundle 均已更新。

- [ ] **Step 3: 提交构建产物**

```bash
git add packages/token-usage/lib
git commit -m "chore(token-usage): 重新打包 Node/浏览器 bundle（含 recharts）"
```

- [ ] **Step 4: 人工开发回路验证（告知用户执行）**

提示用户在开发回路中目测确认：

```powershell
cd deepseek-harness; pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml
```

打开 Web UI → 侧栏"Token 用量"→ 确认：默认显示 13 周热力图；点击格子进单日堆叠柱状图（新增/缓存两色 + 图例 + tooltip）；深浅色主题切换颜色跟随。可用 `curl "http://localhost:<port>/token-usage/api/range?days=91"` 验证端点返回。

---

## Self-Review 记录

- Spec 覆盖：§2 组件拆分 → Task 3/4/5；§3 数据流 → Task 2/5；§4 热力图 → Task 1（纯函数）+ Task 4；§5 堆叠柱状图 + 命中率 → Task 3 + Task 5；§6 依赖打包 → Task 3/6；§7 错误处理 → Task 2（400/405/500 路径）+ Task 5（加载失败文案、全零渲染测试）；§8 测试 → 各 Task TDD 步骤；§9 YAGNI → 未引入多余功能
- 类型一致性：`HeatmapDay`/`HeatmapCell`/`cacheSplit`/`cacheHitRate`/`DailyBarChart`/`ActivityHeatmap` 签名在 Task 1/3/4 定义，Task 5 消费处已核对一致
- `2026-08-18` 周二、`2026-05-24` 周日的星期数已推算验证（网格断言依赖此）
