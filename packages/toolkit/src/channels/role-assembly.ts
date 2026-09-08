/** 角色形态会话装配（Router bot 会话与 schedule 执行器共用）：persona 单 section + tools 白名单 + 模型解析。 */
import type { AgentRecord } from '../agents/store.ts'
import type { AgentHooks, DefaultModelAccessor } from './ports.ts'

/** 角色 persona 的 scoped 段名（与 Router 既有产出一致，逐字段不可改）。 */
export const ROLE_PERSONA_SECTION = 'dsh-agent-toolkit:agent:persona'

/** 角色形态创作期注入：persona 非空 → 单 section（order 0）；tools 白名单存在 → 带上（由 setupAgentScope restrict）。 */
export function roleHooks(role: AgentRecord): AgentHooks {
  const sections = role.persona === undefined || role.persona.trim().length === 0
    ? []
    : [{ name: ROLE_PERSONA_SECTION, order: 0, text: role.persona }]
  return {
    ...(sections.length > 0 ? { sections } : {}),
    ...(role.tools !== undefined ? { tools: role.tools.allow } : {}),
  }
}

/** 角色模型：自配优先，缺省回退宿主默认模型（与 Router 语义一致）。 */
export function roleAgentOptions(
  role: AgentRecord,
  defaultModel: DefaultModelAccessor,
): { provider?: string; model?: string } {
  return role.model ?? defaultModel()
}
