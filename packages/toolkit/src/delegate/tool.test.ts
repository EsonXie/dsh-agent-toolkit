import { expect, test } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { AgentRecord } from '../agents/store.ts'
import { createActiveRoutes, type ActiveRoutes, type DelegateRoute } from './active.ts'
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

function okRun(output: ContentBlock[], disposeError?: Error): SubagentRun {
  return {
    id: 'child-session-1' as unknown as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve<SubagentResult>({ stopReason: 'completed', output } as SubagentResult),
    dispose: () => disposeError ? Promise.reject(disposeError) : Promise.resolve(),
  } as unknown as SubagentRun
}

interface Captured { provider: string; request: SubagentStartRequest }

/** 假 persona 构造：含归档测试断言的两处文本，便于平移保留原语义。 */
function fakePersona(role: AgentRecord): string {
  return `你是审查员。\n不能再次委派（role=${role.id}）`
}

function depsWith(
  run: SubagentRun,
  captured: Captured[],
  buildPersona: (role: AgentRecord) => string = fakePersona,
  extras: { active?: ActiveRoutes; recordRoute?: (id: string, route: DelegateRoute) => Promise<void> } = {},
): DelegateToolDeps {
  return {
    roster: () => ROSTER,
    provider: 'spawn',
    buildPersona,
    startRun: async (provider, request) => { captured.push({ provider, request }); return run },
    active: extras.active ?? createActiveRoutes(),
    recordRoute: extras.recordRoute ?? (async () => {}),
  }
}

const exec = { agent: parent, signal: new AbortController().signal }

async function callTool(tool: unknown, args: Record<string, unknown>, execArg: unknown = exec) {
  const execute = (tool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute
  return execute(args, execArg)
}

test('成功委派：请求字段正确，persona 经 buildPersona 生成，返回规范 JSON 含 childSessionId，run 被 dispose', async () => {
  const captured: Captured[] = []
  const personaCalls: AgentRecord[] = []
  const buildPersona = (role: AgentRecord): string => {
    personaCalls.push(role)
    return `PERSONA[${role.id}]`
  }
  let disposed = false
  const run = okRun([{ type: 'text', text: '结论' } as ContentBlock])
  const origDispose = run.dispose
  run.dispose = async () => { disposed = true; return origDispose() }
  const tool = createDelegateTool('team_delegate', depsWith(run, captured, buildPersona))
  const result = await callTool(tool, { role: 'reviewer', description: '审查登录模块', prompt: '请审查 src/auth/' })
  expect(result).toMatchObject({
    kind: 'foreground', role: 'reviewer', runId: 'child-session-1', childSessionId: 'child-session-1',
  })
  expect(captured).toHaveLength(1)
  const { provider, request } = captured[0]
  expect(provider).toBe('spawn')
  expect(request.label).toBe('role:reviewer: 审查登录模块')
  expect(request.maxDepth).toBe(1)
  expect(personaCalls).toHaveLength(1)
  expect(personaCalls[0]).toBe(ROSTER.find(r => r.id === 'reviewer'))
  expect(request.persona).toBe('PERSONA[reviewer]')
  expect(request.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  expect(request.toolFilter).toBeUndefined()
  expect(request.parent).toBe(parent)
  expect(request.signal).toBe(exec.signal)
  expect(disposed).toBe(true)
})

test('persona 默认假实现保留契约语义（含不能再次委派）', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await callTool(tool, { role: 'reviewer', description: '审查', prompt: '任务' })
  expect(captured[0].request.persona).toContain('你是审查员。')
  expect(captured[0].request.persona).toContain('不能再次委派')
})

test('角色配了 tools.allow：透传为 toolFilter（数组拷贝，不共享引用）', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await callTool(tool, { role: 'scout', description: '探索', prompt: '任务' })
  expect(captured[0].request.toolFilter).toEqual({ allow: ['read', 'search'] })
  expect(captured[0].request.toolFilter?.allow).not.toBe(ROSTER.find(r => r.id === 'scout')!.tools!.allow)
})

test('角色未配 model/tools 时不传 agentOptions/toolFilter', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await callTool(tool, { role: 'worker', description: '执行', prompt: '任务' })
  expect(captured[0].request.agentOptions).toBeUndefined()
  expect(captured[0].request.toolFilter).toBeUndefined()
})

