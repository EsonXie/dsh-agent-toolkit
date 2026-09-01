// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { SubagentModelChip } from './SubagentModelChip.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const t = (key: string, params?: Record<string, unknown>): string => {
  const dict: Record<string, string> = { 'header.modelAria': '子会话模型 {route}' }
  let text = dict[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) text = text.replace(`{${k}}`, String(v))
  return text
}

function propsWith(subagent: unknown) {
  return {
    sessionId: 'child-1',
    useSession: (selector: (s: { subagent: unknown }) => unknown) => selector({ subagent }),
    t,
  } as unknown as Parameters<typeof SubagentModelChip>[0]
}

const ADDRESS = { parentSessionId: 'p1', childSessionId: 'child-1', mode: 'one-shot' }

test('非子会话：渲染 null，不发起 fetch', () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const { container } = render(<SubagentModelChip {...propsWith(null)} />)
  expect(container.firstChild).toBeNull()
  expect(fetchMock).not.toHaveBeenCalled()
})

test('子会话且路由命中：渲染 provider / model chip', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  })))
  render(<SubagentModelChip {...propsWith(ADDRESS)} />)
  expect(await screen.findByText('deepseek / deepseek-chat')).toBeTruthy()
  expect(fetch).toHaveBeenCalledWith('/dsh-agent-toolkit/api/delegate/route?session=child-1')
})

test('子会话但无路由记录（404）：渲染 null', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
  const { container } = render(<SubagentModelChip {...propsWith(ADDRESS)} />)
  await vi.waitFor(() => { expect(fetch).toHaveBeenCalled() })
  expect(container.firstChild).toBeNull()
})
