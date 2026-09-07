/** 动态工具名册：团队 preset 面经宿主 standing mount 枚举（standingKeyFor + scoped schemas），
 *  agentPresets 缺席/枚举失败回退 NATIVE_TOOL_NAMES 常量。每次调用现算，不缓存——standing
 *  mount 由宿主按 composition 文件代际缓存，view 遍历是纯内存操作。
 *  设计：docs/superpowers/specs/2026-09-07-dynamic-tool-catalog-design.md */
import type { Context } from '@deepseek-ai/cordis'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
// type-only 激活 dsh-tools 对 cordis Context 的声明合并（ctx.tools）。
import type {} from '@deepseek-ai/dsh-tools'
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'

/** agentPresets 服务的结构类型（可选服务经 ctx.get 读取，team-preset.ts AgentPresetsLike 先例）。*/
interface PresetStandingLike {
  standingKeyFor(id?: string): Promise<ScopeKey>
}

/** Agents 面板/迁移/创建命令共用的工具名册。*/
export interface ToolCatalog {
  /** 团队 preset 工具面（不含 global 名与 run_code 保留名，字典序）。*/
  listPresetTools(): Promise<string[]>
  /** 顶层注册表全局工具名（不含 run_code 保留名）。*/
  listGlobalTools(): string[]
}

export function createToolCatalog(ctx: Context, presetId: string): ToolCatalog {
  return {
    async listPresetTools() {
      // 惰性解析（attachments 教训：apply 期一次性捕获会吃到未注册的 undefined）。
      const presets = ctx.get('agentPresets', false) as PresetStandingLike | undefined
      if (presets === undefined) return [...NATIVE_TOOL_NAMES]
      try {
        const key = await presets.standingKeyFor(presetId)
        const global = new Set(ctx.tools.schemas().map((s) => s.name))
        return ctx.tools.schemas(key).map((s) => s.name)
          .filter((n) => !global.has(n) && n !== RUN_CODE_NAME)
          .sort()
      } catch (error) {
        ctx.logger.warn(
          `dsh-agent-toolkit: 枚举 preset "${presetId}" 工具面失败，回退内置常量：${error instanceof Error ? error.message : String(error)}`,
        )
        return [...NATIVE_TOOL_NAMES]
      }
    },
    listGlobalTools() {
      return ctx.tools.schemas().map((s) => s.name).filter((n) => n !== RUN_CODE_NAME)
    },
  }
}
