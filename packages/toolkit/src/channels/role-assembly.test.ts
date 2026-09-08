import { describe, expect, test } from 'vitest'
import { ROLE_PERSONA_SECTION, roleAgentOptions, roleHooks } from './role-assembly.ts'
import type { AgentRecord } from '../agents/store.ts'

const role = (over: Partial<AgentRecord>): AgentRecord => ({ id: 'explorer', name: 'Explorer', ...over })

describe('roleHooks', () => {
  test('persona 单 section（order 0，固定段名）+ tools 白名单', () => {
    expect(roleHooks(role({ persona: '你是探索员。', tools: { allow: ['read'] } }))).toEqual({
      sections: [{ name: ROLE_PERSONA_SECTION, order: 0, text: '你是探索员。' }],
      tools: ['read'],
    })
    expect(ROLE_PERSONA_SECTION).toBe('dsh-agent-toolkit:agent:persona')
  })
  test('空/纯空白 persona 省略 sections；无 tools 省略 tools', () => {
    expect(roleHooks(role({}))).toEqual({})
    expect(roleHooks(role({ persona: '   ' }))).toEqual({})
  })
})

describe('roleAgentOptions', () => {
  test('角色自配模型优先；缺省回退宿主默认模型', () => {
    const fallback = () => ({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(roleAgentOptions(role({ model: { provider: 'anthropic', model: 'claude-sonnet-4' } }), fallback))
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(roleAgentOptions(role({}), fallback)).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })
})
