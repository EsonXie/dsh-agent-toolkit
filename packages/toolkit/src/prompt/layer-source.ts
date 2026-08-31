/** 分层提示词层源：内存缓存 + prompt_layers 表回写 + 订阅通知；Config 仅作首启种子。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { LayerConfig } from './types.ts'
import { validateLayers, type LayerView } from './index.ts'

/** prompt_layers 表单行的 key 常量。 */
export const PROMPT_LAYERS_KEY = 'layers'
/** meta 表首启种子一次性标记键。 */
export const PROMPT_LAYERS_SEEDED_KEY = 'prompt_layers_seeded'

export interface PromptLayersRow {
  layers: LayerConfig[]
  /** identity 段覆盖文本（可选，仅非空时写入；空/缺省 = 原生句）。 */
  identity?: string
}

/** 层源的完整能力：setupPrompt 只消费 get/getIdentity/subscribe（LayerView），存储层消费 set/setIdentity/reset。 */
export interface LayerSource extends LayerView {
  /** 校验 → 写表 → 更新内存 → 通知订阅者。 */
  set(layers: LayerConfig[]): Promise<void>
  /** 写入 identity 覆盖文本（空串 = 还原原生）→ 更新内存 → 通知订阅者。 */
  setIdentity(text: string): Promise<void>
  /** 清表 + 清种子标记 → 重写种子 → 通知订阅者。连带清空 identity 覆盖。 */
  reset(): Promise<void>
}

export interface PromptLayerTables {
  promptLayers: KvTable<string, PromptLayersRow>
  meta: KvTable<string, { value: string }>
}

/** 组装存储行：identity 仅非空时落字段（空串 = 还原原生，不留残字段）。 */
function row(layers: LayerConfig[], identity: string): PromptLayersRow {
  return identity === '' ? { layers } : { layers, identity }
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
  let identity: string
  const existing = promptLayers.get(PROMPT_LAYERS_KEY)
  if (existing !== undefined) {
    // 不再 validateLayers(existing.layers)：旧存储可能含已退役的层名（如 base），
    // reconcile 负责对齐种子结构，校验只针对 reconcile 后的结果（恒合法，防御性保留）。
    cache = reconcileLayers(existing.layers, seedLayers)
    validateLayers(cache)
    identity = existing.identity ?? ''
    await promptLayers.put(PROMPT_LAYERS_KEY, row(cache, identity))
  } else {
    cache = seedLayers
    identity = ''
    await promptLayers.put(PROMPT_LAYERS_KEY, { layers: cache })
  }
  if (meta.get(PROMPT_LAYERS_SEEDED_KEY) === undefined) {
    await meta.put(PROMPT_LAYERS_SEEDED_KEY, { value: '1' })
  }

  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of [...listeners]) listener() }

  return {
    get: () => cache,
    getIdentity: () => identity,
    async set(layers: LayerConfig[]): Promise<void> {
      validateLayers(layers)
      validateFixedLayers(layers, seedLayers)
      await promptLayers.put(PROMPT_LAYERS_KEY, row(layers, identity))
      cache = layers
      notify()
    },
    async setIdentity(text: string): Promise<void> {
      await promptLayers.put(PROMPT_LAYERS_KEY, row(cache, text))
      identity = text
      notify()
    },
    async reset(): Promise<void> {
      await promptLayers.delete(PROMPT_LAYERS_KEY)
      await meta.delete(PROMPT_LAYERS_SEEDED_KEY)
      await promptLayers.put(PROMPT_LAYERS_KEY, { layers: seedLayers })
      await meta.put(PROMPT_LAYERS_SEEDED_KEY, { value: '1' })
      cache = seedLayers
      identity = ''
      notify()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
