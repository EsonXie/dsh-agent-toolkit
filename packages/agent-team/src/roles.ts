/** 角色名册文件解析：$DSH_HOME/agent-team/roles/<name>.yml 一角色一文件。 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import z from '@deepseek-ai/schemastery'

/** 角色级工具限制：原样透传为 SubagentStartRequest.toolFilter（精确名白/黑名单，无通配）。 */
export interface RoleTools {
  readonly allow?: string[]
  readonly deny?: string[]
}

/** 一名可委派角色。provider/model 缺省继承主 Agent；tools 缺省不限制。 */
export interface Role {
  readonly name: string
  readonly description: string
  readonly persona: string
  readonly provider?: string
  readonly model?: string
  readonly tools?: RoleTools
}

export const NAME_RE = /^[A-Za-z0-9_-]+$/

const RoleFileSchema = z.object({
  name: z.string(),
  description: z.string().required(),
  persona: z.string().required(),
  provider: z.string(),
  model: z.string(),
  tools: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
})

/**
 * 解析校验单个角色文件。
 * @param text - 文件内容。
 * @param source - 用于错误信息的来源名（通常是文件路径）。
 * @param fileName - 文件名（去 .yml），name 省略时的取值；显式 name 须与它一致。
 * @throws YAML 语法错误、结构非法、name 与文件名不一致、name 非法字符、tools 空对象。
 */
export function parseRoleYaml(text: string, source: string, fileName: string): Role {
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch (error) {
    throw new Error(`agent-team: 角色文件 ${source} 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)
  }
  // Schemastery fills absent optional object/array fields with their defaults
  // (tools -> { allow: [], deny: [] }), so presence must be detected from the
  // raw YAML, not from the normalized schema output.
  const hasTools = parsed !== null && typeof parsed === 'object' && 'tools' in (parsed as object)
  let raw: { name?: string; description: string; persona: string; provider?: string; model?: string; tools?: RoleTools }
  try {
    raw = RoleFileSchema(parsed as Parameters<typeof RoleFileSchema>[0]) as typeof raw
  } catch (error) {
    throw new Error(`agent-team: 角色文件 ${source} 校验失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const name = raw.name ?? fileName
  if (raw.name !== undefined && raw.name !== fileName) {
    throw new Error(`agent-team: 角色文件 ${source} 的 name "${raw.name}" 与文件名 "${fileName}" 不一致（省略 name 即取文件名）`)
  }
  if (!NAME_RE.test(name)) {
    throw new Error(`agent-team: 角色名 "${name}" 非法（${source}）：只允许字母、数字、-、_`)
  }
  if (hasTools && raw.tools !== undefined && raw.tools.allow?.length === 0 && raw.tools.deny?.length === 0) {
    throw new Error(`agent-team: 角色文件 ${source} 的 tools 为空：allow/deny 至少配一个（宿主拒绝空 filter）`)
  }
  const tools = hasTools && raw.tools !== undefined
    ? {
        ...raw.tools.allow && raw.tools.allow.length > 0 ? { allow: raw.tools.allow } : {},
        ...raw.tools.deny && raw.tools.deny.length > 0 ? { deny: raw.tools.deny } : {},
      }
    : undefined
  return {
    name,
    description: raw.description,
    persona: raw.persona,
    ...raw.provider !== undefined ? { provider: raw.provider } : {},
    ...raw.model !== undefined ? { model: raw.model } : {},
    ...tools !== undefined ? { tools } : {},
  }
}

/**
 * 读取 roles 目录下全部 .yml 角色文件，按文件名字典序返回。
 * @param dir - roles 目录绝对路径。
 * @returns 角色列表；目录不存在或无 .yml 文件时返回空列表（静默跳过，属正常态）。
 * @throws 目录存在但不可读（非 ENOENT）、任一文件内容非法。
 */
export async function loadRolesDir(dir: string): Promise<Role[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`agent-team: 角色目录不可读：${dir}（${error instanceof Error ? error.message : String(error)}）`)
  }
  const files = entries.filter(f => f.endsWith('.yml')).sort()
  const roles: Role[] = []
  for (const file of files) {
    const path = join(dir, file)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      throw new Error(`agent-team: 角色文件不可读：${path}（${error instanceof Error ? error.message : String(error)}）`)
    }
    roles.push(parseRoleYaml(text, path, file.slice(0, -'.yml'.length)))
  }
  return roles
}
