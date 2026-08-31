/** 浏览器半 RPC 封装（fetch → Node 半统一 webServer 路由）。类型全部 import type，不进 bundle。 */
import type { LayerConfig, Rule } from '../../prompt/types.ts'

/** 裸组装探测结果（与 Node 半 prompt/api.ts 的 NativeProbe 同构，此处重复定义保持浏览器半纯净）。 */
export interface NativeProbe {
  sections: Array<{ name: string; text: string }>
  contexts: Array<{ name: string; text: string }>
}

export interface PromptLayersPayload {
  layers: LayerConfig[]
  rules: Rule[]
  seedLayers: LayerConfig[]
  native: NativeProbe
  modelFallbackText: string
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = init === undefined
    ? await fetch(input)
    : await fetch(input, { ...init, headers: { 'content-type': 'application/json' } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const fetchPromptLayers = () => request<PromptLayersPayload>('/dsh-agent-toolkit/api/prompt-layers')

export const saveLayers = (layers: LayerConfig[]) =>
  request('/dsh-agent-toolkit/api/prompt-layers', { method: 'PUT', body: JSON.stringify({ layers }) })

export const resetLayers = () =>
  request('/dsh-agent-toolkit/api/prompt-layers/reset', { method: 'POST' })
