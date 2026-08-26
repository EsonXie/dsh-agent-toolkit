/** dsh-agent-toolkit 纯函数：range 端点参数与摘要、13 周热力图网格、缓存/新增拆分。无运行时依赖，两半共用。 */
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
