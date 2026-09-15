import { describe, expect, test } from 'vitest'
import { setupBots, type BotsModuleConfig } from './index.ts'

describe('bots 模块导出', () => {
  test('导出 setupBots 模块函数（suite apply 接线用）', () => {
    expect(typeof setupBots).toBe('function')
  })

  test('BotsModuleConfig 十字段与 project-bot Config 同字段名（默认值由 Task 15 平移，源：archive project-bot/src/index.ts:38-45；docMaxBytes 与 debugLog/debugLogDir/debugLogRetentionDays 为 Task 5 新增）', () => {
    const config: BotsModuleConfig = {
      cardUpdateThrottleMs: 0, cardMaxBytes: 0, cardPrintStep: 0, processMaxBytes: 0,
      registerAppTimeoutMs: 0, processingReactionEmoji: '', errorDetailMaxChars: 0, injectSender: false, approval: false, docMaxBytes: 0,
      debugLog: false, debugLogDir: '', debugLogRetentionDays: 0, permissionPreset: 'danger-full-access',
    }
    expect(Object.keys(config).sort()).toEqual([
      'approval', 'cardMaxBytes', 'cardPrintStep', 'cardUpdateThrottleMs', 'debugLog', 'debugLogDir', 'debugLogRetentionDays',
      'docMaxBytes', 'errorDetailMaxChars', 'injectSender', 'permissionPreset', 'processMaxBytes', 'processingReactionEmoji', 'registerAppTimeoutMs',
    ])
  })
})
