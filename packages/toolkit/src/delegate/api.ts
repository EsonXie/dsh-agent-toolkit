/** delegate RPC 端点：在途委派路由（运行中委派卡）+ 持久委派路由（子会话头部 chip）。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { json } from '../shared/http.ts'
import { registerOptionalRoutes } from '../shared/webserver.ts'
import type { ActiveRoutes } from './active.ts'
import type { DelegationRouteRecord } from './routes.ts'

export interface DelegateApiDeps {
  readonly active: ActiveRoutes
  /** 持久路由表读面（KvTable.get 同步读）。 */
  readonly routes: { get(childSessionId: string): DelegationRouteRecord | undefined }
}

export function createDelegateApiHandler(deps: DelegateApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sub = url.pathname.replace(/^\/dsh-agent-toolkit\/api/, '') || '/'
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (sub === '/delegate/active') {
      const route = deps.active.get(url.searchParams.get('session') ?? '', url.searchParams.get('role') ?? '')
      if (route === undefined) {
        json(res, 404, { error: 'not found' })
        return
      }
      json(res, 200, route)
      return
    }
    if (sub === '/delegate/route') {
      const record = deps.routes.get(url.searchParams.get('session') ?? '')
      if (record === undefined) {
        json(res, 404, { error: 'not found' })
        return
      }
      json(res, 200, { provider: record.provider, model: record.model })
      return
    }
    json(res, 404, { error: 'not found' })
  }
}

/**
 * 注册 delegate 路由（恒启用，与 agents 同策略）。webServer 为可选服务：
 * 缺席时经 registerOptionalRoutes 惰性不注册。prefix 先于 /api 兜底前缀命中。
 */
export function setupDelegateApi(ctx: Context, deps: DelegateApiDeps): void {
  const handler = createDelegateApiHandler(deps)
  registerOptionalRoutes(ctx, (webCtx) => {
    const unregister = webCtx.webServer.register({ kind: 'prefix', path: '/dsh-agent-toolkit/api/delegate', handler })
    return () => unregister()
  })
}
