import { describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import yaml from 'js-yaml'
import { disableSubagentRows, TEAM_PRESET_DISABLED_ROWS, setupAgentTeamPreset, type AgentTeamPresetConfig } from './team-preset.ts'

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

describe('agent-team 工具面守护（2026-09-16：bot 会话含 ask_user_question）', () => {
  test('disableSubagentRows 不误伤 tool-ask-user 行——生成 composition 保留 ask_user_question 面', () => {
    // 镜像宿主 shipped standard 的两个关键行：待收窄的 subagent 族 + 必须保留的 ask-user 行。
    const source = [
      '# demo composition',
      '- id: tool-ask-user',
      "  name: '@deepseek-ai/dsh-tool-ask-user'",
      '',
      '- id: delegation',
      '  name: cordis:group',
      '  group: true',
      '  config:',
      '    - id: tool-subagent',
      "      name: '@deepseek-ai/dsh-tool-subagent'",
      '',
      '    - id: tool-subagent-fork',
      "      name: '@deepseek-ai/dsh-tool-subagent'",
      '',
      '    - id: tool-subagent-control',
      "      name: '@deepseek-ai/dsh-tool-subagent-control'",
      '',
      '    - id: tool-subagent-list-agents',
      "      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
      '',
    ].join('\n')
    const warn = vi.fn()
    const result = disableSubagentRows(source, warn)
    expect(warn).not.toHaveBeenCalled()
    // ask-user 行逐字节保留，且块内没有被插入 disabled（bot 会话工具面仍含 ask_user_question）。
    expect(result).toContain("- id: tool-ask-user\n  name: '@deepseek-ai/dsh-tool-ask-user'")
    const askUserBlock = result.slice(result.indexOf('- id: tool-ask-user'), result.indexOf('- id: delegation'))
    expect(askUserBlock).not.toContain('disabled')
    // 收窄只针对 subagent 族。
    expect(result).toContain("    - id: tool-subagent\n      disabled: true")
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
  const TARGETS: readonly string[] = TEAM_PRESET_DISABLED_ROWS

  /** 解析后 entry list 的行形（嵌套 group 的 config 递归收集）。 */
  type PluginRow = { id?: string; disabled?: unknown; group?: boolean; config?: unknown }

  function collectRows(value: unknown, into: PluginRow[] = []): PluginRow[] {
    if (!Array.isArray(value)) return into
    for (const row of value) {
      if (typeof row !== 'object' || row === null) continue
      into.push(row as PluginRow)
      collectRows((row as PluginRow).config, into)
    }
    return into
  }

  /**
   * 真实 cordis Context + 可选注入的 fake agentPresets 服务。fake 面与 0.1.7 宿主面一致
   *（readDocument/register，@deepseek-ai/dsh-agent-preset-registry）——0.2.3/0.2.4 两起
   * "fake 单测掩盖宿主语义"事故的直接对策：旧 roots/read 面在 0.1.7 registry 上必炸。
   */
  function makeCtx(service?: ReturnType<typeof makeAgentPresets>) {
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    if (service !== undefined) ctx.provide('agentPresets', service)
    return { ctx, warn }
  }

  function makeAgentPresets(overrides: {
    readDocument?: (id: string) => Promise<{ content: string }>
    register?: (definition: { id: string; name?: string; description?: string; plugins: readonly unknown[] }) => Promise<() => Promise<void>>
  } = {}) {
    return {
      readDocument: vi.fn(overrides.readDocument ?? (async () => ({ content: SOURCE }))),
      register: vi.fn(overrides.register ?? (async () => async () => {})),
    }
  }

  test('enabled=false：服务零调用、零 warn', async () => {
    const agentPresets = makeAgentPresets()
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, { ...CONFIG, enabled: false })
    expect(agentPresets.readDocument).not.toHaveBeenCalled()
    expect(agentPresets.register).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  test('agentPresets 服务缺席（旧宿主）：静默跳过，不 warn 不抛错', async () => {
    const { ctx, warn } = makeCtx()
    await expect(setupAgentTeamPreset(ctx, CONFIG)).resolves.toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  test('非法 id：readDocument 之前 warn 返回', async () => {
    const agentPresets = makeAgentPresets()
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, { ...CONFIG, id: '../evil' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不是合法 preset id'))
    expect(agentPresets.readDocument).not.toHaveBeenCalled()
    expect(agentPresets.register).not.toHaveBeenCalled()
  })

  test('readDocument 失败：warn 降级，不调 register', async () => {
    const agentPresets = makeAgentPresets({ readDocument: () => Promise.reject(new Error('Unknown agent preset: standard')) })
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown agent preset: standard'))
    expect(agentPresets.register).not.toHaveBeenCalled()
  })

  test('正常路径：register 被调，plugins = 派生文本经 js-yaml + entryListSchema 的解析结果（4 个目标行 disabled: true）', async () => {
    const agentPresets = makeAgentPresets()
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).not.toHaveBeenCalled()
    expect(agentPresets.readDocument).toHaveBeenCalledWith('standard')
    expect(agentPresets.register).toHaveBeenCalledTimes(1)
    const definition = agentPresets.register.mock.calls[0][0]
    expect(definition.id).toBe(CONFIG.id)
    expect(definition.name).toBe(CONFIG.name)
    expect(definition.description).toBe(CONFIG.description)
    // 注册的 plugins 与 disableSubagentRows 派生文本（EXPECTED）的 schema 解析结果全等。
    expect(definition.plugins).toEqual(yaml.load(EXPECTED, { schema: entryListSchema }))
    const rows = collectRows(definition.plugins)
    expect(TARGETS.every((id) => rows.find((row) => row.id === id)?.disabled === true)).toBe(true)
    // 非目标行不受影响：tool-workflow 保持无 disabled。
    expect(rows.find((row) => row.id === 'tool-workflow')?.disabled).toBeUndefined()
  })

  test('源 content 缺锚点行：warn 指出缺失行，其余目标行照常禁用并注册', async () => {
    const source = SOURCE.replace(
      "    - id: tool-subagent-list-agents\n      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'\n\n",
      '',
    )
    const agentPresets = makeAgentPresets({ readDocument: async () => ({ content: source }) })
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('- id: tool-subagent-list-agents'))
    expect(agentPresets.register).toHaveBeenCalledTimes(1)
    const rows = collectRows(agentPresets.register.mock.calls[0][0].plugins)
    const disabled = TARGETS.filter((id) => rows.find((row) => row.id === id)?.disabled === true)
    expect(disabled).toEqual(TARGETS.filter((id) => id !== 'tool-subagent-list-agents'))
  })

  test('content 含 !!js 行（宿主 Loader 方言）：entryListSchema 解析为 JsExpr 对象，目标行照常禁用', async () => {
    const source = `${SOURCE}    - id: tool-workflow-guard\n      name: '@deepseek-ai/dsh-tool-workflow'\n      disabled: !!js process.platform === 'win32'\n`
    const agentPresets = makeAgentPresets({ readDocument: async () => ({ content: source }) })
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).not.toHaveBeenCalled()
    expect(agentPresets.register).toHaveBeenCalledTimes(1)
    const rows = collectRows(agentPresets.register.mock.calls[0][0].plugins)
    // !!js 行解析为 JsExpr（若插件误用默认 schema 解析，这里会先抛错走降级分支）。
    expect(rows.find((row) => row.id === 'tool-workflow-guard')?.disabled).toEqual({ __jsExpr: "process.platform === 'win32'" })
    expect(TARGETS.every((id) => rows.find((row) => row.id === id)?.disabled === true)).toBe(true)
  })

  test('解析失败：warn 降级，不调 register', async () => {
    const agentPresets = makeAgentPresets({ readDocument: async () => ({ content: '[1,2' }) })
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('解析派生 composition 失败'))
    expect(agentPresets.register).not.toHaveBeenCalled()
  })

  test('注册 disposer 接入 effect：插件卸载时 register 返回的卸载函数被调用', async () => {
    const unregister = vi.fn(async () => {})
    const agentPresets = makeAgentPresets({ register: async () => unregister })
    const { ctx } = makeCtx(agentPresets)
    // 经真实 cordis 插件 fiber 启动：setup 在 plugin apply 内注册 effect（生产同款生命周期）。
    const fiber = ctx.plugin(async (inner: Context) => { await setupAgentTeamPreset(inner, CONFIG) })
    await fiber
    expect(agentPresets.register).toHaveBeenCalledTimes(1)
    expect(unregister).not.toHaveBeenCalled()
    // 卸载（HMR 重组同路径）：effect disposer 等待 register 的 Promise 结算后调用卸载函数。
    await fiber.dispose()
    expect(unregister).toHaveBeenCalledTimes(1)
  })
})
