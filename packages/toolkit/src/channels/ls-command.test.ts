/** ls-command 的测试：单层罗列（排序/截断/空目录）、递归名称搜索、符号链接不追随、拒绝文案。 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { formatLsText, listProjectDir, LS_MAX_ENTRIES, lsRejectText, searchProjectTree } from './ls-command.ts'

let root: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dsh-ls-cmd-'))
  await mkdir(path.join(root, 'docs', 'sub'), { recursive: true })
  await mkdir(path.join(root, 'empty'))
  await writeFile(path.join(root, 'docs', 'report.md'), '# 报告\n', 'utf8')
  await writeFile(path.join(root, 'docs', 'sub', 'notes.md'), 'x', 'utf8')
  await writeFile(path.join(root, 'README.md'), 'x', 'utf8')
  await writeFile(path.join(root, '.hidden'), 'x', 'utf8')
  await writeFile(path.join(root, 'zeta.md'), 'x', 'utf8')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('listProjectDir', () => {
  test('单层混合：目录在前，隐藏文件照列，按名称排序', async () => {
    const res = await listProjectDir(root, '.')
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries.map((e) => `${e.name}${e.dir ? '/' : ''}`))
      .toEqual(['docs/', 'empty/', '.hidden', 'README.md', 'zeta.md'])
    expect(res.truncated).toBeNull()
  })

  test('子目录罗列', async () => {
    const res = await listProjectDir(root, 'docs')
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries.map((e) => `${e.name}${e.dir ? '/' : ''}`)).toEqual(['sub/', 'report.md'])
  })

  test('拒绝越界 / 不存在 / 目标是文件', async () => {
    expect(await listProjectDir(root, '../x')).toEqual({ ok: false, reason: 'outside' })
    expect(await listProjectDir(root, 'nope')).toEqual({ ok: false, reason: 'not-found' })
    expect(await listProjectDir(root, 'README.md')).toEqual({ ok: false, reason: 'not-dir' })
  })

  test('超过 LS_MAX_ENTRIES 截断并计 remaining', async () => {
    const many = await mkdtemp(path.join(tmpdir(), 'dsh-ls-many-'))
    try {
      for (let i = 0; i < LS_MAX_ENTRIES + 7; i++) {
        await writeFile(path.join(many, `f${String(i).padStart(3, '0')}.txt`), 'x')
      }
      const res = await listProjectDir(many, '.')
      if (!res.ok) throw new Error('unreachable')
      expect(res.entries).toHaveLength(LS_MAX_ENTRIES)
      expect(res.truncated).toBe('cap')
      expect(res.remaining).toBe(7)
    } finally {
      await rm(many, { recursive: true, force: true })
    }
  })
})

describe('searchProjectTree', () => {
  test('递归匹配：大小写不敏感，路径相对项目根 posix 化', async () => {
    const res = await searchProjectTree(root, '.', 'REPORT')
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries).toEqual([{ name: 'docs/report.md', dir: false }])
  })

  test('目录也参与匹配（dir 标记）', async () => {
    const res = await searchProjectTree(root, '.', 'sub')
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries).toEqual([{ name: 'docs/sub', dir: true }])
  })

  test('限定子目录为基准，命中按路径排序', async () => {
    const res = await searchProjectTree(root, 'docs', 'md')
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries).toEqual([
      { name: 'docs/report.md', dir: false },
      { name: 'docs/sub/notes.md', dir: false },
    ])
  })

  test('符号链接不追随：链接自身不列出、不进入其子树；链接作目标按越界拒绝', async (t) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-ls-out-'))
    try {
      await writeFile(path.join(outside, 'secret.md'), 'x')
      try {
        await symlink(outside, path.join(root, 'linkdir'), 'junction')
      } catch {
        t.skip('当前环境不允许创建符号链接')
        return
      }
      const res = await searchProjectTree(root, '.', 'secret')
      if (!res.ok) throw new Error('unreachable')
      expect(res.entries).toEqual([])
      expect(await listProjectDir(root, 'linkdir')).toEqual({ ok: false, reason: 'outside' })
    } finally {
      await rm(outside, { recursive: true, force: true })
      await rm(path.join(root, 'linkdir'), { recursive: true, force: true })
    }
  })
})

describe('formatLsText / lsRejectText', () => {
  test('单层渲染：表头 + 目录 / 后缀 + 截断提示', () => {
    const text = formatLsText({ ok: true, entries: [{ name: 'docs', dir: true }, { name: 'a.md', dir: false }], truncated: 'cap', remaining: 5 }, '.', undefined)
    expect(text).toBe('项目根目录：\ndocs/\na.md\n…还有 5 条，用 /ls <子目录> 细化')
  })

  test('空目录与无匹配', () => {
    expect(formatLsText({ ok: true, entries: [], truncated: null, remaining: 0 }, 'docs', undefined)).toBe('（空目录：docs）')
    expect(formatLsText({ ok: true, entries: [], truncated: null, remaining: 0 }, 'docs', 'xyz')).toBe('无匹配条目：xyz（docs）')
  })

  test('搜索渲染与截断提示', () => {
    expect(formatLsText({ ok: true, entries: [{ name: 'docs/report.md', dir: false }], truncated: null, remaining: 0 }, '.', 'report'))
      .toBe('「report」的匹配条目（项目根）：\ndocs/report.md')
    const entries = Array.from({ length: LS_MAX_ENTRIES }, (_, i) => ({ name: `f${i}`, dir: false }))
    expect(formatLsText({ ok: true, entries, truncated: 'walk', remaining: 0 }, '.', 'f'))
      .toContain('…已截断，用更精确的关键字或更小的目录细化')
  })

  test('拒绝文案', () => {
    expect(lsRejectText('outside', 'x')).toContain('项目目录内')
    expect(lsRejectText('not-found', 'x')).toBe('目录不存在：x')
    expect(lsRejectText('not-dir', 'a.md')).toBe('/ls 列目录，发文件请用 /doc a.md')
  })
})
