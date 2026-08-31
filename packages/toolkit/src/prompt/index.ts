/** prompt 模块：内置模型层（按模型规则整体覆盖）+ persona 可编辑层 + model-notes 自动层。 */
import type { Context } from '@deepseek-ai/cordis'
// type-only 导入激活声明合并：Context.systemPrompt 与 AssembleContext.agent。
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { BASE_TEXT } from './defaults.ts'
import { globToRegExp, selectRule } from './match.ts'
import type { Config as ConfigT, LayerConfig, Rule } from './types.ts'

export type { Config, LayerConfig, Rule, RuleMatch } from './types.ts'

/** 固定追加层的层名（保留，用户层不得使用）。 */
export const MODEL_NOTES_LAYER = 'model-notes'

/** 内置模型层名（保留）：固定注册 prompt-stack:base 段、不进存储，仍是 rules overrides 的合法目标。 */
export const BASE_LAYER = 'base'

const BASE_SECTION = `prompt-stack:${BASE_LAYER}`

/** 运行时层视图：setupPrompt 只消费 get + subscribe，不关心存储细节（测试可注入假实现）。 */
export interface LayerView {
  get(): LayerConfig[]
  subscribe(listener: () => void): () => void
}

/** 层列表语义校验：空、层名重复、保留层名（base/model-notes）。 */
export function validateLayers(layers: LayerConfig[]): void {
  if (layers.length === 0) {
    throw new Error('prompt-stack: config.layers must define at least one layer')
  }
  const names = new Set<string>()
  for (const layer of layers) {
    if (layer.name === MODEL_NOTES_LAYER || layer.name === BASE_LAYER) {
      throw new Error(`prompt-stack: layer name "${layer.name}" is reserved`)
    }
    if (names.has(layer.name)) {
      throw new Error(`prompt-stack: duplicate layer name "${layer.name}"`)
    }
    names.add(layer.name)
  }
}

/**
 * 激活期校验（dsh「误配置响亮失败」惯例）：空 layers、层名重复、保留层名、
 * overrides 引用未知层（内置 base 与 model-notes 之外的存储层名）、空 match、非法 glob 全部抛错。
 */
export function validateConfig(config: ConfigT): void {
  validateLayers(config.layers)
  const names = new Set([BASE_LAYER, ...config.layers.map(layer => layer.name)])
  for (const [index, rule] of config.rules.entries()) {
    const { provider, model, modelPattern } = rule.match
    if (provider === undefined && model === undefined && modelPattern === undefined) {
      throw new Error(`prompt-stack: rules[${index}].match must set at least one of provider, model, modelPattern`)
    }
    if (modelPattern !== undefined) globToRegExp(modelPattern)
    for (const key of Object.keys(rule.overrides ?? {})) {
      if (!names.has(key)) {
        throw new Error(`prompt-stack: rules[${index}].overrides references unknown layer "${key}"`)
      }
    }
  }
}

/**
 * 固定注册 prompt-stack:base（模型层，order 0）+ 每个存储层一个段 + model-notes。
 * 文本在每次组装时按当前 agent 的 provider/model 选唯一命中规则（最高分、同分取配置序靠前），
 * 模型层用 overrides.base 整体替换内置 BASE_TEXT，存储层用 overrides 替换该层文本。
 * 裸组装（无 agent）静默用默认文本。deployment:persona 槽位还原生，本模块不触碰。
 *
 * 运行时选模型与首条消息钉住语义不变（见 waterfall 注释）。
 */
