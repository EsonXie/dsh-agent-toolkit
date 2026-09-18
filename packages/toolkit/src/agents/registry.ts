/** Agent 注册表：内存缓存 + 持久化回写 + 订阅通知；main 置顶、内置保底不可删。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { AgentRecordSchema, migrateAgentRecord, type AgentRecord } from './store.ts'
import { BUILTIN_AGENTS, EXPLORER_READONLY_ALLOW, GENERAL_ALLOW, LEGACY_EXPLORER_ALLOW } from './builtin.ts'
import { importRolesYaml } from './import-yaml.ts'
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'

export interface AgentRegistry {
  /** main 置顶，其余按 createdAt 升序（并列按 id）。 */
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

/** explorer 只读白名单一次性并入的 meta 表标记键。 */
export const EXPLORER_READONLY_MIGRATED_KEY = 'explorer_readonly_migrated'

/** tools.allow 一次性并入「preset 面 − 原生常量」差集的 meta 表标记键。 */
export const TOOLS_PRESET_MIGRATED_KEY = 'tools_preset_catalog_migrated'

/** 内置角色工具名单重选（explorer 5→10 / general 无→20）一次性迁移的 meta 表标记键。 */
export const BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY = 'builtin_tools_recatalog_migrated'

/** 存量 Agent 缺 createdAt/updatedAt 时一次性回填的 meta 表标记键。 */
export const AGENTS_TIMESTAMPS_BACKFILLED_KEY = 'agents_timestamps_backfilled'

/**
 * 打开 dsh_agent_toolkit 域 → 首启 YAML 导入 → 旧记录迁移（promptLayers/原生并入/preset 差集并入/explorer 只读/内置名单重选）→
 * 缺 main/explorer/general 时种入内置 → 构建内存缓存。域由 apply 统一 open（storage-domain 同名单开），此处只消费表句柄。
 */
export async function createRegistry(
  warn: (msg: string) => void,
  tables: { agents: KvTable<string, AgentRecord>; meta: KvTable<string, { value: string }> },
  /** 动态 preset 工具面（tool-catalog.ts）；缺席 = 跳过 preset 并入迁移（不置标记）。 */
  listPresetTools?: () => Promise<string[]>,
  /** 回填时间戳的时钟；测试可注入固定值。 */
  now: () => number = Date.now,
): Promise<AgentRegistry> {
  const { agents, meta } = tables

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

  // preset 并入：UI 从未提供 preset 工具名，存量自定义白名单缺它们非用户本意。
  // 并入集 = preset 面 − NATIVE_TOOL_NAMES（native 名一直在 UI 可勾，用户不勾是有意排除，
  // 不回收改）；builtin 记录跳过（explorer 只读白名单是插件设计，不 widen）。
  // 枚举失败/服务缺席：跳过且不置标记，下次启动重试。
  if (meta.get(TOOLS_PRESET_MIGRATED_KEY) === undefined && listPresetTools !== undefined) {
    let extra: string[] | undefined
    try {
      const surface = await listPresetTools()
      extra = surface.filter((n) => !NATIVE_TOOL_NAMES.includes(n))
    } catch {
      extra = undefined
    }
    // 空差集（= 回退常量减常量，如 agentPresets 缺席/枚举失败回退后差集为空）不置标记：
    // 置上会永久跳过重试；下次启动重试为空差集是无害幂等 no-op。
    if (extra !== undefined && extra.length > 0) {
      for (const [id, record] of agents.entries()) {
        if (record.builtin === true || record.tools === undefined) continue
        const missing = extra.filter((n) => !record.tools!.allow.includes(n))
        if (missing.length > 0) await agents.put(id, { ...record, tools: { allow: [...record.tools!.allow, ...missing] } })
      }
      await meta.put(TOOLS_PRESET_MIGRATED_KEY, { value: '1' })
    }
  }

  // explorer 只读白名单一次性迁移：deny 语义取消后 explorer 失去硬约束，此处补派生白名单恢复。
  // 先于 seedBuiltins 执行：新装环境的 explorer 由种入直接携带白名单，不经过本迁移与原生并入。
  const explorerMigrated = meta.get(EXPLORER_READONLY_MIGRATED_KEY) !== undefined
  if (!explorerMigrated) {
    const explorer = agents.get('explorer')
    if (explorer !== undefined && explorer.tools === undefined) {
      await agents.put('explorer', { ...explorer, tools: { allow: [...EXPLORER_READONLY_ALLOW] } })
    }
    await meta.put(EXPLORER_READONLY_MIGRATED_KEY, { value: '1' })
  }

  // 内置名单重选一次性迁移（2026-09-08）：explorer 旧默认 → 新 10 个；general 无 tools
  // → preset 面全量 20 个。条件式：仅更新仍是旧默认值的 builtin 记录（用户面板改过的 =
  // 自定义，跳过）。explorer 旧默认有两种形状：纯净 5 个（seed/只读迁移写入的 LEGACY 派生
  // 顺序）与原生并入加写后的 7 个（[...LEGACY, write, edit]——0.2.x 时代 native 合并不
  // 跳过 builtin 记录，真实存量多为此形状）；7 个形状替换后 write/edit 随之移除，只读
  // 约束随新名单恢复。同 id 非 builtin 记录是用户数据，不动。无外部依赖，跑完即置标记。
  if (meta.get(BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY) === undefined) {
    const explorer = agents.get('explorer')
    const legacyShapes: readonly (readonly string[])[] = [LEGACY_EXPLORER_ALLOW, [...LEGACY_EXPLORER_ALLOW, 'write', 'edit']]
    if (explorer?.builtin === true && explorer.tools !== undefined
      && legacyShapes.some((shape) => explorer.tools!.allow.length === shape.length
        && explorer.tools!.allow.every((n, i) => n === shape[i]))) {
      await agents.put('explorer', { ...explorer, tools: { allow: [...EXPLORER_READONLY_ALLOW] } })
    }
    const general = agents.get('general')
    if (general?.builtin === true && general.tools === undefined) {
      await agents.put('general', { ...general, tools: { allow: [...GENERAL_ALLOW] } })
    }
    await meta.put(BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY, { value: '1' })
  }

  await seedBuiltins(agents)

  // 存量记录时间戳一次性回填（2026-09-17）：缺 createdAt/updatedAt 的记录按 id 字典序
  // 依次赋 now()+index，使列表按创建时间升序有稳定基准。在 seedBuiltins 之后执行——
  // 新种入的内置记录同样缺时间戳，一并回填（与用户自建记录同规参与排序，而非因缺字段排前）。
  // meta 标记幂等：二次启动不再改写用户已有时间戳。
  if (meta.get(AGENTS_TIMESTAMPS_BACKFILLED_KEY) === undefined) {
    const missing = [...agents.keys()]
      .filter((id) => agents.get(id)?.createdAt === undefined)
      .sort((a, b) => a.localeCompare(b))
    const base = now()
    for (const [index, id] of missing.entries()) {
      const record = agents.get(id)
      if (record === undefined) continue
      await agents.put(id, { ...record, createdAt: base + index, updatedAt: base + index })
    }
    await meta.put(AGENTS_TIMESTAMPS_BACKFILLED_KEY, { value: '1' })
  }

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
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
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
