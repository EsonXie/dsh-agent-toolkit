// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// Deterministic class names: the width-override assertion must not depend on
// the bundler's hashed output.
vi.mock('../src/client/UsageModal.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('../src/client/ActivityHeatmap.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('../src/client/chart.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

import { shiftDate } from '../src/aggregate.ts'
import { UsageModal } from '../src/client/UsageModal.tsx'

// 2026-08-18 是周二。
const TODAY = '2026-08-18'

const RANGE_PAYLOAD = {
  today: TODAY,
  days: Array.from({ length: 91 }, (_, i) => ({
    date: shiftDate(TODAY, i - 90),
    billed: i === 90 ? 14500 : 0,
    calls: i === 90 ? 1 : 0,
  })),
}

const DAY_PAYLOAD = {
  today: TODAY,
  record: {
    date: TODAY,
    hours: Array.from({ length: 24 }, () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 })),
    totals: { input: 14000, output: 500, cacheRead: 56000, cacheWrite: 0, estimated: 0, calls: 1, estimatedCalls: 0 },
    byModel: { 'deepseek/deepseek-chat': { input: 14000, output: 500, cacheRead: 56000, cacheWrite: 0, estimated: 0, calls: 1, estimatedCalls: 0 } },
    byProject: {},
    bySession: {
      'session-76afe15b-21dc-4280-8b11-f0da78695596': {
        input: 14000, output: 500, cacheRead: 56000, cacheWrite: 0, estimated: 0, calls: 1, estimatedCalls: 0,
        cwd: 'D:/work/laiye/work/github/LeaderAgent',
      },
    },
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 },
  },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.startsWith('/token-usage/api/range') ? RANGE_PAYLOAD : DAY_PAYLOAD
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('对话框携带加宽覆盖类（Modal 默认 380px 会裁切图表与行）', () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  const dialog = screen.getByRole('dialog')
  expect(dialog.classList.contains('dialog')).toBe(true)
})

test('initialDate 为 null 时默认打开活动 tab', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  expect(await screen.findByText('近 13 周活动')).toBeTruthy()
  expect(screen.getByRole('tab', { name: '活动' }).getAttribute('aria-selected')).toBe('true')
})

test('点击"单日" tab 进入单日视图', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  await screen.findByText('近 13 周活动')
  fireEvent.click(screen.getByRole('tab', { name: '单日' }))
  expect(await screen.findByText('按模型')).toBeTruthy()
  expect(screen.getByRole('tab', { name: '单日' }).getAttribute('aria-selected')).toBe('true')
})

test('initialDate 非 null 时默认打开单日 tab 且日期为该日', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  expect(await screen.findByText('按模型')).toBeTruthy()
  expect(screen.getByRole('tab', { name: '单日' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.queryByText('近 13 周活动')).toBeNull()
})

test('tab 来回切换视图内容正确', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  await screen.findByText('近 13 周活动')
  fireEvent.click(screen.getByRole('tab', { name: '单日' }))
  await screen.findByText('按模型')
  fireEvent.click(screen.getByRole('tab', { name: '活动' }))
  expect(await screen.findByText('近 13 周活动')).toBeTruthy()
  expect(screen.queryByText('按模型')).toBeNull()
})

test('不渲染按会话细分（数据存在也不展示）', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  expect(await screen.findByText('按模型')).toBeTruthy()
  expect(screen.queryByText('按会话')).toBeNull()
  expect(screen.queryByText(/session-76afe15b/)).toBeNull()
})

test('总量行显示缓存命中率（56000/(14000+56000)=80%）', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={TODAY} />)
  expect(await screen.findByText(/缓存命中率 80%/)).toBeTruthy()
})
