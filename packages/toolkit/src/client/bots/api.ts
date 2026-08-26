/** 浏览器半 RPC 封装（fetch → Node 半 webServer 路由）。类型全部 import type，不进 bundle。 */
import type { RegisterState } from '../../bots/register-app.ts'
import type { BotRecord } from '../../bots/store.ts'

export type BotListItem = BotRecord & { status: string }

export interface BotInput {
  id?: string
  name: string
  project: string
  persona?: string
  /** 绑定的 Agent（'main' 或注册表角色 id）；null 清回主 Agent。 */
  agentRef?: string | null
  tools?: string[]
  agentOptions?: { provider?: string; model?: string }
  feishu?: { appId: string; appSecret?: string; appSecretRef?: string }
}

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

export const fetchBots = () => request<{ bots: BotListItem[] }>('/dsh-agent-toolkit/api/bots/bots').then((r) => r.bots)

export interface ProviderOption { id: string; name: string }
export interface ModelOption { id: string; name: string }
/** Agent 下拉选项（Task 14 的 GET /dsh-agent-toolkit/api/agents 返回 AgentRecord[]，此处取子集）。 */
export interface AgentOption { id: string; name: string; description?: string }

export const fetchProviders = () =>
  request<{ providers: ProviderOption[] }>('/dsh-agent-toolkit/api/bots/providers').then((r) => r.providers)

export const fetchAgents = () =>
  request<AgentOption[]>('/dsh-agent-toolkit/api/agents')

export const fetchModels = (provider: string) =>
  request<{ models: ModelOption[] }>(`/dsh-agent-toolkit/api/bots/models?provider=${encodeURIComponent(provider)}`).then((r) => r.models)

export function createBot(input: BotInput): Promise<unknown> {
  return request('/dsh-agent-toolkit/api/bots/bots', { method: 'POST', body: JSON.stringify(input) })
}

export function updateBot(id: string, input: Partial<BotInput>): Promise<unknown> {
  return request(`/dsh-agent-toolkit/api/bots/bots?id=${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) })
}

export function deleteBot(id: string): Promise<unknown> {
  return request(`/dsh-agent-toolkit/api/bots/bots?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export const startRegisterApp = () => request<{ id: string }>('/dsh-agent-toolkit/api/bots/register-app', { method: 'POST' })

export const pollRegisterApp = (id: string) =>
  request<{ state: RegisterState }>(`/dsh-agent-toolkit/api/bots/register-app/status?id=${encodeURIComponent(id)}`).then((r) => r.state)
