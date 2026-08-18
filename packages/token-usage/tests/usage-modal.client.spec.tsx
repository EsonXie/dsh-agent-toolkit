// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// Deterministic class names: the width-override assertion must not depend on
// the bundler's hashed output.
vi.mock('../src/client/UsageModal.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

import { UsageModal } from '../src/client/UsageModal.tsx'

const DAY_PAYLOAD = {
  today: '2026-08-18',
  record: {
    date: '2026-08-18',
    hours: Array.from({ length: 24 }, () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 })),
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 },
    byModel: { 'deepseek/deepseek-chat': { input: 14000, output: 500, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 1, estimatedCalls: 0 } },
    byProject: {},
    bySession: {
      'session-76afe15b-21dc-4280-8b11-f0da78695596': {
        input: 14000, output: 500, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 1, estimatedCalls: 0,
        cwd: 'D:/work/laiye/work/github/LeaderAgent',
      },
    },
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0, estimatedCalls: 0 },
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

test('对话框携带加宽覆盖类（Modal 默认 380px 会裁切图表与行）', () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  const dialog = screen.getByRole('dialog')
  expect(dialog.classList.contains('dialog')).toBe(true)
})

test('不渲染按会话细分（数据存在也不展示）', async () => {
  render(<UsageModal open onClose={() => {}} initialDate={null} />)
  expect(await screen.findByText('按模型')).toBeTruthy()
  expect(screen.queryByText('按会话')).toBeNull()
  expect(screen.queryByText(/session-76afe15b/)).toBeNull()
})
