/** project-bot 存储域声明：身份、版本、记录 zod schema 的单一来源。 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 飞书自建应用 appId 形态（WSClient 同款校验）。 */
export const FEISHU_APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/
/** CredentialRef 字符集（credentials 服务 credentialRef() 的校验规则）。 */
export const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** bot id：小写 slug。 */
export const BOT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

export const FeishuConfigSchema = z.object({
  appId: z.string().regex(FEISHU_APP_ID_RE),
  appSecretRef: z.string().regex(CREDENTIAL_REF_RE),
})
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>

export const BotRecordSchema = z.object({
  id: z.string().regex(BOT_ID_RE),
  name: z.string().min(1).max(64),
  channel: z.literal('feishu'),
  feishu: FeishuConfigSchema,
  /** 绑定项目（agent 的 cwd，绝对路径）。一 bot 一项目。 */
  project: z.string().min(1),
  /** 透传到 agent 创作期的 persona 提示段。 */
  persona: z.string().max(8000).optional(),
  /** 挂载的 agent preset id（缺省 = 名册默认 preset）。 */
  preset: z.string().min(1).optional(),
  /** 可用工具白名单（缺省 = 不限制）；空数组无意义，直接拒绝。 */
  tools: z.array(z.string().min(1)).min(1).optional(),
  agentOptions: z.object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type BotRecord = z.infer<typeof BotRecordSchema>

export const BindingSchema = z.object({ sessionId: z.string().min(1) })
export type Binding = z.infer<typeof BindingSchema>

/** domain 名受 UNIT_NAME_RE 约束（^[a-z][a-z0-9_]*$），不允许连字符。 */
export const projectBotDomain = defineDomain({
  name: 'project_bot',
  version: 1,
  tables: {
    bots: domainTable<string, BotRecord>(BotRecordSchema),
    bindings: domainTable<string, Binding>(BindingSchema),
  },
})

/** bindings 表 key：(botId, chatId) → sessionId。 */
export function bindingKey(botId: string, chatId: string): string {
  return `${botId}:${chatId}`
}
