// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PromptLayersEntry } from './entry.tsx'

const RUNTIME = {
  useSessions: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<SessionListState>,
  useWorkspaces: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<WorkspaceListState>,
}

const PAYLOAD = {
  layers: [{ name: 'base', order: 0, text: 'B' }],
  rules: [],
  seedLayers: [{ name: 'base', order: 0, text: 'B' }],
  native: { sections: [], contexts: [] },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } })))
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('宽栏与窄栏均仅图标（Tooltip/aria-label 提供可访问名）', () => {
  const { unmount } = render(<PromptLayersEntry wide {...RUNTIME} />)
  expect(screen.getByRole('button', { name: '分层提示词' }).textContent).not.toContain('分层提示词')
  unmount()
  render(<PromptLayersEntry wide={false} {...RUNTIME} />)
  expect(screen.getByRole('button', { name: '分层提示词' }).textContent).not.toContain('分层提示词')
})

test('点击打开模态框并拉取列表', async () => {
  render(<PromptLayersEntry wide {...RUNTIME} />)
  screen.getByRole('button', { name: '分层提示词' }).click()
  // 层名只出现在行按钮里
  expect(await screen.findByText('base', { selector: 'button > span' })).toBeTruthy()
})
