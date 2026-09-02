import { describe, expect, test, vi } from 'vitest'
import { disableSubagentRows } from './team-preset.ts'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { afterEach, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { setupAgentTeamPreset, type AgentTeamPresetConfig } from './team-preset.ts'

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

describe('setupAgentTeamPreset', () => {
  const CONFIG: AgentTeamPresetConfig = {
    enabled: true,
    id: 'agent-team',
    source: 'standard',
    name: 'Agent 团队',
    description: 'Agent 团队模式：禁用原生 subagent 工具族，委派统一走 team_delegate 团队角色',
  }

  let tempDir: string
  let userRoot: string
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-toolkit-team-preset-'))
    userRoot = join(tempDir, 'presets')
  })
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  function makeCtx(agentPresets: unknown): { ctx: Context; warn: ReturnType<typeof vi.fn> } {
    const warn = vi.fn()
    const ctx = { logger: { warn }, get: vi.fn(() => agentPresets) } as unknown as Context
    return { ctx, warn }
  }

  function makeAgentPresets(overrides: {
    roots?: { path: string; trust: 'system' | 'user' }[]
    read?: (id: string) => Promise<string>
  } = {}) {
    return {
      roots: overrides.roots ?? [{ path: userRoot, trust: 'user' as const }],
      read: vi.fn(overrides.read ?? (() => Promise.resolve(SOURCE))),
    }
  }

  const targetDir = () => join(userRoot, 'agent-team')

  test('enabled=false：不读服务、不写任何文件', async () => {
    const agentPresets = makeAgentPresets()
    const { ctx } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, { ...CONFIG, enabled: false })
    expect(agentPresets.read).not.toHaveBeenCalled()
    await expect(readdir(userRoot)).rejects.toThrow()
  })

  test('agentPresets 服务缺席（rc2 旧宿主）：静默跳过，不 warn 不抛错不写文件', async () => {
    const { ctx, warn } = makeCtx(undefined)
    await expect(setupAgentTeamPreset(ctx, CONFIG)).resolves.toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    await expect(readdir(userRoot)).rejects.toThrow()
  })

  test('非法 id（路径逃逸）：read 之前 warn 返回', async () => {
    const agentPresets = makeAgentPresets()
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, { ...CONFIG, id: '../evil' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不是合法 preset id'))
    expect(agentPresets.read).not.toHaveBeenCalled()
  })

  test('read 失败（未知/损坏源 preset）：warn 降级，不写文件', async () => {
    const agentPresets = makeAgentPresets({ read: () => Promise.reject(new Error('preset "standard" not found')) })
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('preset "standard" not found'))
    await expect(readdir(userRoot)).rejects.toThrow()
  })

  test('roots 无 trust=user：warn 降级，不写文件', async () => {
    const agentPresets = makeAgentPresets({ roots: [{ path: join(tempDir, 'sys'), trust: 'system' }] })
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trust=user'))
    await expect(readdir(userRoot)).rejects.toThrow()
  })

  test('同名用户 preset 保护：无 .generated-by 标记的已存在目录不覆盖', async () => {
    await mkdir(targetDir(), { recursive: true })
    await writeFile(join(targetDir(), 'keep.txt'), 'user data', 'utf8')
    const { ctx, warn } = makeCtx(makeAgentPresets())
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不覆盖'))
    expect(await readFile(join(targetDir(), 'keep.txt'), 'utf8')).toBe('user data')
    await expect(readFile(join(targetDir(), 'agent.cordis.yml'), 'utf8')).rejects.toThrow()
  })

  test('同名用户 preset 保护：.generated-by 内容不符的已存在目录不覆盖', async () => {
    await mkdir(targetDir(), { recursive: true })
    await writeFile(join(targetDir(), '.generated-by'), 'other-tool\n', 'utf8')
    await writeFile(join(targetDir(), 'keep.txt'), 'user data', 'utf8')
    const { ctx, warn } = makeCtx(makeAgentPresets())
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不覆盖'))
    expect(await readFile(join(targetDir(), '.generated-by'), 'utf8')).toBe('other-tool\n')
    expect(await readFile(join(targetDir(), 'keep.txt'), 'utf8')).toBe('user data')
    await expect(readFile(join(targetDir(), 'agent.cordis.yml'), 'utf8')).rejects.toThrow()
  })

  test('正常路径：写入 3 个文件，composition 带头部注释 + 4 个 disabled；重复运行（带标记）重写', async () => {
    const { ctx, warn } = makeCtx(makeAgentPresets())
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).not.toHaveBeenCalled()
    const composition = await readFile(join(targetDir(), 'agent.cordis.yml'), 'utf8')
    expect(composition.startsWith('# 本文件由 dsh-agent-toolkit 自动生成')).toBe(true)
    expect(composition.match(/disabled: true/g)).toHaveLength(4)
    const metadata = yaml.load(await readFile(join(targetDir(), 'preset.yml'), 'utf8'))
    expect(metadata).toEqual({ name: 'Agent 团队', description: CONFIG.description })
    expect((await readFile(join(targetDir(), '.generated-by'), 'utf8')).trim()).toBe('dsh-agent-toolkit')
    // 重复运行：目录已有标记 → 重写（name 改了要生效），不 warn。
    await setupAgentTeamPreset(ctx, { ...CONFIG, name: '团队模式' })
    expect(warn).not.toHaveBeenCalled()
    expect(yaml.load(await readFile(join(targetDir(), 'preset.yml'), 'utf8'))).toEqual({ name: '团队模式', description: CONFIG.description })
  })
})
