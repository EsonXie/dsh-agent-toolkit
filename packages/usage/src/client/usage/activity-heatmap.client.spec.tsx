// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('./ActivityHeatmap.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('./chart.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

import { shiftDate } from '../../usage/aggregate.ts'
import { ActivityHeatmap } from './ActivityHeatmap.tsx'

const TODAY = '2026-08-18'
const DAYS = Array.from({ length: 91 }, (_, i) => ({
  date: shiftDate(TODAY, i - 90), billed: i === 90 ? 14500 : 0, calls: i === 90 ? 2 : 0, fresh: 0, cached: 0,
}))

afterEach(cleanup)

test('渲染 91 个格子按钮，未来格禁用且无点击', () => {
  const onSelectDay = vi.fn()
  const { container } = render(<ActivityHeatmap today={TODAY} days={DAYS} onSelectDay={onSelectDay} />)
  const cells = container.querySelectorAll('.week button')
  expect(cells).toHaveLength(91)
  expect(container.querySelectorAll('.week button:disabled')).toHaveLength(4)
})

test('点击非未来格回调该日期；未来格不可点', () => {
  const onSelectDay = vi.fn()
  const { container } = render(<ActivityHeatmap today={TODAY} days={DAYS} onSelectDay={onSelectDay} />)
  const todayCell = Array.from(container.querySelectorAll('.week button'))
    .find((c) => c.getAttribute('data-date') === TODAY)!
  fireEvent.click(todayCell)
  expect(onSelectDay).toHaveBeenCalledWith(TODAY)
})

test('悬停格子显示自定义 tooltip 卡片（日期 + 用量 + 次数）', () => {
  const { container, getByText } = render(<ActivityHeatmap today={TODAY} days={DAYS} onSelectDay={() => {}} />)
  const todayCell = Array.from(container.querySelectorAll('.week button'))
    .find((c) => c.getAttribute('data-date') === TODAY)!
  fireEvent.mouseEnter(todayCell)
  expect(getByText(TODAY)).toBeTruthy()
  expect(getByText(/14\.5K/)).toBeTruthy()
  expect(getByText(/2 次/)).toBeTruthy()
})

test('星期标签（一/三/五）与少多图例', () => {
  const { getByText } = render(<ActivityHeatmap today={TODAY} days={DAYS} onSelectDay={() => {}} />)
  expect(getByText('一')).toBeTruthy()
  expect(getByText('三')).toBeTruthy()
  expect(getByText('五')).toBeTruthy()
  expect(getByText('少')).toBeTruthy()
  expect(getByText('多')).toBeTruthy()
})

test('跨月列渲染月份标签', () => {
  const { container } = render(<ActivityHeatmap today={TODAY} days={DAYS} onSelectDay={() => {}} />)
  const labels = Array.from(container.querySelectorAll('span')).map((s) => s.textContent)
  expect(labels).toContain('6月')
  expect(labels).toContain('7月')
  expect(labels).toContain('8月')
})
