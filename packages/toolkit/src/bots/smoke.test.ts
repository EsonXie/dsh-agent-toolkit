import { describe, expect, test } from 'vitest'
import { setupBots, type BotsModuleConfig } from './index.ts'

describe('bots 模块导出', () => {
  test('导出 setupBots 模块函数（suite apply 接线用）', () => {
    expect(typeof setupBots).toBe('function')
  })

  test('BotsModuleConfig 十八字段（sessionsPageSize 为 /sessions 分页新增）', () => {
    const config: BotsModuleConfig = {
      cardUpdateThrottleMs: 0, cardMaxBytes: 0, cardPrintStep: 0, processMaxBytes: 0,
      registerAppTimeoutMs: 0, processingReactionEmoji: '', errorDetailMaxChars: 0, injectSender: false, approval: false, questions: false, docMaxBytes: 0,
      debugLog: false, debugLogDir: '', debugLogRetentionDays: 0, permissionPreset: 'danger-full-access',
      questionTimeoutMs: 0, approvalTimeoutMs: 0, sessionsPageSize: 0,
    }
    expect(Object.keys(config).sort()).toEqual([
      'approval', 'approvalTimeoutMs', 'cardMaxBytes', 'cardPrintStep', 'cardUpdateThrottleMs', 'debugLog', 'debugLogDir', 'debugLogRetentionDays',
      'docMaxBytes', 'errorDetailMaxChars', 'injectSender', 'permissionPreset', 'processMaxBytes', 'processingReactionEmoji',
      'questionTimeoutMs', 'questions', 'registerAppTimeoutMs', 'sessionsPageSize',
    ])
  })
})
