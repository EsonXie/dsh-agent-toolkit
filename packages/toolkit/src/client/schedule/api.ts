/** 浏览器半 RPC 封装（fetch → Node 半 webServer 路由）。类型全部 import type，不进 bundle。 */
import type { CronRun, CronTask } from '../../schedule/store.ts'
import type { CronTaskInput, CronTaskView } from '../../schedule/service.ts'

export type { CronTaskInput, CronTaskView }
export type { CronRun, CronTask }

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

const BASE = '/dsh-agent-toolkit/api/cron'

export const fetchTasks = () => request<{ tasks: CronTaskView[] }>(`${BASE}/tasks`).then((r) => r.tasks)

export const createTask = (input: CronTaskInput) =>
  request<{ task: CronTask }>(`${BASE}/tasks`, { method: 'POST', body: JSON.stringify(input) })

export const updateTask = (id: string, patch: Partial<CronTaskInput>) =>
  request<{ task: CronTask }>(`${BASE}/tasks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) })

export const deleteTask = (id: string) =>
  request(`${BASE}/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const triggerTask = (id: string) =>
  request<{ run: CronRun }>(`${BASE}/tasks/${encodeURIComponent(id)}/trigger`, { method: 'POST', body: '{}' })

export const fetchRuns = (id: string) =>
  request<{ runs: CronRun[] }>(`${BASE}/tasks/${encodeURIComponent(id)}/runs`).then((r) => r.runs)

export const fetchProjects = () =>
  request<{ projects: string[] }>(`${BASE}/projects`).then((r) => r.projects)

/** Agent 下拉选项（复用 agents 端点；取子集）。 */
export interface AgentOption { id: string; name: string; description?: string }
export const fetchAgents = () => request<AgentOption[]>('/dsh-agent-toolkit/api/agents')
