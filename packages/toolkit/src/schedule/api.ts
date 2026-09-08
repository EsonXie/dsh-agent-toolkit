/** 定时任务浏览器半 RPC：单前缀路由 /dsh-agent-toolkit/api/cron + 内部路径分发（bots/api.ts 同款骨架）。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { json, readJsonBody } from '../shared/http.ts'
import type { CronService, CronTaskInput } from './service.ts'
import { CronScheduleSchema, CronTargetSchema } from './store.ts'

export interface CronApiDeps {
  service: CronService
  /** 候选 cwd 列表（workspaceRegistry.list() 的 path 集；服务缺席时调用方给空数组）。 */
  listProjects(): string[]
  runHistoryLimit: number
}

const CreateBodySchema = z.object({
  name: z.string().min(1).max(64),
  prompt: z.string().min(1).max(8000),
  cwd: z.string().min(1),
  schedule: CronScheduleSchema,
  target: CronTargetSchema,
  catchup: z.boolean(),
  enabled: z.boolean(),
}) satisfies z.ZodType<CronTaskInput>
const UpdateBodySchema = CreateBodySchema.partial()

export function createCronApiHandler(deps: CronApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sub = url.pathname.replace(/^\/dsh-agent-toolkit\/api\/cron/, '') || '/'
    const method = req.method ?? 'GET'
    const taskMatch = /^\/tasks\/([^/]+)$/.exec(sub)
    const triggerMatch = /^\/tasks\/([^/]+)\/trigger$/.exec(sub)
    const runsMatch = /^\/tasks\/([^/]+)\/runs$/.exec(sub)

    if (sub === '/tasks' && method === 'GET') {
      json(res, 200, { tasks: deps.service.list() })
      return
    }

    if (sub === '/tasks' && method === 'POST') {
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const parsed = CreateBodySchema.safeParse(body)
      if (!parsed.success) {
        json(res, 400, { error: parsed.error.issues[0]?.message ?? 'invalid body' })
        return
      }
      const result = await deps.service.create(parsed.data)
      if (!result.ok) {
        json(res, 400, { error: result.error })
        return
      }
      json(res, 200, { task: result.value })
      return
    }

    if (taskMatch !== null && method === 'PUT') {
      const id = decodeURIComponent(taskMatch[1])
      if (deps.service.get(id) === undefined) {
        json(res, 404, { error: `定时任务 "${id}" 不存在` })
        return
      }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const parsed = UpdateBodySchema.safeParse(body)
      if (!parsed.success) {
        json(res, 400, { error: parsed.error.issues[0]?.message ?? 'invalid body' })
        return
      }
      const result = await deps.service.update(id, parsed.data)
      if (!result.ok) {
        json(res, 400, { error: result.error })
        return
      }
      json(res, 200, { task: result.value })
      return
    }

    if (taskMatch !== null && method === 'DELETE') {
      const id = decodeURIComponent(taskMatch[1])
      if (deps.service.get(id) === undefined) {
        json(res, 404, { error: `定时任务 "${id}" 不存在` })
        return
      }
      const result = await deps.service.remove(id)
      if (!result.ok) {
        json(res, 400, { error: result.error })
        return
      }
      json(res, 200, { ok: true })
      return
    }

    if (triggerMatch !== null && method === 'POST') {
      const id = decodeURIComponent(triggerMatch[1])
      if (deps.service.get(id) === undefined) {
        json(res, 404, { error: `定时任务 "${id}" 不存在` })
        return
      }
      const result = await deps.service.trigger(id)
      if (!result.ok) {
        // 运行中冲突 409；其余（理论上只有不存在，已被预检拦截）400。
        json(res, /正在运行/.test(result.error) ? 409 : 400, { error: result.error })
        return
      }
      json(res, 200, { run: result.value })
      return
    }

    if (runsMatch !== null && method === 'GET') {
      const id = decodeURIComponent(runsMatch[1])
      if (deps.service.get(id) === undefined) {
        json(res, 404, { error: `定时任务 "${id}" 不存在` })
        return
      }
      json(res, 200, { runs: deps.service.runsOf(id, deps.runHistoryLimit) })
      return
    }

    if (sub === '/projects' && method === 'GET') {
      json(res, 200, { projects: deps.listProjects() })
      return
    }

    if (sub === '/tasks' || taskMatch !== null || triggerMatch !== null || runsMatch !== null || sub === '/projects') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    json(res, 404, { error: 'not found' })
  }
}
