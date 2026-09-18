import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { DEFAULT_LAYERS, DEFAULT_RULES } from './prompt/defaults.ts'
import { Config, apply } from './index.ts'
import { setupBots } from './bots/index.ts'
import { setupSchedule } from './schedule/index.ts'

// 部分 mock（保留原实现随 apply 真实接线，仅暴露调用参数供接线断言）——照 bots/index.test.ts
// 对 createAgentsPort 的同款 vi.fn(original) 先例。
vi.mock('./bots/index.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./bots/index.ts')>()
  return { ...original, setupBots: vi.fn(original.setupBots) }
})
vi.mock('./schedule/index.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./schedule/index.ts')>()
  return { ...original, setupSchedule: vi.fn(original.setupSchedule) }
})

class FakeTable<V> implements KvTable<string, V> {
  private readonly records = new Map<string, V>()
  get(key: string): V | undefined { return this.records.get(key) }
  entries(): IterableIterator<[string, V]> { return this.records.entries() }
  keys(): IterableIterator<string> { return this.records.keys() }
  get size(): number { return this.records.size }
  async put(key: string, value: V): Promise<void> { this.records.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.records.delete(key) }
  async update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error(`missing-key: ${key}`)
    const next = fn(current)
    this.records.set(key, next)
    return next
  }
}

class FakeDomain {
  readonly name: string
  private readonly tables = new Map<string, FakeTable<unknown>>()
  constructor(spec: DomainSpec, private readonly onClose: (name: string) => void = () => {}) {
    this.name = spec.name
    for (const name of Object.keys(spec.tables)) this.tables.set(name, new FakeTable())
  }
  table(name: string): KvTable<string, unknown> {
    const table = this.tables.get(name)
    if (table === undefined) throw new Error(`no table ${name}`)
    return table as KvTable<string, unknown>
  }
  async close(): Promise<void> { this.onClose(this.name) }
}

interface ApplyHarness {
  ctx: Context
  commands: string[]
  sections: string[]
  tools: string[]
  openedDomains: string[]
  registered: { kind: string; path: string }[]
  effects: (() => unknown)[]
}

/** 记录 apply 经各模块注册的命令/section/工具、打开的存储域、webServer 路由与 effect 注册。 */
function makeCtx(onDomainClose: (name: string) => void = () => {}): ApplyHarness {
  const commands: string[] = []
  const sections: string[] = []
  const tools: string[] = []
  const openedDomains: string[] = []
  const registered: { kind: string; path: string }[] = []
  const effects: (() => unknown)[] = []
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    storageDomain: {
      open: (spec: DomainSpec) => {
        openedDomains.push(spec.name)
        return Promise.resolve(new FakeDomain(spec, onDomainClose))
      },
    },
    effect: (fn: () => unknown) => { effects.push(fn) },
    on: vi.fn(() => () => {}),
    systemPrompt: {
      section: (s: { name: string }) => {
        sections.push(s.name)
        return () => {}
      },
      getSectionOrder: () => 2800,
    },
    tools: {
      register: (d: { name: string }) => {
        tools.push(d.name)
        return () => {}
      },
      schemas: () => [],
    },
    subagents: { getProvider: () => undefined, start: vi.fn() },
    commands: {
      register: (c: { name: string }) => {
        commands.push(c.name)
        return () => {}
      },
    },
    credentials: { set: vi.fn(async () => {}), resolve: vi.fn(async () => undefined), unset: vi.fn(async () => {}) },
    agents: { create: vi.fn(), resume: vi.fn(), roots: () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'spawn', model: 'deepseek-chat' }) },
    llm: { listProviders: () => [], listModels: () => Promise.resolve([]) },
    get: () => undefined,
    // 模拟 ctx.inject 的可选服务语义：webServer 在场时激活子 fiber 并记录注册的路由
    //（registerOptionalRoutes 经此注册 agents/bots 的 RPC 路由；其他依赖不激活回调）。
    inject: (deps: string[], callback: (webCtx: {
      effect: (fn: () => unknown) => unknown
      webServer: { register: (r: { kind: string; path: string }) => () => void }
    }) => void) => {
      if (!deps.includes('webServer')) return
      callback({
        effect: (fn: () => unknown) => fn(),
        webServer: { register: (r) => { registered.push(r); return () => {} } },
      })
    },
  } as unknown as Context
  return { ctx, commands, sections, tools, openedDomains, registered, effects }
}

/** 卸载：cordis 的 disposer 并发执行（Promise.all），逐 effect 调用其 disposer。 */
async function disposeAll(effects: (() => unknown)[]): Promise<void> {
  await Promise.all(effects.map(async (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') await disposer()
  }))
}

let tempHome: string
beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'dsh-toolkit-index-'))
  vi.stubEnv('DSH_HOME', tempHome)
  vi.mocked(setupBots).mockClear()
  vi.mocked(setupSchedule).mockClear()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(tempHome, { recursive: true, force: true })
})

