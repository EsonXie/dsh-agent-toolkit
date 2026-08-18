import { describe, expect, test } from 'vitest'
import { dayParts, formatTokens, shiftDate } from '../src/aggregate.ts'

describe('dayParts', () => {
  test('UTC 深夜在东八区归入次日早晨', () => {
    // 2026-08-18T23:30:00Z = 北京时间 2026-08-19 07:30
    const p = dayParts(Date.UTC(2026, 7, 18, 23, 30), 'Asia/Shanghai')
    expect(p).toEqual({ date: '2026-08-19', hour: 7 })
  })

  test('UTC 时区原样', () => {
    const p = dayParts(Date.UTC(2026, 7, 18, 23, 30), 'UTC')
    expect(p).toEqual({ date: '2026-08-18', hour: 23 })
  })

  test('午夜小时归 0（ICU 可能给 24）', () => {
    const p = dayParts(Date.UTC(2026, 7, 18, 0, 0), 'UTC')
    expect(p).toEqual({ date: '2026-08-18', hour: 0 })
  })
})

describe('shiftDate', () => {
  test('跨月', () => {
    expect(shiftDate('2026-08-01', -1)).toBe('2026-07-31')
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('formatTokens', () => {
  test('边界', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1.0K')
    expect(formatTokens(999950)).toBe('1000.0K')
    expect(formatTokens(1_000_000)).toBe('1.0M')
    expect(formatTokens(1_000_000_000)).toBe('1.0B')
  })
})
