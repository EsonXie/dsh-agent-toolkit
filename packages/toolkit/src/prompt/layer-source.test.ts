import { describe, expect, test } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  openLayerSource,
  reconcileLayers,
  validateFixedLayers,
  PROMPT_LAYERS_KEY,
  PROMPT_LAYERS_SEEDED_KEY,
  type PromptLayersRow,
  type PromptLayerTables,
} from './layer-source.ts'
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

const SEED: LayerConfig[] = [{ name: 'persona', order: 10, text: '' }]

function tables() {
  const promptLayers = new FakeTable<PromptLayersRow>()
  const meta = new FakeTable<{ value: string }>()
  return { promptLayers, meta, api: { promptLayers, meta } as PromptLayerTables }
}

describe('openLayerSource', () => {
  test('首启：无表数据时种入种子层并置标记；二次打开保留已编辑文本', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    expect(source.get()).toEqual(SEED)
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: SEED })
    expect(t.meta.get(PROMPT_LAYERS_SEEDED_KEY)).toEqual({ value: '1' })

    // 模拟已有编辑后的存储：二次打开保留已编辑文本（按种子结构对齐）
    const edited: LayerConfig[] = SEED.map(l => ({ ...l, text: 'P-EDITED' }))
    await t.promptLayers.put(PROMPT_LAYERS_KEY, { layers: edited })
    const source2 = await openLayerSource(t.api, SEED)
    expect(source2.get()).toEqual(edited)
  })

  test('旧四层存储（含 base 保留层与已编辑文本）→ 丢弃 base/domain/task，保留 persona 文本', async () => {
    const t = tables()
    await t.promptLayers.put(PROMPT_LAYERS_KEY, {
      layers: [
        { name: 'persona', order: 0, text: 'MY-PERSONA' },
        { name: 'base', order: 0, text: 'B-EDITED' },
        { name: 'domain', order: 20, text: 'D' },
        { name: 'task', order: 50, text: 'T' },
      ],
    })
    const source = await openLayerSource(t.api, SEED)
    expect(source.get()).toEqual([{ name: 'persona', order: 10, text: 'MY-PERSONA' }])
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: source.get() })
  })

  test('reconcile：旧存储只有多余层 → 补缺失层、丢多余层并写回', async () => {
    const t = tables()
    await t.promptLayers.put(PROMPT_LAYERS_KEY, {
      layers: [
        { name: 'legacy', order: 99, text: 'GONE' },
      ],
    })
    const source = await openLayerSource(t.api, SEED)
    expect(source.get()).toEqual([{ name: 'persona', order: 10, text: '' }])
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: source.get() })
  })

  test('set：同结构改文本写穿并通知；增/删/改名层拒绝且不落表', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    const listener = { called: 0 }
    source.subscribe(() => { listener.called++ })

    const next: LayerConfig[] = SEED.map(l => (l.name === 'persona' ? { ...l, text: 'T' } : l))
    await source.set(next)
    expect(source.get()).toEqual(next)
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: next })
    expect(listener.called).toBe(1)

    await expect(source.set([...next, { name: 'extra', order: 60, text: 'X' }])).rejects.toThrow(/structure is fixed/)
    await expect(source.set([])).rejects.toThrow(/at least one layer/)
    await expect(source.set(next.map(l => (l.name === 'persona' ? { ...l, name: 'renamed' } : l)))).rejects.toThrow(/structure is fixed/)
    await expect(source.set([
      { name: 'a', order: 0, text: 'A' },
      { name: 'a', order: 1, text: 'A2' },
    ])).rejects.toThrow(/duplicate layer name "a"/)
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: next })
  })

  test('reset：清表清标记后重写种子并通知', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    await source.set(SEED.map(l => ({ ...l, text: 'T' })))
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
    await source.set(SEED.map(l => ({ ...l, text: 'X' })))
    expect(listener.called).toBe(1)
    off()
    await source.set(SEED.map(l => ({ ...l, text: 'Y' })))
    expect(listener.called).toBe(1)
  })

  test('identity 覆盖：默认空串；setIdentity 写穿并通知；二次打开保留；空串回落不留残字段', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    expect(source.getIdentity()).toBe('')

    const listener = { called: 0 }
    source.subscribe(() => { listener.called++ })
    await source.setIdentity('MY-IDENTITY')
    expect(source.getIdentity()).toBe('MY-IDENTITY')
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: SEED, identity: 'MY-IDENTITY' })
    expect(listener.called).toBe(1)

    // 二次打开保留覆盖文本（reconcile 不动 identity 字段）
    const source2 = await openLayerSource(t.api, SEED)
    expect(source2.getIdentity()).toBe('MY-IDENTITY')

    // 清空 = 还原原生：回落后行内不留 identity 残字段
    await source2.setIdentity('')
    expect(source2.getIdentity()).toBe('')
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: SEED })
  })

  test('set（层）保留既有 identity 覆盖；reset 连带清空', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    await source.setIdentity('MY-IDENTITY')

    const next: LayerConfig[] = SEED.map(l => ({ ...l, text: 'T' }))
    await source.set(next)
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: next, identity: 'MY-IDENTITY' })
    expect(source.getIdentity()).toBe('MY-IDENTITY')

    await source.reset()
    expect(source.getIdentity()).toBe('')
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: SEED })
  })
})

describe('validateFixedLayers / reconcileLayers', () => {
  test('结构一致（仅文本不同）通过；order 不一致也拒绝', () => {
    expect(() => validateFixedLayers(SEED.map(l => ({ ...l, text: 'X' })), SEED)).not.toThrow()
    expect(() => validateFixedLayers(
      SEED.map(l => (l.name === 'persona' ? { ...l, order: 11 } : l)), SEED,
    )).toThrow(/structure is fixed/)
  })

  test('reconcileLayers 输出种子结构：同名保留文本、缺失补种子、多余丢弃', () => {
    const stored: LayerConfig[] = [{ name: 'persona', order: 7, text: 'KEPT' }, { name: 'ghost', order: 1, text: 'G' }]
    expect(reconcileLayers(stored, SEED)).toEqual([
      { name: 'persona', order: 10, text: 'KEPT' },
    ])
  })
})
