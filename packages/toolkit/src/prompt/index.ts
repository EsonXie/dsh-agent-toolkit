/** prompt 模块：语义化提示词分层 + 按模型规则覆盖层文本（吸收归档 prompt-stack）。 */
import type { Context } from '@deepseek-ai/cordis'
// type-only 导入激活声明合并：Context.systemPrompt 与 AssembleContext.agent。
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PERSONA_SECTION, type AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { TOOLKIT_PERSONA_SECTION } from '../channels/agent-setup.ts'
import { DEFAULT_LAYERS, DEFAULT_RULES } from './defaults.ts'
import { globToRegExp, selectRule } from './match.ts'
import type { Config as ConfigT, LayerConfig, Rule } from './types.ts'

export type { Config, LayerConfig, Rule, RuleMatch } from './types.ts'

/** 固定追加层的层名（保留，用户层不得使用）。 */
export const MODEL_NOTES_LAYER = 'model-notes'

/** persona 层名（固定层栈成员）：不注册 prompt-stack:* 段，运行时填入原生 deployment:persona 槽位。 */
export const PERSONA_LAYER = 'persona'

/** 运行时层视图：setupPrompt 只消费 get + subscribe，不关心存储细节（测试可注入假实现）。 */
export interface LayerView {
  get(): LayerConfig[]
  subscribe(listener: () => void): () => void
}

/** 层列表语义校验：空、层名重复、保留层名。层名规则校验（overrides 引用）见 validateConfig。 */
export function validateLayers(layers: LayerConfig[]): void {
  if (layers.length === 0) {
    throw new Error('prompt-stack: config.layers must define at least one layer')
  }
  const names = new Set<string>()
  for (const layer of layers) {
    if (layer.name === MODEL_NOTES_LAYER) {
      throw new Error(`prompt-stack: layer name "${MODEL_NOTES_LAYER}" is reserved for the rules' append text`)
    }
    if (names.has(layer.name)) {
      throw new Error(`prompt-stack: duplicate layer name "${layer.name}"`)
    }
    names.add(layer.name)
  }
}

/**
 * 激活期校验（dsh「误配置响亮失败」惯例）：空 layers、层名重复、保留层名、
 * overrides 引用未知层、空 match、非法 glob 全部抛错。
 * @param config - 已经过 schema 解析的配置。
 */
export function validateConfig(config: ConfigT): void {
  validateLayers(config.layers)
  const names = new Set(config.layers.map(layer => layer.name))
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
 * 运行时选模型（dsh model-selection）：web 会话的模型选择只改 assemble
 * waterfall 内层的 `variables.provider/model`，不改 agent.options。本模块全局
 * 注册于 boot 期、恒居 waterfall 外层，`await next()` 返回时用最终 variables
 * 解析——首条消息（首次组装）按当次选择的模型命中规则，随后按 session 钉住；
 * 无运行时选择时 variables 即创建期 agent.options（agent-loop 的变量提供器）。
 */
export function setupPrompt(ctx: Context, config: { source: LayerView; rules: Rule[] }): void {
  const { source, rules } = config
  const hitRule = (context: AssembleContext): Rule | undefined =>
    selectRule(rules, context.agent?.options?.provider, context.agent?.options?.model)
  // 子 Agent 隔离：人设/领域/任务等普通层不泄漏进子 Agent 组装（spec §4.5）；
  // model-notes 是模型层（模型的通用使用说明），主子共用、按子的生效模型命中规则。
  const isSubagent = (context: AssembleContext): boolean =>
    context.agent?.session?.header?.origin === 'subagent'

  // 层文本可经 UI 修改：registerSections 先 dispose 上一轮再按当前层重注册，
  // source 变更时经 subscribe 触发。dispose 用 section() 返回的 disposer。
  // persona 层不注册 prompt-stack:* 段——它经下方 waterfall 填入原生
  // deployment:persona 槽位（每次组装实时读 source.get()，无需重注册）。
  let disposers: Array<() => void> = []
  const registerSections = (): void => {
    for (const dispose of disposers) dispose()
    disposers = []
    const layers = source.get()
    validateLayers(layers)
    const sectionLayers = layers.filter(layer => layer.name !== PERSONA_LAYER)
    const notesOrder = sectionLayers.length > 0 ? Math.max(...sectionLayers.map(layer => layer.order)) + 1 : 1
    for (const layer of sectionLayers) {
      disposers.push(ctx.systemPrompt.section({
        name: `prompt-stack:${layer.name}`,
        order: layer.order,
        text: (context) =>
          isSubagent(context) ? '' : (hitRule(context)?.overrides?.[layer.name] ?? layer.text),
      }))
    }
    // 无命中时返回空串，沿用 dsh「空段不渲染」被丢弃。
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
    // 最终 variables 优先（运行时选择），缺省回退创建期 agent.options。
    let provider = assembled.variables.provider ?? context.agent?.options?.provider
    let model = assembled.variables.model ?? context.agent?.options?.model
    const agent = context.agent
    if (agent !== undefined) {
      const cached = pinned.get(agent)
      if (cached !== undefined && cached.sessionId === agent.session.id) {
        provider = cached.provider
        model = cached.model
      } else if (provider !== undefined || model !== undefined) {
        // 只在解析出实际模型时缓存；全 undefined 的组装不钉住（留给首个真实 step）。
        pinned.set(agent, { sessionId: agent.session.id, provider, model })
      }
    }
    const rule = selectRule(rules, provider, model)
    const layers = source.get()
    const sections = assembled.sections.map((section) => {
      if (section.name === notesSection) {
        return { ...section, text: rule?.append ?? '' }
      }
      // persona 层填入原生 deployment:persona 槽位（UI 总是优先于 cordis.yml 的
      // systemPrompt.persona）。两处豁免：子 Agent 的槽位由委派装配提供；
      // bot 会话的 scoped 角色 persona 段在场 = 角色覆盖主 Agent persona。
      if (section.name === PERSONA_SECTION) {
        if (isSubagent(context)) return section
        if (assembled.sections.some(s => s.name === TOOLKIT_PERSONA_SECTION)) return section
        const personaLayer = layers.find(l => l.name === PERSONA_LAYER)
        if (personaLayer === undefined) return section
        return { ...section, text: rule?.overrides?.[PERSONA_LAYER] ?? personaLayer.text }
      }
      const layer = layers.find(l => section.name === `prompt-stack:${l.name}`)
      if (layer === undefined) return section
      // 子 Agent 隔离在此同样生效：上面的 text 回调返回的空串会被本节覆盖，
      // 所以按 origin 直接改写（model-notes 分支已在上面单独处理，不受隔离）。
      return { ...section, text: isSubagent(context) ? '' : (rule?.overrides?.[layer.name] ?? layer.text) }
    })
    return { ...assembled, sections }
  })
}
