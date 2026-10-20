import { expect, test } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentActivation, SubagentActivationSpec, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { AgentRecord } from '../agents/store.ts'
import { createActiveRoutes, type ActiveRoutes, type DelegateRoute } from './active.ts'
import { rolePresetId } from './role-preset.ts'
import { createDelegateTool, type DelegateToolDeps } from './tool.ts'

const ROSTER: AgentRecord[] = [
  { id: 'main', name: '主 Agent' },
  { id: 'reviewer', name: 'Reviewer', description: '代码审查员', model: { provider: 'deepseek', model: 'deepseek-reasoner' } },
  { id: 'scout', name: 'Scout', description: '只读探索', tools: { allow: ['read', 'search'] } },
  { id: 'worker', name: 'Worker', description: '通用执行' },
]

const parent = {
  options: { provider: 'deepseek', model: 'deepseek-chat' },
  session: { id: 'parent-session-1' },
} as unknown as Agent

function fakeActivation(
  result: SubagentResult,
  childId = 'child-session-1',
  disposeError?: Error,
): SubagentActivation & { disposed: boolean } {
  const state = { disposed: false }
  return {
    childId: childId as never,
    result: Promise.resolve(result),
    dispose: () => {
      state.disposed = true
      return disposeError ? Promise.reject(disposeError) : Promise.resolve()
    },
    get disposed() { return state.disposed },
  } as SubagentActivation & { disposed: boolean }
}

interface Captured { spec: SubagentActivationSpec }

function depsWith(
  activation: SubagentActivation,
  captured: Captured[],
  extras: {
    active?: ActiveRoutes
    recordRoute?: (id: string, route: DelegateRoute) => Promise<void>
  } = {},
): DelegateToolDeps {
  return {
    roster: () => ROSTER,
    provider: 'spawn',
    startActivation: async (spec) => { captured.push({ spec }); return activation },
    active: extras.active ?? createActiveRoutes(),
    recordRoute: extras.recordRoute ?? (async () => {}),
  }
}

const exec = { agent: parent, signal: new AbortController().signal }

async function callTool(tool: unknown, args: Record<string, unknown>, execArg: unknown = exec) {
  const execute = (tool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute
  return execute(args, execArg)
}

test('成功委派：spec 字段正确（preset/maxDepth/delivery），返回规范 JSON 含 childSessionId，activation 被 dispose', async () => {
  const captured: Captured[] = []
  const activation = fakeActivation({ stopReason: 'completed', output: [{ type: 'text', text: '结论' }] } as SubagentResult)
  const tool = createDelegateTool('team_delegate', depsWith(activation, captured))
  const result = await callTool(tool, { role: 'reviewer', description: '审查登录模块', prompt: '请审查 src/auth/' })
  expect(result).toMatchObject({
    kind: 'foreground', role: 'reviewer', runId: 'child-session-1', childSessionId: 'child-session-1',
  })
  expect(captured).toHaveLength(1)
  const { spec } = captured[0]!
  expect(spec.provider).toBe('spawn')
  expect(spec.delivery).toBe('caller')
  expect(spec.label).toBe('role:reviewer: 审查登录模块')
  expect(spec.signal).toBe(exec.signal)
  const request = spec.request
  expect(request.agentPreset).toBe(rolePresetId('reviewer'))
  expect(request.maxDepth).toBe(1)
  expect(request.parent).toBe(parent)
  expect(request.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  // persona/工具白名单由角色 preset 承载，请求里不再有这两个键。
  expect('persona' in request).toBe(false)
  expect('toolFilter' in request).toBe(false)
  expect(activation.disposed).toBe(true)
})

test('角色未配 model：不传 agentOptions；agentPreset 照常选择；无 persona/toolFilter 键', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(fakeActivation({ stopReason: 'completed', output: [] } as SubagentResult), captured))
  await callTool(tool, { role: 'worker', description: '执行', prompt: '任务' })
  const request = captured[0]!.spec.request
  expect(request.agentPreset).toBe(rolePresetId('worker'))
  expect(request.agentOptions).toBeUndefined()
  expect('persona' in request).toBe(false)
  expect('toolFilter' in request).toBe(false)
})

test('未知角色报错并列出可用角色（不含 main），且不发起委派', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(fakeActivation({ stopReason: 'completed', output: [] } as SubagentResult), captured))
  await expect(callTool(tool, { role: 'nobody', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/未知角色 "nobody"。可用角色：reviewer, scout, worker/)
  expect(captured).toHaveLength(0)
})

test('不能委派给 main（查找排除 main）', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(fakeActivation({ stopReason: 'completed', output: [] } as SubagentResult), captured))
  await expect(callTool(tool, { role: 'main', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/未知角色 "main"/)
  expect(captured).toHaveLength(0)
})

