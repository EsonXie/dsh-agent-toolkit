// @vitest-environment jsdom
import { cloneElement, type ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('./chart.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>()
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      cloneElement(children, { width: 600, height: 160 }),
  }
})

import { RangeBarChart } from './RangeBarChart.tsx'

afterEach(cleanup)

const DAYS = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-08-1${i + 2}`, billed: 0, calls: i, fresh: 100 * i, cached: 10 * i,
}))

test('渲染 SVG 图表与新增/缓存图例，X 轴为 MM-DD', () => {
  const { container } = render(<RangeBarChart days={DAYS} />)
  expect(container.querySelector('svg')).not.toBeNull()
  expect(screen.getByText('新增')).toBeTruthy()
  expect(screen.getByText('缓存')).toBeTruthy()
  expect(screen.getByText('08-12')).toBeTruthy()
})

test('全零范围也渲染（空柱不崩）', () => {
  const zero = DAYS.map((d) => ({ ...d, fresh: 0, cached: 0, calls: 0 }))
  const { container } = render(<RangeBarChart days={zero} />)
  expect(container.querySelector('svg')).not.toBeNull()
})
