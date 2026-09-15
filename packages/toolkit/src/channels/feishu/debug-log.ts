/** 生产调试文件日志：JSONL、按日滚动、按文件名日期保留 N 天；一切 fs 错误静默（绝不影响出站链路）。 */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DebugSink } from '../channel.ts'

/** 默认日志目录（Config feishu.debugLogDir 为空时）。 */
export function DEFAULT_DEBUG_LOG_DIR(): string {
  return join(homedir(), '.dsh', 'logs', 'feishu-debug')
}

/** 内容摘要：长度 + 首 head + 尾 tail 个 code point（不劈代理对；不落全文）。 */
export function preview(text: string, head = 20, tail = 20): { len: number; head: string; tail: string } {
  const chars = [...text]
  if (chars.length <= head + tail) return { len: chars.length, head: text, tail: '' }
  return { len: chars.length, head: chars.slice(0, head).join(''), tail: chars.slice(-tail).join('') }
}

const FILE_NAME = /^feishu-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

export function createFeishuDebugLogger(dir: string, retentionDays: number, now: () => Date = () => new Date()): DebugSink {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const fileNameOf = (d: Date): string => `feishu-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.jsonl`
  /** 按文件名日期删除超过 retentionDays 天的文件（文件名为准，不看 mtime）。 */
  const cleanup = (today: Date): void => {
    try {
      const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - retentionDays)
      for (const name of readdirSync(dir)) {
        const m = FILE_NAME.exec(name)
        if (m === null) continue
        const fileDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
        if (fileDate < cutoff) {
          try { unlinkSync(join(dir, name)) } catch { /* 单文件失败不阻断 */ }
        }
      }
    } catch { /* 目录不可读等：静默 */ }
  }
  try { mkdirSync(dir, { recursive: true }) } catch { /* 静默 */ }
  cleanup(now())
  let currentFile = ''
  return (event) => {
    try {
      const file = fileNameOf(now())
      if (file !== currentFile) {
        currentFile = file
        cleanup(now())
      }
      appendFileSync(join(dir, file), `${JSON.stringify({ ts: now().toISOString(), ...event })}\n`, 'utf8')
    } catch { /* 日志失败静默 */ }
  }
}
