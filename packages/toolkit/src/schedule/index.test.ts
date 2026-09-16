/** setupSchedule permissionPreset 接线守护：配置后任务会话建账统一应用宿主权限预设
 *  （镜像 bots/index.test.ts 的 setupBots permissionPreset 接线）。 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { setupSchedule, type ScheduleModuleConfig } from './index.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import { createAgentsPort } from '../channels/agents-port.ts'

vi.mock('../channels/agents-port.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../channels/agents-port.ts')>()
  return { ...original, createAgentsPort: vi.fn(original.createAgentsPort) }
})

beforeEach(() => vi.mocked(createAgentsPort).mockClear())

function makeConfig(): ScheduleModuleConfig {
  return { runTimeoutMinutes: 60, runHistoryLimit: 20 }
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

function makeCtx(permissionPresets?: unknown): Context {
  return {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    storageDomain: {
      open: () => Promise.resolve({
        table: () => ({ keys: () => [] }),
        close: async () => {},
      }),
    },
    effect: () => {},
    on: vi.fn(() => () => {}),
    agents: { create: vi.fn(), resume: vi.fn(), get: vi.fn(() => undefined), roots: () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'spawn', model: 'deepseek-chat' }) },
    get: vi.fn((name: string) => (name === 'permissionPresets' ? permissionPresets : undefined)),
  } as unknown as Context
}

describe('setupSchedule permissionPreset 接线', () => {
  test('配置 permissionPreset：createAgentsPort 第 4 参为应用器，调用后落到 svc.set(session, name)', () => {
    const set = vi.fn()
    const svc = { names: ['workspace-write', 'danger-full-access'], set }
    const ctx = makeCtx(svc)
    setupSchedule(ctx, { ...makeConfig(), permissionPreset: 'danger-full-access' }, { registry: makeRegistry(), cronExcludedSessions: new Set() })
    const applyPreset = vi.mocked(createAgentsPort).mock.calls[0]![3]
    expect(typeof applyPreset).toBe('function')
    const session = {} as Parameters<NonNullable<typeof applyPreset>>[0]
    applyPreset!(session)
    expect(set).toHaveBeenCalledWith(session, 'danger-full-access')
  })

  test('未配置 permissionPreset：createAgentsPort 第 4 参为 undefined', () => {
    const ctx = makeCtx()
    setupSchedule(ctx, makeConfig(), { registry: makeRegistry(), cronExcludedSessions: new Set() })
    expect(vi.mocked(createAgentsPort).mock.calls[0]![3]).toBeUndefined()
  })
})
