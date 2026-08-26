import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/types.d.ts
/** prompt-stack 的配置类型（仅类型，无运行时代码）。 */
/** 一个语义层：name 同时是 section 名后缀（`prompt-stack:<name>`）。 */
interface LayerConfig {
  name: string;
  /** 拼接顺序，升序；建议区间见 spec：0 persona / 10–40 domain / 50 task。 */
  order: number;
  /** 层文本，支持 dsh 严格插值 `{{variable}}`。 */
  text: string;
}
/** 模型匹配条件：三字段均可选但至少一个；多字段为 AND 语义。 */
interface RuleMatch {
  /** provider 精确匹配。 */
  provider?: string;
  /** 模型 id 精确匹配。 */
  model?: string;
  /** 模型 id glob（`*` / `?`），如 `deepseek-*`、`gpt*codex*`。 */
  modelPattern?: string;
}
/** 一条模型规则：命中后按层覆盖文本，可选追加 model-notes。 */
interface Rule {
  match: RuleMatch;
  /** 层名 -> 替换文本。 */
  overrides?: Record<string, string>;
  /** 命中时渲染为固定追加层 `prompt-stack:model-notes`。 */
  append?: string;
}
/** 插件配置（整体替换语义，不做深合并）。 */
interface Config$1 {
  layers: LayerConfig[];
  rules: Rule[];
}
//#endregion
//#region src/index.d.ts
type Config = Config$1;
declare const name = "prompt-stack";
declare const inject: string[];
/** 固定追加层的层名（保留，用户层不得使用）。 */
declare const MODEL_NOTES_LAYER = "model-notes";
declare const Config: z<unknown, Config$1>;
/**
 * 激活期校验（dsh「误配置响亮失败」惯例）：空 layers、层名重复、保留层名、
 * overrides 引用未知层、空 match、非法 glob 全部抛错。
 * @param config - 已经过 schema 解析的配置。
 */
declare function validateConfig(config: Config$1): void;
/**
 * 每个层注册一个函数式 section；text 在每次组装时按当前 agent 的
 * provider/model 选唯一命中规则（最高分、同分取配置序靠前），用其
 * overrides 替换该层文本。裸组装（无 agent）静默用默认文本。
 *
 * 运行时选模型（dsh model-selection）：web 会话的模型选择只改 assemble
 * waterfall 内层的 `variables.provider/model`，不改 agent.options。本插件全局
 * 注册于 boot 期、恒居 waterfall 外层，`await next()` 返回时用最终 variables
 * 解析——首条消息（首次组装）按当次选择的模型命中规则，随后按 session 钉住；
 * 无运行时选择时 variables 即创建期 agent.options（agent-loop 的变量提供器）。
 */
declare function apply(ctx: Context, config: Config$1): void;
//#endregion
export { Config, type LayerConfig, MODEL_NOTES_LAYER, type Rule, type RuleMatch, apply, inject, name, validateConfig };
//# sourceMappingURL=index.d.ts.map