/** 首启导入：把旧 agent-team 角色名册 $DSH_HOME/agent-team/roles/*.yml 一次性并入注册表。 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import yaml from 'js-yaml'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentRecord } from './store.ts'
import { AGENT_ID_RE } from './store.ts'

/** 导入一次性标记在 meta 表中的键。 */
export const ROLES_YAML_IMPORTED_KEY = 'roles_yaml_imported'

export interface ImportRolesContext {
  agents: KvTable<string, AgentRecord>
  meta: KvTable<string, { value: string }>
  warn: (msg: string) => void
}

export interface ImportResult {
  /** 成功导入（覆盖/新增）的条数。 */
  imported: number
  /** 解析失败被跳过的文件名列表。 */
  skipped: string[]
}

const RoleYamlSchema = z.object({
  name: z.string().optional(),
  description: z.string().min(1),
  persona: z.string().min(1),
  provider: z.string().optional(),
  model: z.string().optional(),
  tools: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }).optional(),
})

/**
 * 解析校验单个角色 YAML 文件并转成 AgentRecord。
 * @param text - 文件内容。
 * @param source - 用于错误信息的来源名（通常是文件路径）。
 * @param fileName - 文件名（去 .yml），name 省略时的取值；显式 name 须与它一致。
 * @param warn - 非致命丢弃（如 tools.deny）的通知通道。
 * @throws YAML 语法错误、结构非法、name 与文件名不一致、id 非法、tools 空。
 */
export function parseRoleYaml(text: string, source: string, fileName: string, warn?: (msg: string) => void): AgentRecord {
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch (error) {
    throw new Error(`dsh-agent-toolkit: 角色文件 ${source} 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)
  }
  const hasTools = parsed !== null && typeof parsed === 'object' && 'tools' in (parsed as object)
  let raw: z.infer<typeof RoleYamlSchema>
  try {
    raw = RoleYamlSchema.parse(parsed)
  } catch (error) {
    throw new Error(`dsh-agent-toolkit: 角色文件 ${source} 校验失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const id = raw.name ?? fileName
  if (raw.name !== undefined && raw.name !== fileName) {
    throw new Error(`dsh-agent-toolkit: 角色文件 ${source} 的 name "${raw.name}" 与文件名 "${fileName}" 不一致（省略 name 即取文件名）`)
  }
  if (!AGENT_ID_RE.test(id)) {
    throw new Error(`dsh-agent-toolkit: 角色 id "${id}" 非法（${source}）：只允许小写字母、数字、-，且以小写字母开头`)
  }
  if (hasTools && raw.tools !== undefined && (raw.tools.allow?.length ?? 0) === 0 && (raw.tools.deny?.length ?? 0) === 0) {
    throw new Error(`dsh-agent-toolkit: 角色文件 ${source} 的 tools 为空：allow/deny 至少配一个`)
  }
  if (raw.tools?.deny !== undefined && raw.tools.deny.length > 0) {
    warn?.(`dsh-agent-toolkit: 角色文件 ${source} 的 tools.deny 已忽略（注册表仅支持 allow 白名单）`)
  }
  const model = raw.provider !== undefined && raw.model !== undefined ? { provider: raw.provider, model: raw.model } : undefined
  const tools = hasTools && raw.tools !== undefined && raw.tools.allow !== undefined && raw.tools.allow.length > 0
    ? { allow: raw.tools.allow }
    : undefined
  return {
    id,
    name: id,
    description: raw.description,
    promptLayers: [{ name: 'persona', order: 0, text: raw.persona }],
    ...(model !== undefined ? { model } : {}),
    ...(tools !== undefined ? { tools } : {}),
  }
}

/**
 * 读取 roles 目录下全部 .yml 角色文件，按文件名字典序返回（严格模式：任一文件非法即抛错）。
 * @param dir - roles 目录绝对路径。
 * @returns 角色记录列表；目录不存在或无 .yml 文件时返回空列表（静默跳过，属正常态）。
 * @throws 目录存在但不可读（非 ENOENT）、任一文件不可读/非法。
 */
export async function loadRolesDir(dir: string): Promise<AgentRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`dsh-agent-toolkit: 角色目录不可读：${dir}（${error instanceof Error ? error.message : String(error)}）`)
  }
  const files = entries.filter(f => f.endsWith('.yml')).sort()
  const records: AgentRecord[] = []
  for (const file of files) {
    const path = join(dir, file)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      throw new Error(`dsh-agent-toolkit: 角色文件不可读：${path}（${error instanceof Error ? error.message : String(error)}）`)
    }
    records.push(parseRoleYaml(text, path, file.slice(0, -'.yml'.length)))
  }
  return records
}

/**
 * 首启一次性导入：meta 表 roles_yaml_imported 标记短路；逐文件解析失败 warn 跳过（不阻塞激活）；
 * 同名 YAML 覆盖内置保底记录。
 * @param ctx - agents/meta 表句柄与 warn 通道。
 * @param rolesDir - roles 目录；缺省为 $DSH_HOME/agent-team/roles。
 */
export async function importRolesYaml(ctx: ImportRolesContext, rolesDir?: string): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skipped: [] }
  if (ctx.meta.get(ROLES_YAML_IMPORTED_KEY) !== undefined) return result
  const dir = rolesDir ?? join(resolveDshHome(), 'agent-team', 'roles')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      ctx.warn(`dsh-agent-toolkit: 角色目录不可读：${dir}（${error instanceof Error ? error.message : String(error)}）`)
    }
    await markImported(ctx)
    return result
  }
  const files = entries.filter(f => f.endsWith('.yml')).sort()
  for (const file of files) {
    const path = join(dir, file)
    try {
      const text = await readFile(path, 'utf8')
      const record = parseRoleYaml(text, path, file.slice(0, -'.yml'.length), ctx.warn)
      await ctx.agents.put(record.id, record)
      result.imported++
    } catch (error) {
      result.skipped.push(file)
      ctx.warn(`dsh-agent-toolkit: 角色文件 ${path} 导入失败，已跳过：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await markImported(ctx)
  return result
}

async function markImported(ctx: ImportRolesContext): Promise<void> {
  await ctx.meta.put(ROLES_YAML_IMPORTED_KEY, { value: '1' })
}
