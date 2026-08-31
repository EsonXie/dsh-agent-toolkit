// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('./ActivityHeatmap.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('./chart.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

import { shiftDate } from '../../usage/aggregate.ts'
import { ActivityHeatmap } from './ActivityHeatmap.tsx'

// 2026-08-18 是周二：末列含 4 个未来格（周三~周六）。
const TODAY = '2026-08-18'
const DAYS = Array.from({ length: 91 }, (_, i) => ({ date: shiftDate(TODAY, i - 90), billed: 0, calls: 0 }))

afterEach(cleanup)

test('渲染 91 格纯展示格子，未来格带 aria-disabled', () => {
  const { container } = render(<ActivityHeatmap today={TODAY} days={DAYS} />)
  const cells = container.querySelectorAll('.week > div')
  expect(cells).toHaveLength(91)
  expect(container.querySelectorAll('[aria-disabled="true"]')).toHaveLength(4)
  // 非未来格携带 title tooltip；未来格没有
  const todayCell = Array.from(cells).find((c) => (c as HTMLElement).title.startsWith(TODAY))
  expect(todayCell).toBeDefined()
  expect(container.querySelectorAll('.week > div[title]')).toHaveLength(87)
})

test('跨月列渲染月份标签', () => {
  const { container } = render(<ActivityHeatmap today={TODAY} days={DAYS} />)
  // 2026-05-24 ~ 2026-08-22 跨 5/6/7/8 四个月，至少出现 6/7/8 三个标签
  const labels = Array.from(container.querySelectorAll('span')).map((s) => s.textContent)
  expect(labels).toContain('6月')
  expect(labels).toContain('7月')
  expect(labels).toContain('8月')
})
