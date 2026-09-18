import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { agentToolkitDomain, type AgentRecord } from './store.ts'
import { createRegistry, AGENTS_TIMESTAMPS_BACKFILLED_KEY, BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY, EXPLORER_READONLY_MIGRATED_KEY, TOOLS_NATIVE_MIGRATED_KEY, type AgentRegistry } from './registry.ts'
import { EXPLORER_READONLY_ALLOW, GENERAL_ALLOW, LEGACY_EXPLORER_ALLOW } from './builtin.ts'
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'

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

class FakeDomain {
  readonly name = agentToolkitDomain.name
  private readonly tables = new Map<string, FakeTable<unknown>>()
  constructor(spec: DomainSpec) {
    for (const name of Object.keys(spec.tables)) this.tables.set(name, new FakeTable())
  }
  table(name: string): KvTable<string, unknown> {
    const table = this.tables.get(name)
    if (table === undefined) throw new Error(`no table ${name}`)
    return table as KvTable<string, unknown>
  }
  async close(): Promise<void> {}
}

function agentsOf(domain: FakeDomain): KvTable<string, AgentRecord> {
  return domain.table('agents') as unknown as KvTable<string, AgentRecord>
}

function tablesOf(domain: FakeDomain) {
  return {
    agents: domain.table('agents') as unknown as KvTable<string, AgentRecord>,
    meta: domain.table('meta') as unknown as KvTable<string, { value: string }>,
  }
}

let tempHome: string
beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'dsh-toolkit-registry-'))
  vi.stubEnv('DSH_HOME', tempHome)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(tempHome, { recursive: true, force: true })
})

test('createRegistry：空表种入内置三条（main/explorer/general）', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry.list().map(r => r.id)).toEqual(['main', 'explorer', 'general'])
  expect(registry.get('main')?.name).toBe('主 Agent')
  expect(registry.get('explorer')?.builtin).toBe(true)
  expect(registry.get('general')?.builtin).toBe(true)
})

test('createRegistry：已有记录不重复种入', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('general', { id: 'general', name: '自定义', builtin: false })
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry.get('general')).toMatchObject({ id: 'general', name: '自定义', builtin: false })
  expect(registry.list().map(r => r.id)).toEqual(['main', 'explorer', 'general'])
})

test('list：main 置顶，其余按 createdAt 升序（存量回填基准 = id 序）', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('zeta', { id: 'zeta', name: 'Zeta' })
  await agentsOf(domain).put('alpha', { id: 'alpha', name: 'Alpha' })
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry.list().map(r => r.id)).toEqual(['main', 'alpha', 'explorer', 'general', 'zeta'])
})

test('list：main 置顶，其余按 createdAt 升序、并列按 id 字典序', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const { agents, meta } = tablesOf(domain)
  await agents.put('b', { id: 'b', name: 'B', createdAt: 20 })
  await agents.put('a', { id: 'a', name: 'A', createdAt: 20 })
  await agents.put('c', { id: 'c', name: 'C', createdAt: 10 })
  const registry = await createRegistry(vi.fn(), { agents, meta }, async () => [], () => 1000)
  // 内置 explorer/general 由种入后回填获得 now()+index（晚于用户自建），排在用户记录之后。
  expect(registry.list().map(r => r.id)).toEqual(['main', 'c', 'a', 'b', 'explorer', 'general'])
})

test('回填迁移：缺 createdAt 的存量记录按 id 序回填 now()+index，幂等', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const { agents, meta } = tablesOf(domain)
  await agents.put('b', { id: 'b', name: 'B' })
  await agents.put('a', { id: 'a', name: 'A' })
  const registry = await createRegistry(vi.fn(), { agents, meta }, async () => [], () => 1000)
  expect(agents.get('a')?.createdAt).toBe(1000)
  expect(agents.get('b')?.createdAt).toBe(1001)
  expect(meta.get(AGENTS_TIMESTAMPS_BACKFILLED_KEY)).toEqual({ value: '1' })
  // 幂等：二次创建不再改写
  const again = await createRegistry(vi.fn(), { agents, meta }, async () => [], () => 2000)
  expect(agents.get('a')?.createdAt).toBe(1000)
  expect(again.list()[0].id).toBe('main')
})

test('upsert：写穿到持久层并刷新缓存', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const agents = agentsOf(domain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  await registry.upsert({ id: 'dev', name: 'Dev', description: '开发' })
  expect(registry.get('dev')).toEqual({ id: 'dev', name: 'Dev', description: '开发' })
  expect(agents.get('dev')).toEqual({ id: 'dev', name: 'Dev', description: '开发' })
})

