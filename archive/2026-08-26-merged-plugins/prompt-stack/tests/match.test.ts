import { describe, expect, test } from 'vitest'
import { globToRegExp, scoreRule, selectRule } from '../src/match.ts'
import type { Rule } from '../src/types.ts'

describe('globToRegExp', () => {
  test('* 匹配任意后缀，锚定全串', () => {
    const re = globToRegExp('deepseek-*')
    expect(re.test('deepseek-v4')).toBe(true)
    expect(re.test('deepseek-')).toBe(true)
    expect(re.test('deepseek')).toBe(false)
    expect(re.test('x-deepseek-v4')).toBe(false)
  })

  test('正则元字符被转义，不误配', () => {
    const re = globToRegExp('gpt-4*')
    expect(re.test('gpt-4o')).toBe(true)
    expect(re.test('gptX4o')).toBe(false)
  })

  test('多段通配 gpt*codex*', () => {
    const re = globToRegExp('gpt*codex*')
    expect(re.test('gpt-5-codex')).toBe(true)
    expect(re.test('gpt-5')).toBe(false)
  })

  test('空 pattern 与全空白 pattern 抛错', () => {
    expect(() => globToRegExp('')).toThrow(/non-empty/)
    expect(() => globToRegExp('   ')).toThrow(/non-empty/)
  })
})

describe('scoreRule', () => {
  test('model 精确 = 4，modelPattern = 2，provider = 1，累加', () => {
    expect(scoreRule({ model: 'deepseek-v4' }, 'deepseek', 'deepseek-v4')).toBe(4)
    expect(scoreRule({ modelPattern: 'deepseek-*' }, 'deepseek', 'deepseek-v4')).toBe(2)
    expect(scoreRule({ provider: 'deepseek' }, 'deepseek', 'deepseek-v4')).toBe(1)
    expect(scoreRule({ provider: 'deepseek', model: 'deepseek-v4' }, 'deepseek', 'deepseek-v4')).toBe(5)
    expect(scoreRule({ provider: 'deepseek', modelPattern: 'deepseek-*' }, 'deepseek', 'deepseek-v4')).toBe(3)
  })

  test('任一指定字段不匹配则整条不命中（AND 语义）', () => {
    expect(scoreRule({ provider: 'deepseek', model: 'v3' }, 'deepseek', 'deepseek-v4')).toBe(0)
    expect(scoreRule({ modelPattern: 'claude*' }, 'deepseek', 'deepseek-v4')).toBe(0)
    expect(scoreRule({ provider: 'openai' }, 'deepseek', 'deepseek-v4')).toBe(0)
  })

  test('provider/model 为 undefined 时不命中依赖它们的字段', () => {
    expect(scoreRule({ model: 'm' }, undefined, undefined)).toBe(0)
    expect(scoreRule({ modelPattern: '*' }, undefined, undefined)).toBe(0)
    expect(scoreRule({ provider: 'p' }, undefined, 'm')).toBe(0)
    expect(scoreRule({ modelPattern: '*' }, undefined, 'm')).toBe(2)
  })
})

describe('selectRule', () => {
  const rules: Rule[] = [
    { match: { provider: 'deepseek' }, append: 'provider-rule' },
    { match: { modelPattern: 'deepseek-*' }, append: 'pattern-rule' },
    { match: { model: 'deepseek-v4' }, append: 'exact-rule' },
  ]

  test('精确 id > 通配 > provider-only', () => {
    expect(selectRule(rules, 'deepseek', 'deepseek-v4')?.append).toBe('exact-rule')
    expect(selectRule(rules, 'deepseek', 'deepseek-v3')?.append).toBe('pattern-rule')
    expect(selectRule(rules, 'deepseek', 'other')?.append).toBe('provider-rule')
  })

  test('同分取配置序靠前者', () => {
    const tied: Rule[] = [
      { match: { modelPattern: 'gpt-4*' }, append: 'first' },
      { match: { modelPattern: 'gpt*' }, append: 'second' },
    ]
    expect(selectRule(tied, 'openai', 'gpt-4o')?.append).toBe('first')
  })

  test('无命中返回 undefined', () => {
    expect(selectRule(rules, 'openai', 'gpt-4o')).toBeUndefined()
    expect(selectRule([], 'deepseek', 'deepseek-v4')).toBeUndefined()
  })
})
