/** agents 注册表存储域声明：记录 schema + domain 布局的单一来源。 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { LayerConfig } from '../prompt/types.ts'

/** Agent id 约束：'main' 或小写字母开头、仅 [a-z0-9-]、总长 ≤ 32。 */
export const AGENT_ID_RE = /^(?:main|[a-z][a-z0-9-]{0,31})$/

/** 一条 Agent 注册表记录。tools 仅白名单。 */
export interface AgentRecord {
  id: string // 'main' 或 [a-z0-9-] slug
  name: string
  description?: string
  persona?: string // 角色唯一可自定义提示层（固定分层中的 persona 层文本）
  /** @deprecated 仅迁移输入：旧版多分层，createRegistry 读取时拼接进 persona 后剥离。 */
  promptLayers?: LayerConfig[]
  model?: { provider: string; model: string }
  tools?: { allow: string[] } // 仅白名单；空数组拒绝（min(1) 语义）
  builtin?: boolean
}

export const LayerConfigSchema = z.object({
  name: z.string(),
  order: z.number(),
  text: z.string(),
})

export const AgentRecordSchema: z.ZodType<AgentRecord> = z.object({
  id: z.string().regex(AGENT_ID_RE),
  name: z.string().min(1),
  description: z.string().optional(),
  persona: z.string().optional(),
  promptLayers: z.array(LayerConfigSchema).optional(),
  model: z.object({ provider: z.string(), model: z.string() }).optional(),
  tools: z.object({ allow: z.array(z.string()).min(1) }).optional(),
  builtin: z.boolean().optional(),
})

/** domain 名/表名受 UNIT_NAME_RE 约束（^[a-z][a-z0-9_]*$），不允许连字符。 */
export const agentToolkitDomain = defineDomain({
  name: 'dsh_agent_toolkit',
  version: 1,
  tables: {
    agents: domainTable<string, AgentRecord>(AgentRecordSchema),
    // meta 表存一次性标记（如 roles_yaml_imported），schema 无法表达则独立成表。
    meta: domainTable<string, { value: string }>(z.object({ value: z.string() })),
    // 分层提示词层列表：单行 JSON（key 常量 'layers'），整体替换语义，与 agents 表同构校验。
    prompt_layers: domainTable<string, { layers: LayerConfig[] }>(z.object({ layers: z.array(LayerConfigSchema) })),
  },
})

/**
 * 旧记录迁移：promptLayers 按 order 升序拼接进 persona（忽略纯空白层；persona 已存在不覆盖），
 * 剥离 promptLayers 返回新对象；无需迁移返回原引用（调用方按引用比较决定是否写回）。
 */
export function migrateAgentRecord(record: AgentRecord): AgentRecord {
  if (record.promptLayers === undefined) return record
  const { promptLayers, ...rest } = record
  const joined = [...promptLayers]
    .sort((a, b) => a.order - b.order)
    .map((layer) => layer.text)
    .filter((text) => text.trim().length > 0)
    .join('\n\n')
  const persona = rest.persona ?? joined
  return persona.length > 0 ? { ...rest, persona } : rest
}
