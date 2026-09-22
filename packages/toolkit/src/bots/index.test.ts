import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { setupBots, type BotsModuleConfig, type BotsDeps } from './index.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import type { Binding, BotRecord } from './store.ts'
import type { ApprovalOutcome, ApprovalRequestLike } from '../channels/approval/center.ts'
import type { QuestionAnswerLike, QuestionRequestLike } from '../channels/questions/center.ts'
import { createAgentsPort } from '../channels/agents-port.ts'

vi.mock('../channels/agents-port.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../channels/agents-port.ts')>()
  return { ...original, createAgentsPort: vi.fn(original.createAgentsPort) }
})

beforeEach(() => vi.mocked(createAgentsPort).mockClear())

function makeConfig(approval: boolean, questions = true): BotsModuleConfig {
  return {
    cardUpdateThrottleMs: 500,
    cardMaxBytes: 28000,
    cardPrintStep: 5,
    processMaxBytes: 8000,
    registerAppTimeoutMs: 600000,
    processingReactionEmoji: 'OneSecond',
    errorDetailMaxChars: 500,
    injectSender: true,
    approval,
    questions,
    questionTimeoutMs: 300000,
    approvalTimeoutMs: 300000,
    docMaxBytes: 0,
    debugLog: false,
    debugLogDir: '',
    debugLogRetentionDays: 7,
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

/** 内存 KvTable（够 setupBots 启动链消费：get/keys/put/delete）。 */
function makeTable<V>(): KvTable<string, V> {
  const records = new Map<string, V>()
  return {
    get: (key) => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    get size() { return records.size },
    put: async (key, value) => { records.set(key, value) },
    delete: async (key) => records.delete(key),
    update: async (key, fn) => {
      const current = records.get(key)
      if (current === undefined) throw new Error(`missing-key: ${key}`)
      const next = fn(current)
      records.set(key, next)
      return next
    },
  }
}

/** setupBots 依赖：registry + 由插件入口打开的 project_bot 表句柄。 */
function makeDeps(overrides: Partial<BotsDeps> = {}): BotsDeps {
  return {
    registry: makeRegistry(),
    bots: makeTable<BotRecord>(),
    bindings: makeTable<Binding>(),
    ...overrides,
  }
}

function makeCtx(permissionPresets?: unknown): { ctx: Context; on: ReturnType<typeof vi.fn> } {
  const on = vi.fn(() => () => {})
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    effect: () => {},
    on,
    credentials: { set: vi.fn(async () => {}), resolve: vi.fn(async () => undefined), unset: vi.fn(async () => {}) },
    agents: { create: vi.fn(), resume: vi.fn(), get: vi.fn(() => undefined) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'spawn', model: 'deepseek-chat' }) },
    get: vi.fn((name: string) => (name === 'permissionPresets' ? permissionPresets : undefined)),
    inject: () => {},
  } as unknown as Context
  return { ctx, on }
}

function registrationsOf(on: ReturnType<typeof vi.fn>, event: string): { handler: unknown; options: unknown }[] {
  return on.mock.calls
    .filter(([name]) => name === event)
    .map(([, handler, options]) => ({ handler, options }))
}

function approvalRegistrations(on: ReturnType<typeof vi.fn>): { handler: unknown; options: unknown }[] {
  return registrationsOf(on, 'approval/request')
}

describe('setupBots 审批 answerer 注册门控', () => {
  test('approval=true：注册 approval/request answerer（prepend 抢在 web api-proxy 前）', () => {
    const { ctx, on } = makeCtx()
    setupBots(ctx, makeConfig(true), makeDeps())
    const regs = approvalRegistrations(on)
    expect(regs).toHaveLength(1)
    expect(regs[0]!.options).toEqual({ prepend: true })
    expect(typeof regs[0]!.handler).toBe('function')
  })

  test('approval=false：不注册 approval/request answerer（回到 web api-proxy 弹窗）', () => {
    const { ctx, on } = makeCtx()
    setupBots(ctx, makeConfig(false), makeDeps())
    expect(approvalRegistrations(on)).toHaveLength(0)
  })

  test('runtime 未启动（undefined）：注册的 answerer 透传 next', async () => {
    const { ctx, on } = makeCtx()
    setupBots(ctx, makeConfig(true), makeDeps())
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

describe('setupBots 问答 answerer 注册门控', () => {
  test('questions=true：注册 user-questions/request answerer（prepend 抢在 web api-proxy 前）', () => {
    const { ctx, on } = makeCtx()
    setupBots(ctx, makeConfig(true, true), makeDeps())
    const regs = registrationsOf(on, 'user-questions/request')
    expect(regs).toHaveLength(1)
    expect(regs[0]!.options).toEqual({ prepend: true })
    expect(typeof regs[0]!.handler).toBe('function')
  })

  test('questions=false：不注册 user-questions/request answerer（回到 web 浏览器应答）', () => {
    const { ctx, on } = makeCtx()
    setupBots(ctx, makeConfig(true, false), makeDeps())
    expect(registrationsOf(on, 'user-questions/request')).toHaveLength(0)
  })

  test('runtime 未启动（undefined）：注册的 answerer 透传 next', async () => {
    const { ctx, on } = makeCtx()
    setupBots(ctx, makeConfig(true, true), makeDeps())
    const handler = registrationsOf(on, 'user-questions/request')[0]!.handler as (
      req: QuestionRequestLike,
      next: () => Promise<QuestionAnswerLike>,
    ) => Promise<QuestionAnswerLike>
    const req: QuestionRequestLike = { questions: [{ id: 'q1', question: '继续吗？' }] }
    const answer = { answers: [{ id: 'q1', selected: [] }] }
    const next = vi.fn(async () => answer)
    expect(await handler(req, next)).toBe(answer)
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('setupBots permissionPreset 接线', () => {
  test('配置 permissionPreset：createAgentsPort 第 4 参为应用器，调用后落到 svc.set(session, name)', () => {
    const set = vi.fn()
    const svc = { names: ['workspace-write', 'danger-full-access'], set }
    const { ctx } = makeCtx(svc)
    setupBots(ctx, { ...makeConfig(true), permissionPreset: 'danger-full-access' }, makeDeps())
    const applyPreset = vi.mocked(createAgentsPort).mock.calls[0]![3]
    expect(typeof applyPreset).toBe('function')
    const session = {} as Parameters<NonNullable<typeof applyPreset>>[0]
    applyPreset!(session)
    expect(set).toHaveBeenCalledWith(session, 'danger-full-access')
  })

  test('未配置 permissionPreset：createAgentsPort 第 4 参为 undefined', () => {
    const { ctx } = makeCtx()
    setupBots(ctx, makeConfig(true), makeDeps())
    expect(vi.mocked(createAgentsPort).mock.calls[0]![3]).toBeUndefined()
  })
})

describe('setupBots cron 排除集接线', () => {
  test('bot 聊天会话不登记排除集：createAgentsPort 第 3 参恒为 undefined', () => {
    const { ctx } = makeCtx()
    setupBots(ctx, makeConfig(true), makeDeps())
    expect(vi.mocked(createAgentsPort).mock.calls[0]![2]).toBeUndefined()
  })
})
