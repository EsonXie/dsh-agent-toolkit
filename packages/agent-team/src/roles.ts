/** teams/*.yml 的加载与校验：团队名册的唯一解析入口。 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import z from '@deepseek-ai/schemastery'

/** 一名团队成员（角色）。 */
export interface Role {
  /** 标识符：字母数字 + -_；模型调用 team_delegate 时的 role 参数值。 */
  readonly name: string
  /** 一句话职责，编入工具 description，是主 Agent 选角的唯一依据。 */
  readonly description: string
  /** 角色层系统提示词（拼在插件基础层之后）。 */
  readonly persona: string
  /** 可选：覆盖模型供应商，缺省继承主 Agent。 */
  readonly provider?: string
  /** 可选：覆盖模型，缺省继承主 Agent。 */
  readonly model?: string
}

/** 一个团队：teams/<id>.yml 解析产物。 */
export interface Team {
  /** 团队 id = 文件名去 .yml 后缀。 */
  readonly id: string
  readonly roles: Role[]
}

const RoleSchema = z.object({
  name: z.string().required(),
  description: z.string().required(),
  persona: z.string().required(),
  provider: z.string(),
  model: z.string(),
})

const RolesFileSchema = z.object({
  roles: z.array(RoleSchema).required(),
})

const NAME_RE = /^[A-Za-z0-9_-]+$/

/**
 * 解析并校验单个名册文本。
 * @param text - 文件内容。
 * @param source - 用于错误信息的来源名（通常是文件路径）。
 * @returns 校验通过的角色列表。
 * @throws YAML 语法错误、结构非法、name 非法、角色重名。
 */
export function parseRolesYaml(text: string, source: string): Role[] {
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch (error) {
    throw new Error(`agent-team: 角色文件 ${source} 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)
  }
  let roles: Role[]
  try {
    roles = (RolesFileSchema(parsed as Parameters<typeof RolesFileSchema>[0]) as { roles: Role[] }).roles
  } catch (error) {
    throw new Error(`agent-team: 角色文件 ${source} 校验失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const seen = new Set<string>()
  for (const role of roles) {
    if (!NAME_RE.test(role.name)) {
      throw new Error(`agent-team: 角色文件 ${source} 中 name "${role.name}" 非法：只允许字母、数字、-、_`)
    }
    if (seen.has(role.name)) {
      throw new Error(`agent-team: 角色文件 ${source} 中角色 "${role.name}" 重复定义`)
    }
    seen.add(role.name)
  }
  return roles
}

/**
 * 读取 teams 目录下全部 .yml 名册。
 * @param dir - teams 目录的绝对路径。
 * @returns 按文件名字典序的团队列表。
 * @throws 目录不可读、无 .yml、团队 id 非法、大小写归一重名、任一文件内容非法。
 */
export async function loadTeams(dir: string): Promise<Team[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    throw new Error(`agent-team: 团队目录不可读：${dir}（${error instanceof Error ? error.message : String(error)}）`)
  }
  const files = entries.filter(f => f.endsWith('.yml')).sort()
  if (files.length === 0) {
    throw new Error(`agent-team: 团队目录中没有 .yml 名册：${dir}`)
  }
  const seen = new Set<string>()
  const teams: Team[] = []
  for (const file of files) {
    const id = file.slice(0, -'.yml'.length)
    if (!NAME_RE.test(id)) {
      throw new Error(`agent-team: 团队文件名非法：${file}（id 只允许字母、数字、-、_）`)
    }
    const key = id.toLowerCase()
    if (seen.has(key)) {
      throw new Error(`agent-team: 团队 id 重复（大小写归一后）：${id}`)
    }
    seen.add(key)
    const path = join(dir, file)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      throw new Error(`agent-team: 角色文件不可读：${path}（${error instanceof Error ? error.message : String(error)}）`)
    }
    teams.push({ id, roles: parseRolesYaml(text, path) })
  }
  return teams
}
