/** /doc 指令的路径解析与护栏：仅允许项目目录内、存在的普通文件、大小受控。 */
import type { Stats } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

export type DocReject = 'outside' | 'not-found' | 'not-file' | 'too-large'

export type DocResolution =
  | { ok: true; path: string; name: string }
  | { ok: false; reason: DocReject }

/** 相对项目根解析 arg；绝对路径与 .. 越界一律拒绝；符号链接按 lstat 拒绝（不追随）。 */
export async function resolveDocPath(project: string, arg: string, maxBytes: number): Promise<DocResolution> {
  if (path.isAbsolute(arg)) return { ok: false, reason: 'outside' }
  const abs = path.resolve(project, arg)
  const rel = path.relative(project, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'outside' }
  let st: Stats
  try {
    st = await lstat(abs)
  } catch {
    // lstat 失败（不存在/不可读/悬空链接）统一按 not-found 提示，不区分原因。
    return { ok: false, reason: 'not-found' }
  }
  if (!st.isFile()) return { ok: false, reason: 'not-file' }
  if (st.size > maxBytes) return { ok: false, reason: 'too-large' }
  return { ok: true, path: abs, name: path.basename(abs) }
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
