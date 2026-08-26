import { describe, expect, test } from 'vitest'
import { DailyRecordSchema, tokenUsageDomain } from '../src/store.ts'
import { emptyDaily } from '../src/aggregate.ts'

describe('tokenUsageDomain', () => {
  test('域名与版本', () => {
    expect(tokenUsageDomain.name).toBe('token_usage')
    expect(tokenUsageDomain.version).toBe(1)
    expect(Object.keys(tokenUsageDomain.tables)).toEqual(['daily'])
  })
})

describe('DailyRecordSchema', () => {
  test('接受 emptyDaily 产物', () => {
    expect(DailyRecordSchema.safeParse(emptyDaily('2026-08-18')).success).toBe(true)
  })

  test('拒绝非法日期与缺桶', () => {
    expect(DailyRecordSchema.safeParse(emptyDaily('2026-8-18')).success).toBe(false)
    const bad = emptyDaily('2026-08-18')
    ;(bad.hours as unknown[]).length = 23
    expect(DailyRecordSchema.safeParse(bad).success).toBe(false)
  })
})
