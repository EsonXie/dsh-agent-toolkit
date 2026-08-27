import { describe, expect, test } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { openLayerSource, PROMPT_LAYERS_KEY, PROMPT_LAYERS_SEEDED_KEY, type PromptLayerTables } from './layer-source.ts'
import type { LayerConfig } from './types.ts'

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

const SEED: LayerConfig[] = [{ name: 'base', order: 0, text: 'B' }]

function tables() {
  const promptLayers = new FakeTable<{ layers: LayerConfig[] }>()
  const meta = new FakeTable<{ value: string }>()
  return { promptLayers, meta, api: { promptLayers, meta } as PromptLayerTables }
}

describe('openLayerSource', () => {
  test('首启：无表数据时种入种子层并置标记；二次打开不再覆盖', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    expect(source.get()).toEqual(SEED)
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: SEED })
    expect(t.meta.get(PROMPT_LAYERS_SEEDED_KEY)).toEqual({ value: '1' })

    // 模拟已有编辑后的存储：二次打开应读存储而非种子
    const edited: LayerConfig[] = [{ name: 'base', order: 0, text: 'B' }, { name: 'task', order: 50, text: 'T' }]
    await t.promptLayers.put(PROMPT_LAYERS_KEY, { layers: edited })
    const source2 = await openLayerSource(t.api, SEED)
    expect(source2.get()).toEqual(edited)
  })

  test('set：校验通过写表并通知；非法层拒绝且不落表', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    const listener = { called: 0 }
    source.subscribe(() => { listener.called++ })

    const next: LayerConfig[] = [{ name: 'base', order: 0, text: 'B' }, { name: 'task', order: 50, text: 'T' }]
    await source.set(next)
    expect(source.get()).toEqual(next)
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: next })
    expect(listener.called).toBe(1)

    await expect(source.set([])).rejects.toThrow(/at least one layer/)
    await expect(source.set([
      { name: 'a', order: 0, text: 'A' },
      { name: 'a', order: 1, text: 'A2' },
    ])).rejects.toThrow(/duplicate layer name "a"/)
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: next })
  })

  test('reset：清表清标记后重写种子并通知', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    await source.set([{ name: 'base', order: 0, text: 'B' }, { name: 'task', order: 50, text: 'T' }])
    const listener = { called: 0 }
    source.subscribe(() => { listener.called++ })

    await source.reset()
    expect(source.get()).toEqual(SEED)
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: SEED })
    expect(t.meta.get(PROMPT_LAYERS_SEEDED_KEY)).toEqual({ value: '1' })
    expect(listener.called).toBe(1)
  })

  test('subscribe：退订后不再收到通知', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    const listener = { called: 0 }
    const off = source.subscribe(() => { listener.called++ })
    await source.set([{ name: 'base', order: 0, text: 'X' }])
    expect(listener.called).toBe(1)
    off()
    await source.set([{ name: 'base', order: 0, text: 'Y' }])
    expect(listener.called).toBe(1)
  })
})
