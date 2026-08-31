/** 分层提示词层源：内存缓存 + prompt_layers 表回写 + 订阅通知；Config 仅作首启种子。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { LayerConfig } from './types.ts'
import { validateLayers, type LayerView } from './index.ts'

/** prompt_layers 表单行的 key 常量。 */
export const PROMPT_LAYERS_KEY = 'layers'
/** meta 表首启种子一次性标记键。 */
export const PROMPT_LAYERS_SEEDED_KEY = 'prompt_layers_seeded'

export interface PromptLayersRow { layers: LayerConfig[] }

/** 层源的完整能力：setupPrompt 只消费 get/subscribe（LayerView），存储层消费 set/reset。 */
export interface LayerSource extends LayerView {
  /** 校验 → 写表 → 更新内存 → 通知订阅者。 */
  set(layers: LayerConfig[]): Promise<void>
  /** 清表 + 清种子标记 → 重写种子 → 通知订阅者。 */
  reset(): Promise<void>
}

export interface PromptLayerTables {
  promptLayers: KvTable<string, PromptLayersRow>
  meta: KvTable<string, { value: string }>
}

/** 固定结构校验：name+order 多重集合必须等于种子（仅 text 可变）。 */
export function validateFixedLayers(layers: LayerConfig[], seedLayers: LayerConfig[]): void {
  const key = (layer: LayerConfig): string => `${layer.name}@${String(layer.order)}`
  const seed = seedLayers.map(key).sort()
  const actual = layers.map(key).sort()
  if (actual.length !== seed.length || actual.some((k, i) => k !== seed[i])) {
    throw new Error(`prompt-stack: layer structure is fixed (${seedLayers.map(l => l.name).join(', ')}); only layer text is editable`)
  }
}

/** 按种子结构 reconcile 已存储层：同名层保留已存文本（order 以种子为准）、补缺失、丢多余。 */
export function reconcileLayers(stored: LayerConfig[], seedLayers: LayerConfig[]): LayerConfig[] {
  return seedLayers.map(seed => ({
    ...seed,
    text: stored.find(layer => layer.name === seed.name)?.text ?? seed.text,
  }))
}

/**
 * 打开层源。域由 apply 统一 open（storage-domain 同名单开），本函数只消费表句柄。
 * 首启（表无数据）种入 Config 种子并置标记；此后读存储并按种子结构 reconcile
 * （层栈固定化迁移：保留已编辑文本、补新层、丢多余层）。
 */
export async function openLayerSource(tables: PromptLayerTables, seedLayers: LayerConfig[]): Promise<LayerSource> {
  const { promptLayers, meta } = tables
  validateLayers(seedLayers)
  let cache: LayerConfig[]
  const existing = promptLayers.get(PROMPT_LAYERS_KEY)
  if (existing !== undefined) {
    // 不再 validateLayers(existing.layers)：旧存储可能含已退役的层名（如 base），
    // reconcile 负责对齐种子结构，校验只针对 reconcile 后的结果（恒合法，防御性保留）。
    cache = reconcileLayers(existing.layers, seedLayers)
    validateLayers(cache)
    await promptLayers.put(PROMPT_LAYERS_KEY, { layers: cache })
  } else {
    cache = seedLayers
    await promptLayers.put(PROMPT_LAYERS_KEY, { layers: cache })
  }
  if (meta.get(PROMPT_LAYERS_SEEDED_KEY) === undefined) {
    await meta.put(PROMPT_LAYERS_SEEDED_KEY, { value: '1' })
  }

  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of [...listeners]) listener() }

  return {
    get: () => cache,
    async set(layers: LayerConfig[]): Promise<void> {
      validateLayers(layers)
      validateFixedLayers(layers, seedLayers)
      await promptLayers.put(PROMPT_LAYERS_KEY, { layers })
      cache = layers
      notify()
    },
    async reset(): Promise<void> {
      await promptLayers.delete(PROMPT_LAYERS_KEY)
      await meta.delete(PROMPT_LAYERS_SEEDED_KEY)
      await promptLayers.put(PROMPT_LAYERS_KEY, { layers: seedLayers })
      await meta.put(PROMPT_LAYERS_SEEDED_KEY, { value: '1' })
      cache = seedLayers
      notify()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
