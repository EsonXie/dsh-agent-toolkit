/** agent-bot preset 组合序列化：BASIC_TOOLS → preset 行（bot 会话挂载的最小组合，
 *  委派子会话 composeFrom 认父的前提；spec: docs/superpowers/specs/archive/2026-09-07-bot-delegation-preset-mount-design.md）。 */
import yaml from 'js-yaml'
import { BASIC_TOOLS, type BasicTool } from '../channels/basic-tools.ts'

/** BASIC_TOOLS 插件包名 → preset 行 id（与 standard/agent-team 的行 id 对齐）。新增 BASIC_TOOLS 行必须在此登记。 */
const ROW_IDS: Record<string, string> = {
  '@deepseek-ai/dsh-persona': 'persona',
  '@deepseek-ai/dsh-agent-instructions': 'agent-instructions',
  '@deepseek-ai/dsh-tool-pwsh': 'tool-pwsh',
  '@deepseek-ai/dsh-tool-bash': 'tool-bash',
  '@deepseek-ai/dsh-tool-fs': 'tool-fs',
  '@deepseek-ai/dsh-tool-fs-search': 'tool-fs-search',
}

export const BOT_PRESET_NAME = 'Bot 会话'
export const BOT_PRESET_DESCRIPTION = '飞书 bot 会话组合：基础工具行（persona/instructions/shell/fs/fs-search）；委派子会话经 composeFrom 继承同一组合'

/** BASIC_TOOLS → preset 行对象数组（未登记映射的包名抛错，防新增工具行静默丢 id）。 */
export function serializeBotRows(tools: readonly BasicTool[]): Record<string, unknown>[] {
  return tools.map((tool) => {
    const rowId = ROW_IDS[tool.id]
    if (rowId === undefined) throw new Error(`bot-preset: BASIC_TOOLS 行 ${tool.id} 未登记 preset 行 id 映射`)
    return { id: rowId, name: tool.id, ...tool.config !== undefined ? { config: tool.config } : {} }
  })
}

/** agent-bot composition 文本（平台相关 shell 行已由 BASIC_TOOLS 选定，不用 !!js）。 */
export function botPresetComposition(): string {
  return yaml.dump(serializeBotRows(BASIC_TOOLS), { lineWidth: -1 })
}
