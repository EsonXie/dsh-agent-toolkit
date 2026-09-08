import { describe, expect, test, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { createExecutor, TASK_SECTION_NAME, taskSectionText, type ExecutorDeps } from './executor.ts'
import type { AgentHooks, AgentPort, AgentsPort } from '../channels/ports.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import type { CronRun, CronTask } from './store.ts'

const NOW = Date.parse('2026-09-07T00:00:00.000Z')

const task = (over: Partial<CronTask>): CronTask => ({
  id: 't1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *' },
  target: { kind: 'main' }, catchup: false, enabled: true,
  nextRunAt: null, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
  ...over,
})

interface CreateCall { sessionId: string; cwd: string; agentOptions?: { provider?: string; model?: string }; hooks: AgentHooks }

function fakeTable<V>(): KvTable<string, V> & { data: Map<string, V> } {
  const data = new Map<string, V>()
  return {
    data,
    get: (k: string) => data.get(k),
    put: async (k: string, v: V) => { data.set(k, v) },
    delete: async (k: string) => data.delete(k),
    entries: () => data.entries(),
  } as unknown as KvTable<string, V> & { data: Map<string, V> }
}

const EMPTY_REGISTRY: AgentRegistry = {
  list: () => [], get: () => undefined,
  upsert: async () => undefined, remove: async () => undefined, subscribe: () => () => undefined,
}

function makeDeps(over: {
  agent?: Partial<AgentPort>
  createImpl?: AgentsPort['create']
  registry?: AgentRegistry
  attachError?: Error
  delay?: (ms: number) => Promise<void>
} = {}) {
  const calls: CreateCall[] = []
  const runs = fakeTable<CronRun>()
  const agent: AgentPort = {
    sessionId: 'sess-1',
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: () => Promise.resolve(),
    ...over.agent,
  }
  const deps: ExecutorDeps = {
    agents: {
      create: over.createImpl ?? (async (input) => { calls.push(input); return agent }),
      resume: async () => { throw new Error('not used') },
    },
    registry: over.registry ?? EMPTY_REGISTRY,
    defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    workspace: { attach: async () => { if (over.attachError !== undefined) throw over.attachError } },
    runs,
    runHistoryLimit: 20,
    runTimeoutMs: 60_000,
    warn: vi.fn(),
    now: () => NOW,
    newSessionId: () => 'sess-1',
    newRunId: () => 'run-1',
    delay: over.delay ?? (() => new Promise(() => undefined)), // 默认超时永不触发
  }
  return { deps, calls, runs, agent }
}

describe('taskSectionText', () => {
  test('来源段文本（任务名 + id + 触发时间）', () => {
    expect(taskSectionText(task({}), '2026-09-07T01:00:00.000Z'))
      .toBe('本会话由定时任务「日报」（id: t1）于 2026-09-07T01:00:00.000Z 触发。')
    expect(TASK_SECTION_NAME).toBe('dsh-agent-toolkit:schedule:task')
  })
})

describe('executor.trigger', () => {
  test('main 形态：宿主默认模型 + 仅来源段；followup(prompt) → whenIdle → ok', async () => {
    const { deps, calls, runs, agent } = makeDeps()
    const run = await createExecutor(deps).trigger(task({}))
    expect(calls).toHaveLength(1)
    expect(calls[0].agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(calls[0].hooks).toEqual({
      sections: [{ name: TASK_SECTION_NAME, order: 20, text: taskSectionText(task({}), new Date(NOW).toISOString()) }],
    })
    expect(agent.followup).toHaveBeenCalledWith('写日报')
    expect(run.status).toBe('ok')
    expect(run.sessionId).toBe('sess-1')
    expect(run.finishedAt).toBeDefined()
    expect(runs.data.get('run-1')?.status).toBe('ok')
  })

  test('role 形态：role.model + persona section（order 0）+ tools 白名单 + 来源段追加在尾', async () => {
    const registry: AgentRegistry = {
      ...EMPTY_REGISTRY,
      get: (id) => id === 'explorer'
        ? { id: 'explorer', name: 'Explorer', persona: '你是探索员。', model: { provider: 'anthropic', model: 'claude-sonnet-4' }, tools: { allow: ['read'] } }
        : undefined,
    }
    const { deps, calls } = makeDeps({ registry })
    await createExecutor(deps).trigger(task({ target: { kind: 'role', roleId: 'explorer' } }))
    expect(calls[0].agentOptions).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(calls[0].hooks.tools).toEqual(['read'])
    expect(calls[0].hooks.sections?.map((s) => s.name)).toEqual(['dsh-agent-toolkit:agent:persona', TASK_SECTION_NAME])
  })

  test('role 缺失：降级 main 形态并 warn（同 Router 语义）', async () => {
    const { deps, calls } = makeDeps()
    await createExecutor(deps).trigger(task({ target: { kind: 'role', roleId: 'ghost' } }))
    expect(calls[0].agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(calls[0].hooks.sections).toHaveLength(1)
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('ghost'))
  })

  test('agents.create 抛错 → run 记 error（不建会话不驱动）', async () => {
    const { deps, runs, agent } = makeDeps({ createImpl: async () => { throw new Error('boom') } })
    const run = await createExecutor(deps).trigger(task({}))
    expect(run.status).toBe('error')
    expect(run.error).toBe('boom')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(runs.data.get('run-1')?.status).toBe('error')
  })

  test('whenIdle 拒绝 → run 记 error（摘要截断 500 字符）', async () => {
    const long = 'x'.repeat(600)
    const { deps } = makeDeps({ agent: { whenIdle: () => Promise.reject(new Error(long)) } })
    const run = await createExecutor(deps).trigger(task({}))
    expect(run.status).toBe('error')
    expect(run.error).toHaveLength(500)
  })

  test('超时 → cancel + run 记 error(timeout)', async () => {
    const { deps, agent } = makeDeps({
      agent: { whenIdle: () => new Promise(() => undefined) }, // 永不空闲
      delay: () => Promise.resolve(), // 立即超时
    })
    const run = await createExecutor(deps).trigger(task({}))
    expect(agent.cancel).toHaveBeenCalled()
    expect(run.status).toBe('error')
    expect(run.error).toMatch(/timeout/)
  })

  test('workspace.attach 失败仅 warn（会话降级未分组），执行照常 ok', async () => {
    const { deps } = makeDeps({ attachError: new Error('no workspace') })
    const run = await createExecutor(deps).trigger(task({}))
    expect(run.status).toBe('ok')
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('workspace'))
  })

  test('环形裁剪：runHistoryLimit=2 时只留最近 2 条', async () => {
    const { deps, runs } = makeDeps()
    let n = 0
    deps.newRunId = () => `run-${++n}`
    const executor = createExecutor({ ...deps, runHistoryLimit: 2 })
    await executor.trigger(task({}))
    await executor.trigger(task({}))
    await executor.trigger(task({}))
    expect([...runs.data.keys()].sort()).toEqual(['run-2', 'run-3'])
  })
})
