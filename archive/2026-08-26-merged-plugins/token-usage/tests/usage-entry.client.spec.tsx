// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { shiftDate } from '../src/aggregate.ts'
import { UsageEntry } from '../src/client/UsageEntry.tsx'

const TODAY = '2026-08-18'

const RANGE_PAYLOAD = {
  today: TODAY,
  days: Array.from({ length: 91 }, (_, i) => ({
    date: shiftDate(TODAY, i - 90),
    billed: 0,
    calls: 0,
  })),
}

const DAY_PAYLOAD = {
  today: TODAY,
  record: {
    date: '2026-08-18',
    hours: Array.from({ length: 24 }, () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 })),
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 },
    byModel: {}, byProject: {}, bySession: {},
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 },
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

test('宽栏：图标 + 文字标签', () => {
  render(<UsageEntry wide />)
  const button = screen.getByRole('button', { name: 'Token 用量' })
  expect(button.textContent).toContain('Token 用量')
})

test('窄栏：仅图标，无文字', () => {
  render(<UsageEntry wide={false} />)
  const button = screen.getByRole('button', { name: 'Token 用量' })
  expect(button.textContent).not.toContain('Token 用量')
})

test('点击打开用量模态框，默认进入活动视图并拉取范围数据', async () => {
  render(<UsageEntry wide />)
  screen.getByRole('button', { name: 'Token 用量' }).click()
  expect(await screen.findByText('近 13 周活动')).toBeTruthy()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/token-usage/api/range?days=91')
})
