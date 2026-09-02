import { describe, expect, test, vi } from 'vitest'
import { disableSubagentRows } from './team-preset.ts'

// 镜像宿主 shipped standard 的 delegation 块（缩进 4 空格的列表行）。
const SOURCE = [
  '# demo composition',
  '- id: delegation',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: tool-subagent-control',
  "      name: '@deepseek-ai/dsh-tool-subagent-control'",
  '',
  '    - id: tool-subagent-list-agents',
  "      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
  '',
  '    - id: tool-subagent',
  "      name: '@deepseek-ai/dsh-tool-subagent'",
  '      config:',
  '        provider: spawn',
  '        toolName: subagent',
  '',
  '    - id: tool-subagent-fork',
  "      name: '@deepseek-ai/dsh-tool-subagent'",
  '      config:',
  '        provider: fork',
  '        toolName: subagent_fork',
  '',
  '    - id: tool-workflow',
  "      name: '@deepseek-ai/dsh-tool-workflow'",
  '',
].join('\n')

const EXPECTED = [
  '# demo composition',
  '- id: delegation',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: tool-subagent-control',
  '      disabled: true',
  "      name: '@deepseek-ai/dsh-tool-subagent-control'",
  '',
  '    - id: tool-subagent-list-agents',
  '      disabled: true',
  "      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
  '',
  '    - id: tool-subagent',
  '      disabled: true',
  "      name: '@deepseek-ai/dsh-tool-subagent'",
  '      config:',
  '        provider: spawn',
  '        toolName: subagent',
  '',
  '    - id: tool-subagent-fork',
  '      disabled: true',
  "      name: '@deepseek-ai/dsh-tool-subagent'",
  '      config:',
  '        provider: fork',
  '        toolName: subagent_fork',
  '',
  '    - id: tool-workflow',
  "      name: '@deepseek-ai/dsh-tool-workflow'",
  '',
].join('\n')

describe('disableSubagentRows', () => {
  test('4 个目标行各插入 disabled: true（缩进 = 锚点 + 2），其余文本逐字节不变；tool-subagent 不误中 tool-subagent-fork', () => {
    const warn = vi.fn()
    expect(disableSubagentRows(SOURCE, warn)).toBe(EXPECTED)
    expect(warn).not.toHaveBeenCalled()
  })

  test('幂等：对生成结果再生成 = 不变', () => {
    const once = disableSubagentRows(SOURCE, vi.fn())
    const warn = vi.fn()
    expect(disableSubagentRows(once, warn)).toBe(once)
    expect(warn).not.toHaveBeenCalled()
  })

  test('锚点缺失：warn + 跳过该锚点，其余锚点照常插入', () => {
    const source = SOURCE.replace(
      "    - id: tool-subagent-list-agents\n      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'\n\n",
      '',
    )
    const warn = vi.fn()
    const result = disableSubagentRows(source, warn)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('- id: tool-subagent-list-agents'))
    expect(result.match(/disabled: true/g)).toHaveLength(3)
    expect(result).toContain('    - id: tool-subagent\n      disabled: true\n')
  })

  test('块内已有 disabled 键（含 !!js 形式）则跳过该行，不产生 YAML 重复键', () => {
    const source = SOURCE.replace(
      "    - id: tool-subagent\n",
      "    - id: tool-subagent\n      disabled: !!js process.platform === 'win32'\n",
    )
    const warn = vi.fn()
    const result = disableSubagentRows(source, warn)
    expect(warn).not.toHaveBeenCalled()
    // tool-subagent 块保持原样（只有原有那一行 disabled），其余 3 行各插入一行。
    expect(result).toContain("    - id: tool-subagent\n      disabled: !!js process.platform === 'win32'\n      name:")
    expect(result.match(/^\s*disabled\s*:/gm)).toHaveLength(4)
  })
})
