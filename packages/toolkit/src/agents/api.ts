/** Agents RPC 端点组：注册表 CRUD + providers/models 级联 + 工具名列表。核心恒启用（不随 feishu 门控）。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { json, readJsonBody } from '../shared/http.ts'
import { registerOptionalRoutes } from '../shared/webserver.ts'
import { AgentRecordSchema } from './store.ts'
import type { AgentRegistry } from './registry.ts'
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'

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
      // 分组名册：native = BASIC_TOOLS scoped 挂载的原生工具名（常量），global = 顶层注册表全局工具。
      json(res, 200, { native: [...NATIVE_TOOL_NAMES], global: deps.listTools() })
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
        // builtin 是服务端保留字段：剥离客户端携带值（防经 PUT 自创不可删记录），
        // id 以资源路径为准（覆盖 body.id），保证一致性。
        const bodyRecord: Record<string, unknown> = { ...(body as Record<string, unknown>) }
        delete bodyRecord.builtin
        const candidate: Record<string, unknown> = { ...bodyRecord, id }
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

/**
 * 注册 agents 核心 RPC 路由（恒启用，不随 modules.feishu 门控——Agents 面板总是挂载，
 * 这些端点缺失即「加载失败」）。webServer 为可选服务：缺席时经 registerOptionalRoutes
 * 惰性不注册。挂载点与 bots 同处 /dsh-agent-toolkit/api 前缀，但按路径空间拆成独立
 * prefix/exact 条目（webServer 精确先于最长前缀），互不重叠：
 * - prefix /dsh-agent-toolkit/api/agents   → /agents 与 /agents/:id
 * - prefix /dsh-agent-toolkit/api/providers → /providers 与 /providers/:p/models
 * - exact /dsh-agent-toolkit/api/tools
 * - prefix /dsh-agent-toolkit/api           → 兜底：api 前缀下未被更具体路由（bots/usage）
 *   认领的未知路径仍回 404 JSON（与旧统一分发行为字节一致）。
 */
export function setupAgentsApi(ctx: Context, deps: AgentsApiDeps): void {
  const handler = createAgentsApiHandler(deps)
  registerOptionalRoutes(ctx, (webCtx) => {
    const dispose = [
      webCtx.webServer.register({ kind: 'prefix', path: '/dsh-agent-toolkit/api/agents', handler }),
      webCtx.webServer.register({ kind: 'prefix', path: '/dsh-agent-toolkit/api/providers', handler }),
      webCtx.webServer.register({ kind: 'exact', path: '/dsh-agent-toolkit/api/tools', handler }),
      webCtx.webServer.register({ kind: 'prefix', path: '/dsh-agent-toolkit/api', handler }),
    ]
    return () => dispose.forEach((unregister) => unregister())
  })
}
