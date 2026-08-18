// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { UsageEntry } from '../src/client/UsageEntry.tsx'

const DAY_PAYLOAD = {
  today: '2026-08-18',
  record: {
    date: '2026-08-18',
    hours: Array.from({ length: 24 }, () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 })),
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 },
    byModel: {}, byProject: {}, bySession: {},
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 },
  },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(DAY_PAYLOAD), {
    status: 200, headers: { 'content-type': 'application/json' },
  })))
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

test('点击打开用量模态框并拉取当日数据', async () => {
  render(<UsageEntry wide />)
  screen.getByRole('button', { name: 'Token 用量' }).click()
  expect(await screen.findByText('当日总量', { exact: false })).toBeTruthy()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/token-usage/api/daily')
})
