import { describe, expect, test } from 'vitest'
import { addSample, billedOf, dayParts, emptyDaily, formatTokens, sampleFromEvent, shiftDate } from './aggregate.ts'
import type { UsageSample } from './aggregate.ts'

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

const sample: UsageSample = {
  date: '2026-08-18', hour: 7,
  input: 100, output: 50, cacheRead: 20, cacheWrite: 10, estimated: 0,
  estimatedCall: false, model: 'deepseek/deepseek-chat', sessionId: 's1', cwd: 'D:/proj',
  compaction: false,
}

describe('billedOf', () => {
  test('计费总量含 estimated', () => {
    expect(billedOf({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, calls: 5, estimated: 6 })).toBe(16)
  })
})

describe('addSample', () => {
  test('累加 totals/hours/三维细分，且不改入参', () => {
    const day = emptyDaily('2026-08-18')
    const next = addSample(day, sample)
    expect(day.totals.calls).toBe(0) // 入参未被修改
    expect(billedOf(next.totals)).toBe(180)
    expect(next.totals.calls).toBe(1)
    expect(billedOf(next.hours[7])).toBe(180)
    expect(billedOf(next.hours[8])).toBe(0) // 空小时保持全零
    expect(billedOf(next.byModel['deepseek/deepseek-chat'])).toBe(180)
    expect(next.bySession['s1'].cwd).toBe('D:/proj')
    expect(billedOf(next.byProject['D:/proj'])).toBe(180)
    expect(next.compaction.calls).toBe(0)
  })

  test('compaction 样本并入 totals/hours 与单列桶，不进三维细分', () => {
    const c: UsageSample = { ...sample, model: undefined, sessionId: undefined, cwd: undefined, compaction: true }
    const next = addSample(emptyDaily('2026-08-18'), c)
    expect(billedOf(next.totals)).toBe(180)
    expect(billedOf(next.compaction)).toBe(180)
    expect(Object.keys(next.byModel)).toHaveLength(0)
    expect(Object.keys(next.bySession)).toHaveLength(0)
    expect(Object.keys(next.byProject)).toHaveLength(0)
  })

  test('估算样本计入 estimated 并累计 estimatedCalls', () => {
    const e: UsageSample = { ...sample, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 42, estimatedCall: true }
    const next = addSample(emptyDaily('2026-08-18'), e)
    expect(next.totals.estimated).toBe(42)
    expect(next.totals.estimatedCalls).toBe(1)
    expect(billedOf(next.totals)).toBe(42)
  })
})

describe('sampleFromEvent', () => {
  const session = { header: { id: 's1', cwd: 'D:/proj' } } as never
  const message = {
    id: 'm1', role: 'assistant', content: [],
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
  } as never

  test('assistant/message 带 usage：按互斥字段计费', () => {
    const event = {
      type: 'assistant/message', seq: 1, time: Date.UTC(2026, 7, 18, 12, 0),
      data: { turn: 1, step: 1, message, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 5 } },
    } as never
    const s = sampleFromEvent(session, event, 'UTC', () => 999)
    expect(s).toMatchObject({ date: '2026-08-18', hour: 12, input: 100, output: 50, cacheRead: 20, cacheWrite: 10, estimated: 0, estimatedCall: false, model: 'deepseek/deepseek-chat', compaction: false })
  })

  test('assistant/message 缺 usage：估算整体进 estimated', () => {
    const event = { type: 'assistant/message', seq: 1, time: Date.UTC(2026, 7, 18), data: { turn: 1, step: 1, message } } as never
    const s = sampleFromEvent(session, event, 'UTC', () => 1234)
    expect(s).toMatchObject({ input: 0, output: 0, estimated: 1234, estimatedCall: true })
  })

  test('compaction/summary 带 usage：compaction 样本；缺 usage：跳过', () => {
    const withUsage = { type: 'compaction/summary', seq: 2, time: Date.UTC(2026, 7, 18, 3), data: { provider: 'deepseek', model: 'deepseek-chat', usage: { inputTokens: 500, outputTokens: 100 } } } as never
    expect(sampleFromEvent(session, withUsage, 'UTC', () => 0)).toMatchObject({ hour: 3, input: 500, output: 100, compaction: true, model: undefined })
    const noUsage = { type: 'compaction/summary', seq: 3, time: Date.UTC(2026, 7, 18), data: { provider: 'deepseek', model: 'deepseek-chat' } } as never
    expect(sampleFromEvent(session, noUsage, 'UTC', () => 0)).toBeUndefined()
  })

  test('无关事件返回 undefined', () => {
    const event = { type: 'step/start', seq: 4, time: Date.UTC(2026, 7, 18), data: { turn: 1, step: 1 } } as never
    expect(sampleFromEvent(session, event, 'UTC', () => 0)).toBeUndefined()
  })
})

