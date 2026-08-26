import { describe, expect, test } from 'vitest'
import { setupBots, type BotsModuleConfig } from './index.ts'

describe('bots 模块导出', () => {
  test('导出 setupBots 模块函数（suite apply 接线用）', () => {
    expect(typeof setupBots).toBe('function')
  })

  test('BotsModuleConfig 六字段与 project-bot Config 同字段名（默认值由 Task 15 平移，源：archive project-bot/src/index.ts:38-45）', () => {
    const config: BotsModuleConfig = {
      cardUpdateThrottleMs: 0, cardMaxBytes: 0, processMaxBytes: 0,
      registerAppTimeoutMs: 0, processingReactionEmoji: '', errorDetailMaxChars: 0,
    }
    expect(Object.keys(config).sort()).toEqual([
      'cardMaxBytes', 'cardUpdateThrottleMs', 'errorDetailMaxChars',
      'processMaxBytes', 'processingReactionEmoji', 'registerAppTimeoutMs',
    ])
  })
})