export function setupPrompt(ctx: Context, config: { source: LayerView; rules: Rule[] }): void {
  const { source, rules } = config
  const hitRule = (context: AssembleContext): Rule | undefined =>
    selectRule(rules, context.agent?.options?.provider, context.agent?.options?.model)
  // 子 Agent 隔离：模型层/persona 不泄漏进子 Agent 组装；model-notes 是模型层
  // （模型的通用使用说明），主子共用、按子的生效模型命中规则。
  const isSubagent = (context: AssembleContext): boolean =>
    context.agent?.session?.header?.origin === 'subagent'

  // 层文本可经 UI 修改：registerSections 先 dispose 上一轮再按当前层重注册，
  // source 变更时经 subscribe 触发。base 与 model-notes 恒注册，不随层集变化。
  let disposers: Array<() => void> = []
  const registerSections = (): void => {
    for (const dispose of disposers) dispose()
    disposers = []
    const layers = source.get()
    validateLayers(layers)
    const notesOrder = Math.max(0, ...layers.map(layer => layer.order)) + 1
    disposers.push(ctx.systemPrompt.section({
      name: BASE_SECTION,
      order: 0,
      text: (context) =>
        isSubagent(context) ? '' : (hitRule(context)?.overrides?.[BASE_LAYER] ?? BASE_TEXT),
    }))
    for (const layer of layers) {
      disposers.push(ctx.systemPrompt.section({
        name: `prompt-stack:${layer.name}`,
        order: layer.order,
        text: (context) =>
          isSubagent(context) ? '' : (hitRule(context)?.overrides?.[layer.name] ?? layer.text),
      }))
    }
    disposers.push(ctx.systemPrompt.section({
      name: `prompt-stack:${MODEL_NOTES_LAYER}`,
      order: notesOrder,
      text: (context) => hitRule(context)?.append ?? '',
    }))
  }
  registerSections()
  ctx.effect(() => source.subscribe(registerSections))

  const notesSection = `prompt-stack:${MODEL_NOTES_LAYER}`
  // 首条消息钉住：每个会话的首次组装解析出的 provider/model 缓存起来，会话中途
  // 切模型不再改写系统提示词（对话的行为契约保持稳定）。键带 session id：
  // clear/新会话（id 变化）自动重新解析。HMR 重挂载换新闭包，缓存随之重置。
  const pinned = new WeakMap<Agent, { sessionId: unknown; provider: string | undefined; model: string | undefined }>()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    let provider = assembled.variables.provider ?? context.agent?.options?.provider
    let model = assembled.variables.model ?? context.agent?.options?.model
    const agent = context.agent
    if (agent !== undefined) {
      const cached = pinned.get(agent)
      if (cached !== undefined && cached.sessionId === agent.session.id) {
        provider = cached.provider
        model = cached.model
      } else if (provider !== undefined || model !== undefined) {
        pinned.set(agent, { sessionId: agent.session.id, provider, model })
      }
    }
    const rule = selectRule(rules, provider, model)
    const layers = source.get()
    // 本插件全局注册各段在本次组装的产出（不含钉住改写）。scoped 同名段（bot 角色
    // persona 等）经 dsh 原生 shadow 机制已覆盖全局段，其文本 ≠ 本插件产出，
    // 据此识别并跳过、不介入 shadow（spec §3「对主 Agent persona 层 waterfall 不介入」）。
    const ownSection = (section: { name: string }): string | undefined => {
      if (section.name === BASE_SECTION) {
        return isSubagent(context) ? '' : (hitRule(context)?.overrides?.[BASE_LAYER] ?? BASE_TEXT)
      }
      const layer = layers.find(l => section.name === `prompt-stack:${l.name}`)
      if (layer === undefined) return undefined
      return isSubagent(context) ? '' : (hitRule(context)?.overrides?.[layer.name] ?? layer.text)
    }
    const sections = assembled.sections.map((section) => {
      if (section.name === notesSection) {
        return { ...section, text: rule?.append ?? '' }
      }
      const own = ownSection(section)
      if (own === undefined || section.text !== own) return section
      if (section.name === BASE_SECTION) {
        return { ...section, text: isSubagent(context) ? '' : (rule?.overrides?.[BASE_LAYER] ?? BASE_TEXT) }
      }
      const layer = layers.find(l => section.name === `prompt-stack:${l.name}`)!
      return { ...section, text: isSubagent(context) ? '' : (rule?.overrides?.[layer.name] ?? layer.text) }
    })
    return { ...assembled, sections }
  })
}
