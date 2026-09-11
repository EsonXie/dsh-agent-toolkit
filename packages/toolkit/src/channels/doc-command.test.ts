import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { docRejectText, readDocFile, resolveDocPath } from './doc-command.ts'

let root: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dsh-doc-cmd-'))
  await mkdir(path.join(root, 'docs'), { recursive: true })
  await writeFile(path.join(root, 'docs', 'report.md'), '# 报告\n', 'utf8')
  await writeFile(path.join(root, 'big.bin'), Buffer.alloc(16))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveDocPath', () => {
  test('命中：返回绝对路径与文件名', async () => {
    const res = await resolveDocPath(root, 'docs/report.md', 1024)
    expect(res).toEqual({ ok: true, path: path.join(root, 'docs', 'report.md'), name: 'report.md' })
  })

  test('拒绝绝对路径', async () => {
    const abs = path.join(root, 'docs', 'report.md')
    expect(await resolveDocPath(root, abs, 1024)).toEqual({ ok: false, reason: 'outside' })
  })

  test('拒绝 .. 越出项目根', async () => {
    expect(await resolveDocPath(root, '../outside.md', 1024)).toEqual({ ok: false, reason: 'outside' })
    expect(await resolveDocPath(root, 'docs/../../outside.md', 1024)).toEqual({ ok: false, reason: 'outside' })
  })

  test('拒绝不存在的文件', async () => {
    expect(await resolveDocPath(root, 'docs/nope.md', 1024)).toEqual({ ok: false, reason: 'not-found' })
  })

  test('拒绝目录', async () => {
    expect(await resolveDocPath(root, 'docs', 1024)).toEqual({ ok: false, reason: 'not-file' })
  })

  test('拒绝符号链接（lstat 判定，不追随）', async (t) => {
    const link = path.join(root, 'link.md')
    try {
      await symlink(path.join(root, 'docs', 'report.md'), link)
    } catch {
      t.skip('当前环境不允许创建符号链接')
      return
    }
    expect(await resolveDocPath(root, 'link.md', 1024)).toEqual({ ok: false, reason: 'not-file' })
  })

  test('超过大小上限拒绝', async () => {
    expect(await resolveDocPath(root, 'big.bin', 8)).toEqual({ ok: false, reason: 'too-large' })
    expect(await resolveDocPath(root, 'big.bin', 16)).toMatchObject({ ok: true })
  })
})

describe('readDocFile', () => {
  test('读出文件字节', async () => {
    const res = await resolveDocPath(root, 'docs/report.md', 1024)
    if (!res.ok) throw new Error('unreachable')
    expect(new TextDecoder().decode(await readDocFile(res.path))).toBe('# 报告\n')
  })
})

describe('docRejectText', () => {
  test('各拒绝原因的文案', () => {
    expect(docRejectText('outside', 'x', 1024)).toContain('项目目录内')
    expect(docRejectText('not-found', 'a.md', 1024)).toContain('a.md')
    expect(docRejectText('not-file', 'docs', 1024)).toContain('docs')
    expect(docRejectText('too-large', 'b.bin', 1024)).toContain('b.bin')
  })
})
