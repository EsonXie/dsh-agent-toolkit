/** Agent 注册表：内存缓存 + 持久化回写 + 订阅通知；main 置顶、内置保底不可删。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { AgentRecordSchema, migrateAgentRecord, type AgentRecord } from './store.ts'
import { BUILTIN_AGENTS } from './builtin.ts'
import { importRolesYaml } from './import-yaml.ts'
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'

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

/** tools.allow 一次性并入原生工具名的 meta 表标记键。 */
export const TOOLS_NATIVE_MIGRATED_KEY = 'tools_native_migrated'

/**
 * 打开 dsh_agent_toolkit 域 → 缺 main/explorer/general 时种入内置 → 首启 YAML 导入 →
 * 构建内存缓存。域由 apply 统一 open（storage-domain 同名单开），此处只消费表句柄。
 */
export async function createRegistry(
  warn: (msg: string) => void,
  tables: { agents: KvTable<string, AgentRecord>; meta: KvTable<string, { value: string }> },
): Promise<AgentRegistry> {
  const { agents, meta } = tables

  await seedBuiltins(agents)
  await importRolesYaml({ agents, meta, warn })

  // 旧记录迁移：promptLayers → persona（逐条幂等）；tools.allow 一次性并入原生工具名
  // （meta 标记幂等——UI 从未提供原生工具勾选项，存量白名单缺原生名非用户本意；
  //  标记置位后用户再编辑 allow 不会被回收改）。
  const nativeMigrated = meta.get(TOOLS_NATIVE_MIGRATED_KEY) !== undefined
  for (const [id, record] of agents.entries()) {
    let next = migrateAgentRecord(record)
    if (!nativeMigrated && next.tools !== undefined) {
      const allow = next.tools.allow
      const missing = NATIVE_TOOL_NAMES.filter((name) => !allow.includes(name))
      if (missing.length > 0) next = { ...next, tools: { allow: [...allow, ...missing] } }
    }
    if (next !== record) await agents.put(id, next)
  }
  if (!nativeMigrated) await meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' })

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
      const normalized = migrateAgentRecord(parsed.data)
      const existing = cache.get(record.id)
      if (record.id === 'main' && existing !== undefined) {
        if (existing.name !== record.name || existing.builtin !== record.builtin) {
          throw new Error('dsh-agent-toolkit: 主 Agent（main）的 name/builtin 字段不可修改')
        }
      }
      if (existing?.builtin === true && record.builtin !== true) {
        throw new Error(`dsh-agent-toolkit: 内置角色 ${record.id} 的 builtin 标记不可修改`)
      }
      await agents.put(record.id, normalized)
      cache.set(record.id, normalized)
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
