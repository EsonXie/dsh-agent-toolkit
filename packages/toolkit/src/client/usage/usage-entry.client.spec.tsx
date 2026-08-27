// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { shiftDate } from '../../usage/aggregate.ts'
import { UsageEntry } from './entry.tsx'

const TODAY = '2026-08-18'

// 槽组件 props 含运行时 share（useSessions/useWorkspaces）；本入口不消费，桩函数调用即抛。
const RUNTIME = {
  useSessions: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<SessionListState>,
  useWorkspaces: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<WorkspaceListState>,
}

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
    const payload = url.startsWith('/dsh-agent-toolkit/api/usage/range') ? RANGE_PAYLOAD : DAY_PAYLOAD
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('宽栏：仅图标，无文字（Tooltip/aria-label 提供可访问名）', () => {
  render(<UsageEntry wide {...RUNTIME} />)
  const button = screen.getByRole('button', { name: 'Token 用量' })
  expect(button.textContent).not.toContain('Token 用量')
})

test('窄栏：仅图标，无文字', () => {
  render(<UsageEntry wide={false} {...RUNTIME} />)
  const button = screen.getByRole('button', { name: 'Token 用量' })
  expect(button.textContent).not.toContain('Token 用量')
})

test('点击打开用量模态框，默认进入活动视图并拉取范围数据', async () => {
  render(<UsageEntry wide {...RUNTIME} />)
  screen.getByRole('button', { name: 'Token 用量' }).click()
  expect(await screen.findByText('近 13 周活动')).toBeTruthy()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/dsh-agent-toolkit/api/usage/range?days=91')
})
