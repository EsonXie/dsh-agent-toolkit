import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentActivation, SubagentActivationSpec, SubagentProvider, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { AgentRecord } from '../agents/store.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import { setupDelegate } from './index.ts'
import { createActiveRoutes } from './active.ts'
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
  const capturedSpecs: SubagentActivationSpec[] = []
  const handlers: Record<string, (...args: never[]) => unknown> = {}
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
    on: (name: string, listener: (...args: never[]) => unknown) => { handlers[name] = listener; return () => {} },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 2800 },
    effect: (fn: () => () => void) => fn(),
    get: () => undefined,
  } as unknown as Context
  return { ctx, registeredTools, errors, handlers, capturedSpecs }
}

function setupWith(provider: SubagentProvider | undefined, registry = fakeRegistry(SETUP_ROSTER)) {
  const fake = fakeDelegateCtx(provider)
  setupDelegate(fake.ctx, { provider: 'spawn', toolName: 'team_delegate', rules: [] }, registry, {
    active: createActiveRoutes(),
    recordRoute: async () => {},
  })
  return fake
}

describe('setupDelegate', () => {
  const parent = {
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { id: 'parent-session-1' },
  }

  test('执行 team_delegate：spec 经 ctx.subagents.startActivation 发出（继承父 preset/maxDepth/delivery）', async () => {
    const fake = setupWith(fakeProvider({ depthLimit: true, agentOptions: true }))
    expect(fake.registeredTools.map(t => t.name)).toEqual(['team_delegate'])
    const tool = fake.registeredTools[0]!
    const result = await tool.execute!({ role: 'reviewer', description: '审查', prompt: '任务' },
      { agent: parent, signal: new AbortController().signal })
    expect(result).toMatchObject({ kind: 'foreground', role: 'reviewer', childSessionId: 'child-1' })
    expect(fake.capturedSpecs).toHaveLength(1)
    const spec = fake.capturedSpecs[0]!
    expect(spec.provider).toBe('spawn')
    expect(spec.delivery).toBe('caller')
    expect('agentPreset' in spec.request).toBe(false)
    expect(spec.request.maxDepth).toBe(1)
    expect(fake.errors).toEqual([])
  })

  test('provider 缺 agentPreset：不再要求该能力，照常挂载（子级继承父 preset）', () => {
    const fake = setupWith(fakeProvider({ agentPreset: false, depthLimit: true, agentOptions: true }))
    expect(fake.registeredTools.map(t => t.name)).toEqual(['team_delegate'])
    expect(fake.errors).toEqual([])
  })

  test('provider 缺 depthLimit/agentOptions：初始在场即响亮抛错且不挂载工具', () => {
    let registered: string[] = []
    try {
      const fake = setupWith(fakeProvider({ agentPreset: false, depthLimit: false, agentOptions: false }))
      registered = fake.registeredTools.map(t => t.name)
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('缺少 team_delegate 委派必需能力 depthLimit/agentOptions')
    }
    expect(registered).toEqual([])
  })

  test('setupDelegate 注册 agent/created 组合监听器，不再注册角色 preset', () => {
    const fake = setupWith(fakeProvider({ depthLimit: true, agentOptions: true }))
    expect(fake.handlers['agent/created']).toBeTypeOf('function')
    expect(fake.handlers['agent/created']).toHaveLength(1)
  })
})
