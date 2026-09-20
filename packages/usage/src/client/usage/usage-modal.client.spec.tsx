// @vitest-environment jsdom
import { cloneElement, type ReactElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('./UsageModal.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('./ActivityHeatmap.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
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

import { shiftDate } from '../../usage/aggregate.ts'
import { UsageModal } from './UsageModal.tsx'

const TODAY = '2026-08-18'

const HEATMAP_PAYLOAD = {
  today: TODAY,
  from: shiftDate(TODAY, -90),
  to: TODAY,
  days: Array.from({ length: 91 }, (_, i) => ({
    date: shiftDate(TODAY, i - 90), billed: i === 90 ? 14500 : 0, calls: i === 90 ? 1 : 0, fresh: 0, cached: 0,
  })),
  aggregate: {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 },
    byModel: {}, byProject: {},
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 },
  },
}

const SINGLE_DAY_PAYLOAD = {
  today: TODAY,
  from: TODAY,
  to: TODAY,
  days: [{ date: TODAY, billed: 70500, calls: 1, fresh: 14500, cached: 56000 }],
  aggregate: {
    totals: { input: 14000, output: 500, cacheRead: 56000, cacheWrite: 0, estimated: 0, calls: 1, estimatedCalls: 0 },
    byModel: { 'deepseek/deepseek-chat': { input: 14000, output: 500, cacheRead: 56000, cacheWrite: 0, estimated: 0, calls: 1 } },
    byProject: {},
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 },
  },
  hours: Array.from({ length: 24 }, () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 })),
}

const MULTI_DAY_PAYLOAD = {
  today: TODAY,
  from: '2026-08-12',
  to: TODAY,
  days: Array.from({ length: 7 }, (_, i) => ({
    date: shiftDate(TODAY, i - 6), billed: 100, calls: 1, fresh: 80, cached: 20,
  })),
  aggregate: {
    totals: { input: 560, output: 0, cacheRead: 140, cacheWrite: 0, estimated: 0, calls: 7, estimatedCalls: 0 },
    byModel: { 'deepseek/deepseek-chat': { input: 560, output: 0, cacheRead: 140, cacheWrite: 0, estimated: 0, calls: 7 } },
    byProject: { 'proj-a': { input: 560, output: 0, cacheRead: 140, cacheWrite: 0, estimated: 0, calls: 7 } },
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 },
  },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.includes('days=91') ? HEATMAP_PAYLOAD
      : url.includes(`from=${TODAY}&to=${TODAY}`) ? SINGLE_DAY_PAYLOAD
      : MULTI_DAY_PAYLOAD
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('initialDate 为 null 时默认打开活动 tab', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  expect(await screen.findByText('近 13 周活动')).toBeTruthy()
  expect(screen.getByRole('tab', { name: '活动' }).getAttribute('aria-selected')).toBe('true')
})

test('initialDate 非 null 时打开趋势 tab 且按单日拉取（from=to）', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  expect(await screen.findByText('按模型')).toBeTruthy()
  expect(screen.getByRole('tab', { name: '趋势' }).getAttribute('aria-selected')).toBe('true')
  expect(vi.mocked(fetch)).toHaveBeenCalledWith(`/dsh-agent-toolkit/api/usage/range?from=${TODAY}&to=${TODAY}`)
})

test('切到趋势 tab 默认近 30 天（days=30），渲染按天柱状图', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  await screen.findByText('近 13 周活动')
  fireEvent.click(screen.getByRole('tab', { name: '趋势' }))
  expect(await screen.findByText('范围总量', { exact: false })).toBeTruthy()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/dsh-agent-toolkit/api/usage/range?days=30')
})

test('单日范围显示「当日总量」与缓存命中率（56000/(14000+56000)=80%）', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  expect(await screen.findByText(/当日总量/)).toBeTruthy()
  expect(await screen.findByText(/缓存命中率 80%/)).toBeTruthy()
})

test('多日范围显示聚合 breakdown（按模型/按项目）', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  await screen.findByText('近 13 周活动')
  fireEvent.click(screen.getByRole('tab', { name: '趋势' }))
  expect(await screen.findByText('按模型')).toBeTruthy()
  expect(screen.getByText('按项目')).toBeTruthy()
})

test('自定义起止日期倒置时不发请求并提示', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  await screen.findByText('按模型')
  const calls = vi.mocked(fetch).mock.calls.length
  const [fromInput, toInput] = screen.getAllByLabelText(/起始日期|截止日期/)
  fireEvent.change(fromInput, { target: { value: '2026-08-18' } })
  fireEvent.change(toInput, { target: { value: '2026-08-01' } })
  expect(await screen.findByText(/起始日期不能晚于截止日期/)).toBeTruthy()
  expect(vi.mocked(fetch).mock.calls.length).toBe(calls)
})

test('切回预设后清除自定义区间错误提示', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  await screen.findByText('按模型')
  const [fromInput, toInput] = screen.getAllByLabelText(/起始日期|截止日期/)
  fireEvent.change(fromInput, { target: { value: '2026-08-18' } })
  fireEvent.change(toInput, { target: { value: '2026-08-01' } })
  expect(await screen.findByText(/起始日期不能晚于截止日期/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '近 7 天' }))
  expect(screen.queryByText(/起始日期不能晚于截止日期/)).toBeNull()
  expect(await screen.findByText('范围总量', { exact: false })).toBeTruthy()
})
