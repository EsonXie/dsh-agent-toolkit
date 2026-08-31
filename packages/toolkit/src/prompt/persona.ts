/** 委派子 Agent 的 persona 装配：契约段 + 分层引擎（全局层 + 角色层 + 按模型改写）。 */
import { selectRule } from './match.ts'
import type { LayerConfig, Rule } from './types.ts'

const SECTION_A = (roleName: string): string => `你是团队中的一名成员（角色：${roleName}），由主 Agent 委派任务。
- 你看不到主对话；任务书包含你完成工作所需的全部上下文。
- 你的最终输出会作为结果完整返回给主 Agent：直接给出结论与必要细节。
- 你不能再次委派他人；任务需要拆分时，自己按顺序完成。`

const SECTION_B = `能力使用守则：
- 你可以使用与主 Agent 相同的工具与 MCP 资源，但只在任务必需时调用。
- 动手修改代码前，先阅读项目根目录及涉及目录的 AGENTS.md，并遵循其中约定。
- 产生或修改文件后，运行相关检查（测试、类型检查）验证你的改动。`

export function buildAgentPersona(
  config: { getLayers: () => LayerConfig[]; rules: Rule[] },
  role: { name: string; persona?: string },
  model?: { provider?: string; model?: string },
): string {
  const rule = selectRule(config.rules, model?.provider, model?.model)
  // 角色 persona 固定为 order 0 层；数组稳定排序保证同 order 的全局层（如 base）排在 persona 之前。
  // 与 router 的角色分支一致：persona 缺失或纯空白时跳过，不产出空段落。
  const roleLayers: LayerConfig[] =
    role.persona === undefined || role.persona.trim().length === 0
      ? []
      : [{ name: 'persona', order: 0, text: role.persona }]
  // 全局 persona 层是主 Agent 的人设，不泄漏给子 Agent——子的 persona 由角色层顶替。
  const globalLayers = config.getLayers().filter(layer => layer.name !== 'persona')
  const merged = [...globalLayers, ...roleLayers].sort((a, b) => a.order - b.order)
  // 空文本层（persona/domain/task 默认空串）不产出空段落。
  const texts = merged
    .map(layer => rule?.overrides?.[layer.name] ?? layer.text)
    .filter(text => text.length > 0)
  if (rule?.append !== undefined) texts.push(rule.append)
  return [SECTION_A(role.name), SECTION_B, ...texts].join('\n\n')
}