test('未知角色报错并列出可用角色（不含 main），且不发起委派', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await expect(callTool(tool, { role: 'nobody', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/未知角色 "nobody"。可用角色：reviewer, scout, worker/)
  expect(captured).toHaveLength(0)
})

test('不能委派给 main（查找排除 main）', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await expect(callTool(tool, { role: 'main', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/未知角色 "main"/)
  expect(captured).toHaveLength(0)
})

test('成员异常终止（max-tokens）报错并附部分产出', async () => {
  const run: SubagentRun = {
    id: 'child-2' as unknown as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve<SubagentResult>({ stopReason: 'max-tokens', output: [{ type: 'text', text: '半截结论' }] } as SubagentResult),
    dispose: () => Promise.resolve(),
  } as unknown as SubagentRun
  const tool = createDelegateTool('team_delegate', depsWith(run, []))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/半截结论/)
})

test('dispose 失败不掩盖执行结果失败（AggregateError）', async () => {
  const run: SubagentRun = {
    id: 'child-3' as unknown as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve<SubagentResult>({ stopReason: 'error', output: [] } as SubagentResult),
    dispose: () => Promise.reject(new Error('dispose boom')),
  } as unknown as SubagentRun
  const tool = createDelegateTool('team_delegate', depsWith(run, []))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(AggregateError)
})

test('exec.agent 为空时报错', async () => {
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), []))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' }, { signal: new AbortController().signal }))
    .rejects.toThrowError(/exec\.agent/)
})

test('description 为静态委派语义，不含任何具体名册', () => {
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [])) as { description: string }
  expect(tool.description).not.toContain('reviewer')
  expect(tool.description).toMatch(/does NOT see this conversation/)
  expect(tool.description).toMatch(/self-contained/)
  expect(tool.description).toMatch(/system prompt/)
})

test('presentCall/presentResult 保持 generic 兜底；presentationMeta 投影 role/runId/childSessionId', () => {
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [])) as unknown as {
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

test('角色有 model：路由=角色覆盖；在途条目 startRun 前可见、settle 后删除；recordRoute 收到子会话坐标；meta 透出', async () => {
  const active = createActiveRoutes()
  const recorded: { id: string; route: DelegateRoute }[] = []
  const captured: Captured[] = []
  const run = okRun([{ type: 'text', text: '结论' } as ContentBlock])
  const deps = depsWith(run, captured, fakePersona, {
    active,
    recordRoute: async (id, route) => { recorded.push({ id, route }) },
  })
  // startRun 时在途条目已写入（运行中卡片的读取窗口）。spread 拷贝绕开 readonly。
  const checkingDeps: DelegateToolDeps = {
    ...deps,
    startRun: async (p, req) => {
      expect(active.get('parent-session-1', 'reviewer')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
      return deps.startRun(p, req)
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
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [], fakePersona, {
    recordRoute: async (id, route) => { recorded.push({ id, route }) },
  }))
  const result = await callTool(tool, { role: 'worker', description: '执行', prompt: '任务' }) as Record<string, unknown>
  expect(result.provider).toBe('deepseek')
  expect(result.model).toBe('deepseek-chat')
  expect(recorded).toEqual([{ id: 'child-session-1', route: { provider: 'deepseek', model: 'deepseek-chat' } }])
})

test('父 options 不完整且角色无覆盖：全链路省略（无 meta/无在途/无持久写）', async () => {
  const active = createActiveRoutes()
  let recordCalls = 0
  const bareParent = { options: {}, session: { id: 'p2' } } as unknown as Agent
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [], fakePersona, {
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
  const run: SubagentRun = {
    id: 'child-err' as unknown as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve<SubagentResult>({ stopReason: 'error', output: [] } as SubagentResult),
    dispose: () => Promise.resolve(),
  } as unknown as SubagentRun
  const tool = createDelegateTool('team_delegate', depsWith(run, [], fakePersona, {
    active,
    recordRoute: async (id) => { recorded.push(id) },
  }))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' })).rejects.toThrow()
  expect(active.get('parent-session-1', 'reviewer')).toBeUndefined()
  expect(recorded).toEqual(['child-err'])
})
