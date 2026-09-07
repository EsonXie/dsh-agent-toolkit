import { describe, expect, test } from 'vitest'
import yaml from 'js-yaml'
import { BASIC_TOOLS } from '../channels/basic-tools.ts'
import { botPresetComposition, serializeBotRows } from './bot-preset.ts'

describe('botPresetComposition', () => {
  test('与 BASIC_TOOLS 一一对应：5 行、行 id/name/config 全对齐', () => {
    const rows = yaml.load(botPresetComposition())
    const shellId = process.platform === 'win32' ? 'tool-pwsh' : 'tool-bash'
    const shellName = process.platform === 'win32' ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash'
    expect(rows).toEqual([
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { text: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.' } },
      { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
      { id: shellId, name: shellName },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    ])
  })

  test('行序与 BASIC_TOOLS 一致', () => {
    const rows = yaml.load(botPresetComposition()) as { name: string }[]
    expect(rows.map((r) => r.name)).toEqual(BASIC_TOOLS.map((t) => t.id))
  })
})

describe('serializeBotRows', () => {
  test('未登记映射的 BASIC_TOOLS 行：抛错（生成被 setup 层 catch 转 warn）', () => {
    expect(() => serializeBotRows([{ id: '@deepseek-ai/dsh-tool-unknown' }])).toThrow(/未登记/)
  })
})
