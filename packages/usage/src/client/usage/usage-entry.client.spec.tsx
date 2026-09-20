// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { shiftDate } from '../../usage/aggregate.ts'
import { UsageEntry } from './entry.tsx'

const TODAY = '2026-08-18'

// utilities 槽组件不消费任何 prop（owner props 为空 marker，standard props 用不上），空对象强转即可。
const PROPS = {} as unknown as PropsRuntime<'conversation.session.header.utilities'>

const HEATMAP_PAYLOAD = {
  today: TODAY,
  from: shiftDate(TODAY, -90),
  to: TODAY,
  days: Array.from({ length: 91 }, (_, i) => ({
    date: shiftDate(TODAY, i - 90), billed: 0, calls: 0, fresh: 0, cached: 0,
  })),
  aggregate: {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 },
    byModel: {}, byProject: {},
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 },
  },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(HEATMAP_PAYLOAD), {
    status: 200, headers: { 'content-type': 'application/json' },
  })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('入口为仅图标按钮（aria-label 提供可访问名）', () => {
  render(<UsageEntry {...PROPS} />)
  const button = screen.getByRole('button', { name: 'Token 用量' })
  expect(button.textContent).not.toContain('Token 用量')
})

test('点击打开用量模态框，默认进入活动视图并拉取 91 天范围数据', async () => {
  render(<UsageEntry {...PROPS} />)
  screen.getByRole('button', { name: 'Token 用量' }).click()
  expect(await screen.findByText('近 13 周活动')).toBeTruthy()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/dsh-agent-toolkit/api/usage/range?days=91')
})
