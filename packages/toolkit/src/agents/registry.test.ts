import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { agentToolkitDomain, type AgentRecord } from './store.ts'
import { createRegistry, type AgentRegistry } from './registry.ts'
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

interface FakeCtx {
  ctx: Context
  effects: (() => unknown)[]
}

function makeCtx(domain: FakeDomain): FakeCtx {
  const effects: (() => unknown)[] = []
  const ctx = {
    storageDomain: { open: async () => domain },
    effect: (fn: () => unknown) => { effects.push(fn) },
  } as unknown as Context
  return { ctx, effects }
}

function agentsOf(domain: FakeDomain): KvTable<string, AgentRecord> {
  return domain.table('agents') as unknown as KvTable<string, AgentRecord>
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
  const { ctx } = makeCtx(domain)
  const registry = await createRegistry(ctx, vi.fn())
  expect(registry.list().map(r => r.id)).toEqual(['main', 'explorer', 'general'])
  expect(registry.get('main')?.name).toBe('主 Agent')
  expect(registry.get('explorer')?.builtin).toBe(true)
  expect(registry.get('general')?.builtin).toBe(true)
})

test('createRegistry：已有记录不重复种入', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('general', { id: 'general', name: '自定义', builtin: false })
  const { ctx } = makeCtx(domain)
  const registry = await createRegistry(ctx, vi.fn())
  expect(registry.get('general')).toEqual({ id: 'general', name: '自定义', builtin: false })
  expect(registry.list().map(r => r.id)).toEqual(['main', 'explorer', 'general'])
})

test('list：main 置顶，其余按 id 字典序', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('zeta', { id: 'zeta', name: 'Zeta' })
  await agentsOf(domain).put('alpha', { id: 'alpha', name: 'Alpha' })
  const { ctx } = makeCtx(domain)
  const registry = await createRegistry(ctx, vi.fn())
  expect(registry.list().map(r => r.id)).toEqual(['main', 'alpha', 'explorer', 'general', 'zeta'])
})

test('upsert：写穿到持久层并刷新缓存', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const agents = agentsOf(domain)
  const { ctx } = makeCtx(domain)
  const registry = await createRegistry(ctx, vi.fn())
  await registry.upsert({ id: 'dev', name: 'Dev', description: '开发' })
  expect(registry.get('dev')).toEqual({ id: 'dev', name: 'Dev', description: '开发' })
  expect(agents.get('dev')).toEqual({ id: 'dev', name: 'Dev', description: '开发' })
})

test('upsert：main 的 name/builtin 锁定', async () => {
  const { ctx } = makeCtx(new FakeDomain(agentToolkitDomain))
  const registry = await createRegistry(ctx, vi.fn())
  await expect(registry.upsert({ id: 'main', name: '别的', builtin: true })).rejects.toThrowError(/主 Agent|name\/builtin/)
  await expect(registry.upsert({ id: 'main', name: '主 Agent', builtin: false })).rejects.toThrowError(/主 Agent|name\/builtin/)
  await registry.upsert({ id: 'main', name: '主 Agent', builtin: true, description: '补充' })
  expect(registry.get('main')?.description).toBe('补充')
})

test('upsert：内置角色可改配置，但 builtin 标记不可改', async () => {
  const { ctx } = makeCtx(new FakeDomain(agentToolkitDomain))
  const registry = await createRegistry(ctx, vi.fn())
  await registry.upsert({ id: 'explorer', name: 'Explorer', builtin: true, description: '新描述' })
  expect(registry.get('explorer')?.description).toBe('新描述')
  await expect(registry.upsert({ id: 'explorer', name: 'Explorer', builtin: false })).rejects.toThrowError(/builtin/)
})

test('upsert：非法记录被拒（不落持久层）', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const agents = agentsOf(domain)
  const { ctx } = makeCtx(domain)
  const registry = await createRegistry(ctx, vi.fn())
  await expect(registry.upsert({ id: 'BAD_ID', name: 'x' })).rejects.toThrowError(/校验失败/)
  expect(agents.get('BAD_ID')).toBeUndefined()
})

test('remove：main 与内置抛错', async () => {
  const { ctx } = makeCtx(new FakeDomain(agentToolkitDomain))
  const registry = await createRegistry(ctx, vi.fn())
  await expect(registry.remove('main')).rejects.toThrowError(/main/)
  await expect(registry.remove('explorer')).rejects.toThrowError(/内置/)
  await expect(registry.remove('general')).rejects.toThrowError(/内置/)
})

test('remove：非内置可删并同步缓存', async () => {
  const { ctx } = makeCtx(new FakeDomain(agentToolkitDomain))
  const registry = await createRegistry(ctx, vi.fn())
  await registry.upsert({ id: 'dev', name: 'Dev' })
  await registry.remove('dev')
  expect(registry.get('dev')).toBeUndefined()
  expect(registry.list().map(r => r.id)).toEqual(['main', 'explorer', 'general'])
})

test('subscribe：upsert/remove 后触发；退订后不再触发', async () => {
  const { ctx } = makeCtx(new FakeDomain(agentToolkitDomain))
  const registry = await createRegistry(ctx, vi.fn())
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
  const { ctx } = makeCtx(new FakeDomain(agentToolkitDomain))
  const registry = await createRegistry(ctx, vi.fn())
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
  const { ctx } = makeCtx(domain)
  const registry = await createRegistry(ctx, vi.fn())
  expect(registry.get('legacy')).toEqual({ id: 'legacy', name: 'Legacy', persona: 'A\n\nB' })
  expect(agentsOf(domain).get('legacy')).toEqual({ id: 'legacy', name: 'Legacy', persona: 'A\n\nB' })
})

test('createRegistry：存量 tools.allow 一次性并入原生工具名，meta 标记后不再改动', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('dev', { id: 'dev', name: 'Dev', tools: { allow: ['team_delegate'] } })
  const { ctx } = makeCtx(domain)
  const registry = await createRegistry(ctx, vi.fn())
  expect(registry.get('dev')?.tools?.allow).toEqual(['team_delegate', ...NATIVE_TOOL_NAMES])
  // 标记已置：用户后续编辑（如去掉部分原生工具）不会再被并入
  await registry.upsert({ id: 'dev', name: 'Dev', tools: { allow: ['read'] } })
  const registry2 = await createRegistry(ctx, vi.fn())
  expect(registry2.get('dev')?.tools?.allow).toEqual(['read'])
})
