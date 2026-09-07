/** preset 优先的 agent scope joiner：agentPresets 在场且 mount 成功 → 父链是 preset standing mount，
 *  宿主 spawn 驱动的 composeFrom 能认父（委派子会话继承同一组合）；失败回退 toolsScope（bot 可用性优先）。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolsScope } from './tool-scope.ts'

/** setupAgentScope 的作用域加入策略（ToolsScope 结构兼容：join 返回 unknown 使 Promise<ScopeKey> 可赋，
 *  void 返回类型过窄——TS 严格模式 object 不可赋给 void）。 */
export interface ScopeJoiner {
  join(agentCtx: Context): Promise<unknown>
}

/** agentPresets 服务的挂载面结构类型（可选服务经 ctx.get 读取，team-preset.ts AgentPresetsLike 先例）。 */
interface PresetMountLike {
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

export function createScopeJoiner(ctx: Context, presetId: string, fallback: ToolsScope, warn: (msg: string) => void): ScopeJoiner {
  return {
    async join(agentCtx) {
      // join 时惰性解析（attachments 教训：apply 期一次性捕获会吃到未注册的 undefined）。
      const agentPresets = ctx.get('agentPresets', false) as PresetMountLike | undefined
      if (agentPresets !== undefined) {
        try {
          await agentPresets.mount(agentCtx, presetId)
          return
        } catch (error) {
          warn(`dsh-agent-toolkit: bot 会话挂载 preset "${presetId}" 失败，回退基础工具 standing scope（此后该会话委派子会话将看不到基础工具）：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await fallback.join(agentCtx)
    },
  }
}
