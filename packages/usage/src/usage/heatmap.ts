/** dsh-agent-toolkit 纯函数：range 端点参数与摘要、13 周热力图网格、缓存/新增拆分。无运行时依赖，两半共用。 */
import { billedOf, emptyBucket, shiftDate } from './aggregate.ts'
import type { Bucket, DailyRecord } from './store.ts'

/** range 端点与热力图共用的每日紧凑摘要。 */
export interface HeatmapDay { date: string; billed: number; calls: number; fresh: number; cached: number }

const DAY_MS = 86_400_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_SPAN = 366

/** 解析 range 端点 days 参数：null → 默认 91；1..366 合法；其余返回 null（非法）。 */
export function parseDaysParam(raw: string | null): number | null {
  if (raw === null) return 91
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= 366 ? n : null
}

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
