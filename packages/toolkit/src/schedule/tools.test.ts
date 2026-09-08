import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createCronTools, setupCronTools } from './tools.ts'
import type { CronResult, CronService, CronTaskView } from './service.ts'
import type { CronRun, CronTask } from './store.ts'

const T0 = Date.parse('2026-09-07T00:00:00.000Z')

const VIEW: CronTaskView = {
  id: 'task-1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *' }, target: { kind: 'main' },
  catchup: true, enabled: true, nextRunAt: '2026-09-07T09:00:00.000Z',
  createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
}

function fakeService(over: Partial<CronService> = {}): CronService & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = []
  const record = <A extends unknown[], R>(method: string, impl: (...args: A) => R) =>
    (...args: A): R => { calls.push({ method, args }); return impl(...args) }
  return {
    calls,
    list: record('list', () => [VIEW]),
    get: record('get', (id: string) => (id === 'task-1' ? VIEW : undefined)),
    create: record('create', async (): Promise<CronResult<CronTask>> => ({ ok: true, value: VIEW })),
    update: record('update', async (): Promise<CronResult<CronTask>> => ({ ok: true, value: VIEW })),
    remove: record('remove', async (): Promise<CronResult<null>> => ({ ok: true, value: null })),
    trigger: record('trigger', async (): Promise<CronResult<CronRun>> => ({
      ok: true, value: { id: 'run-1', taskId: 'task-1', triggeredAt: new Date(T0).toISOString(), status: 'ok' },
    })),
    runsOf: record('runsOf', () => []),
    ...over,
  }
}

type Exec = (args: Record<string, unknown>) => Promise<unknown>

function execOf(tools: ReturnType<typeof createCronTools>, name: string): Exec {
  const tool = tools.find((t) => t.name === name)
  if (tool === undefined) throw new Error(`tool ${name} not registered`)
  return tool.execute as unknown as Exec
}

describe('createCronTools', () => {
  test('注册 5 个 cron_ 前缀工具', () => {
    expect(createCronTools(fakeService()).map((t) => t.name)).toEqual([
      'cron_task_create', 'cron_task_list', 'cron_task_update', 'cron_task_delete', 'cron_task_trigger',
    ])
  })

  test('create：扁平参数装配 schedule/target 三选一；服务 ok:false → 抛错', async () => {
    const service = fakeService()
    const exec = execOf(createCronTools(service), 'cron_task_create')
    await exec({
      name: '日报', prompt: '写日报', cwd: 'D:\\work',
      scheduleKind: 'cron', cronExpr: '0 9 * * *', timeZone: 'Asia/Shanghai',
      targetKind: 'role', roleId: 'explorer', catchup: true, enabled: true,
    })
    expect(service.calls[0].args[0]).toEqual({
      name: '日报', prompt: '写日报', cwd: 'D:\\work',
      schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' },
      target: { kind: 'role', roleId: 'explorer' },
      catchup: true, enabled: true,
    })
    // at / every 装配
    await exec({ name: 'a', prompt: 'p', cwd: 'c', scheduleKind: 'at', atTime: '2026-09-08T00:00:00Z', targetKind: 'main', catchup: false, enabled: true })
    expect(service.calls[1].args[0]).toMatchObject({ schedule: { kind: 'at', at: '2026-09-08T00:00:00Z' }, target: { kind: 'main' } })
    await exec({ name: 'a', prompt: 'p', cwd: 'c', scheduleKind: 'every', everySeconds: 3600, targetKind: 'main', catchup: false, enabled: true })
    expect(service.calls[2].args[0]).toMatchObject({ schedule: { kind: 'every', seconds: 3600 } })
    // 缺 kind 对应字段 → 抛错
    await expect(exec({ name: 'a', prompt: 'p', cwd: 'c', scheduleKind: 'cron', targetKind: 'main', catchup: false, enabled: true }))
      .rejects.toThrow(/cronExpr/)
    // 服务校验失败 → 结构化错误
    const failing = fakeService({ create: async () => ({ ok: false, error: '非法 cron 表达式' }) })
    await expect(execOf(createCronTools(failing), 'cron_task_create')({
      name: 'a', prompt: 'p', cwd: 'c', scheduleKind: 'cron', cronExpr: 'bad', targetKind: 'main', catchup: false, enabled: true,
    })).rejects.toThrow('非法 cron 表达式')
  })

  test('list 返回任务视图（enabled/nextRunAt/lastRun）；update/delete/trigger 转发', async () => {
    const service = fakeService()
    const tools = createCronTools(service)
    const list = await execOf(tools, 'cron_task_list')({}) as CronTaskView[]
    expect(list[0]).toMatchObject({ id: 'task-1', enabled: true, nextRunAt: '2026-09-07T09:00:00.000Z' })
    await execOf(tools, 'cron_task_update')({ id: 'task-1', name: '晚报' })
    expect(service.calls.find((c) => c.method === 'update')?.args).toEqual(['task-1', { name: '晚报' }])
    await execOf(tools, 'cron_task_delete')({ id: 'task-1' })
    expect(service.calls.find((c) => c.method === 'remove')?.args).toEqual(['task-1'])
    await execOf(tools, 'cron_task_trigger')({ id: 'task-1' })
    expect(service.calls.find((c) => c.method === 'trigger')?.args).toEqual(['task-1'])
  })

  test('update：只透传出现的字段（undefined 键不进 patch）', async () => {
    const service = fakeService()
    await execOf(createCronTools(service), 'cron_task_update')({ id: 'task-1', enabled: false })
    const patch = service.calls.find((c) => c.method === 'update')?.args[1] as Record<string, unknown>
    expect(patch).toEqual({ enabled: false })
  })
})

