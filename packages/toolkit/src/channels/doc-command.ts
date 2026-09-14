/** /doc /ls 指令的路径解析与护栏：仅允许项目目录内、存在的普通文件、大小受控。 */
import type { Stats } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

export type DocReject = 'outside' | 'not-found' | 'not-file' | 'too-large'

export type DocResolution =
  | { ok: true; path: string; name: string }
  | { ok: false; reason: DocReject }

export type ProjectPath =
  | { ok: true; abs: string; st: Stats }
  | { ok: false; reason: 'outside' | 'not-found' }

/** 相对项目根解析 arg 并做包含护栏：绝对路径与 .. 越界拒绝（词法）；
 * lstat 失败（不存在/不可读/悬空链接）按 not-found；
 * 中间目录若是符号链接 lstat 会跟随其指向，用 realpath 把两侧归一后重判包含
 * （两侧都取真实路径，避免根路径本身带符号链接/8.3 短名时文本不一致误判）。
 * 注意：本护栏只校验到父目录；目标自身是符号链接时的处置由调用方按语义决定
 * （/doc 靠 st.isFile() 拒绝，/ls 显式按越界拒绝）。 */
export async function resolveProjectPath(project: string, arg: string): Promise<ProjectPath> {
  if (path.isAbsolute(arg)) return { ok: false, reason: 'outside' }
  const abs = path.resolve(project, arg)
  const rel = path.relative(project, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'outside' }
  let st: Stats
  try {
    st = await lstat(abs)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  const realRoot = await realpath(project)
  const realParent = await realpath(path.dirname(abs))
  const realRel = path.relative(realRoot, realParent)
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) return { ok: false, reason: 'outside' }
  return { ok: true, abs, st }
}

/** 相对项目根解析 arg；在 resolveProjectPath 护栏之上追加普通文件与大小上限判定。 */
export async function resolveDocPath(project: string, arg: string, maxBytes: number): Promise<DocResolution> {
  const base = await resolveProjectPath(project, arg)
  if (!base.ok) return base
  if (!base.st.isFile()) return { ok: false, reason: 'not-file' }
  if (base.st.size > maxBytes) return { ok: false, reason: 'too-large' }
  return { ok: true, path: base.abs, name: path.basename(base.abs) }
}

/** 读入文件字节（调用方已完成护栏判定；大小已受 maxBytes 约束，可安全入内存）。 */
export async function readDocFile(filePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(filePath))
}

/** 拒绝原因 → 回传渠道的用户文案。 */
export function docRejectText(reason: DocReject, arg: string, maxBytes: number): string {
  switch (reason) {
    case 'outside': return `仅支持发送项目目录内的文件（相对路径，不越出项目根）：${arg}`
    case 'not-found': return `文件不存在：${arg}`
    case 'not-file': return `不支持发送目录或链接：${arg}`
    case 'too-large': return `文件超过大小上限 ${Math.floor(maxBytes / 1024 / 1024)} MiB：${arg}`
    default: {
      const never: never = reason
      throw new Error(`未知拒绝原因：${String(never)}`)
    }
  }
}
