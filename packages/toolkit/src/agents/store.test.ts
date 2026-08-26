import { describe, expect, test } from 'vitest'
import { AgentRecordSchema, agentToolkitDomain } from './store.ts'

const VALID = {
  id: 'explorer',
  name: 'Explorer',
  description: '只读探索',
  promptLayers: [{ name: 'persona', order: 0, text: '你是探索员。' }],
  model: { provider: 'anthropic', model: 'claude-sonnet-4' },
  tools: { allow: ['read'] },
  builtin: true,
}

describe('agentToolkitDomain', () => {
  test('域名、版本与表布局', () => {
    expect(agentToolkitDomain.name).toBe('dsh_agent_toolkit')
    expect(agentToolkitDomain.version).toBe(1)
    expect(Object.keys(agentToolkitDomain.tables)).toEqual(['agents', 'meta'])
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
})
