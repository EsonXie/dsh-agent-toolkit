/** Agents RPC 端点组：注册表 CRUD + providers/models 级联 + 工具名列表。挂载于统一 /dsh-agent-toolkit/api 前缀。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AgentRecordSchema } from './store.ts'
import type { AgentRegistry } from './registry.ts'

/** 一个可选的 provider 路由（id = agentOptions.provider 的值）。 */
export interface ProviderOption { id: string; name: string }
/** 一个可选的模型条目（id = agentOptions.model 的值）。 */
export interface ModelOption { id: string; name: string }

export interface AgentsApiDeps {
  registry: AgentRegistry
  listTools(): string[]
  listProviders(): ProviderOption[]
  /** 失败由调用方（路由）兜底为空数组，不抛错。 */
  listModels(provider: string): Promise<ModelOption[]>
}

const MAX_BODY_BYTES = 64 * 1024

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

/** 读 JSON body；超限 413 / 非法 JSON 400（已写响应时返回 undefined）。 */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_BODY_BYTES) {
      json(res, 413, { error: 'body too large' })
      req.destroy()
      return undefined
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    json(res, 400, { error: 'invalid JSON body' })
    return undefined
  }
}

export function createAgentsApiHandler(deps: AgentsApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sub = url.pathname.replace(/^\/dsh-agent-toolkit\/api/, '') || '/'
    const method = req.method ?? 'GET'

    if (sub === '/agents' && method === 'GET') {
      json(res, 200, deps.registry.list())
      return
    }

    if (sub === '/tools' && method === 'GET') {
      json(res, 200, deps.listTools())
      return
    }

    if (sub === '/providers' && method === 'GET') {
      json(res, 200, deps.listProviders())
      return
    }

    const modelsMatch = /^\/providers\/([^/]+)\/models$/.exec(sub)
    if (modelsMatch !== null && method === 'GET') {
      // 模型列举可能走网络（adapter 探测），失败静默降级为空数组。
      let models: ModelOption[] = []
      try {
        models = await deps.listModels(decodeURIComponent(modelsMatch[1]))
      } catch {
        models = []
      }
      json(res, 200, models)
      return
    }

    const agentMatch = /^\/agents\/([^/]+)$/.exec(sub)
    if (agentMatch !== null) {
      const id = decodeURIComponent(agentMatch[1])

      if (method === 'PUT') {
        const body = await readJsonBody(req, res)
        if (body === undefined) return
        // id 以资源路径为准（覆盖 body.id），保证一致性。
        const candidate: Record<string, unknown> = { ...(body as Record<string, unknown>), id }
        // 服务端保留字段回填：builtin 由既有记录决定（客户端不携带），否则 registry 的
        // "内置标记不可修改" 守卫会让所有内置角色/主 Agent 的配置编辑必然 409。
        const existing = deps.registry.get(id)
        if (existing?.builtin === true) candidate.builtin = true
        const parsed = AgentRecordSchema.safeParse(candidate)
        if (!parsed.success) {
          json(res, 400, { error: parsed.error.issues[0]?.message ?? 'invalid agent record' })
          return
        }
        try {
          await deps.registry.upsert(parsed.data)
        } catch (error) {
          json(res, 409, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        json(res, 200, { ok: true })
        return
      }

      if (method === 'DELETE') {
        if (deps.registry.get(id) === undefined) {
          json(res, 404, { error: `agent "${id}" 不存在` })
          return
        }
        try {
          await deps.registry.remove(id)
        } catch (error) {
          json(res, 409, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        json(res, 200, { ok: true })
        return
      }

      json(res, 405, { error: 'method not allowed' })
      return
    }

    if (['/agents', '/providers', '/tools'].some((p) => sub === p || sub.startsWith(`${p}/`))) {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    json(res, 404, { error: 'not found' })
  }
}
