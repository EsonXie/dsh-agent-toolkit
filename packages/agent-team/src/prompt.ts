/** 成员系统提示词：基础层（A 身份契约 / B 能力守则 / C 模型适配）+ persona 层。 */
import type { Role } from './roles.ts'

/** Config 的模型适配模板覆盖入口（缺省字段用内置文本）。 */
export interface PromptTemplates {
  /** C 段兜底模板（无族匹配时）。 */
  readonly default?: string
  /** 按族名覆盖 C 段模板，如 { reasoning: '…' }。 */
  readonly families?: Record<string, string>
}

/** A 段：身份与契约。 */
const SECTION_A = (roleName: string): string => `你是团队中的一名成员（角色：${roleName}），由主 Agent 委派任务。
- 你看不到主对话；任务书包含你完成工作所需的全部上下文。
- 你的最终输出会作为结果完整返回给主 Agent：直接给出结论与必要细节。
- 你不能再次委派他人；任务需要拆分时，自己按顺序完成。`

/** B 段：能力使用守则。 */
const SECTION_B = `能力使用守则：
- 你可以使用与主 Agent 相同的工具与 MCP 资源，但只在任务必需时调用。
- 动手修改代码前，先阅读项目根目录及涉及目录的 AGENTS.md，并遵循其中约定。
- 产生或修改文件后，运行相关检查（测试、类型检查）验证你的改动。`

/** C 段内置模板：按模型族。 */
const BUILTIN_FAMILY_TEMPLATES: Record<string, string> = {
  reasoning: '你使用的模型具备推理能力；直接给出高质量结论，无需外化逐步推理过程。',
  chat: '请在输出中保持结构清晰：先结论，后依据；涉及多处修改时分节列出。',
}

/** C 段内置兜底模板。 */
const BUILTIN_DEFAULT_TEMPLATE = '请确保输出自包含：主 Agent 只看到你的最终文本。'

/** 模型名 → 族，按序首个命中生效。 */
export const MODEL_FAMILY_RULES = [
  [/reason/i, 'reasoning'],
  [/chat/i, 'chat'],
] as const

/**
 * 解析模型的族名。
 * @param model - 实际生效的模型名（可能为 undefined）。
 * @returns 族名，未命中返回 undefined。
 */
function modelFamily(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  for (const [pattern, family] of MODEL_FAMILY_RULES) {
    if (pattern.test(model)) return family
  }
  return undefined
}

/**
 * 拼装一名成员的完整系统提示词。
 * @param role - 角色定义（persona 层来源）。
 * @param model - 本次委派实际生效的模型（角色配置或继承主 Agent）。
 * @param templates - Config 的 C 段覆盖。
 * @returns A+B+C+persona 以空行连接的完整提示词。
 */
export function buildMemberPersona(role: Role, model: string | undefined, templates?: PromptTemplates): string {
  const family = modelFamily(model)
  const sectionC = (family !== undefined ? templates?.families?.[family] : undefined)
    ?? (family !== undefined ? BUILTIN_FAMILY_TEMPLATES[family] : undefined)
    ?? templates?.default
    ?? BUILTIN_DEFAULT_TEMPLATE
  return [SECTION_A(role.name), SECTION_B, sectionC, role.persona].join('\n\n')
}
