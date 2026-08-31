/** 委派子 Agent 的 persona 装配：契约段 + 内置模型层（按子的模型改写）+ 角色 persona。 */
import { BASE_TEXT } from './defaults.ts'
import { selectRule } from './match.ts'
import type { Rule } from './types.ts'

const SECTION_A = (roleName: string): string => `你是团队中的一名成员（角色：${roleName}），由主 Agent 委派任务。
- 你看不到主对话；任务书包含你完成工作所需的全部上下文。
- 你的最终输出会作为结果完整返回给主 Agent：直接给出结论与必要细节。
- 你不能再次委派他人；任务需要拆分时，自己按顺序完成。`

const SECTION_B = `能力使用守则：
- 你可以使用与主 Agent 相同的工具与 MCP 资源，但只在任务必需时调用。
- 动手修改代码前，先阅读项目根目录及涉及目录的 AGENTS.md，并遵循其中约定。
- 产生或修改文件后，运行相关检查（测试、类型检查）验证你的改动。`

/**
 * 子 Agent 提示词 = 契约段 A/B + 模型层文本（命中规则 overrides.base 整份替换内置
 * BASE_TEXT）+ 角色 persona（非空时，排在模型层之后）+ 命中规则的 append（model-notes）。
 * 全局 persona 层是主 Agent 的人设，不进入子 Agent（子的角色由 role.persona 顶替）。
 */
export function buildAgentPersona(
  config: { rules: Rule[] },
  role: { name: string; persona?: string },
  model?: { provider?: string; model?: string },
): string {
  const rule = selectRule(config.rules, model?.provider, model?.model)
  const texts = [rule?.overrides?.base ?? BASE_TEXT]
  if (role.persona !== undefined && role.persona.trim().length > 0) texts.push(role.persona)
  if (rule?.append !== undefined) texts.push(rule.append)
  return [SECTION_A(role.name), SECTION_B, ...texts].join('\n\n')
}
