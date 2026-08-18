import { describe, expect, test } from 'vitest'
import { addSample, emptyDaily, type UsageSample } from '../src/aggregate.ts'
import { renderDay, renderWeek } from '../src/render.ts'

const s: UsageSample = {
  date: '2026-08-18', hour: 7, input: 900, output: 200, cacheRead: 0, cacheWrite: 0,
  estimated: 0, estimatedCall: false, model: 'deepseek/deepseek-chat', sessionId: 's1', cwd: 'D:/proj',
  compaction: false,
}

describe('renderDay', () => {
  test('含总量、调用数与模型细分', () => {
    const text = renderDay(addSample(emptyDaily('2026-08-18'), s))
    expect(text).toContain('2026-08-18')
    expect(text).toContain('1.1K')
    expect(text).toContain('deepseek/deepseek-chat')
    expect(text).toContain('D:/proj')
  })

  test('不输出按会话细分（维度已下线，仅保留采集）', () => {
    const text = renderDay(addSample(emptyDaily('2026-08-18'), s))
    expect(text).not.toContain('按会话')
    expect(text).not.toContain('s1')
  })

  test('估算标注', () => {
    const e: UsageSample = { ...s, input: 0, output: 0, estimated: 500, estimatedCall: true }
    expect(renderDay(addSample(emptyDaily('2026-08-18'), e))).toContain('估算')
  })
})

describe('renderWeek', () => {
  test('今日详情 + 近 7 日逐日行', () => {
    const days = Array.from({ length: 7 }, (_, i) => emptyDaily(`2026-08-${18 - i}`))
    days[0] = addSample(days[0], s)
    const text = renderWeek('2026-08-18', days)
    expect(text).toContain('2026-08-17')
    expect(text).toContain('2026-08-12')
  })
})
