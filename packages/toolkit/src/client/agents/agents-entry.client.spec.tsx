// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AgentsEntry } from './entry.tsx'

const AGENTS = [
  { id: 'main', name: '主 Agent', builtin: true },
  { id: 'explorer', name: 'Explorer', description: '快速只读代码库探索', builtin: true },
]

// 槽组件 props 含运行时 share（useSessions/useWorkspaces）；本入口不消费，桩函数调用即抛。
const RUNTIME = {
  useSessions: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<SessionListState>,
  useWorkspaces: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<WorkspaceListState>,
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url === '/dsh-agent-toolkit/api/agents'
      ? AGENTS
      : url === '/dsh-agent-toolkit/api/tools' ? { native: ['bash'], global: [] } : url === '/dsh-agent-toolkit/api/providers' ? [] : []
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('宽栏与窄栏均仅图标（Tooltip/aria-label 提供可访问名）', () => {
  const { unmount } = render(<AgentsEntry wide {...RUNTIME} />)
  expect(screen.getByRole('button', { name: 'Agent 管理' }).textContent).not.toContain('Agent 管理')
  unmount()
  render(<AgentsEntry wide={false} {...RUNTIME} />)
  expect(screen.getByRole('button', { name: 'Agent 管理' }).textContent).not.toContain('Agent 管理')
})

test('点击打开 Agent 管理模态框并拉取列表', async () => {
  render(<AgentsEntry wide {...RUNTIME} />)
  screen.getByRole('button', { name: 'Agent 管理' }).click()
  expect(await screen.findByText('Explorer')).toBeTruthy()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/dsh-agent-toolkit/api/agents')
})
