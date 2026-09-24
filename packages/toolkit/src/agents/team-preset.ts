/**
 * Agent 团队 preset 自动生成：readDocument 读取宿主 registry 的源 preset composition，
 * 文本级禁用 subagent 工具族 4 个行，经 entryListSchema 解析回 entry list 后
 * agentPresets.register 声明式注册（dsh 0.1.7 删除文件根扫描协议，preset 全走 registry 注册）。
 * 设计：docs/superpowers/specs/archive/2026-09-02-agent-team-preset-design.md
 */
import yaml from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

/** 本功能的可调配置（Config schema 在 ../index.ts）。 */
export interface AgentTeamPresetConfig {
  /** 总开关：false 时启动不注册 preset。 */
  enabled: boolean
  /** 注册的 preset id。 */
  id: string
  /** 源 preset id，读其 composition 做派生。 */
  source: string
  /** 注册 definition 的显示名。 */
  name: string
  /** 注册 definition 的描述。 */
  description: string
}

/** 禁用目标行：覆盖与 team_delegate 竞争/配套的 5 个模型可见工具所属的 4 个行。 */
export const TEAM_PRESET_DISABLED_ROWS = [
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-control',
  'tool-subagent-list-agents',
] as const

/**
 * 文本级锚点改写：对 4 个目标行各插入一行 `disabled: true`（缩进 = 锚点缩进 + 2 空格）。
 * 锚点是整行精确匹配 `- id: <行id>`（忽略首尾空白），防 tool-subagent 误中
 * tool-subagent-fork / tool-subagent-control 前缀；锚点所属块内（锚点行之后、
 * 首个缩进 <= 锚点缩进的非空行之前）已有 `disabled:` 键则跳过——既幂等，也避免
 * 与宿主已有的 `disabled: !!js ...` 撞出 YAML 重复键。锚点缺失 warn 并跳过该锚点，
 * 其余照常。除插入行外文本逐字节不变。
 */
export function disableSubagentRows(source: string, warn: (msg: string) => void): string {
  const lines = source.split('\n')
  for (const row of TEAM_PRESET_DISABLED_ROWS) {
    const anchor = `- id: ${row}`
    const index = lines.findIndex((line) => line.trim() === anchor)
    if (index === -1) {
      warn(`dsh-agent-toolkit: agent-team preset 锚点行 "${anchor}" 在源 composition 中缺失，已跳过`)
      continue
    }
    const indent = lines[index].length - lines[index].trimStart().length
    let hasDisabled = false
    for (let i = index + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim() === '') continue
      if (line.length - line.trimStart().length <= indent) break
      if (/^\s*disabled\s*:/.test(line)) {
        hasDisabled = true
        break
      }
    }
    if (hasDisabled) continue
    lines.splice(index + 1, 0, `${' '.repeat(indent + 2)}disabled: true`)
  }
  return lines.join('\n')
}

/** 镜像宿主 PRESET_ID 的 id 白名单：合法 id 才注册（文件协议时代兼任路径逃逸 containment 边界）。 */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * agentPresets 服务的结构类型。可选服务经 ctx.get 读取（宿主约定：可选服务用
 * ctx.get，不进 inject），结构类型避免对 @deepseek-ai/dsh-agent-preset-registry 的依赖
 *（bots/index.ts 的 WorkspaceRegistryLike 先例）。
 */
interface AgentPresetsLike {
  readDocument(id: string): Promise<{ content: string }>
  register(definition: {
    id: string
    name?: string
    description?: string
    plugins: readonly unknown[]
  }): Promise<() => Promise<void>>
}

/**
 * 启动时派生并声明式注册 agent-team preset：readDocument 读源 composition →
 * disableSubagentRows 文本改写 → entryListSchema 解析 → agentPresets.register。
 * 所有失败路径 warn 降级，不影响插件其余功能。不设为默认 preset；卸载/HMR 重组时
 * ctx.effect 自动注销注册，无文件残留。
 */
export async function setupAgentTeamPreset(ctx: Context, config: AgentTeamPresetConfig): Promise<void> {
  if (!config.enabled) return
  const warn = (msg: string): void => { ctx.logger.warn(msg) }
  // 无 agentPresets 服务的宿主：静默跳过（无 subagent/team_delegate 工具竞争问题）。
  const agentPresets = ctx.get('agentPresets', false) as AgentPresetsLike | undefined
  if (agentPresets === undefined) return
  if (!PRESET_ID.test(config.id)) {
    warn(`dsh-agent-toolkit: agentTeamPreset.id "${config.id}" 不是合法 preset id，跳过 agent-team 生成`)
    return
  }
  let source: string
  try {
    source = (await agentPresets.readDocument(config.source)).content
  } catch (error) {
    warn(`dsh-agent-toolkit: 读取源 preset "${config.source}" 失败，跳过 agent-team 生成：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  let plugins: unknown
  try {
    plugins = yaml.load(disableSubagentRows(source, warn), { schema: entryListSchema })
  } catch (error) {
    warn(`dsh-agent-toolkit: 解析派生 composition 失败，跳过 agent-team 生成：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  // 注册生命周期交给 ctx.effect：插件卸载（含 HMR 重组）时宿主自动注销 preset，
  // 替代 0.1.5 时代的标记目录与自愈重写。
  ctx.effect(
    () => agentPresets.register({ id: config.id, name: config.name, description: config.description, plugins: plugins as readonly unknown[] }),
    'dsh-agent-toolkit: agent-team preset',
  )
}
