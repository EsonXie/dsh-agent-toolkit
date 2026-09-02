/**
 * Agent 团队 preset 自动生成：派生宿主当前 shipped standard composition，
 * 文本级禁用 subagent 工具族 4 个行，写入首个 trust=user 的 preset root。
 * 设计：docs/superpowers/specs/2026-09-02-agent-team-preset-design.md
 */

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
