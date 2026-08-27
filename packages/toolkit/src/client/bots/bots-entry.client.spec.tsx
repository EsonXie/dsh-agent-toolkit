// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BotsEntry } from './entry.tsx'

const BOTS = {
  bots: [{
    id: 'reviewer', name: '评审机器人', channel: 'feishu',
    feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
    project: 'D:\\work\\demo', status: 'connected', createdAt: 1, updatedAt: 1,
  }],
}

// 槽组件 props 含运行时 share（useSessions/useWorkspaces）；入口只消费 useWorkspaces。
const RUNTIME = {
  useSessions: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<SessionListState>,
  useWorkspaces: ((selector: (state: { items: readonly unknown[] }) => unknown) =>
    selector({ items: [] })) as unknown as SnapshotSelectorHook<WorkspaceListState>,
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.startsWith('/dsh-agent-toolkit/api/bots/bots') ? BOTS : { tools: ['bash'] }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('宽栏与窄栏均仅图标（Tooltip/aria-label 提供可访问名）', () => {
  const { unmount } = render(<BotsEntry wide {...RUNTIME} />)
  expect(screen.getByRole('button', { name: '消息机器人' }).textContent).not.toContain('消息机器人')
  unmount()
  render(<BotsEntry wide={false} {...RUNTIME} />)
  expect(screen.getByRole('button', { name: '消息机器人' }).textContent).not.toContain('消息机器人')
})

test('点击打开机器人列表模态框并拉取列表', async () => {
  render(<BotsEntry wide {...RUNTIME} />)
  screen.getByRole('button', { name: '消息机器人' }).click()
  expect(await screen.findByText('评审机器人')).toBeTruthy()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/dsh-agent-toolkit/api/bots/bots')
})
