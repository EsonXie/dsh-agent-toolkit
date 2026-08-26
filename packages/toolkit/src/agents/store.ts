/** agents 注册表存储域声明：记录 schema + domain 布局的单一来源。 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { LayerConfig } from '../prompt/types.ts'

/** Agent id 约束：'main' 或小写字母开头、仅 [a-z0-9-]、总长 ≤ 32。 */
export const AGENT_ID_RE = /^(?:main|[a-z][a-z0-9-]{0,31})$/

/** 一条 Agent 注册表记录。tools 仅白名单（用户定案：deny 不做）。 */
export interface AgentRecord {
  id: string // 'main' 或 [a-z0-9-] slug
  name: string
  description?: string
  promptLayers?: LayerConfig[] // 引用 ../prompt/types.ts
  model?: { provider: string; model: string }
  tools?: { allow: string[] } // 仅白名单；空数组拒绝（min(1) 语义）
  builtin?: boolean
}

const LayerConfigSchema = z.object({
  name: z.string(),
  order: z.number(),
  text: z.string(),
})

export const AgentRecordSchema: z.ZodType<AgentRecord> = z.object({
  id: z.string().regex(AGENT_ID_RE),
  name: z.string().min(1),
  description: z.string().optional(),
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
  },
})
