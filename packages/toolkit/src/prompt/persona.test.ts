import { describe, expect, test } from 'vitest'
import { buildAgentPersona } from './persona.ts'
import { BASE_TEXT } from './defaults.ts'
import type { Rule } from './types.ts'

const SECTION_A = (roleName: string): string => `你是团队中的一名成员（角色：${roleName}），由主 Agent 委派任务。
- 你看不到主对话；任务书包含你完成工作所需的全部上下文。
- 你的最终输出会作为结果完整返回给主 Agent：直接给出结论与必要细节。
- 你不能再次委派他人；任务需要拆分时，自己按顺序完成。`

const SECTION_B = `能力使用守则：
- 你可以使用与主 Agent 相同的工具与 MCP 资源，但只在任务必需时调用。
- 动手修改代码前，先阅读项目根目录及涉及目录的 AGENTS.md，并遵循其中约定。
- 产生或修改文件后，运行相关检查（测试、类型检查）验证你的改动。`

describe('buildAgentPersona', () => {
  test('无 role.persona、无规则命中 = 契约段 + 内置模型层 BASE_TEXT', () => {
    expect(buildAgentPersona({ rules: [] }, { name: 'explorer' }))
      .toBe(`${SECTION_A('explorer')}\n\n${SECTION_B}\n\n${BASE_TEXT}`)
  })

  test('role.persona 排在模型层之后；空/纯空白跳过不产空段落', () => {
    const withRole = buildAgentPersona({ rules: [] }, { name: 'general', persona: 'R' })
    expect(withRole).toBe(`${SECTION_A('general')}\n\n${SECTION_B}\n\n${BASE_TEXT}\n\nR`)
    const empty = `${SECTION_A('general')}\n\n${SECTION_B}\n\n${BASE_TEXT}`
    expect(buildAgentPersona({ rules: [] }, { name: 'general', persona: '' })).toBe(empty)
    expect(buildAgentPersona({ rules: [] }, { name: 'general', persona: '   \n\t ' })).toBe(empty)
  })

  test('命中规则：overrides.base 整份替换模型层、append 成为末段', () => {
    const rules: Rule[] = [{ match: { model: 'deepseek-v4' }, overrides: { base: 'V4-BASE' }, append: 'V4-NOTES' }]
    const persona = buildAgentPersona({ rules }, { name: 'general', persona: 'R' }, { provider: 'deepseek', model: 'deepseek-v4' })
    expect(persona).toBe(`${SECTION_A('general')}\n\n${SECTION_B}\n\nV4-BASE\n\nR\n\nV4-NOTES`)
  })

  test('契约段中角色名正确代入', () => {
    const persona = buildAgentPersona({ rules: [] }, { name: 'code-reviewer' })
    expect(persona.startsWith('你是团队中的一名成员（角色：code-reviewer），由主 Agent 委派任务。')).toBe(true)
    expect(persona).not.toContain('undefined')
  })
})
