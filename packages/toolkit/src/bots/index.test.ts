import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { setupBots, type BotsModuleConfig } from './index.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import type { ApprovalOutcome, ApprovalRequestLike } from '../channels/approval/center.ts'

function makeConfig(approval: boolean): BotsModuleConfig {
  return {
    cardUpdateThrottleMs: 500,
    cardMaxBytes: 28000,
    processMaxBytes: 8000,
    registerAppTimeoutMs: 600000,
    processingReactionEmoji: 'OneSecond',
    errorDetailMaxChars: 500,
    injectSender: true,
    approval,
  }
}

function makeRegistry(): AgentRegistry {
  return {
    list: () => [],
    get: () => undefined,
    upsert: async () => undefined,
    remove: async () => undefined,
    subscribe: () => () => undefined,
  }
}

function makeCtx(): { ctx: Context; on: ReturnType<typeof vi.fn> } {
  const on = vi.fn(() => () => {})
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    storageDomain: {
      open: () => Promise.resolve({
        table: () => ({ keys: () => [] }),
        close: async () => {},
      }),
    },
    effect: () => {},
    on,
    credentials: { set: vi.fn(async () => {}), resolve: vi.fn(async () => undefined), unset: vi.fn(async () => {}) },
    agents: { create: vi.fn(), resume: vi.fn() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'spawn', model: 'deepseek-chat' }) },
    get: () => undefined,
    inject: () => {},
  } as unknown as Context
  return { ctx, on }
}

function approvalRegistrations(on: ReturnType<typeof vi.fn>): { handler: unknown; options: unknown }[] {
  return on.mock.calls
    .filter(([event]) => event === 'approval/request')
    .map(([, handler, options]) => ({ handler, options }))
}

describe('setupBots 审批 answerer 注册门控', () => {
  test('approval=true：注册 approval/request answerer（prepend 抢在 web api-proxy 前）', () => {
    const { ctx, on } = makeCtx()
    setupBots(ctx, makeConfig(true), { registry: makeRegistry() })
    const regs = approvalRegistrations(on)
    expect(regs).toHaveLength(1)
    expect(regs[0]!.options).toEqual({ prepend: true })
    expect(typeof regs[0]!.handler).toBe('function')
  })

  test('approval=false：不注册 approval/request answerer（回到 web api-proxy 弹窗）', () => {
    const { ctx, on } = makeCtx()
    setupBots(ctx, makeConfig(false), { registry: makeRegistry() })
    expect(approvalRegistrations(on)).toHaveLength(0)
  })

  test('runtime 未启动（undefined）：注册的 answerer 透传 next', async () => {
    const { ctx, on } = makeCtx()
    setupBots(ctx, makeConfig(true), { registry: makeRegistry() })
    const handler = approvalRegistrations(on)[0]!.handler as (
      req: ApprovalRequestLike,
      next: () => Promise<ApprovalOutcome>,
    ) => Promise<ApprovalOutcome>
    const req: ApprovalRequestLike = { agent: { session: { id: 's1' } }, toolName: 'write' }
    const next = vi.fn(async () => 'unavailable' as const)
    expect(await handler(req, next)).toBe('unavailable')
    expect(next).toHaveBeenCalledTimes(1)
  })
})
