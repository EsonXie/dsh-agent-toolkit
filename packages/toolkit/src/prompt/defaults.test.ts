import { describe, expect, test } from 'vitest'
import { DEFAULT_LAYERS, DEFAULT_RULES } from './defaults.ts'
import { selectRule } from './match.ts'

/** 所有默认文本中禁止出现的 opencode 专有标记（大小写不敏感者另行小写化比较）。 */
const FORBIDDEN = ['opencode', '/bug', '/help', 'ctrl+p', 'todowrite', 'apply_patch', 'webfetch', 'opencode.ai', 'anomalyco']

/** 每条规则文本（overrides 与 append）的必含标记。 */
const REQUIRED_MARKERS: Array<{ ruleIndex: number; markers: string[] }> = [
  { ruleIndex: 0, markers: ['Professional objectivity'] },        // claude → anthropic
  { ruleIndex: 1, markers: ['Core Mandates'] },                   // gemini
  { ruleIndex: 2, markers: ['Workflow', 'root cause'] },          // gpt-4* → beast
  { ruleIndex: 5, markers: ['Editing constraints'] },             // gpt*codex* → codex
  { ruleIndex: 6, markers: ['Autonomy and persistence'] },        // gpt* → gpt
  { ruleIndex: 7, markers: ['same language as the user'] },       // kimi* → kimi
  { ruleIndex: 14, markers: ['reasoning_content'] },              // glm-* append
]

function allTexts(): string[] {
  const texts = DEFAULT_LAYERS.map(layer => layer.text)
  for (const rule of DEFAULT_RULES) {
    texts.push(...Object.values(rule.overrides ?? {}))
    if (rule.append !== undefined) texts.push(rule.append)
  }
  return texts
}

describe('DEFAULT_LAYERS / DEFAULT_RULES 结构', () => {
  test('默认单层：persona（order 10，默认空串）；base 移出层集', () => {
    expect(DEFAULT_LAYERS).toEqual([{ name: 'persona', order: 10, text: '' }])
  })

  test('15 条默认规则；deepseek/glm 仅 append 无 overrides', () => {
    expect(DEFAULT_RULES).toHaveLength(15)
    const deepseek = DEFAULT_RULES[13]
    const glm = DEFAULT_RULES[14]
    expect(deepseek.match).toEqual({ modelPattern: 'deepseek*' })
    expect(deepseek.overrides).toBeUndefined()
    expect(deepseek.append).toBeDefined()
    expect(glm.match).toEqual({ modelPattern: 'glm-*' })
    expect(glm.overrides).toBeUndefined()
    expect(glm.append).toBeDefined()
  })
})

describe('默认文本卫生', () => {
  test('不含 opencode 专有标记', () => {
    for (const text of allTexts()) {
      const lower = text.toLowerCase()
      for (const token of FORBIDDEN) {
        expect(lower, `文本不应包含 "${token}"`).not.toContain(token)
      }
    }
  })

  test('各模型族文本含必含标记', () => {
    for (const { ruleIndex, markers } of REQUIRED_MARKERS) {
      const rule = DEFAULT_RULES[ruleIndex]
      const text = rule.overrides?.base ?? rule.append ?? ''
      for (const marker of markers) {
        expect(text, `rules[${ruleIndex}] 应包含 "${marker}"`).toContain(marker)
      }
    }
  })
})

describe('默认规则的选择行为', () => {
  test('claude/gemini/deepseek/glm/kimi 路由', () => {
    expect(selectRule(DEFAULT_RULES, 'anthropic', 'claude-sonnet-4')?.overrides?.base).toContain('Professional objectivity')
    expect(selectRule(DEFAULT_RULES, 'google', 'gemini-2.5-pro')?.overrides?.base).toContain('Core Mandates')
    expect(selectRule(DEFAULT_RULES, 'deepseek', 'deepseek-v4')?.append).toBeDefined()
    expect(selectRule(DEFAULT_RULES, 'zhipu', 'glm-4.6')?.append).toContain('reasoning_content')
    expect(selectRule(DEFAULT_RULES, 'moonshotai', 'k2')?.overrides?.base).toContain('same language as the user')
    expect(selectRule(DEFAULT_RULES, 'kimi-for-coding', 'k3-256k')?.overrides?.base).toContain('same language as the user')
    // kimi 官方模型 id（k2/k3-256k 等）+ 自定义 provider 名也能命中 kimi 族
    expect(selectRule(DEFAULT_RULES, 'kimi-coding', 'k3-256k')?.overrides?.base).toContain('same language as the user')
    expect(selectRule(DEFAULT_RULES, 'custom-provider', 'k2')?.overrides?.base).toContain('same language as the user')
  })

  test('gpt-4o 同分取配置序靠前者（beast 而非 gpt）', () => {
    expect(selectRule(DEFAULT_RULES, 'openai', 'gpt-4o')?.overrides?.base).toContain('Workflow')
  })

  test('gpt-5-codex 命中 codex 规则', () => {
    expect(selectRule(DEFAULT_RULES, 'openai', 'gpt-5-codex')?.overrides?.base).toContain('Editing constraints')
  })

  test('未知模型无命中', () => {
    expect(selectRule(DEFAULT_RULES, 'unknown', 'mystery-1')).toBeUndefined()
  })
})