test('团队不可见角色不可委派：报错且不出现在可用清单，不发起委派', async () => {
  const captured: Captured[] = []
  const roster: AgentRecord[] = [
    ...ROSTER,
    { id: 'hidden', name: 'Hidden', visibleInTeam: false },
  ]
  const deps: DelegateToolDeps = { ...depsWith(fakeActivation({ stopReason: 'completed', output: [] } as SubagentResult), captured), roster: () => roster }
  const tool = createDelegateTool('team_delegate', deps)
  await expect(callTool(tool, { role: 'hidden', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/未知角色 "hidden"。可用角色：reviewer, scout, worker/)
  expect(captured).toHaveLength(0)
})

test('显式 visibleInTeam: true 的角色照常可委派', async () => {
  const captured: Captured[] = []
  const roster: AgentRecord[] = [{ id: 'shown', name: 'Shown', visibleInTeam: true }]
  const deps: DelegateToolDeps = { ...depsWith(fakeActivation({ stopReason: 'completed', output: [] } as SubagentResult), captured), roster: () => roster }
  const tool = createDelegateTool('team_delegate', deps)
  await callTool(tool, { role: 'shown', description: '执行', prompt: '任务' })
  expect(captured).toHaveLength(1)
})

test('成员异常终止（max-tokens）报错并附部分产出', async () => {
  const activation = fakeActivation(
    { stopReason: 'max-tokens', output: [{ type: 'text', text: '半截结论' }] } as SubagentResult,
    'child-2',
  )
  const tool = createDelegateTool('team_delegate', depsWith(activation, []))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/半截结论/)
})

test('dispose 失败不掩盖执行结果失败（AggregateError）', async () => {
  const activation = fakeActivation(
    { stopReason: 'error', output: [] } as SubagentResult,
    'child-3',
    new Error('dispose boom'),
  )
  const tool = createDelegateTool('team_delegate', depsWith(activation, []))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(AggregateError)
})

test('exec.agent 为空时报错', async () => {
  const tool = createDelegateTool('team_delegate', depsWith(fakeActivation({ stopReason: 'completed', output: [] } as SubagentResult), []))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' }, { signal: new AbortController().signal }))
    .rejects.toThrowError(/exec\.agent/)
})

test('description 为静态委派语义，不含任何具体名册', () => {
  const tool = createDelegateTool('team_delegate', depsWith(fakeActivation({ stopReason: 'completed', output: [] } as SubagentResult), [])) as { description: string }
  expect(tool.description).not.toContain('reviewer')
  expect(tool.description).toMatch(/does NOT see this conversation/)
  expect(tool.description).toMatch(/self-contained/)
  expect(tool.description).toMatch(/system prompt/)
})

test('presentCall/presentResult 保持 generic 兜底；presentationMeta 投影 role/runId/childSessionId', () => {
  const tool = createDelegateTool('team_delegate', depsWith(fakeActivation({ stopReason: 'completed', output: [] } as SubagentResult), [])) as unknown as {
    presentCall: (args: Record<string, unknown>) => unknown
    presentResult: (args: Record<string, unknown>, result: { isError: boolean }) => unknown
    output: { presentationMeta: (args: unknown, value: Record<string, unknown>) => unknown }
  }
  expect(tool.presentCall({ role: 'reviewer', description: '审查登录模块', prompt: '请审查 src/auth/' }))
    .toEqual({ card: 'generic', title: '委派 · reviewer: 审查登录模块', rawInput: '请审查 src/auth/' })
  expect(tool.presentResult({ role: 'reviewer', description: '审查登录模块', prompt: '请审查 src/auth/' }, { isError: false })).toEqual({ card: 'generic' })
  expect(tool.presentResult({ role: 'reviewer', description: '审查登录模块', prompt: '请审查 src/auth/' }, { isError: true })).toBeUndefined()
  expect(tool.output.presentationMeta({}, {
    kind: 'foreground', role: 'reviewer', runId: 'r1', childSessionId: 'c1', output: [{ type: 'text', text: 'x' }],
  })).toEqual({ role: 'reviewer', runId: 'r1', childSessionId: 'c1' })
})

/** 读工具的 presentationMeta（output 面测试 casts，与既有 description 测试同法）。 */
function metaOf(tool: unknown, value: Record<string, unknown>): Record<string, unknown> {
  return (tool as unknown as {
    output: { presentationMeta: (args: unknown, v: Record<string, unknown>) => Record<string, unknown> }
  }).output.presentationMeta({}, value)
}

test('角色有 model：路由=角色覆盖；在途条目 startActivation 前可见、settle 后删除；recordRoute 收到子会话坐标；meta 透出', async () => {
  const active = createActiveRoutes()
  const recorded: { id: string; route: DelegateRoute }[] = []
  const captured: Captured[] = []
  const deps = depsWith(fakeActivation({ stopReason: 'completed', output: [{ type: 'text', text: '结论' }] } as SubagentResult), captured, {
    active,
    recordRoute: async (id, route) => { recorded.push({ id, route }) },
  })
  // startActivation 时在途条目已写入（运行中卡片的读取窗口）。spread 拷贝绕开 readonly。
  const checkingDeps: DelegateToolDeps = {
    ...deps,
    startActivation: async (spec) => {
      expect(active.get('parent-session-1', 'reviewer')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
      return deps.startActivation(spec)
    },
  }
  const tool = createDelegateTool('team_delegate', checkingDeps)
  const result = await callTool(tool, { role: 'reviewer', description: '审查', prompt: '任务' }) as Record<string, unknown>
  expect(result.provider).toBe('deepseek')
  expect(result.model).toBe('deepseek-reasoner')
  expect(recorded).toEqual([{ id: 'child-session-1', route: { provider: 'deepseek', model: 'deepseek-reasoner' } }])
  expect(active.get('parent-session-1', 'reviewer')).toBeUndefined() // settle 后删除
  expect(metaOf(tool, result)).toMatchObject({
    role: 'reviewer', childSessionId: 'child-session-1',
    provider: 'deepseek', model: 'deepseek-reasoner',
  })
})

test('角色无 model：路由继承父 options', async () => {
  const recorded: { id: string; route: DelegateRoute }[] = []
  const tool = createDelegateTool('team_delegate', depsWith(fakeActivation({ stopReason: 'completed', output: [] } as SubagentResult), [], {
    recordRoute: async (id, route) => { recorded.push({ id, route }) },
  }))
  const result = await callTool(tool, { role: 'worker', description: '执行', prompt: '任务' }) as Record<string, unknown>
  expect(result.provider).toBe('deepseek')
  expect(result.model).toBe('deepseek-chat')
  expect(recorded).toEqual([{ id: 'child-session-1', route: { provider: 'deepseek', model: 'deepseek-chat' } }])
})

test('角色 model 字段含空串：视为未配置，路由回退父 options', async () => {
  const roster: AgentRecord[] = [
    { id: 'main', name: '主 Agent' },
    { id: 'both-empty', name: 'BothEmpty', model: { provider: '', model: '' } },
    { id: 'provider-empty', name: 'ProviderEmpty', model: { provider: '', model: 'deepseek-chat' } },
  ]
  const recorded: { id: string; route: DelegateRoute }[] = []
  const deps: DelegateToolDeps = {
    roster: () => roster,
    provider: 'spawn',
    startActivation: async () => fakeActivation({ stopReason: 'completed', output: [] } as SubagentResult),
    active: createActiveRoutes(),
    recordRoute: async (id, route) => { recorded.push({ id, route }) },
  }
  const tool = createDelegateTool('team_delegate', deps)
  const a = await callTool(tool, { role: 'both-empty', description: 'a', prompt: '任务' }) as Record<string, unknown>
  const b = await callTool(tool, { role: 'provider-empty', description: 'b', prompt: '任务' }) as Record<string, unknown>
  expect(a.provider).toBe('deepseek')
  expect(a.model).toBe('deepseek-chat')
  expect(b.provider).toBe('deepseek')
  expect(b.model).toBe('deepseek-chat')
  expect(recorded).toEqual([
    { id: 'child-session-1', route: { provider: 'deepseek', model: 'deepseek-chat' } },
    { id: 'child-session-1', route: { provider: 'deepseek', model: 'deepseek-chat' } },
  ])
})

test('父 options 不完整且角色无覆盖：全链路省略（无 meta/无在途/无持久写）', async () => {
  const active = createActiveRoutes()
  let recordCalls = 0
  const bareParent = { options: {}, session: { id: 'p2' } } as unknown as Agent
  const tool = createDelegateTool('team_delegate', depsWith(fakeActivation({ stopReason: 'completed', output: [] } as SubagentResult), [], {
    active,
    recordRoute: async () => { recordCalls += 1 },
  }))
  const result = await callTool(tool, { role: 'worker', description: 'x', prompt: 'y' },
    { agent: bareParent, signal: new AbortController().signal }) as Record<string, unknown>
  expect(result.provider).toBeUndefined()
  expect(result.model).toBeUndefined()
  expect(metaOf(tool, result).provider).toBeUndefined()
  expect(active.get('p2', 'worker')).toBeUndefined()
  expect(recordCalls).toBe(0)
})

test('settle 抛错路径：在途条目仍被 finally 删除；持久行已写（子会话确曾以该路由运行）', async () => {
  const active = createActiveRoutes()
  const recorded: string[] = []
  const activation = fakeActivation({ stopReason: 'error', output: [] } as SubagentResult, 'child-err')
  const tool = createDelegateTool('team_delegate', depsWith(activation, [], {
    active,
    recordRoute: async (id) => { recorded.push(id) },
  }))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' })).rejects.toThrow()
  expect(active.get('parent-session-1', 'reviewer')).toBeUndefined()
  expect(recorded).toEqual(['child-err'])
})
