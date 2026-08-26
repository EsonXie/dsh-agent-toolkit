import { describe, expect, test } from 'vitest'
import { validateConfig } from './index.ts'
import { DEFAULT_LAYERS, DEFAULT_RULES } from './defaults.ts'
import type { Config as ConfigT } from './types.ts'

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

describe('默认配置（DEFAULT_*，schema 默认值来源）', () => {
  test('空输入对应的默认配置 = DEFAULT_LAYERS + DEFAULT_RULES，且合法', () => {
    const defaults = { layers: DEFAULT_LAYERS, rules: DEFAULT_RULES }
    expect(defaults.layers.length).toBeGreaterThan(0)
    expect(defaults.rules.length).toBeGreaterThan(0)
    expect(() => validateConfig(defaults)).not.toThrow()
  })

  test('默认规则 overrides 全部命中默认层名', () => {
    const layerNames = new Set(DEFAULT_LAYERS.map(layer => layer.name))
    for (const rule of DEFAULT_RULES) {
      for (const key of Object.keys(rule.overrides ?? {})) {
        expect(layerNames.has(key), `默认规则 overrides 引用未知层 "${key}"`).toBe(true)
      }
    }
  })
})
