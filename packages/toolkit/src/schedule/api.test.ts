import { describe, expect, test } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { createCronApiHandler } from './api.ts'
import type { CronResult, CronService, CronTaskView } from './service.ts'
import type { CronRun, CronTask } from './store.ts'

const T0 = Date.parse('2026-09-07T00:00:00.000Z')
const TASK: CronTask = {
  id: 'task-1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *' }, target: { kind: 'main' },
  catchup: true, enabled: true, nextRunAt: '2026-09-07T09:00:00.000Z',
  createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
}

/** fake service：内存 Map 实现（不走真 scheduler——api 层只测转发与状态码）。 */
function fakeService(): CronService & { tasks: Map<string, CronTask>; runLog: CronRun[] } {
  const tasks = new Map<string, CronTask>([['task-1', TASK]])
  const runLog: CronRun[] = []
  let n = 1
  const ok = <T>(value: T): CronResult<T> => ({ ok: true, value })
  const fail = (error: string): CronResult<never> => ({ ok: false, error })
  return {
    tasks, runLog,
    list: () => [...tasks.values()],
    get: (id) => tasks.get(id),
    create: async (input) => {
      const task: CronTask = { ...input, id: `task-${++n}`, nextRunAt: null, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() }
      tasks.set(task.id, task)
      return ok(task)
    },
    update: async (id, patch) => {
      const existing = tasks.get(id)
      if (existing === undefined) return fail(`定时任务 "${id}" 不存在`)
      const next = { ...existing, ...patch, updatedAt: new Date(T0).toISOString() }
      tasks.set(id, next)
      return ok(next)
    },
    remove: async (id) => {
      if (!tasks.delete(id)) return fail(`定时任务 "${id}" 不存在`)
      return ok(null)
    },
    trigger: async (id) => {
      if (!tasks.has(id)) return fail(`定时任务 "${id}" 不存在`)
      const run: CronRun = { id: 'run-1', taskId: id, triggeredAt: new Date(T0).toISOString(), status: 'running' }
      runLog.push(run)
      return ok(run)
    },
    runsOf: (id, limit) => runLog.filter((r) => r.taskId === id).slice(0, limit),
  }
}

type FakeService = ReturnType<typeof fakeService>

function req(method: string, path: string, body?: unknown): IncomingMessage {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  r.method = method
  r.url = path
  return r
}

interface Captured { code: number; body: unknown }
function res(): ServerResponse & { captured: Captured } {
  const captured: Captured = { code: 0, body: undefined }
  return {
    captured,
    writeHead(code: number) { captured.code = code; return this },
    end(body?: string) { captured.body = body === undefined ? undefined : JSON.parse(body) },
  } as unknown as ServerResponse & { captured: Captured }
}

const BASE = '/dsh-agent-toolkit/api/cron'

function makeHandler() {
  const service = fakeService()
  const handler = createCronApiHandler({ service, listProjects: () => ['D:\\work', 'D:\\ops'], runHistoryLimit: 20 })
  return { service, handler }
}

describe('cron api', () => {
  test('GET /tasks 列表', async () => {
    const { handler } = makeHandler()
    const r = res()
    await handler(req('GET', `${BASE}/tasks`), r)
    expect(r.captured.code).toBe(200)
    expect((r.captured.body as { tasks: CronTaskView[] }).tasks[0].id).toBe('task-1')
  })

  test('POST /tasks 创建 round-trip；body 校验失败 400', async () => {
    const { handler, service } = makeHandler()
    const create = {
      name: '晚报', prompt: '写晚报', cwd: 'D:\\ops',
      schedule: { kind: 'every', seconds: 3600 }, target: { kind: 'main' },
      catchup: false, enabled: true,
    }
    const r = res()
    await handler(req('POST', `${BASE}/tasks`, create), r)
    expect(r.captured.code).toBe(200)
    expect(service.tasks.size).toBe(2)
    const bad = res()
    await handler(req('POST', `${BASE}/tasks`, { name: '' }), bad)
    expect(bad.captured.code).toBe(400)
  })

  test('PUT /tasks/:id 更新；不存在 404', async () => {
    const { handler, service } = makeHandler()
    const r = res()
    await handler(req('PUT', `${BASE}/tasks/task-1`, { name: '改名' }), r)
    expect(r.captured.code).toBe(200)
    expect(service.tasks.get('task-1')?.name).toBe('改名')
    const missing = res()
    await handler(req('PUT', `${BASE}/tasks/ghost`, { name: 'x' }), missing)
    expect(missing.captured.code).toBe(404)
  })

  test('DELETE /tasks/:id；不存在 404', async () => {
    const { handler, service } = makeHandler()
    const r = res()
    await handler(req('DELETE', `${BASE}/tasks/task-1`), r)
    expect(r.captured.code).toBe(200)
    expect(service.tasks.size).toBe(0)
    const missing = res()
    await handler(req('DELETE', `${BASE}/tasks/task-1`), missing)
    expect(missing.captured.code).toBe(404)
  })

  test('POST /tasks/:id/trigger；运行中 409；不存在 404', async () => {
    const { handler, service } = makeHandler()
    const r = res()
    await handler(req('POST', `${BASE}/tasks/task-1/trigger`), r)
    expect(r.captured.code).toBe(200)
    expect((r.captured.body as { run: CronRun }).run.status).toBe('running')
    service.trigger = async () => ({ ok: false, error: '定时任务 "日报" 正在运行中，本次手动触发已跳过' })
    const conflict = res()
    await handler(req('POST', `${BASE}/tasks/task-1/trigger`), conflict)
    expect(conflict.captured.code).toBe(409)
    const missing = res()
    await handler(req('POST', `${BASE}/tasks/ghost/trigger`), missing)
    expect(missing.captured.code).toBe(404)
  })

  test('GET /tasks/:id/runs 运行历史；不存在 404', async () => {
    const { handler, service } = makeHandler()
    service.runLog.push({ id: 'r1', taskId: 'task-1', triggeredAt: new Date(T0).toISOString(), status: 'ok' })
    const r = res()
    await handler(req('GET', `${BASE}/tasks/task-1/runs`), r)
    expect(r.captured.code).toBe(200)
    expect((r.captured.body as { runs: CronRun[] }).runs).toHaveLength(1)
    const missing = res()
    await handler(req('GET', `${BASE}/tasks/ghost/runs`), missing)
    expect(missing.captured.code).toBe(404)
  })

  test('GET /projects 候选 cwd 列表；405/404 兜底', async () => {
    const { handler } = makeHandler()
    const r = res()
    await handler(req('GET', `${BASE}/projects`), r)
    expect((r.captured.body as { projects: string[] }).projects).toEqual(['D:\\work', 'D:\\ops'])
    const wrong = res()
    await handler(req('DELETE', `${BASE}/tasks`), wrong)
    expect(wrong.captured.code).toBe(405)
    const nope = res()
    await handler(req('GET', `${BASE}/nope`), nope)
    expect(nope.captured.code).toBe(404)
  })
})
