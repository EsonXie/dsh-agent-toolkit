import { expect, test } from 'vitest'
import { emptyDaily } from './aggregate.ts'
import {
  cacheHitRate, cacheSplit, heatmapGrid, levelOf, parseDaysParam, rangeSummaries,
  type HeatmapDay,
} from './heatmap.ts'

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
