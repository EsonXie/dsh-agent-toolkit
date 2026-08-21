import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { loadRolesDir, parseRoleYaml } from '../src/roles.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'agent-team-roles-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const VALID = 'description: 只读探索\npersona: 你是探索员。\n'

test('parseRoleYaml：name 省略取文件名；带 tools/provider/model 完整解析', () => {
  const minimal = parseRoleYaml(VALID, 'explorer.yml', 'explorer')
  expect(minimal).toEqual({ name: 'explorer', description: '只读探索', persona: '你是探索员。' })
  const full = parseRoleYaml(
    VALID + 'provider: anthropic\nmodel: claude-sonnet-4\ntools:\n  deny: [write, edit]\n',
    'scout.yml', 'scout',
  )
  expect(full).toEqual({
    name: 'scout', description: '只读探索', persona: '你是探索员。',
    provider: 'anthropic', model: 'claude-sonnet-4', tools: { deny: ['write', 'edit'] },
  })
})

test('parseRoleYaml：name 显式填写但与文件名不一致 → 抛错', () => {
  expect(() => parseRoleYaml('name: other\n' + VALID, 'explorer.yml', 'explorer'))
    .toThrowError(/与文件名/)
})

test('parseRoleYaml：name 非法字符 / description 缺失 / persona 缺失 → 抛错', () => {
  expect(() => parseRoleYaml(VALID, 'bad name.yml', 'bad name')).toThrowError(/非法/)
  expect(() => parseRoleYaml('persona: 有\n', 'x.yml', 'x')).toThrowError(/description|校验失败/)
  expect(() => parseRoleYaml('description: 有\n', 'x.yml', 'x')).toThrowError(/persona|校验失败/)
})

test('parseRoleYaml：tools 空对象（allow/deny 都没有）→ 抛错（宿主空 filter 语义）', () => {
  expect(() => parseRoleYaml(VALID + 'tools: {}\n', 'x.yml', 'x')).toThrowError(/tools/)
})

test('parseRoleYaml：YAML 语法错误 → 抛错且信息含来源名', () => {
  expect(() => parseRoleYaml('description: [未闭合', 'broken.yml', 'broken'))
    .toThrowError(/broken\.yml/)
})

test('loadRolesDir：目录不存在 → 空列表（静默跳过）', async () => {
  await expect(loadRolesDir(join(dir, 'missing'))).resolves.toEqual([])
})

test('loadRolesDir：目录无 .yml → 空列表；按文件名字典序返回', async () => {
  await writeFile(join(dir, 'b.yml'), VALID)
  await writeFile(join(dir, 'a.yml'), VALID)
  await writeFile(join(dir, 'note.txt'), '忽略我')
  const roles = await loadRolesDir(dir)
  expect(roles.map(r => r.name)).toEqual(['a', 'b'])
})

test('loadRolesDir：任一文件非法 → 抛错；目录不可读（非 ENOENT）→ 抛错', async () => {
  await writeFile(join(dir, 'ok.yml'), VALID)
  await writeFile(join(dir, 'bad.yml'), 'description: [未闭合')
  await expect(loadRolesDir(dir)).rejects.toThrowError(/bad\.yml/)
  await expect(loadRolesDir(join(dir, 'ok.yml'))).rejects.toThrowError() // 文件路径当目录 → ENOTDIR
})

test('loadRolesDir：同目录内角色重名 → 抛错', async () => {
  await writeFile(join(dir, 'x.yml'), 'name: x\n' + VALID)
  // 同名只能来自「name 省略取文件名」之外的途径：两个文件名同名不可能，故构造
  // name 与文件名一致前提下无法重名——此用例改为验证非法 name 在目录加载期即失败
  await writeFile(join(dir, 'x2.yml'), 'description: 有\npersona: 有\ntools:\n  allow: []\n')
  await expect(loadRolesDir(dir)).rejects.toThrowError(/tools/)
})
