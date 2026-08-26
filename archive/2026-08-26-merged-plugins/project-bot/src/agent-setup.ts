/** agent 创建/恢复的作用域组合：preset 挂载 → persona/tools 创作期注入。 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHooks } from './core/ports.ts'

/** agentPresets 服务的窄化结构（可选服务，测试 fake 注入）。 */
export interface PresetsLike {
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/**
 * 组合 agent 作用域：先挂指定 preset（基础编码工具层随组合进入，与原生 UI 会话同源），
 * 再叠 bot 的 persona 与 tools 白名单。顺序敏感：restrict 必须在 mount 之后，
 * 否则白名单命中不到 preset 带入的工具名。presetId 为 undefined 时跳过挂载，hooks 照常注入。
 */
export async function setupAgentScope(
  agentCtx: Context,
  presets: PresetsLike | undefined,
  presetId: string | undefined,
  hooks: AgentHooks,
): Promise<void> {
  if (presets !== undefined && presetId !== undefined) await presets.mount(agentCtx, presetId)
  if (hooks.persona !== undefined) {
    agentCtx.systemPrompt.section({ name: 'project-bot:persona', order: 0, text: hooks.persona })
  }
  if (hooks.tools !== undefined) {
    agentCtx.tools.restrict({ allow: hooks.tools })
  }
}

/**
 * 解析待挂载的 preset id：configured（Config agentPreset）优先，缺省用名册默认。
 * 服务缺失或名册不含该 id 时降级 undefined（warn 告警，含名册可用清单）——
 * 会话裸跑可聊但无 preset 工具层；preset 存在但组合损坏在 mount 阶段仍响亮失败。
 */
export async function resolvePresetId(
  presets: PresetsLike | undefined,
  configured: string | undefined,
  warn: (message: string) => void,
): Promise<string | undefined> {
  if (presets === undefined) return undefined
  try {
    return (await presets.resolve(configured)).id
  } catch (error) {
    warn(`[project-bot] preset 解析失败，会话将无 preset 工具层：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}
