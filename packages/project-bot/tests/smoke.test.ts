import { describe, expect, test } from 'vitest'
import { Config, inject, name } from '../src/index.ts'

describe('project-bot 插件导出', () => {
  test('导出名与依赖声明', () => {
    expect(name).toBe('project-bot')
    expect(inject).toEqual(['agents', 'credentials', 'storageDomain', 'tools'])
  })

  test('Config 默认值', () => {
    const config = Config({})
    expect(config.cardUpdateThrottleMs).toBe(500)
    expect(config.cardMaxBytes).toBe(28_000)
    expect(config.registerAppTimeoutMs).toBe(600_000)
    expect(config.processingReactionEmoji).toBe('OneSecond')
  })
})
