import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentActivation, SubagentActivationSpec, SubagentProvider, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { AgentRecord } from '../agents/store.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import { setupDelegate } from './index.ts'
import { createActiveRoutes } from './active.ts'
import { rolePresetId } from './role-preset.ts'
import { teamSectionText } from './index.ts'

const ROSTER = [
  { id: 'main', name: '主 Agent' },
  { id: 'reviewer', name: 'Reviewer', description: '代码审查员' },
  { id: 'scout', name: 'Scout' },
]

describe('teamSectionText', () => {
  test('工具对当前 scope 不可见：段落为空（渲染时被丢弃）', () => {
    expect(teamSectionText('team_delegate', ROSTER, false)).toBe('')
  })

  test('工具可见：段落含工具名与成员名册（main 排除，description 优先）', () => {
    const text = teamSectionText('team_delegate', ROSTER, true)
    expect(text).toContain('team_delegate')
    expect(text).toContain('reviewer: 代码审查员')
    expect(text).toContain('scout: Scout')
    expect(text).not.toContain('main')
  })

  test('visibleInTeam: false 的成员不进名册；缺省与 true 照常列出', () => {
    const roster = [
      { id: 'main', name: '主 Agent' },
      { id: 'reviewer', name: 'Reviewer', description: '代码审查员' },
      { id: 'hidden', name: 'Hidden', description: '团队不可见', visibleInTeam: false },
      { id: 'shown', name: 'Shown', visibleInTeam: true },
    ]
    const text = teamSectionText('team_delegate', roster, true)
    expect(text).toContain('reviewer: 代码审查员')
    expect(text).toContain('shown: Shown')
    expect(text).not.toContain('hidden')
  })
})

const SETUP_ROSTER: AgentRecord[] = [
  { id: 'main', name: '主 Agent' },
  { id: 'reviewer', name: 'Reviewer', description: '代码审查员' },
  { id: 'hidden', name: 'Hidden', visibleInTeam: false },
]

function fakeRegistry(records: AgentRecord[]): AgentRegistry {
  return {
    list: () => records,
    get: (id) => records.find(r => r.id === id),
    upsert: async () => {},
    remove: async () => {},
    subscribe: () => () => {},
  }
}

function fakeProvider(capabilities: Record<string, boolean>): SubagentProvider {
  return {
    name: 'spawn',
    capabilities,
    inheritsParentContext: false,
  } as unknown as SubagentProvider
}

function fakeDelegateCtx(provider: SubagentProvider | undefined) {
  const registeredTools: { name: string; execute?: (a: unknown, e: unknown) => Promise<unknown> }[] = []
  const errors: string[] = []
  const presetIds: string[] = []
  const capturedSpecs: SubagentActivationSpec[] = []
  const ctx = {
    tools: {
      register: (tool: { name: string; execute?: (a: unknown, e: unknown) => Promise<unknown> }) => {
        registeredTools.push(tool)
        return () => {}
      },
      schemas: () => [],
      get: () => undefined,
    },
    logger: {
      warn: () => {},
      error: (error: unknown) => { errors.push(error instanceof Error ? error.message : String(error)) },
      info: () => {},
    },
    subagents: {
      getProvider: () => provider,
      // 假 startActivation：捕获 spec 并返回已完成 activation（0.2.1 委派入口）。
      startActivation: async (spec: SubagentActivationSpec): Promise<SubagentActivation> => {
        capturedSpecs.push(spec)
        return {
          childId: 'child-1' as never,
          result: Promise.resolve({ stopReason: 'completed', output: [] } as SubagentResult),
          dispose: () => Promise.resolve(),
        } as unknown as SubagentActivation
      },
    },
    on: () => () => {},
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 2800 },
    effect: (fn: () => () => void) => fn(),
    get: (name: string) => name === 'agentPresets'
      ? { register: async (definition: { id: string }) => { presetIds.push(definition.id); return async () => {} } }
      : undefined,
  } as unknown as Context
  return { ctx, registeredTools, errors, presetIds, capturedSpecs }
}

function setupWith(provider: SubagentProvider | undefined, registry = fakeRegistry(SETUP_ROSTER)) {
  const fake = fakeDelegateCtx(provider)
  setupDelegate(fake.ctx, { provider: 'spawn', toolName: 'team_delegate', rules: [] }, registry, {
    active: createActiveRoutes(),
    recordRoute: async () => {},
  })
  return fake
}

// setupRolePresets 的首次同步走 void 异步链， flush 微任务后再断言。
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('setupDelegate', () => {
  const parent = {
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { id: 'parent-session-1' },
  }

  test('provider 具备 agentPreset/depthLimit/agentOptions：挂载工具；执行后 spec 经 ctx.subagents.startActivation 发出（agentPreset/maxDepth/delivery 正确）', async () => {
    const fake = setupWith(fakeProvider({ agentPreset: true, depthLimit: true, agentOptions: true }))
    expect(fake.registeredTools.map(t => t.name)).toEqual(['team_delegate'])
    const tool = fake.registeredTools[0]!
    const result = await tool.execute!({ role: 'reviewer', description: '审查', prompt: '任务' },
      { agent: parent, signal: new AbortController().signal })
    expect(result).toMatchObject({ kind: 'foreground', role: 'reviewer', childSessionId: 'child-1' })
    expect(fake.capturedSpecs).toHaveLength(1)
    const spec = fake.capturedSpecs[0]!
    expect(spec.provider).toBe('spawn')
    expect(spec.delivery).toBe('caller')
    expect(spec.request.agentPreset).toBe(rolePresetId('reviewer'))
    expect(spec.request.maxDepth).toBe(1)
    expect(fake.errors).toEqual([])
  })

  test('provider 缺能力：初始在场即响亮抛错（能力清单）且不挂载工具', () => {
    let registered: string[] = []
    try {
      const fake = setupWith(fakeProvider({ agentPreset: false, depthLimit: true, agentOptions: true }))
      registered = fake.registeredTools.map(t => t.name)
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('缺少 team_delegate 委派必需能力 agentPreset')
    }
    expect(registered).toEqual([])
  })

  test('provider 全部缺能力：抛齐全清单', () => {
    expect(() => setupWith(fakeProvider({ agentPreset: false, depthLimit: false, agentOptions: false })))
      .toThrowError(/缺少 team_delegate 委派必需能力 agentPreset\/depthLimit\/agentOptions/)
  })

  test('setupDelegate 后为团队角色注册对应 preset（断言收到 dsh-agent-toolkit-role-<id>）', async () => {
    const fake = setupWith(fakeProvider({ agentPreset: true, depthLimit: true, agentOptions: true }))
    await flush()
    expect(fake.presetIds).toContain(rolePresetId('reviewer'))
  })
})
