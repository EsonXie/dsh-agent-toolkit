/** Agent 注册表：内存缓存 + 持久化回写 + 订阅通知；main 置顶、内置保底不可删。 */
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { openDomainSafely } from '../shared/storage.ts'
import { AgentRecordSchema, agentToolkitDomain, type AgentRecord } from './store.ts'
import { BUILTIN_AGENTS } from './builtin.ts'
import { importRolesYaml } from './import-yaml.ts'

export interface AgentRegistry {
  /** main 置顶，其余按 id 字典序。 */
  list(): AgentRecord[]
  get(id: string): AgentRecord | undefined
  /** main 的 name/builtin 不可改；builtin 可改配置不可删。 */
  upsert(record: AgentRecord): Promise<void>
  /** main 与 builtin 抛错。 */
  remove(id: string): Promise<void>
  /** UI/委派提示段热更新用；返回退订函数。 */
  subscribe(listener: () => void): () => void
}

/**
 * 打开 dsh_agent_toolkit 域 → 缺 main/explorer/general 时种入内置 → 首启 YAML 导入 →
 * 构建内存缓存。域句柄由 openDomainSafely 在卸载时关闭。
 */
export async function createRegistry(ctx: Context, warn: (msg: string) => void): Promise<AgentRegistry> {
  const domain = await openDomainSafely(ctx, agentToolkitDomain, warn)
  const agents = domain.table('agents') as KvTable<string, AgentRecord>
  const meta = domain.table('meta') as KvTable<string, { value: string }>

  await seedBuiltins(agents)
  await importRolesYaml({ agents, meta, warn })

  const cache = new Map<string, AgentRecord>()
  for (const [id, record] of agents.entries()) cache.set(id, record)

  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }

  return {
    list(): AgentRecord[] {
      const main = cache.get('main')
      const rest = [...cache.entries()]
        .filter(([id]) => id !== 'main')
        .map(([, record]) => record)
        .sort((a, b) => a.id.localeCompare(b.id))
      return main === undefined ? rest : [main, ...rest]
    },
    get(id: string): AgentRecord | undefined {
      return cache.get(id)
    },
    async upsert(record: AgentRecord): Promise<void> {
      const parsed = AgentRecordSchema.safeParse(record)
      if (!parsed.success) {
        throw new Error(`dsh-agent-toolkit: Agent 记录校验失败：${parsed.error.message}`)
      }
      const existing = cache.get(record.id)
      if (record.id === 'main' && existing !== undefined) {
        if (existing.name !== record.name || existing.builtin !== record.builtin) {
          throw new Error('dsh-agent-toolkit: 主 Agent（main）的 name/builtin 字段不可修改')
        }
      }
      if (existing?.builtin === true && record.builtin !== true) {
        throw new Error(`dsh-agent-toolkit: 内置角色 ${record.id} 的 builtin 标记不可修改`)
      }
      await agents.put(record.id, record)
      cache.set(record.id, record)
      notify()
    },
    async remove(id: string): Promise<void> {
      if (id === 'main') throw new Error('dsh-agent-toolkit: 主 Agent（main）不可删除')
      const existing = cache.get(id)
      if (existing?.builtin === true) {
        throw new Error(`dsh-agent-toolkit: 内置角色 ${id} 不可删除`)
      }
      const deleted = await agents.delete(id)
      if (deleted) {
        cache.delete(id)
        notify()
      }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

async function seedBuiltins(agents: KvTable<string, AgentRecord>): Promise<void> {
  for (const builtin of BUILTIN_AGENTS) {
    if (agents.get(builtin.id) === undefined) {
      await agents.put(builtin.id, builtin)
    }
  }
}
