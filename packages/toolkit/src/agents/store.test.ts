import { describe, expect, test } from 'vitest'
import { AgentRecordSchema, agentToolkitDomain, migrateAgentRecord } from './store.ts'

const VALID = {
  id: 'explorer',
  name: 'Explorer',
  description: '只读探索',
  persona: '你是探索员。',
  model: { provider: 'anthropic', model: 'claude-sonnet-4' },
  tools: { allow: ['read'] },
  builtin: true,
}

describe('agentToolkitDomain', () => {
  test('域名、版本与表布局', () => {
    expect(agentToolkitDomain.name).toBe('dsh_agent_toolkit')
    expect(agentToolkitDomain.version).toBe(1)
    expect(Object.keys(agentToolkitDomain.tables)).toEqual(['agents', 'meta', 'prompt_layers'])
  })

  test('prompt_layers 表 schema 校验 { layers: LayerConfig[] } 单行', () => {
    const table = agentToolkitDomain.tables.prompt_layers
    expect(table.valueSchema.safeParse({ layers: [{ name: 'base', order: 0, text: 'B' }] }).success).toBe(true)
    expect(table.valueSchema.safeParse({ layers: [{ name: 'base' }] }).success).toBe(false)
  })
})

describe('AgentRecordSchema', () => {
  test('接受完整合法记录', () => {
    expect(AgentRecordSchema.safeParse(VALID).success).toBe(true)
  })

  test('接受最小记录（main 保底形态）', () => {
    expect(AgentRecordSchema.safeParse({ id: 'main', name: '主 Agent', builtin: true }).success).toBe(true)
  })

  test('接受合法 id：main / 小写字母开头 slug', () => {
    for (const id of ['main', 'explorer', 'general', 'x', 'foo-bar', 'a' + 'b'.repeat(31)]) {
      expect(AgentRecordSchema.safeParse({ id, name: 'n' }).success).toBe(true)
    }
  })

  test('拒绝非法 id', () => {
    for (const id of ['', 'Main', '1abc', 'foo_bar', 'foo bar', 'a'.repeat(33)]) {
      expect(AgentRecordSchema.safeParse({ id, name: 'n' }).success).toBe(false)
    }
  })

  test('拒绝空 name', () => {
    expect(AgentRecordSchema.safeParse({ id: 'x', name: '' }).success).toBe(false)
    expect(AgentRecordSchema.safeParse({ id: 'x', name: '  ' }).success).toBe(true)
  })

  test('拒绝空 allow 数组（min(1) 语义，同 BOT 表 tools）', () => {
    expect(AgentRecordSchema.safeParse({ id: 'x', name: 'X', tools: { allow: [] } }).success).toBe(false)
  })

  test('接受 persona 字段与遗留 promptLayers（迁移输入）', () => {
    expect(AgentRecordSchema.safeParse({ id: 'x', name: 'X', persona: 'P' }).success).toBe(true)
    expect(AgentRecordSchema.safeParse({ id: 'x', name: 'X', promptLayers: [{ name: 'persona', order: 0, text: 'P' }] }).success).toBe(true)
  })
})

describe('migrateAgentRecord', () => {
  test('promptLayers 按 order 拼接进 persona 并剥离', () => {
    const migrated = migrateAgentRecord({
      id: 'x', name: 'X',
      promptLayers: [
        { name: 'b', order: 10, text: 'B' },
        { name: 'a', order: 0, text: 'A' },
      ],
    })
    expect(migrated).toEqual({ id: 'x', name: 'X', persona: 'A\n\nB' })
  })

  test('无 promptLayers 返回原引用', () => {
    const record = { id: 'x', name: 'X', persona: 'P' }
    expect(migrateAgentRecord(record)).toBe(record)
  })

  test('已有 persona 时保留 persona、剥离 promptLayers', () => {
    const migrated = migrateAgentRecord({
      id: 'x', name: 'X', persona: 'P',
      promptLayers: [{ name: 'a', order: 0, text: 'A' }],
    })
    expect(migrated).toEqual({ id: 'x', name: 'X', persona: 'P' })
  })

  test('promptLayers 全为空白文本则不产生 persona', () => {
    const migrated = migrateAgentRecord({
      id: 'x', name: 'X',
      promptLayers: [{ name: 'a', order: 0, text: '  ' }],
    })
    expect(migrated).toEqual({ id: 'x', name: 'X' })
  })
})
