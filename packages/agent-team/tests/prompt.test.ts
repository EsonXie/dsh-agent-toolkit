// packages/agent-team/tests/prompt.test.ts
import { expect, test } from 'vitest'
import { buildMemberPersona } from '../src/prompt.ts'
import type { Role } from '../src/roles.ts'

const role: Role = { name: 'reviewer', description: '代码审查员', persona: '你是资深代码审查员。' }

test('拼装含基础层三段与 persona 层，persona 在最后', () => {
  const text = buildMemberPersona(role, 'deepseek-chat')
  expect(text).toContain('角色：reviewer')        // A 段含角色名
  expect(text).toContain('不能再次委派')          // A 段契约
  expect(text).toContain('AGENTS.md')             // B 段能力守则
  const personaIndex = text.lastIndexOf('你是资深代码审查员。')
  expect(personaIndex).toBeGreaterThan(-1)
  expect(text.slice(personaIndex)).toBe('你是资深代码审查员。')
})

test('reasoning 族模型用 reasoning 模板', () => {
  const text = buildMemberPersona(role, 'deepseek-reasoner')
  expect(text).toContain('推理能力')
})

test('chat 族模型用 chat 模板', () => {
  expect(buildMemberPersona(role, 'deepseek-chat')).toContain('先结论，后依据')
})

test('未知模型与 undefined 都用 default 模板', () => {
  expect(buildMemberPersona(role, 'gpt-5')).toContain('自包含')
  expect(buildMemberPersona(role, undefined)).toContain('自包含')
})

test('Config 模板覆盖：families 优先，其次 default', () => {
  const custom = buildMemberPersona(role, 'deepseek-reasoner', {
    families: { reasoning: '自定义推理模板' },
  })
  expect(custom).toContain('自定义推理模板')
  const customDefault = buildMemberPersona(role, 'gpt-5', { default: '自定义兜底' })
  expect(customDefault).toContain('自定义兜底')
})
