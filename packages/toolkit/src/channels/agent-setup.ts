/** agent 创建/恢复的作用域组合：加入基础工具行 standing scope → persona/tools 创作期注入。 */
import type { Context } from '@deepseek-ai/cordis'
// type-only 激活 dsh-system-prompt / dsh-tools 对 cordis Context 的声明合并（agentCtx.systemPrompt / agentCtx.tools）。
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { AgentHooks } from './ports.ts'
import type { ToolsScope } from './tool-scope.ts'

/** bot 会话角色 persona 的 scoped 段名：与全局 persona 层同名，scoped 注册即 shadow 覆盖主 Agent persona。 */
export const TOOLKIT_PERSONA_SECTION = 'prompt-stack:persona'

/**
 * 组合 agent 作用域：先把 agent scope 父链挂到基础工具行 standing scope（工具成为
 * 继承面），再叠 bot 的 persona 与 tools 白名单。
 * 顺序敏感：restrict 必须在 join 之后——宿主 tools.restrict() 只校验并过滤继承面
 * （global + 祖先 scope 层），own 层（agentCtx 直接挂载）的名字既不可 restrict 也
 * 不受 restrict 影响，直接挂进 agentCtx 的白名单会抛 unknown global tools。
 */
export async function setupAgentScope(
  agentCtx: Context,
  hooks: AgentHooks,
  toolsScope: ToolsScope,
): Promise<void> {
  await toolsScope.join(agentCtx)
  if (hooks.persona !== undefined) {
    agentCtx.systemPrompt.section({ name: TOOLKIT_PERSONA_SECTION, order: 10, text: hooks.persona })
  }
  if (hooks.sections !== undefined) {
    for (const section of hooks.sections) {
      agentCtx.systemPrompt.section({ name: section.name, order: section.order, text: section.text })
    }
  }
  if (hooks.tools !== undefined) {
    agentCtx.tools.restrict({ allow: hooks.tools })
  }
}
