import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentRecord } from './store.ts'
import { BUILTIN_AGENTS } from './builtin.ts'
import { ROLES_YAML_IMPORTED_KEY, importRolesYaml, loadRolesDir, parseRoleYaml } from './import-yaml.ts'

class FakeTable<V> implements KvTable<string, V> {
  private readonly records = new Map<string, V>()
  get(key: string): V | undefined { return this.records.get(key) }
  entries(): IterableIterator<[string, V]> { return this.records.entries() }
  keys(): IterableIterator<string> { return this.records.keys() }
  get size(): number { return this.records.size }
  async put(key: string, value: V): Promise<void> { this.records.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.records.delete(key) }
  async update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error(`missing-key: ${key}`)
    const next = fn(current)
    this.records.set(key, next)
    return next
  }
}

function makeStore(): { agents: KvTable<string, AgentRecord>; meta: KvTable<string, { value: string }>; warn: ReturnType<typeof vi.fn> } {
  return {
    agents: new FakeTable<AgentRecord>(),
    meta: new FakeTable<{ value: string }>(),
    warn: vi.fn(),
  }
}

const VALID = 'description: 只读探索\npersona: 你是探索员。\n'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-toolkit-roles-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('parseRoleYaml：persona 直写同名字段；name 省略取文件名', () => {
  const rec = parseRoleYaml(VALID, 'explorer.yml', 'explorer')
  expect(rec).toEqual({
    id: 'explorer',
    name: 'explorer',
    description: '只读探索',
    persona: '你是探索员。',
  })
})

test('parseRoleYaml：provider/model 同存才合并为 model 字段', () => {
  const both = parseRoleYaml(VALID + 'provider: anthropic\nmodel: claude-sonnet-4\n', 's.yml', 's')
  expect(both.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
  const onlyProvider = parseRoleYaml(VALID + 'provider: anthropic\n', 's.yml', 's')
  expect(onlyProvider.model).toBeUndefined()
  const onlyModel = parseRoleYaml(VALID + 'model: claude\n', 's.yml', 's')
  expect(onlyModel.model).toBeUndefined()
})

test('parseRoleYaml：deny 作未知键剥离；deny-only → tools 空抛错', () => {
  const withAllow = parseRoleYaml(VALID + 'tools:\n  allow: [read]\n  deny: [write]\n', 's.yml', 's')
  expect(withAllow.tools).toEqual({ allow: ['read'] })
  expect(() => parseRoleYaml(VALID + 'tools:\n  deny: [write, edit]\n', 's.yml', 's')).toThrowError(/tools 为空/)
})

test('parseRoleYaml：name 与文件名不一致 / 非法 id / 缺失必填 / tools 空 → 抛错', () => {
  expect(() => parseRoleYaml('name: other\n' + VALID, 'e.yml', 'e')).toThrowError(/文件名/)
  expect(() => parseRoleYaml(VALID, 'Bad.yml', 'Bad')).toThrowError(/非法/)
  expect(() => parseRoleYaml('persona: 有\n', 'x.yml', 'x')).toThrowError(/校验失败/)
  expect(() => parseRoleYaml(VALID + 'tools: {}\n', 'x.yml', 'x')).toThrowError(/tools/)
})

test('parseRoleYaml：YAML 语法错误 → 抛错且信息含来源名', () => {
  expect(() => parseRoleYaml('description: [未闭合', 'broken.yml', 'broken')).toThrowError(/broken\.yml/)
})

test('loadRolesDir：目录不存在 → 空列表（静默跳过）', async () => {
  await expect(loadRolesDir(join(dir, 'missing'))).resolves.toEqual([])
})

test('loadRolesDir：无 .yml → 空列表；按文件名字典序返回，忽略非 .yml', async () => {
  await writeFile(join(dir, 'b.yml'), VALID)
  await writeFile(join(dir, 'a.yml'), VALID)
  await writeFile(join(dir, 'note.txt'), '忽略我')
  const roles = await loadRolesDir(dir)
  expect(roles.map(r => r.id)).toEqual(['a', 'b'])
})

test('loadRolesDir：任一文件非法 → 抛错（严格模式）', async () => {
  await writeFile(join(dir, 'ok.yml'), VALID)
  await writeFile(join(dir, 'bad.yml'), 'description: [未闭合')
  await expect(loadRolesDir(dir)).rejects.toThrowError(/bad\.yml/)
})

test('importRolesYaml：同名 YAML 覆盖内置；只导入一次（meta 标记）', async () => {
  const { agents, meta, warn } = makeStore()
  const builtinExplorer = BUILTIN_AGENTS.find(a => a.id === 'explorer')!
  await agents.put(builtinExplorer.id, builtinExplorer)
  const rolesDir = join(dir, 'roles')
  await mkdir(rolesDir, { recursive: true })
  await writeFile(join(rolesDir, 'explorer.yml'), 'description: 新探索\npersona: 新文本。\n')
  const first = await importRolesYaml({ agents, meta, warn }, rolesDir)
  expect(first.imported).toBe(1)
  expect(agents.get('explorer')?.persona).toBe('新文本。')
  expect(meta.get(ROLES_YAML_IMPORTED_KEY)).toEqual({ value: '1' })
  await writeFile(join(rolesDir, 'new.yml'), 'description: 新\npersona: 新。\n')
  const second = await importRolesYaml({ agents, meta, warn }, rolesDir)
  expect(second.imported).toBe(0)
  expect(agents.get('new')).toBeUndefined()
})

test('importRolesYaml：逐文件解析失败 warn 跳过，不阻塞其余文件', async () => {
  const { agents, meta, warn } = makeStore()
  const rolesDir = join(dir, 'roles')
  await mkdir(rolesDir, { recursive: true })
  await writeFile(join(rolesDir, 'ok.yml'), VALID)
  await writeFile(join(rolesDir, 'bad.yml'), 'description: [未闭合')
  const result = await importRolesYaml({ agents, meta, warn }, rolesDir)
  expect(result.imported).toBe(1)
  expect(result.skipped).toEqual(['bad.yml'])
  expect(agents.get('ok')).toBeDefined()
  expect(agents.get('bad')).toBeUndefined()
  expect(warn).toHaveBeenCalled()
  expect(meta.get(ROLES_YAML_IMPORTED_KEY)).toEqual({ value: '1' })
})

test('importRolesYaml：roles 目录不存在 → 空导入 + 标记完成', async () => {
  const { agents, meta, warn } = makeStore()
  const result = await importRolesYaml({ agents, meta, warn }, join(dir, 'missing'))
  expect(result.imported).toBe(0)
  expect(result.skipped).toEqual([])
  expect(meta.get(ROLES_YAML_IMPORTED_KEY)).toEqual({ value: '1' })
})
