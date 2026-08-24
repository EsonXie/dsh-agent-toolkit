/** 浏览器半 RPC 封装（fetch → Node 半 webServer 路由）。类型全部 import type，不进 bundle。 */
import type { RegisterState } from '../register-app.ts'
import type { BotRecord } from '../store.ts'

export type BotListItem = BotRecord & { status: string }

export interface BotInput {
  id?: string
  name: string
  project: string
  persona?: string
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

export const fetchBots = () => request<{ bots: BotListItem[] }>('/project-bot/api/bots').then((r) => r.bots)

export const fetchTools = () => request<{ tools: string[] }>('/project-bot/api/tools').then((r) => r.tools)

export function createBot(input: BotInput): Promise<unknown> {
  return request('/project-bot/api/bots', { method: 'POST', body: JSON.stringify(input) })
}

export function updateBot(id: string, input: Partial<BotInput>): Promise<unknown> {
  return request(`/project-bot/api/bots?id=${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) })
}

export function deleteBot(id: string): Promise<unknown> {
  return request(`/project-bot/api/bots?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export const startRegisterApp = () => request<{ id: string }>('/project-bot/api/register-app', { method: 'POST' })

export const pollRegisterApp = (id: string) =>
  request<{ state: RegisterState }>(`/project-bot/api/register-app/status?id=${encodeURIComponent(id)}`).then((r) => r.state)