/** 等 setupUsage 的 openSucceeded 微任务链落地：/token-usage 命令注册已移入 open 成功后。 */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('Config 默认值', () => {
  test('Config({}) 产出全量默认值（模块开关/分层/规则/时区/委派/飞书）', () => {
    const config = Config({})
    expect(config.modules).toEqual({ feishu: true, usage: true })
    expect(config.layers).toEqual(DEFAULT_LAYERS)
    expect(config.rules).toEqual(DEFAULT_RULES)
    expect(config.timezone).toBe('Asia/Shanghai')
    expect(config.provider).toBe('spawn')
    expect(config.toolName).toBe('team_delegate')
    expect(config.feishu).toEqual({
      cardUpdateThrottleMs: 500,
      cardMaxBytes: 26_000,
      cardPrintStep: 5,
      processMaxBytes: 8_000,
      registerAppTimeoutMs: 600_000,
      processingReactionEmoji: 'OneSecond',
      errorDetailMaxChars: 500,
      injectSender: true,
      approval: true,
      questions: true,
      docMaxBytes: 31_457_280,
      debugLog: true,
      debugLogDir: '',
      debugLogRetentionDays: 7,
    })
    expect(config.agentTeamPreset).toEqual({
      enabled: true,
      id: 'agent-team',
      source: 'standard',
      name: 'Agent 团队',
      description: 'Agent 团队模式：禁用原生 subagent 工具族，委派统一走 team_delegate 团队角色',
    })
    expect(config.schedule).toEqual({ runTimeoutMinutes: 60, runHistoryLimit: 20 })
  })

  test('feishu.injectSender=false 原样保留', () => {
    const config = Config({ feishu: { injectSender: false } })
    expect(config.feishu.injectSender).toBe(false)
  })

  test('feishu.approval=false 原样保留（关闭飞书审批卡片，回到 web api-proxy 弹窗）', () => {
    const config = Config({ feishu: { approval: false } })
    expect(config.feishu.approval).toBe(false)
  })

  test('feishu.questions：默认开启（ask_user_question / plan 评审走飞书卡片作答），显式关闭原样保留', () => {
    expect(Config({}).feishu.questions).toBe(true)
    expect(Config({ feishu: { questions: false } }).feishu.questions).toBe(false)
  })

  test('存量多余键兼容：agentTeamPreset.botsId 与 feishu 未知键均不炸（schemastery 宽容）', () => {
    const config = Config({
      agentTeamPreset: { botsId: 'agent-bot' },
      feishu: { legacyUnknownKey: true },
    })
    expect(config.feishu.questions).toBe(true)
    expect(config.agentTeamPreset.id).toBe('agent-team')
  })

  test('feishu.permissionPreset：缺省 undefined（维持宿主默认预设），显式配置原样保留', () => {
    expect(Config({}).feishu.permissionPreset).toBeUndefined()
    expect(Config({ feishu: { permissionPreset: 'danger-full-access' } }).feishu.permissionPreset).toBe('danger-full-access')
  })

  test('schedule.permissionPreset：缺省 undefined（维持宿主默认预设），显式配置原样保留', () => {
    expect(Config({}).schedule.permissionPreset).toBeUndefined()
    expect(Config({ schedule: { permissionPreset: 'danger-full-access' } }).schedule.permissionPreset).toBe('danger-full-access')
  })

  test('feishu 调试日志三键：默认开启、默认目录为空（解析到 ~/.dsh/logs/feishu-debug）、默认保留 7 天', () => {
    const parsed = Config({}) as { feishu: { debugLog: boolean; debugLogDir: string; debugLogRetentionDays: number } }
    expect(parsed.feishu.debugLog).toBe(true)
    expect(parsed.feishu.debugLogDir).toBe('')
    expect(parsed.feishu.debugLogRetentionDays).toBe(7)
  })
})

