/** 浏览器半 RPC 封装（fetch → Node 半统一 webServer 路由）。类型全部 import type，不进 bundle。 */
import type { AgentRecord } from '../../agents/store.ts'

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = init === undefined
    ? await fetch(input)
    : await fetch(input, {
      ...init,
      headers: { 'content-type': 'application/json' },
    })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

/** GET /agents → AgentRecord[]（裸数组；与 Task 13 bots 的 fetchAgents 同源契约）。 */
export const fetchAgents = () => request<AgentRecord[]>('/dsh-agent-toolkit/api/agents')

export interface ProviderOption { id: string; name: string }
export interface ModelOption { id: string; name: string }

export const fetchProviders = () => request<ProviderOption[]>('/dsh-agent-toolkit/api/providers')

export const fetchModels = (provider: string) =>
  request<ModelOption[]>(`/dsh-agent-toolkit/api/providers/${encodeURIComponent(provider)}/models`)

export interface ToolsCatalog { native: string[]; global: string[] }

export const fetchTools = () => request<ToolsCatalog>('/dsh-agent-toolkit/api/tools')

/** PUT /agents/:id（upsert：全量替换记录）。 */
export const saveAgent = (record: AgentRecord) =>
  request(`/dsh-agent-toolkit/api/agents/${encodeURIComponent(record.id)}`, { method: 'PUT', body: JSON.stringify(record) })

export const deleteAgent = (id: string) =>
  request(`/dsh-agent-toolkit/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