test('upsert：main 的 name/builtin 锁定', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  await expect(registry.upsert({ id: 'main', name: '别的', builtin: true })).rejects.toThrowError(/主 Agent|name\/builtin/)
  await expect(registry.upsert({ id: 'main', name: '主 Agent', builtin: false })).rejects.toThrowError(/主 Agent|name\/builtin/)
  await registry.upsert({ id: 'main', name: '主 Agent', builtin: true, description: '补充' })
  expect(registry.get('main')?.description).toBe('补充')
})

test('upsert：内置角色可改配置，但 builtin 标记不可改', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  await registry.upsert({ id: 'explorer', name: 'Explorer', builtin: true, description: '新描述' })
  expect(registry.get('explorer')?.description).toBe('新描述')
  await expect(registry.upsert({ id: 'explorer', name: 'Explorer', builtin: false })).rejects.toThrowError(/builtin/)
})

test('upsert：非法记录被拒（不落持久层）', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const agents = agentsOf(domain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  await expect(registry.upsert({ id: 'BAD_ID', name: 'x' })).rejects.toThrowError(/校验失败/)
  expect(agents.get('BAD_ID')).toBeUndefined()
})

test('remove：main 与内置抛错', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  await expect(registry.remove('main')).rejects.toThrowError(/main/)
  await expect(registry.remove('explorer')).rejects.toThrowError(/内置/)
  await expect(registry.remove('general')).rejects.toThrowError(/内置/)
})

test('remove：非内置可删并同步缓存', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  await registry.upsert({ id: 'dev', name: 'Dev' })
  await registry.remove('dev')
  expect(registry.get('dev')).toBeUndefined()
  expect(registry.list().map(r => r.id)).toEqual(['main', 'explorer', 'general'])
})

test('subscribe：upsert/remove 后触发；退订后不再触发', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  const listener = vi.fn()
  const off = registry.subscribe(listener)
  await registry.upsert({ id: 'dev', name: 'Dev' })
  await registry.upsert({ id: 'dev', name: 'Dev2' })
  expect(listener).toHaveBeenCalledTimes(2)
  await registry.remove('dev')
  expect(listener).toHaveBeenCalledTimes(3)
  off()
  await registry.upsert({ id: 'dev2', name: 'Dev2' })
  expect(listener).toHaveBeenCalledTimes(3)
})

test('多个订阅者各自收到通知；互不影响', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  const a = vi.fn()
  const b = vi.fn()
  registry.subscribe(a)
  registry.subscribe(b)
  await registry.upsert({ id: 'dev', name: 'Dev' })
  expect(a).toHaveBeenCalledTimes(1)
  expect(b).toHaveBeenCalledTimes(1)
})

test('createRegistry：旧记录 promptLayers 迁移为 persona 并写回持久层', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('legacy', {
    id: 'legacy', name: 'Legacy',
    promptLayers: [
      { name: 'b', order: 10, text: 'B' },
      { name: 'a', order: 0, text: 'A' },
    ],
  })
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry.get('legacy')).toMatchObject({ id: 'legacy', name: 'Legacy', persona: 'A\n\nB' })
  expect(agentsOf(domain).get('legacy')).toMatchObject({ id: 'legacy', name: 'Legacy', persona: 'A\n\nB' })
})

test('createRegistry：存量 tools.allow 一次性并入原生工具名，meta 标记后不再改动', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('dev', { id: 'dev', name: 'Dev', tools: { allow: ['team_delegate'] } })
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry.get('dev')?.tools?.allow).toEqual(['team_delegate', ...NATIVE_TOOL_NAMES])
  // 标记已置：用户后续编辑（如去掉部分原生工具）不会再被并入
  await registry.upsert({ id: 'dev', name: 'Dev', tools: { allow: ['read'] } })
  const registry2 = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry2.get('dev')?.tools?.allow).toEqual(['read'])
})

test('createRegistry：内置 explorer 默认只读白名单（不含 write/edit）；general 默认 preset 面全量（不含 team_delegate/run_code）', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry.get('explorer')?.tools?.allow).toEqual(EXPLORER_READONLY_ALLOW)
  expect(registry.get('explorer')?.tools?.allow).not.toContain('write')
  expect(registry.get('explorer')?.tools?.allow).not.toContain('edit')
  expect(registry.get('general')?.tools?.allow).toEqual(GENERAL_ALLOW)
  expect(registry.get('general')?.tools?.allow).not.toContain('team_delegate')
  expect(registry.get('general')?.tools?.allow).not.toContain('run_code')
})

