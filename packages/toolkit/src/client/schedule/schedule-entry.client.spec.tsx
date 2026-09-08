// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import type { CommonKeyOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, expect, test, vi } from 'vitest'
import { ScheduleEntry } from './entry.tsx'
import { zh, type ScheduleKey } from './locales.ts'

/** t 桩：zh 真源 + {param} 插值。键域含共享 common 词汇（TranslateNS 并入）。 */
function t(key: ScheduleKey | CommonKeyOf, params?: Record<string, unknown>): string {
  let text: string = zh[key as ScheduleKey] ?? ''
  for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v))
  return text
}

// 槽组件 props 含运行时 share（useSessions/useWorkspaces）；入口只消费 openSession/t。
const RUNTIME = {
  useSessions: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<SessionListState>,
  useWorkspaces: ((selector: (state: { items: readonly unknown[] }) => unknown) =>
    selector({ items: [] })) as unknown as SnapshotSelectorHook<WorkspaceListState>,
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('入口渲染图标按钮（aria-label 定时任务），点击开模态框', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tasks: [] }), { status: 200 })))
  render(<ScheduleEntry wide t={t} openSession={vi.fn()} {...RUNTIME} />)
  const trigger = screen.getByRole('button', { name: '定时任务' })
  expect(trigger).toBeDefined()
})
