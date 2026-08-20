/** prompt-stack 插件：语义化提示词分层 + 按模型规则覆盖层文本。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// type-only 导入激活声明合并：Context.systemPrompt 与 AssembleContext.agent。
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { DEFAULT_LAYERS, DEFAULT_RULES } from './defaults.ts'
import { globToRegExp, selectRule } from './match.ts'
import type { Config as ConfigT, Rule } from './types.ts'

export type Config = ConfigT
export type { LayerConfig, Rule, RuleMatch } from './types.ts'

export const name = 'prompt-stack'

export const inject = ['systemPrompt']

/** 固定追加层的层名（保留，用户层不得使用）。 */
export const MODEL_NOTES_LAYER = 'model-notes'

export const Config: z<unknown, ConfigT> = z.object({
  layers: z.array(z.object({
    name: z.string().required(),
    order: z.number().required(),
    text: z.string().required(),
  })).default(DEFAULT_LAYERS),
  // 元素 cast 为 z<Rule>：Rule.overrides/append 可选，而 z.object 输出键全必填，
  // 直接 .default(DEFAULT_RULES) 会类型不匹配。transform 丢弃空 overrides：
  // z.dict 隐式默认 {}，会给 append-only 默认规则注入 overrides: {}（破坏
  // Config({}) 与 DEFAULT_RULES 的精确相等）。
  rules: z.array((z.object({
    match: z.object({
      provider: z.string(),
      model: z.string(),
      modelPattern: z.string(),
    }).required(),
    overrides: z.transform(z.dict(z.string()), value => Object.keys(value).length === 0 ? undefined : value),
    append: z.string(),
  }) as z<Rule>)).default(DEFAULT_RULES),
  // 输入侧用 unknown：插件 config 来自 YAML/用户（未校验），schema 负责校验与默认。
}) as z<unknown, ConfigT>

/**
 * 激活期校验（dsh「误配置响亮失败」惯例）：空 layers、层名重复、保留层名、
 * overrides 引用未知层、空 match、非法 glob 全部抛错。
 * @param config - 已经过 schema 解析的配置。
 */
export function validateConfig(config: ConfigT): void {
  if (config.layers.length === 0) {
    throw new Error('prompt-stack: config.layers must define at least one layer')
  }
  const names = new Set<string>()
  for (const layer of config.layers) {
    if (layer.name === MODEL_NOTES_LAYER) {
      throw new Error(`prompt-stack: layer name "${MODEL_NOTES_LAYER}" is reserved for the rules' append text`)
    }
    if (names.has(layer.name)) {
      throw new Error(`prompt-stack: duplicate layer name "${layer.name}"`)
    }
    names.add(layer.name)
  }
  for (const [index, rule] of config.rules.entries()) {
    const { provider, model, modelPattern } = rule.match
    if (provider === undefined && model === undefined && modelPattern === undefined) {
      throw new Error(`prompt-stack: rules[${index}].match must set at least one of provider, model, modelPattern`)
    }
    // 非法 glob（空 pattern）在此抛错。
    if (modelPattern !== undefined) globToRegExp(modelPattern)
    for (const key of Object.keys(rule.overrides ?? {})) {
      if (!names.has(key)) {
        throw new Error(`prompt-stack: rules[${index}].overrides references unknown layer "${key}"`)
      }
    }
  }
}

/**
 * 每个层注册一个函数式 section；text 在每次组装时按当前 agent 的
 * provider/model 选唯一命中规则（最高分、同分取配置序靠前），用其
 * overrides 替换该层文本。裸组装（无 agent）静默用默认文本。
 *
 * 运行时切模型（dsh model-selection）：它在 agent scope 的
 * `system-prompt/assemble` waterfall 内层把 `variables.provider/model` 覆盖为
 * 运行时选择（web 会话的模型选择只走这条路，不改 agent.options）。本插件全局
 * 注册于 boot 期，在 waterfall 链中居外层，`await next()` 返回时用最终
 * variables 重新解析本插件各段——运行时选择由此生效；无覆盖时 variables 即
 * 创建期 agent.options（agent-loop 注册的变量提供器），行为与基线一致。
 */
export function apply(ctx: Context, config: ConfigT): void {
  validateConfig(config)
  const notesOrder = Math.max(...config.layers.map(layer => layer.order)) + 1
  const hitRule = (context: AssembleContext): Rule | undefined =>
    selectRule(config.rules, context.agent?.options?.provider, context.agent?.options?.model)
  for (const layer of config.layers) {
    ctx.systemPrompt.section({
      name: `prompt-stack:${layer.name}`,
      order: layer.order,
      text: (context) => hitRule(context)?.overrides?.[layer.name] ?? layer.text,
    })
  }
  // 无命中时返回空串，沿用 dsh「空段不渲染」被丢弃。
  ctx.systemPrompt.section({
    name: `prompt-stack:${MODEL_NOTES_LAYER}`,
    order: notesOrder,
    text: (context) => hitRule(context)?.append ?? '',
  })

  const notesSection = `prompt-stack:${MODEL_NOTES_LAYER}`
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    // 最终 variables 优先（运行时选择），缺省回退创建期 agent.options。
    const provider = assembled.variables.provider ?? context.agent?.options?.provider
    const model = assembled.variables.model ?? context.agent?.options?.model
    const rule = selectRule(config.rules, provider, model)
    const sections = assembled.sections.map((section) => {
      if (section.name === notesSection) {
        return { ...section, text: rule?.append ?? '' }
      }
      const layer = config.layers.find(l => section.name === `prompt-stack:${l.name}`)
      if (layer === undefined) return section
      return { ...section, text: rule?.overrides?.[layer.name] ?? layer.text }
    })
    return { ...assembled, sections }
  })
}
