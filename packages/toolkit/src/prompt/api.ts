/** 分层提示词 RPC 端点组：读（layers+rules+seed+native 探测）、写（PUT 全量替换）、reset。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { registerOptionalRoutes } from '../shared/webserver.ts'
import { json, readJsonBody } from '../shared/http.ts'
import { LayerConfigSchema } from '../agents/store.ts'
import { BASE_TEXT } from './defaults.ts'
import { validateLayers } from './index.ts'
import { validateFixedLayers, type LayerSource } from './layer-source.ts'
import type { LayerConfig, Rule } from './types.ts'

/** 裸组装探测结果：原生 sections / 动态 contexts 的名称与当前文本（只读展示用）。 */
export interface NativeProbe {
  sections: Array<{ name: string; text: string }>
  contexts: Array<{ name: string; text: string }>
}

export interface PromptLayersApiDeps {
  source: LayerSource
  rules: Rule[]
  seedLayers: LayerConfig[]
  /** 裸 assemble 探测（apply 闭包注入）；失败降级为空列表，不阻塞主数据。 */
  probe: () => Promise<NativeProbe>
}

const LayersBodySchema = z.object({ layers: z.array(LayerConfigSchema) })

export function createPromptLayersApiHandler(deps: PromptLayersApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sub = url.pathname.replace(/^\/dsh-agent-toolkit\/api\/prompt-layers/, '') || '/'
    const method = req.method ?? 'GET'

    if (sub === '/' && method === 'GET') {
      let native: NativeProbe = { sections: [], contexts: [] }
      try {
        native = await deps.probe()
      } catch { /* 探测失败降级为空，layers/rules/seedLayers 主数据照常返回 */ }
      json(res, 200, { layers: deps.source.get(), rules: deps.rules, seedLayers: deps.seedLayers, native, modelFallbackText: BASE_TEXT })
      return
    }

    if (sub === '/' && method === 'PUT') {
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const parsed = LayersBodySchema.safeParse(body)
      if (!parsed.success) {
        json(res, 400, { error: parsed.error.issues[0]?.message ?? 'invalid layers body' })
        return
      }
      try {
        validateLayers(parsed.data.layers)
        validateFixedLayers(parsed.data.layers, deps.seedLayers)
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      try {
        await deps.source.set(parsed.data.layers)
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      json(res, 200, { ok: true })
      return
    }

    if (sub === '/reset' && method === 'POST') {
      try {
        await deps.source.reset()
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      json(res, 200, { ok: true })
      return
    }

    if (sub === '/reset' || sub === '/') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    json(res, 404, { error: 'not found' })
  }
}

/** 注册 /dsh-agent-toolkit/api/prompt-layers 前缀路由（webServer 可选服务，缺席惰性不注册）。 */
export function setupPromptLayersApi(ctx: Context, deps: PromptLayersApiDeps): void {
  const handler = createPromptLayersApiHandler(deps)
  registerOptionalRoutes(ctx, (webCtx) => {
    const dispose = webCtx.webServer.register({ kind: 'prefix', path: '/dsh-agent-toolkit/api/prompt-layers', handler })
    return () => dispose()
  })
}