describe('apply 模块接线与开关', () => {
  // 本 describe 走 setupBots 的测试显式 feishu.debugLog: false：debugLog 默认开启会经
  // DEFAULT_DEBUG_LOG_DIR()（os.homedir()，不感知 DSH_HOME）在真实 ~/.dsh/logs 下 mkdir，
  // 破坏测试 hermeticity。默认值本身由上方「Config 默认值」describe 断言，不受影响。
  test('默认配置：注册 /token-usage 命令、五个存储域、委派工具挂载路径', async () => {
    const h = makeCtx()
    await apply(h.ctx, Config({ feishu: { debugLog: false } }))
    await flush()
    expect(h.commands).toContain('token-usage')
    expect(h.commands).toContain('create-agent')
    expect(h.openedDomains.sort()).toEqual(['dsh_agent_toolkit', 'dsh_agent_toolkit_routes', 'dsh_agent_toolkit_schedule', 'project_bot', 'token_usage'])
    expect(h.sections).toEqual(expect.arrayContaining(['plugin:dsh-agent-toolkit:team', 'prompt-stack:base', 'prompt-stack:model-notes']))
    expect(h.tools).not.toContain('team_delegate') // 无 subagent provider 在场时不挂载工具
  })

  test('modules.usage=false：不注册 /token-usage 命令，也不打开 token_usage 域', async () => {
    const h = makeCtx()
    await apply(h.ctx, Config({ modules: { usage: false }, feishu: { debugLog: false } }))
    expect(h.commands).not.toContain('token-usage')
    expect(h.openedDomains).not.toContain('token_usage')
  })

  test('modules.feishu=false：project_bot 域仍开（agents API 删除守卫恒需 Bot 计数），仅 bots 运行时/路由不下达', async () => {
    const h = makeCtx()
    await apply(h.ctx, Config({ modules: { feishu: false } }))
    expect(h.openedDomains).toContain('token_usage')
    expect(h.openedDomains).toContain('project_bot')
    expect(vi.mocked(setupBots)).not.toHaveBeenCalled()
  })

  test('modules.feishu=false：agents/providers/tools RPC 仍注册（核心恒启用），bots 路由不注册', async () => {
    const h = makeCtx()
    await apply(h.ctx, Config({ modules: { feishu: false } }))
    const paths = h.registered.map((r) => r.path)
    expect(paths).toContain('/dsh-agent-toolkit/api/agents')
    expect(paths).toContain('/dsh-agent-toolkit/api/providers')
    expect(paths).toContain('/dsh-agent-toolkit/api/tools')
    expect(paths).toContain('/dsh-agent-toolkit/api/prompt-layers')
    expect(paths).toContain('/dsh-agent-toolkit/api/delegate')
    expect(paths).not.toContain('/dsh-agent-toolkit/api/bots')
  })

  test('默认配置：/dsh-agent-toolkit/api/cron 前缀路由注册（schedule 恒启用，不随 modules 门控）', async () => {
    const h = makeCtx()
    await apply(h.ctx, Config({ modules: { feishu: false } }))
    await flush()
    expect(h.registered.map((r) => r.path)).toContain('/dsh-agent-toolkit/api/cron')
  })

  test('cron_* 门控接线：setupBots deps 无会话排除字段，setupSchedule deps 携带 cronExcludedSessions Set', async () => {
    const h = makeCtx()
    await apply(h.ctx, Config({ feishu: { debugLog: false } }))
    const botsDeps = vi.mocked(setupBots).mock.calls[0]![2] as unknown as Record<string, unknown>
    // bot 聊天会话不登记排除集：deps 键面为 registry/presetId + 插件入口打开的 bots/bindings 表句柄；
    // 回退重新加回任何会话排除字段（如 ownedSessions）并传入都会在此失败。
    expect(Object.keys(botsDeps).sort()).toEqual(['bindings', 'bots', 'presetId', 'registry'])
    // schedule 执行会话仍登记：门控排除集以 Set 形式下达。
    const scheduleDeps = vi.mocked(setupSchedule).mock.calls[0]![2]
    expect(scheduleDeps.cronExcludedSessions).toBeInstanceOf(Set)
  })

  test('默认配置：agents RPC 与 bots 路由均注册（同一 /dsh-agent-toolkit/api 前缀，路径互不重叠）', async () => {
    const h = makeCtx()
    await apply(h.ctx, Config({ feishu: { debugLog: false } }))
    const paths = h.registered.map((r) => r.path)
    expect(paths).toContain('/dsh-agent-toolkit/api/agents')
    expect(paths).toContain('/dsh-agent-toolkit/api/providers')
    expect(paths).toContain('/dsh-agent-toolkit/api/tools')
    expect(paths).toContain('/dsh-agent-toolkit/api/prompt-layers')
    expect(paths).toContain('/dsh-agent-toolkit/api/delegate')
    expect(paths).toContain('/dsh-agent-toolkit/api/bots')
  })

  test('apply 先校验 prompt 配置：非法 layers 在打开任何存储域前拒绝', async () => {
    const h = makeCtx()
    await expect(apply(h.ctx, Config({ layers: [], rules: [] }))).rejects.toThrow(/at least one layer/)
    expect(h.openedDomains).toEqual([])
  })

  test('卸载：project_bot 关域前先排空 bots（drain 先于 close，不能并发）', async () => {
    // cordis 的 disposer 并发执行（Promise.all），注册顺序/逆序都不提供串行保证；
    // 必须由 openDomainSafely 的单个 effect 串行 await drain 后再 close。
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const h = makeCtx((name) => { order.push(`close:${name}`) })
    vi.mocked(setupBots).mockImplementationOnce(() => async () => { await gate; order.push('drain') })
    await apply(h.ctx, Config({ feishu: { debugLog: false } }))
    const done = disposeAll(h.effects)
    await Promise.resolve()
    // drain 未落定前 project_bot 不得关闭（close 一旦开始就拒绝新入队的写）。
    expect(order).not.toContain('close:project_bot')
    release()
    await done
    // 其他域并发关闭不受影响，但 project_bot 必须排在 drain 之后。
    expect(order.indexOf('drain')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('drain')).toBeLessThan(order.indexOf('close:project_bot'))
  })
})