test('createRegistry：存量无 tools 的 explorer 一次性补默认白名单；改回不限制后不再补', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('explorer', { id: 'explorer', name: 'Explorer', builtin: true })
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry.get('explorer')?.tools?.allow).toEqual(EXPLORER_READONLY_ALLOW)
  expect(tablesOf(domain).meta.get(EXPLORER_READONLY_MIGRATED_KEY)).toEqual({ value: '1' })
  // 用户经 UI 显式改回不限制（省略 tools）后，迁移不再回补
  await registry.upsert({ id: 'explorer', name: 'Explorer', builtin: true })
  const registry2 = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry2.get('explorer')?.tools).toBeUndefined()
})

test('createRegistry：已配 tools 的存量 explorer 不被只读迁移改动', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' }) // 隔离原生并入的干扰
  await tables.agents.put('explorer', { id: 'explorer', name: 'Explorer', builtin: true, tools: { allow: ['read'] } })
  const registry = await createRegistry(vi.fn(), tables)
  expect(registry.get('explorer')?.tools?.allow).toEqual(['read'])
})

test('createRegistry：存量自定义白名单一次性并入 preset 面减 native 的差集；builtin 不 widen', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' }) // 隔离原生并入的干扰
  await agentsOf(domain).put('dev', { id: 'dev', name: 'Dev', tools: { allow: ['read'] } })
  await agentsOf(domain).put('explorer', { id: 'explorer', name: 'Explorer', builtin: true, tools: { allow: ['read'] } })
  const presetSurface = [...NATIVE_TOOL_NAMES, 'todo_write', 'web_search']
  const registry = await createRegistry(vi.fn(), tables, async () => presetSurface)
  // 差集（todo_write/web_search）并入普通角色；write/edit 属 native，不回收改
  expect(registry.get('dev')?.tools?.allow).toEqual(['read', 'todo_write', 'web_search'])
  // builtin explorer 的只读白名单是插件设计，不 widen
  expect(registry.get('explorer')?.tools?.allow).toEqual(['read'])
  expect(tables.meta.get('tools_preset_catalog_migrated')).toEqual({ value: '1' })
  // 标记已置：用户后续编辑（去掉并入项）不会再被并入
  await registry.upsert({ id: 'dev', name: 'Dev', tools: { allow: ['read'] } })
  const registry2 = await createRegistry(vi.fn(), tables, async () => presetSurface)
  expect(registry2.get('dev')?.tools?.allow).toEqual(['read'])
})

test('createRegistry：枚举失败 → 跳过迁移且不置标记（下次启动重试）', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' }) // 隔离原生并入的干扰
  await agentsOf(domain).put('dev', { id: 'dev', name: 'Dev', tools: { allow: ['read'] } })
  const registry = await createRegistry(vi.fn(), tables, async () => { throw new Error('preset broken') })
  expect(registry.get('dev')?.tools?.allow).toEqual(['read'])
  expect(tables.meta.get('tools_preset_catalog_migrated')).toBeUndefined()
  // 下次启动枚举恢复 → 迁移执行
  const registry2 = await createRegistry(vi.fn(), tables, async () => ['read', 'todo_write'])
  expect(registry2.get('dev')?.tools?.allow).toEqual(['read', 'todo_write'])
})

test('createRegistry：preset 面等于原生常量（回退路径）→ 差集为空不置标记；面恢复含额外名 → 迁移并置标记', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' }) // 隔离原生并入的干扰
  await agentsOf(domain).put('dev', { id: 'dev', name: 'Dev', tools: { allow: ['read'] } })
  // 回退常量本身：差集 = 常量 − 常量 = 空 → 跳过迁移且不置标记（下次启动重试）
  const registry = await createRegistry(vi.fn(), tables, async () => [...NATIVE_TOOL_NAMES])
  expect(registry.get('dev')?.tools?.allow).toEqual(['read'])
  expect(tables.meta.get('tools_preset_catalog_migrated')).toBeUndefined()
  // 面恢复含额外名 → 差集并入 + 置标记
  const registry2 = await createRegistry(vi.fn(), tables, async () => [...NATIVE_TOOL_NAMES, 'todo_write'])
  expect(registry2.get('dev')?.tools?.allow).toEqual(['read', 'todo_write'])
  expect(tables.meta.get('tools_preset_catalog_migrated')).toEqual({ value: '1' })
})

test('createRegistry：不传 listPresetTools（两参调用）→ 跳过迁移且不置标记', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('dev', { id: 'dev', name: 'Dev', tools: { allow: ['read'] } })
  await createRegistry(vi.fn(), tablesOf(domain))
  expect(tablesOf(domain).meta.get('tools_preset_catalog_migrated')).toBeUndefined()
})