describe('setupCronTools 门控与互斥探测', () => {
  interface FakeAgent {
    session: { id: string; header: { origin?: string } }
    ctx: { effect(fn: () => () => void): void; tools: unknown }
    effects: Array<() => void>
  }

  /** fake ctx + fake agent（agent.ctx.tools 与 ctx.tools 共用注册表，便于断言）。
   *  register 按宿主语义（tools/src/index.ts:726-728）对同名同 scope 抛错，
   *  ctx.effect 收集 toolkit 级 fiber disposer（供 HMR 重挂测试手动卸载）。 */
  function fakeWorld(over: { hasScheduleCreate?: boolean } = {}) {
    const listeners: ((payload: { agent: FakeAgent }) => void)[] = []
    const registered: string[] = []
    const registeredSet = new Set<string>()
    const warns: string[] = []
    const toolsRegistry = {
      get: (name: string) => (name === 'schedule_create' && over.hasScheduleCreate === true ? { name } : undefined),
      register: (tool: { name: string }) => {
        if (registeredSet.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered in this scope`)
        registeredSet.add(tool.name)
        registered.push(tool.name)
        return () => {
          registeredSet.delete(tool.name)
          const i = registered.lastIndexOf(tool.name)
          if (i >= 0) registered.splice(i, 1)
        }
      },
    }
    let roots: FakeAgent[] = []
    const fiberDisposers: Array<() => void | Promise<void>> = []
    const ctx = {
      agents: { roots: () => roots },
      on: (event: string, listener: (payload: { agent: FakeAgent }) => void) => {
        if (event === 'agent/created') {
          listeners.push(listener)
          return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1) }
        }
        return () => undefined
      },
      tools: toolsRegistry,
      logger: { warn: (m: string) => warns.push(m) },
      effect: (fn: () => (() => void | Promise<void>) | undefined) => {
        const disposer = fn()
        if (disposer !== undefined) fiberDisposers.push(disposer)
      },
    } as unknown as Context
    const makeAgent = (origin: string | undefined, sessionId: string): FakeAgent => {
      const effects: Array<() => void> = []
      return {
        session: { id: sessionId, header: { origin } },
        // 真实 cordis 的 ctx.effect 同步执行 body 并返回 disposer；fake 同步镜像。
        ctx: {
          effect: (fn: () => () => void) => { const disposer = fn(); effects.push(disposer); return disposer },
          tools: toolsRegistry,
        },
        effects,
      }
    }
    return {
      ctx, listeners, registered, warns, makeAgent, fiberDisposers,
      setRoots: (agents: FakeAgent[]) => { roots = agents },
    }
  }

  test('主 Agent（origin undefined）注册 5 工具；schedule_create 在场 → warn', () => {
    const world = fakeWorld({ hasScheduleCreate: true })
    const agent = world.makeAgent(undefined, 'sess-main')
    world.setRoots([agent])
    setupCronTools(world.ctx, createCronTools(fakeService()), new Set())
    expect(world.registered).toEqual(['cron_task_create', 'cron_task_list', 'cron_task_update', 'cron_task_delete', 'cron_task_trigger'])
    expect(world.warns.some((m) => m.includes('schedule_create'))).toBe(true)
  })

  test('subagent 与插件自有会话不注册', () => {
    const world = fakeWorld()
    world.setRoots([world.makeAgent('subagent', 'sess-sub'), world.makeAgent(undefined, 'sess-owned')])
    setupCronTools(world.ctx, createCronTools(fakeService()), new Set(['sess-owned']))
    expect(world.registered).toEqual([])
  })

  test('agent/created 对未来主 Agent 注册', () => {
    const world = fakeWorld()
    setupCronTools(world.ctx, createCronTools(fakeService()), new Set())
    const agent = world.makeAgent(undefined, 'sess-new')
    for (const listener of world.listeners) listener({ agent })
    expect(world.registered).toContain('cron_task_create')
  })

  test('HMR 重挂：fiber 卸载清理 agent 工具后可再次挂载，不抛重复注册', async () => {
    const world = fakeWorld()
    const agent = world.makeAgent(undefined, 'sess-main')
    world.setRoots([agent])
    // fiber 1：主 Agent 注册 5 工具。
    setupCronTools(world.ctx, createCronTools(fakeService()), new Set())
    expect(world.registered).toHaveLength(5)
    // fiber 1 卸载（HMR）：toolkit 级 ctx.effect cleanup 摘下 agent 上挂的工具。
    await Promise.all(world.fiberDisposers.splice(0).map((dispose) => Promise.resolve(dispose())))
    expect(world.registered).toEqual([])
    // fiber 2 重挂：注册表已清空，可再次注册（旧实现残留 5 工具 → duplicate 抛错）。
    setupCronTools(world.ctx, createCronTools(fakeService()), new Set())
    expect(world.registered).toHaveLength(5)
  })

  test('同一 agent 重复 attach（roots 快照 + agent/created 双路径）只注册一次', () => {
    const world = fakeWorld()
    const agent = world.makeAgent(undefined, 'sess-main')
    world.setRoots([agent])
    setupCronTools(world.ctx, createCronTools(fakeService()), new Set())
    for (const listener of world.listeners) listener({ agent })
    expect(world.registered.filter((n) => n === 'cron_task_create')).toHaveLength(1)
  })

  test('agent.ctx 卸载：disposer 运行，工具从注册表移除', () => {
    const world = fakeWorld()
    const agent = world.makeAgent(undefined, 'sess-main')
    world.setRoots([agent])
    setupCronTools(world.ctx, createCronTools(fakeService()), new Set())
    expect(agent.effects).toHaveLength(1)
    agent.effects[0]()
    expect(world.registered).toEqual([])
  })
})
