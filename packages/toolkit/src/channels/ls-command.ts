/** /ls 指令的目录罗列与递归名称搜索：单层树形渲染（连接符 + 类型图标 + 文件大小）+ 关键字子树过滤（不追随符号链接）。 */
import { readdir, stat } from 'node:fs/promises'
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
  /** 仅普通文件有值（字节）；目录与符号链接条目无。截断后对展示条目 stat 补全，单条失败静默略过。 */
  size?: number
  /** true = 符号链接条目（仅单层模式会列出；不追随、不显示大小）。 */
  link?: boolean
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

/** 文件扩展名 → 类型图标（不分大小写）；未命中用 📄。 */
const ICON_BY_EXT: Record<string, string> = {
  md: '📝', markdown: '📝', txt: '📝',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', ico: '🖼️', bmp: '🖼️',
  zip: '📦', tar: '📦', gz: '📦', tgz: '📦', '7z': '📦', rar: '📦',
  mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬',
  mp3: '🎵', wav: '🎵', flac: '🎵', m4a: '🎵', ogg: '🎵',
  csv: '📊', xlsx: '📊', xls: '📊',
  ts: '📜', tsx: '📜', js: '📜', jsx: '📜', mjs: '📜', cjs: '📜', py: '📜', java: '📜', go: '📜', rs: '📜',
  c: '📜', cc: '📜', cpp: '📜', h: '📜', hpp: '📜', cs: '📜', sh: '📜', ps1: '📜', bat: '📜',
  vue: '📜', html: '📜', css: '📜', scss: '📜',
  json: '⚙️', yaml: '⚙️', yml: '⚙️', toml: '⚙️', xml: '⚙️', ini: '⚙️', env: '⚙️',
  pdf: '📕',
}

/** 条目 → 类型图标：符号链接 🔗、目录 📁、文件按扩展名映射、默认 📄。 */
export function iconForEntry(name: string, dir: boolean, link: boolean): string {
  if (link) return '🔗'
  if (dir) return '📁'
  return ICON_BY_EXT[path.extname(name).slice(1).toLowerCase()] ?? '📄'
}

/** 字节数 → 人类可读：1024 进制，KB 起固定一位小数。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const u of units) {
    if (value < 1024) break
    value /= 1024
    unit = u
  }
  return `${value.toFixed(1)} ${unit}`
}

/** 截断后对展示的普通文件条目 stat 补 size；单条失败静默略过（保持 never-throws）。 */
async function fillSizes(entries: LsEntry[], absOf: (e: LsEntry) => string): Promise<void> {
  await Promise.all(entries.map(async (e) => {
    if (e.dir || e.link) return
    try {
      e.size = (await stat(absOf(e))).size
    } catch {
      // 竞态删除/权限不足：条目照常显示，仅无大小。
    }
  }))
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
  const entries: LsEntry[] = items.map((d) => (d.isSymbolicLink()
    ? { name: d.name, dir: false, link: true }
    : { name: d.name, dir: d.isDirectory() }))
  entries.sort(compareEntries)
  const capped = capEntries(entries)
  if (capped.ok) await fillSizes(capped.entries, (e) => path.join(dir.abs, e.name))
  return capped
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
  const entries = hits.slice(0, LS_MAX_ENTRIES)
  await fillSizes(entries, (e) => path.join(project, e.name))
  return { ok: true, entries, truncated, remaining: 0 }
}

/** 条目行：图标 + 名称 + 可选大小后缀；prefix 为树形连接符（单层模式用，搜索模式传空串）。 */
function entryLine(e: LsEntry, prefix: string): string {
  const base = `${prefix}${iconForEntry(e.name, e.dir, e.link === true)} ${e.name}`
  return e.size === undefined ? base : `${base}  ${formatSize(e.size)}`
}

/** LsListing → notice 文本（arg 为 '.' 时显示「项目根」）。 */
export function formatLsText(res: Extract<LsListing, { ok: true }>, arg: string, keyword: string | undefined): string {
  const label = arg === '.' ? '项目根' : arg
  if (keyword !== undefined) {
    const lines = res.entries.map((e) => entryLine(e, ''))
    if (lines.length === 0) return `无匹配条目：${keyword}（${label}）`
    const body = [`「${keyword}」的匹配条目（${label}）：`, ...lines]
    if (res.truncated !== null) body.push('…已截断，用更精确的关键字或更小的目录细化')
    return body.join('\n')
  }
  const lines = res.entries.map((e, i) => entryLine(e, i === res.entries.length - 1 ? '└── ' : '├── '))
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
