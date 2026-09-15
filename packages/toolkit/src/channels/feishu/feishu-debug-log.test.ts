import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createFeishuDebugLogger, preview } from './debug-log.ts'

let dir = ''
afterEach(() => { if (dir !== '') rmSync(dir, { recursive: true, force: true }) })

describe('preview', () => {
  test('短文本原样、长文本首尾各 20 code point、不劈代理对', () => {
    expect(preview('你好')).toEqual({ len: 2, head: '你好', tail: '' })
    const long = 'a'.repeat(30) + '😀'.repeat(20)   // 50 code points
    const p = preview(long)
    expect(p.len).toBe(50)
    expect(p.head).toBe('a'.repeat(20))
    expect(p.tail).toBe('😀'.repeat(20))
    expect([...p.tail].length).toBe(20)
  })
})

describe('createFeishuDebugLogger', () => {
  test('写入当日 JSONL 文件，每行一个事件且带 ts', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-dbg-'))
    const sink = createFeishuDebugLogger(dir, 7, () => new Date(2026, 8, 15, 10, 0, 0))
    sink({ event: 'op', chatId: 'oc_1', op: 'update' })
    const lines = readFileSync(join(dir, 'feishu-2026-09-15.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const row = JSON.parse(lines[0]!) as { ts: string; event: string; op: string }
    expect(row.event).toBe('op')
    expect(row.op).toBe('update')
    expect(typeof row.ts).toBe('string')
  })

  test('跨日切换文件名，并在切换时清理超期文件（按文件名日期）', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-dbg-'))
    // 预置 8 天前与 6 天前的旧文件
    writeFileSync(join(dir, 'feishu-2026-09-07.jsonl'), '{}\n')
    writeFileSync(join(dir, 'feishu-2026-09-09.jsonl'), '{}\n')
    let day = 15
    const sink = createFeishuDebugLogger(dir, 7, () => new Date(2026, 8, day, 10, 0, 0))
    sink({ event: 'a' })   // 创建时清理：09-07（8 天前）删除，09-09（6 天前）保留
    expect(readdirSync(dir).sort()).toEqual(['feishu-2026-09-09.jsonl', 'feishu-2026-09-15.jsonl'])
    day = 16
    sink({ event: 'b' })   // 跨日切换
    expect(readdirSync(dir).sort()).toContain('feishu-2026-09-16.jsonl')
  })

  test('写失败静默（目录被删后不抛错）', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-dbg-'))
    const sink = createFeishuDebugLogger(dir, 7)
    rmSync(dir, { recursive: true, force: true })
    expect(() => sink({ event: 'op' })).not.toThrow()
  })
})
