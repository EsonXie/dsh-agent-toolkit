/** 成员系统提示词：基础层（A 身份契约 / B 能力守则）+ 角色 persona。
 *  按模型区分提示词归 prompt-stack（其子 Agent 隔离后不作用于成员，spec §4.5）；
 *  角色的模型适配由角色 persona 针对所配模型自足撰写。 */
import type { Role } from './roles.ts'

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

/**
 * 拼装一名成员的完整系统提示词。
 * @param role - 角色定义（persona 层来源）。
 * @returns A+B+persona 以空行连接的完整提示词。
 */
export function buildMemberPersona(role: Role): string {
  return [SECTION_A(role.name), SECTION_B, role.persona].join('\n\n')
}
