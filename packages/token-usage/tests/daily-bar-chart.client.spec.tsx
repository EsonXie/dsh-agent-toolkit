// @vitest-environment jsdom
import { cloneElement, type ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('../src/client/chart.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
// jsdom 无布局，ResponsiveContainer 量不出尺寸就不渲染子树；mock 成固定尺寸克隆。
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children, { width: 600, height: 160 }),
  }
})

import { emptyDaily } from '../src/aggregate.ts'
import { DailyBarChart } from '../src/client/DailyBarChart.tsx'

afterEach(cleanup)

test('渲染 SVG 图表与新增/缓存图例', () => {
  const record = emptyDaily('2026-08-18')
  record.hours[10] = { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0, estimated: 0, calls: 2 }
  const { container } = render(<DailyBarChart record={record} />)
  expect(container.querySelector('svg')).not.toBeNull()
  expect(screen.getByText('新增')).toBeTruthy()
  expect(screen.getByText('缓存')).toBeTruthy()
})

test('全零日也渲染（空柱不崩）', () => {
  const { container } = render(<DailyBarChart record={emptyDaily('2026-08-18')} />)
  expect(container.querySelector('svg')).not.toBeNull()
})
