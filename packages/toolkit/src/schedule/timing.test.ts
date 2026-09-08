import { describe, expect, test } from 'vitest'
import {
  advanceAfterTrigger, nextOccurrence, previewOccurrences, rearmTask, recomputeTask, validateSchedule,
} from './timing.ts'
import type { CronTask } from './store.ts'

// 固定时钟：2026-09-07T00:00:00.000Z（周一）
const NOW = Date.parse('2026-09-07T00:00:00.000Z')
const CREATED = Date.parse('2026-09-07T00:00:00.000Z')

const task = (over: Partial<CronTask>): CronTask => ({
  id: 't1', name: 'n', prompt: 'p', cwd: 'D:\\work',
  schedule: { kind: 'every', seconds: 3600 },
  target: { kind: 'main' }, catchup: false, enabled: true,
  nextRunAt: null, createdAt: new Date(CREATED).toISOString(), updatedAt: new Date(CREATED).toISOString(),
  ...over,
})

describe('validateSchedule', () => {
  test('合法 cron：5 字段；at（未来、RFC 3339）；every 返回 undefined', () => {
    expect(validateSchedule({ kind: 'cron', expr: '0 9 * * *' }, NOW)).toBeUndefined()
    expect(validateSchedule({ kind: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' }, NOW)).toBeUndefined()
    expect(validateSchedule({ kind: 'at', at: '2026-09-08T00:00:00Z' }, NOW)).toBeUndefined()
    expect(validateSchedule({ kind: 'every', seconds: 60 }, NOW)).toBeUndefined()
  })
  test('拒绝 6/7 字段（秒级/年字段首期不开放）', () => {
    expect(validateSchedule({ kind: 'cron', expr: '0 0 9 * * *' }, NOW)).toMatch(/5 字段/)
    expect(validateSchedule({ kind: 'cron', expr: '0 0 9 * * * 2026' }, NOW)).toMatch(/5 字段/)
  })
  test('拒绝非法 cron 表达式 / 未知时区 / 非法 at / 过去的 at', () => {
    expect(validateSchedule({ kind: 'cron', expr: '99 9 * * *' }, NOW)).toMatch(/非法 cron 表达式/)
    expect(validateSchedule({ kind: 'cron', expr: '0 9 * * *', timeZone: 'Mars/Olympus' }, NOW)).toMatch(/未知时区/)
    expect(validateSchedule({ kind: 'at', at: 'not-a-date' }, NOW)).toMatch(/非法 at 时间/)
    expect(validateSchedule({ kind: 'at', at: '2026-09-06T00:00:00Z' }, NOW)).toMatch(/未来/)
  })
})

describe('nextOccurrence', () => {
  test('cron：now 之后下一 occurrence（显式 UTC）', () => {
    const next = nextOccurrence({ kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' }, CREATED, NOW)
    expect(next).toBe(Date.parse('2026-09-07T09:00:00.000Z'))
  })
  test('cron 带时区：Asia/Shanghai 09:00 = UTC 01:00', () => {
    const next = nextOccurrence({ kind: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' }, CREATED, NOW)
    expect(next).toBe(Date.parse('2026-09-07T01:00:00.000Z'))
  })
  test('at：未来返回触发点，过期返回 null', () => {
    expect(nextOccurrence({ kind: 'at', at: '2026-09-08T00:00:00Z' }, CREATED, NOW)).toBe(Date.parse('2026-09-08T00:00:00.000Z'))
    expect(nextOccurrence({ kind: 'at', at: '2026-09-06T00:00:00Z' }, CREATED, NOW)).toBeNull()
  })
  test('every：创建锚点对齐推进，跳过中间错过的（不枚举积压）', () => {
    // 锚 00:00，间隔 1h；now = 10:30 → 下一触发 11:00
    const later = Date.parse('2026-09-07T10:30:00.000Z')
    expect(nextOccurrence({ kind: 'every', seconds: 3600 }, CREATED, later)).toBe(Date.parse('2026-09-07T11:00:00.000Z'))
  })
})

describe('previewOccurrences', () => {
  test('cron 预览未来 3 次；at 只给 1 次（未来时）', () => {
    const prevs = previewOccurrences({ kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' }, 3, CREATED, NOW)
    expect(prevs).toEqual([
      Date.parse('2026-09-07T09:00:00.000Z'),
      Date.parse('2026-09-08T09:00:00.000Z'),
      Date.parse('2026-09-09T09:00:00.000Z'),
    ])
    expect(previewOccurrences({ kind: 'at', at: '2026-09-08T00:00:00Z' }, 3, CREATED, NOW)).toHaveLength(1)
    expect(previewOccurrences({ kind: 'at', at: '2026-09-06T00:00:00Z' }, 3, CREATED, NOW)).toHaveLength(0)
  })
})

describe('rearmTask（启动 rearm）', () => {
  test('nextRunAt 仍在未来 → 原样保持（返回原引用）', () => {
    const t = task({ nextRunAt: '2026-09-08T00:00:00.000Z' })
    expect(rearmTask(t, NOW)).toBe(t)
  })
  test('已过期且 catchup=true → 设为立即', () => {
    const t = task({ catchup: true, nextRunAt: '2026-09-06T00:00:00.000Z' })
    const rearmed = rearmTask(t, NOW)
    expect(rearmed.nextRunAt).toBe(new Date(NOW).toISOString())
    expect(rearmed.enabled).toBe(true)
  })
  test('已过期且 catchup=false → 下一未来触发点；at 无未来触发点 → 作废', () => {
    const cronT = task({ schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' }, nextRunAt: '2026-09-06T09:00:00.000Z' })
    expect(rearmTask(cronT, NOW).nextRunAt).toBe('2026-09-07T09:00:00.000Z')
    const atT = task({ schedule: { kind: 'at', at: '2026-09-06T00:00:00Z' }, nextRunAt: '2026-09-06T00:00:00.000Z' })
    const rearmed = rearmTask(atT, NOW)
    expect(rearmed.enabled).toBe(false)
    expect(rearmed.nextRunAt).toBeNull()
  })
  test('disabled → nextRunAt 置 null（已 null 返回原引用）', () => {
    const t = task({ enabled: false, nextRunAt: '2026-09-08T00:00:00.000Z' })
    expect(rearmTask(t, NOW).nextRunAt).toBeNull()
    const already = task({ enabled: false, nextRunAt: null })
    expect(rearmTask(already, NOW)).toBe(already)
  })
})

describe('recomputeTask / advanceAfterTrigger', () => {
  test('recomputeTask：enabled 重算 nextRunAt；disabled 置 null', () => {
    const t = task({ schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' } })
    expect(recomputeTask(t, NOW).nextRunAt).toBe('2026-09-07T09:00:00.000Z')
    expect(recomputeTask(task({ enabled: false }), NOW).nextRunAt).toBeNull()
  })
  test('advanceAfterTrigger：cron/every 推进到下一触发点；at 一次性作废', () => {
    const cronT = task({ schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' }, nextRunAt: '2026-09-07T09:00:00.000Z' })
    expect(advanceAfterTrigger(cronT, Date.parse('2026-09-07T09:00:05.000Z')).nextRunAt).toBe('2026-09-08T09:00:00.000Z')
    const atT = task({ schedule: { kind: 'at', at: '2026-09-08T00:00:00Z' }, nextRunAt: '2026-09-08T00:00:00.000Z' })
    const advanced = advanceAfterTrigger(atT, Date.parse('2026-09-08T00:00:01.000Z'))
    expect(advanced.enabled).toBe(false)
    expect(advanced.nextRunAt).toBeNull()
  })
})
