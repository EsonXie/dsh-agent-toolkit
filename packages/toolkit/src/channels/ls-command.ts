/** /ls 指令的目录罗列与递归名称搜索：单层 ls 语义 + 关键字子树过滤（不追随符号链接）。 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { resolveProjectPath } from './doc-command.ts'

/** 单层罗列/搜索结果的条数上限（超出截断并提示细化）。 */
export const LS_MAX_ENTRIES = 100
/** 递归搜索的遍历条目数上限（防 node_modules 级大树拖垮响应）。 */
export const LS_MAX_WALK = 10_000

export type LsReject = 'outside' | 'not-found' | 'not-dir'

export interface LsEntry {
  /** 单层模式为条目名；搜索模式为相对项目根的路径（posix 分隔）。 */
  name: string
  dir: boolean
}

export type LsListing =
  | { ok: true; entries: LsEntry[]; truncated: 'cap' | 'walk' | null; remaining: number }
  | { ok: false; reason: LsReject }

/** 目录在前，同类按名称排序。 */
function compareEntries(a: LsEntry, b: LsEntry): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1
  return a.name.localeCompare(b.name)
}

function capEntries(entries: LsEntry[]): LsListing {
  if (entries.length <= LS_MAX_ENTRIES) return { ok: true, entries, truncated: null, remaining: 0 }
  return { ok: true, entries: entries.slice(0, LS_MAX_ENTRIES), truncated: 'cap', remaining: entries.length - LS_MAX_ENTRIES }
}

/** 共享护栏 + /ls 自语义：目标是文件 → not-dir；目标是符号链接 → 按越界拒绝（指向不定，err-safe）。 */
async function resolveLsDir(project: string, arg: string): Promise<LsListing | { ok: true; abs: string }> {
  const base = await resolveProjectPath(project, arg)
  if (!base.ok) return base
  if (base.st.isSymbolicLink()) return { ok: false, reason: 'outside' }
  if (base.st.isFile()) return { ok: false, reason: 'not-dir' }
  return { ok: true, abs: base.abs }
}

/** 单层罗列：readdir withFileTypes 不追随符号链接（链接条目照列，仅作展示）。 */
export async function listProjectDir(project: string, arg: string): Promise<LsListing> {
  const dir = await resolveLsDir(project, arg)
  if (!('abs' in dir)) return dir
  const items = await readdir(dir.abs, { withFileTypes: true })
  const entries = items.map((d) => ({ name: d.name, dir: d.isDirectory() }))
  entries.sort(compareEntries)
  return capEntries(entries)
}

function toProjectRel(project: string, abs: string): string {
  return path.relative(project, abs).split(path.sep).join('/')
}

/** 递归名称过滤：迭代式 DFS（显式栈防深目录爆栈）；符号链接跳过（不追随、不列出），防环防越界。 */
export async function searchProjectTree(project: string, arg: string, keyword: string): Promise<LsListing> {
  const dir = await resolveLsDir(project, arg)
  if (!('abs' in dir)) return dir
  const needle = keyword.toLowerCase()
  const hits: LsEntry[] = []
  let walked = 0
  let truncated: 'cap' | 'walk' | null = null
  const stack: string[] = [dir.abs]
  while (stack.length > 0) {
    if (hits.length >= LS_MAX_ENTRIES) { truncated = 'cap'; break }
    if (walked >= LS_MAX_WALK) { truncated = 'walk'; break }
    const current = stack.pop()!
    let items
    try {
      items = await readdir(current, { withFileTypes: true })
    } catch {
      // 无权限/竞态删除的子目录跳过。
      continue
    }
    walked += items.length
    for (const d of items) {
      if (d.isSymbolicLink()) continue
      const abs = path.join(current, d.name)
      if (d.name.toLowerCase().includes(needle)) {
        hits.push({ name: toProjectRel(project, abs), dir: d.isDirectory() })
      }
      if (d.isDirectory()) stack.push(abs)
    }
  }
  hits.sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, entries: hits.slice(0, LS_MAX_ENTRIES), truncated, remaining: 0 }
}

/** LsListing → notice 文本（arg 为 '.' 时显示「项目根」）。 */
export function formatLsText(res: Extract<LsListing, { ok: true }>, arg: string, keyword: string | undefined): string {
  const label = arg === '.' ? '项目根' : arg
  const lines = res.entries.map((e) => (e.dir ? `${e.name}/` : e.name))
  if (keyword !== undefined) {
    if (lines.length === 0) return `无匹配条目：${keyword}（${label}）`
    const body = [`「${keyword}」的匹配条目（${label}）：`, ...lines]
    if (res.truncated !== null) body.push('…已截断，用更精确的关键字或更小的目录细化')
    return body.join('\n')
  }
  if (lines.length === 0) return `（空目录：${label}）`
  const body = [`${label === '项目根' ? '项目根目录' : label}：`, ...lines]
  if (res.truncated === 'cap') body.push(`…还有 ${res.remaining} 条，用 /ls <子目录> 细化`)
  return body.join('\n')
}

/** 拒绝原因 → 回传渠道的用户文案。 */
export function lsRejectText(reason: LsReject, arg: string): string {
  switch (reason) {
    case 'outside': return `仅支持项目目录内的路径（相对路径，不越出项目根）：${arg}`
    case 'not-found': return `目录不存在：${arg}`
    case 'not-dir': return `/ls 列目录，发文件请用 /doc ${arg}`
    default: {
      const never: never = reason
      throw new Error(`未知拒绝原因：${String(never)}`)
    }
  }
}
