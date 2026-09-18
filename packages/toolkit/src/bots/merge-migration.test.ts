import { expect, test, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { BotRecord } from './store.ts'
import { BOTS_AGENT_MERGE_MIGRATED_KEY, migrateBotsIntoAgents } from './merge-migration.ts'

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

/** 自建 Map 版依赖（同 registry.test.ts 模式）：bots 与 meta 两张表。 */
function makeDeps(): {
  bots: FakeTable<BotRecord>
  meta: FakeTable<{ value: string }>
} {
  return { bots: new FakeTable<BotRecord>(), meta: new FakeTable<{ value: string }>() }
}

const baseBot: BotRecord = {
  id: 'b1',
  name: '机器人',
  project: '/p',
  createdAt: 1,
  updatedAt: 1,
}

test('已迁移过：直接跳过', async () => {
  const { bots, meta } = makeDeps()
  await meta.put(BOTS_AGENT_MERGE_MIGRATED_KEY, { value: '1' })
  await bots.put('b1', { ...baseBot, persona: 'x', tools: ['read'] })
  await migrateBotsIntoAgents({ bots, meta }, vi.fn())
  expect(bots.get('b1')).toEqual({ ...baseBot, persona: 'x', tools: ['read'] })
})

test('main 绑定：剥离 persona/tools 并 warn，保留 agentOptions', async () => {
  const { bots, meta } = makeDeps()
  await bots.put('b1', {
    ...baseBot,
    persona: 'x',
    tools: ['read'],
    agentOptions: { provider: 'p', model: 'm' },
  })
  const warn = vi.fn()
  await migrateBotsIntoAgents({ bots, meta }, warn)
  const after = bots.get('b1')
  expect(after).not.toHaveProperty('persona')
  expect(after).not.toHaveProperty('tools')
  expect(after?.agentOptions).toEqual({ provider: 'p', model: 'm' })
  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn.mock.calls[0]![0]).toContain('b1')
})

test('角色绑定：剥离 persona/tools/agentOptions，不 warn（这些值运行时本就被忽略）', async () => {
  const { bots, meta } = makeDeps()
  await bots.put('b1', {
    ...baseBot,
    agentRef: 'role-x',
    persona: 'x',
    tools: ['read'],
    agentOptions: { provider: 'p', model: 'm' },
  })
  const warn = vi.fn()
  await migrateBotsIntoAgents({ bots, meta }, warn)
  const after = bots.get('b1')
  expect(after).not.toHaveProperty('persona')
  expect(after).not.toHaveProperty('tools')
  expect(after).not.toHaveProperty('agentOptions')
  expect(warn).not.toHaveBeenCalled()
})

test('幂等：第二次跑不再改写', async () => {
  const { bots, meta } = makeDeps()
  await bots.put('b1', { ...baseBot, persona: 'x', tools: ['read'] })
  await migrateBotsIntoAgents({ bots, meta }, vi.fn())
  const putSpy = vi.fn(bots.put.bind(bots))
  bots.put = putSpy
  await migrateBotsIntoAgents({ bots, meta }, vi.fn())
  expect(putSpy).not.toHaveBeenCalled()
})