test('内置名单重选：explorer = 旧只读五件 + 只读安全五件（含 skill）；general = preset 面 20 个', () => {
  for (const name of ['web_search', 'todo_write', 'job_list', 'job_output', 'skill']) {
    expect(EXPLORER_READONLY_ALLOW).toContain(name)
  }
  expect(EXPLORER_READONLY_ALLOW).toHaveLength(LEGACY_EXPLORER_ALLOW.length + 5)
  expect(LEGACY_EXPLORER_ALLOW).toHaveLength(5)
  expect(GENERAL_ALLOW).toHaveLength(20)
  for (const name of ['write', 'edit', 'job_kill', 'ralph', 'workflow', 'ask_user_question', 'skill', 'exit_plan_mode', 'create_goal', 'get_goal', 'update_goal']) {
    expect(GENERAL_ALLOW).toContain(name)
  }
  expect(GENERAL_ALLOW).not.toContain('team_delegate')
  expect(GENERAL_ALLOW).not.toContain('run_code')
  expect(EXPLORER_READONLY_ALLOW).not.toContain('run_code')
  // shell 平台条件派生，两名单恰好含一个 shell 名
  expect(GENERAL_ALLOW.filter((n) => n === 'pwsh' || n === 'bash')).toHaveLength(1)
  expect(EXPLORER_READONLY_ALLOW.filter((n) => n === 'pwsh' || n === 'bash')).toHaveLength(1)
})

test('createRegistry：旧默认内置名单一次性重选（explorer 5→10、general 无→20），meta 标记幂等', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' }) // 隔离原生并入（否则 LEGACY 先被补 write/edit，等值比对永不命中）
  await tables.agents.put('explorer', { id: 'explorer', name: 'Explorer', builtin: true, tools: { allow: [...LEGACY_EXPLORER_ALLOW] } })
  await tables.agents.put('general', { id: 'general', name: 'General', builtin: true })
  const registry = await createRegistry(vi.fn(), tables)
  expect(registry.get('explorer')?.tools?.allow).toEqual(EXPLORER_READONLY_ALLOW)
  expect(registry.get('general')?.tools?.allow).toEqual(GENERAL_ALLOW)
  expect(tables.meta.get(BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY)).toEqual({ value: '1' })
  // 标记已置：用户后续编辑（如 explorer 去掉并入项）不会被回收改
  await registry.upsert({ id: 'explorer', name: 'Explorer', builtin: true, tools: { allow: ['read'] } })
  const registry2 = await createRegistry(vi.fn(), tables)
  expect(registry2.get('explorer')?.tools?.allow).toEqual(['read'])
})

test('createRegistry：用户自定义过的内置记录跳过（explorer 改过白名单 / general 已配 tools），标记仍置位', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' }) // 隔离原生并入
  await tables.agents.put('explorer', { id: 'explorer', name: 'Explorer', builtin: true, tools: { allow: ['read'] } })
  await tables.agents.put('general', { id: 'general', name: 'General', builtin: true, tools: { allow: ['read', 'write'] } })
  const registry = await createRegistry(vi.fn(), tables)
  expect(registry.get('explorer')?.tools?.allow).toEqual(['read'])
  expect(registry.get('general')?.tools?.allow).toEqual(['read', 'write'])
  expect(tables.meta.get(BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY)).toEqual({ value: '1' })
})

test('createRegistry：原生并入加写后的 explorer（旧 5 + write/edit 共 7 个形状）同样更新为新名单，write/edit 随之移除', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' })
  await tables.agents.put('explorer', { id: 'explorer', name: 'Explorer', builtin: true, tools: { allow: [...LEGACY_EXPLORER_ALLOW, 'write', 'edit'] } })
  const registry = await createRegistry(vi.fn(), tables)
  expect(registry.get('explorer')?.tools?.allow).toEqual(EXPLORER_READONLY_ALLOW)
  expect(registry.get('explorer')?.tools?.allow).not.toContain('write')
  expect(registry.get('explorer')?.tools?.allow).not.toContain('edit')
})

test('createRegistry：同 id 非 builtin 记录不动（用户数据），builtin 才迁移', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' })
  await tables.agents.put('general', { id: 'general', name: '自定义', builtin: false })
  const registry = await createRegistry(vi.fn(), tables)
  expect(registry.get('general')).toMatchObject({ id: 'general', name: '自定义', builtin: false })
  expect(tables.meta.get(BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY)).toEqual({ value: '1' })
})
