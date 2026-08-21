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
