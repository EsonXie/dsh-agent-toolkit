/**
 * Agent 团队 preset 自动生成：派生宿主当前 shipped standard composition，
 * 文本级禁用 subagent 工具族 4 个行，写入首个 trust=user 的 preset root。
 * 设计：docs/superpowers/specs/2026-09-02-agent-team-preset-design.md
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'

/** 本功能的可调配置（Config schema 在 ../index.ts）。 */
export interface AgentTeamPresetConfig {
  /** 总开关：false 时启动不生成/刷新 preset。 */
  enabled: boolean
  /** 生成的 preset id（即目录名）。 */
  id: string
  /** 源 preset id，读其 composition 做派生。 */
  source: string
  /** preset.yml 的显示名。 */
  name: string
  /** preset.yml 的描述。 */
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

// 三个文件名镜像宿主 @deepseek-ai/dsh-agent-presets 的 COMPOSITION_FILE / METADATA_FILE
// 契约（文件名即 discovery 协议）；不 import 宿主常量，避免新增运行时耦合。
const COMPOSITION_FILE = 'agent.cordis.yml'
const METADATA_FILE = 'preset.yml'
/** 生成目录的归属标记：无此标记的同名目录视为用户手工 preset，不覆盖。 */
const MARKER_FILE = '.generated-by'
const MARKER_CONTENT = 'dsh-agent-toolkit'
/** 镜像宿主 PRESET_ID：preset id 即目录名，正则白名单是路径逃逸的 containment 边界。 */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

const GENERATED_HEADER = '# 本文件由 dsh-agent-toolkit 自动生成，勿手改（每次启动重写）。\n'

/**
 * agentPresets 服务的结构类型。可选服务经 ctx.get 读取（宿主约定：可选服务用
 * ctx.get，不进 inject），结构类型避免对 @deepseek-ai/dsh-agent-presets 的依赖
 *（bots/index.ts 的 WorkspaceRegistryLike 先例）。
 */
interface AgentPresetsLike {
  readonly roots: readonly { path: string; trust: 'system' | 'user' }[]
  read(id: string): Promise<string>
}

/**
 * 启动时生成/刷新 agent-team preset。所有失败路径 warn 降级，不影响插件其余功能。
 * 不设为默认 preset、卸载不删目录（可能有会话在用；composition 不引用 toolkit 行，
 * 残留 preset 自身仍可用）。每次启动重写：standing mount 按文件代际，重写只影响新会话。
 */
export async function setupAgentTeamPreset(ctx: Context, config: AgentTeamPresetConfig): Promise<void> {
  if (!config.enabled) return
  const warn = (msg: string): void => { ctx.logger.warn(msg) }
  // rc2 等无 presets 的旧宿主：静默跳过（旧宿主无 subagent/team_delegate 工具竞争问题）。
  const agentPresets = ctx.get('agentPresets', false) as AgentPresetsLike | undefined
  if (agentPresets === undefined) return
  if (!PRESET_ID.test(config.id)) {
    warn(`dsh-agent-toolkit: agentTeamPreset.id "${config.id}" 不是合法 preset id，跳过 agent-team 生成`)
    return
  }
  let source: string
  try {
    source = await agentPresets.read(config.source)
  } catch (error) {
    warn(`dsh-agent-toolkit: 读取源 preset "${config.source}" 失败，跳过 agent-team 生成：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const root = agentPresets.roots.find((r) => r.trust === 'user')
  if (root === undefined) {
    warn('dsh-agent-toolkit: preset roots 中无 trust=user 的目录，跳过 agent-team 生成')
    return
  }
  const composition = GENERATED_HEADER + disableSubagentRows(source, warn)
  const dir = join(expandHomePath(root.path), config.id)
  try {
    const markerPath = join(dir, MARKER_FILE)
    let dirExists = true
    try {
      await access(dir)
    } catch {
      dirExists = false
    }
    if (dirExists) {
      let marked = false
      try {
        marked = (await readFile(markerPath, 'utf8')).trim() === MARKER_CONTENT
      } catch {
        // 无标记文件 = 用户手工同名 preset。
      }
      if (!marked) {
        warn(`dsh-agent-toolkit: ${dir} 已存在且非本插件生成，不覆盖，跳过 agent-team 生成`)
        return
      }
    }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, COMPOSITION_FILE), composition, 'utf8')
    await writeFile(join(dir, METADATA_FILE), yaml.dump({ name: config.name, description: config.description }, { lineWidth: -1 }), 'utf8')
    await writeFile(markerPath, `${MARKER_CONTENT}\n`, 'utf8')
  } catch (error) {
    warn(`dsh-agent-toolkit: 写入 agent-team preset 失败（${dir}）：${error instanceof Error ? error.message : String(error)}`)
  }
}
