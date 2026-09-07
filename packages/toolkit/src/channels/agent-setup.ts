/** agent 创建/恢复的作用域组合：加入作用域组合（preset 或基础工具 standing scope 回退）→ persona/tools 创作期注入。
 *  hooks.tools 先与该会话真实可见面求交（warn-drop 未知名）——同一白名单同时喂委派 toolFilter（父 preset 面）
 *  与 bot 会话（agent-bot 面），求交消除两条路径的有效性不对称。 */
import type { Context } from '@deepseek-ai/cordis'
// type-only 激活 dsh-system-prompt / dsh-tools 对 cordis Context 的声明合并（agentCtx.systemPrompt / agentCtx.tools）。
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { AgentHooks } from './ports.ts'
import type { ScopeJoiner } from './scope-joiner.ts'

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
  joiner: ScopeJoiner,
): Promise<void> {
  await joiner.join(agentCtx)
  if (hooks.persona !== undefined) {
    agentCtx.systemPrompt.section({ name: TOOLKIT_PERSONA_SECTION, order: 10, text: hooks.persona })
  }
  if (hooks.sections !== undefined) {
    for (const section of hooks.sections) {
      agentCtx.systemPrompt.section({ name: section.name, order: section.order, text: section.text })
    }
  }
  if (hooks.tools !== undefined) {
    // 求交：join 后的 scoped schemas = global + 祖先层（preset standing 或 BASIC_TOOLS
    // fallback standing），正是 restrict 的合法命名空间；未知名 warn-drop 而非抛错，
    // 使同一角色白名单在委派（父 preset 面）与 bot（agent-bot 面）两条路径都安全。
    const visible = new Set(agentCtx.tools.schemas(scopeOf(agentCtx)).map((s) => s.name)
      .filter((n) => n !== RUN_CODE_NAME))
    const effective = hooks.tools.filter((n) => visible.has(n))
    const dropped = hooks.tools.filter((n) => !visible.has(n))
    if (dropped.length > 0) {
      agentCtx.logger.warn(`dsh-agent-toolkit: 工具白名单含本会话不可见工具，已忽略：${dropped.join(', ')}`)
    }
    if (effective.length === 0) {
      throw new Error(`dsh-agent-toolkit: 工具白名单求交后为空（原 ${hooks.tools.length} 个均不可见）：${hooks.tools.join(', ')}`)
    }
    agentCtx.tools.restrict({ allow: effective })
  }
}
