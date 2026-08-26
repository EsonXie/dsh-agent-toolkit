import { describe, expect, test } from 'vitest'
import { buildAgentPersona } from './persona.ts'
import type { LayerConfig, Rule } from './types.ts'

const SECTION_A = (roleName: string): string => `你是团队中的一名成员（角色：${roleName}），由主 Agent 委派任务。
- 你看不到主对话；任务书包含你完成工作所需的全部上下文。
- 你的最终输出会作为结果完整返回给主 Agent：直接给出结论与必要细节。
- 你不能再次委派他人；任务需要拆分时，自己按顺序完成。`

const SECTION_B = `能力使用守则：
- 你可以使用与主 Agent 相同的工具与 MCP 资源，但只在任务必需时调用。
- 动手修改代码前，先阅读项目根目录及涉及目录的 AGENTS.md，并遵循其中约定。
- 产生或修改文件后，运行相关检查（测试、类型检查）验证你的改动。`

const configOf = (layers: LayerConfig[], rules: Rule[]): { layers: LayerConfig[]; rules: Rule[] } => ({ layers, rules })

describe('buildAgentPersona', () => {
  test('无 role.promptLayers、无规则命中时 = 契约段 + 全局 layers 按 order 拼接', () => {
    const config = configOf(
      [
        { name: 'task', order: 50, text: 'TASK' },
        { name: 'base', order: 0, text: 'BASE' },
      ],
      [],
    )
    expect(buildAgentPersona(config, { name: 'explorer' }))
      .toBe(`${SECTION_A('explorer')}\n\n${SECTION_B}\n\nBASE\n\nTASK`)
  })

  test('role.promptLayers 与全局层按 order 交错合并', () => {
    const config = configOf(
      [
        { name: 'global', order: 10, text: 'G' },
        { name: 'task', order: 50, text: 'T' },
      ],
      [],
    )
    const persona = buildAgentPersona(config, {
      name: 'general',
      promptLayers: [{ name: 'role', order: 30, text: 'R' }],
    })
    expect(persona).toBe(`${SECTION_A('general')}\n\n${SECTION_B}\n\nG\n\nR\n\nT`)
  })

  test('命中规则的 overrides 替换对应层文本、append 成为末段', () => {
    const config = configOf(
      [
        { name: 'base', order: 0, text: 'BASE' },
        { name: 'task', order: 50, text: 'TASK' },
      ],
      [{ match: { model: 'deepseek-v4' }, overrides: { task: 'V4-TASK' }, append: 'V4-NOTES' }],
    )
    const persona = buildAgentPersona(config, { name: 'general' }, { provider: 'deepseek', model: 'deepseek-v4' })
    expect(persona).toBe(`${SECTION_A('general')}\n\n${SECTION_B}\n\nBASE\n\nV4-TASK\n\nV4-NOTES`)
  })

  test('契约段中角色名正确代入', () => {
    const persona = buildAgentPersona(configOf([{ name: 'base', order: 0, text: 'B' }], []), { name: 'code-reviewer' })
    expect(persona.startsWith('你是团队中的一名成员（角色：code-reviewer），由主 Agent 委派任务。')).toBe(true)
    expect(persona).not.toContain('undefined')
  })
})
