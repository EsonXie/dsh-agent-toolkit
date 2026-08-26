import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { DEFAULT_LAYERS, DEFAULT_RULES } from './prompt/defaults.ts'
import { Config, apply } from './index.ts'

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
  constructor(spec: DomainSpec) {
    this.name = spec.name
    for (const name of Object.keys(spec.tables)) this.tables.set(name, new FakeTable())
  }
  table(name: string): KvTable<string, unknown> {
    const table = this.tables.get(name)
    if (table === undefined) throw new Error(`no table ${name}`)
    return table as KvTable<string, unknown>
  }
  async close(): Promise<void> {}
}

interface ApplyHarness {
  ctx: Context
  commands: string[]
  sections: string[]
  tools: string[]
  openedDomains: string[]
}

/** 记录 apply 经各模块注册的命令/section/工具与打开的存储域。 */
function makeCtx(): ApplyHarness {
  const commands: string[] = []
  const sections: string[] = []
  const tools: string[] = []
  const openedDomains: string[] = []
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    storageDomain: {
      open: (spec: DomainSpec) => {
        openedDomains.push(spec.name)
        return Promise.resolve(new FakeDomain(spec))
      },
    },
    effect: () => {},
    on: vi.fn(() => () => {}),
    systemPrompt: {
      section: (s: { name: string }) => {
        sections.push(s.name)
        return () => {}
      },
    },
    tools: {
      register: (d: { name: string }) => {
        tools.push(d.name)
        return () => {}
      },
    },
    subagents: { getProvider: () => undefined, start: vi.fn() },
    commands: {
      register: (c: { name: string }) => {
        commands.push(c.name)
        return () => {}
      },
    },
    credentials: { set: vi.fn(async () => {}), resolve: vi.fn(async () => undefined), unset: vi.fn(async () => {}) },
    agents: { create: vi.fn(), resume: vi.fn() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'spawn', model: 'deepseek-chat' }) },
    llm: { listProviders: () => [], listModels: () => Promise.resolve([]) },
    get: () => undefined,
    inject: vi.fn(),
  } as unknown as Context
  return { ctx, commands, sections, tools, openedDomains }
}

let tempHome: string
beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'dsh-toolkit-index-'))
  vi.stubEnv('DSH_HOME', tempHome)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(tempHome, { recursive: true, force: true })
})

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
      cardMaxBytes: 28_000,
      processMaxBytes: 8_000,
      registerAppTimeoutMs: 600_000,
      processingReactionEmoji: 'OneSecond',
      errorDetailMaxChars: 500,
    })
  })
})

describe('apply 模块接线与开关', () => {
  test('默认配置：注册 /token-usage 命令、三个存储域、委派工具挂载路径', async () => {
    const h = makeCtx()
    await apply(h.ctx, Config({}))
    expect(h.commands).toContain('token-usage')
    expect(h.openedDomains.sort()).toEqual(['dsh_agent_toolkit', 'project_bot', 'token_usage'])
    expect(h.sections).toEqual(expect.arrayContaining(['plugin:dsh-agent-toolkit:team', 'prompt-stack:base', 'prompt-stack:model-notes']))
    expect(h.tools).not.toContain('team_delegate') // 无 subagent provider 在场时不挂载工具
  })

  test('modules.usage=false：不注册 /token-usage 命令，也不打开 token_usage 域', async () => {
    const h = makeCtx()
    await apply(h.ctx, Config({ modules: { usage: false } }))
    expect(h.commands).not.toContain('token-usage')
    expect(h.openedDomains).not.toContain('token_usage')
  })

  test('modules.feishu=false：不开 project_bot 域', async () => {
    const h = makeCtx()
    await apply(h.ctx, Config({ modules: { feishu: false } }))
    expect(h.openedDomains).toContain('token_usage')
    expect(h.openedDomains).not.toContain('project_bot')
  })

  test('apply 先校验 prompt 配置：非法 layers 在打开任何存储域前拒绝', async () => {
    const h = makeCtx()
    await expect(apply(h.ctx, Config({ layers: [], rules: [] }))).rejects.toThrow(/at least one layer/)
    expect(h.openedDomains).toEqual([])
  })
})
