import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createScopeJoiner } from './scope-joiner.ts'
import type { ToolsScope } from './tool-scope.ts'

function harness(agentPresets: unknown) {
  const ctx = { get: vi.fn(() => agentPresets) } as unknown as Context
  const agentCtx = { fake: 'agentCtx' } as unknown as Context
  const fallbackJoin = vi.fn(() => Promise.resolve({ origin: 'fallback' }))
  const fallback = { join: fallbackJoin, dispose: vi.fn() } as unknown as ToolsScope
  const warn = vi.fn()
  return { ctx, agentCtx, fallback, fallbackJoin, warn }
}

describe('createScopeJoiner', () => {
  test('mount 成功：挂 preset，不进回退', async () => {
    const mount = vi.fn(() => Promise.resolve({ id: 'agent-bot' }))
    const { ctx, agentCtx, fallbackJoin, warn } = harness({ mount })
    await createScopeJoiner(ctx, 'agent-bot', { join: fallbackJoin } as unknown as ToolsScope, warn).join(agentCtx)
    expect(mount).toHaveBeenCalledWith(agentCtx, 'agent-bot')
    expect(fallbackJoin).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  test('mount 抛错：warn（含 preset id 与委派缺陷提示）后回退 toolsScope', async () => {
    const mount = vi.fn(() => Promise.reject(new Error('preset "agent-bot" not found')))
    const { ctx, agentCtx, fallbackJoin, warn } = harness({ mount })
    await createScopeJoiner(ctx, 'agent-bot', { join: fallbackJoin } as unknown as ToolsScope, warn).join(agentCtx)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent-bot'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('委派子会话'))
    expect(fallbackJoin).toHaveBeenCalledWith(agentCtx)
  })

  test('agentPresets 缺席（rc2 旧宿主）：静默回退，不 warn', async () => {
    const { ctx, agentCtx, fallbackJoin, warn } = harness(undefined)
    await createScopeJoiner(ctx, 'agent-bot', { join: fallbackJoin } as unknown as ToolsScope, warn).join(agentCtx)
    expect(fallbackJoin).toHaveBeenCalledWith(agentCtx)
    expect(warn).not.toHaveBeenCalled()
  })
})
