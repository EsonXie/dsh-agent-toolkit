import { describe, expect, test } from 'vitest'
import { Config, validateConfig } from '../src/index.ts'
import { DEFAULT_LAYERS, DEFAULT_RULES } from '../src/defaults.ts'
import type { Config as ConfigT } from '../src/types.ts'

const base: ConfigT = {
  layers: [
    { name: 'base', order: 0, text: 'BASE' },
    { name: 'task', order: 50, text: 'TASK' },
  ],
  rules: [{ match: { modelPattern: 'deepseek-*' }, overrides: { task: 'T' }, append: 'N' }],
}

describe('validateConfig', () => {
  test('合法配置与插件默认配置都通过', () => {
    expect(() => validateConfig(base)).not.toThrow()
    expect(() => validateConfig({ layers: DEFAULT_LAYERS, rules: DEFAULT_RULES })).not.toThrow()
  })

  test('layers 为空数组抛错', () => {
    expect(() => validateConfig({ layers: [], rules: [] })).toThrow(/at least one layer/)
  })

  test('层名重复抛错', () => {
    const config: ConfigT = { ...base, layers: [...base.layers, { name: 'base', order: 9, text: 'X' }] }
    expect(() => validateConfig(config)).toThrow(/duplicate layer name "base"/)
  })

  test('保留层名 model-notes 抛错', () => {
    const config: ConfigT = { ...base, layers: [...base.layers, { name: 'model-notes', order: 9, text: 'X' }] }
    expect(() => validateConfig(config)).toThrow(/reserved/)
  })

  test('overrides 引用不存在的层名抛错', () => {
    const config: ConfigT = { ...base, rules: [{ match: { model: 'm' }, overrides: { ghost: 'X' } }] }
    expect(() => validateConfig(config)).toThrow(/unknown layer "ghost"/)
  })

  test('match 三字段全空抛错（带规则序号）', () => {
    const config: ConfigT = { ...base, rules: [{ match: {} }] }
    expect(() => validateConfig(config)).toThrow(/rules\[0\].match/)
  })

  test('空 modelPattern 抛错', () => {
    const config: ConfigT = { ...base, rules: [{ match: { modelPattern: '  ' } }] }
    expect(() => validateConfig(config)).toThrow(/non-empty glob/)
  })
})

describe('Config schema', () => {
  test('空输入产出默认配置（layers/rules 整体默认）', () => {
    const parsed = Config({})
    expect(parsed.layers).toEqual(DEFAULT_LAYERS)
    expect(parsed.rules).toEqual(DEFAULT_RULES)
  })

  test('用户配置整体替换默认值（不做深合并）', () => {
    const parsed = Config({ layers: [{ name: 'only', order: 3, text: 'X' }] })
    expect(parsed.layers).toEqual([{ name: 'only', order: 3, text: 'X' }])
    expect(parsed.rules).toEqual(DEFAULT_RULES)
  })
})
