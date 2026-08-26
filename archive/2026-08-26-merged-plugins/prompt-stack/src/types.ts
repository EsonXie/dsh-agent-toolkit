/** prompt-stack 的配置类型（仅类型，无运行时代码）。 */

/** 一个语义层：name 同时是 section 名后缀（`prompt-stack:<name>`）。 */
export interface LayerConfig {
  name: string
  /** 拼接顺序，升序；建议区间见 spec：0 persona / 10–40 domain / 50 task。 */
  order: number
  /** 层文本，支持 dsh 严格插值 `{{variable}}`。 */
  text: string
}

/** 模型匹配条件：三字段均可选但至少一个；多字段为 AND 语义。 */
export interface RuleMatch {
  /** provider 精确匹配。 */
  provider?: string
  /** 模型 id 精确匹配。 */
  model?: string
  /** 模型 id glob（`*` / `?`），如 `deepseek-*`、`gpt*codex*`。 */
  modelPattern?: string
}

/** 一条模型规则：命中后按层覆盖文本，可选追加 model-notes。 */
export interface Rule {
  match: RuleMatch
  /** 层名 -> 替换文本。 */
  overrides?: Record<string, string>
  /** 命中时渲染为固定追加层 `prompt-stack:model-notes`。 */
  append?: string
}

/** 插件配置（整体替换语义，不做深合并）。 */
export interface Config {
  layers: LayerConfig[]
  rules: Rule[]
}
