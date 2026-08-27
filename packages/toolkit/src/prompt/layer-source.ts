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

/**
 * 打开层源。域由 apply 统一 open（storage-domain 同名单开），本函数只消费表句柄。
 * 首启（meta 无标记 / 表无数据）种入 Config 种子并置标记；此后一律读存储。
 */
export async function openLayerSource(tables: PromptLayerTables, seedLayers: LayerConfig[]): Promise<LayerSource> {
  const { promptLayers, meta } = tables
  let cache: LayerConfig[]
  const existing = promptLayers.get(PROMPT_LAYERS_KEY)
  if (existing !== undefined) {
    cache = existing.layers
    validateLayers(cache)
  } else {
    validateLayers(seedLayers)
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
