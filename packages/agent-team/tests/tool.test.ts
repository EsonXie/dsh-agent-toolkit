import { expect, test } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { Role } from '../src/roles.ts'
import { createDelegateTool, type DelegateToolDeps } from '../src/tool.ts'

const ROSTER: Role[] = [
  { name: 'reviewer', description: '代码审查员', persona: '你是审查员。', provider: 'deepseek', model: 'deepseek-reasoner' },
  { name: 'scout', description: '只读探索', persona: '你是探索员。', tools: { deny: ['write', 'edit'] } },
  { name: 'worker', description: '通用执行', persona: '你是执行员。' },
]

const parent = { options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as Agent

function okRun(output: ContentBlock[], disposeError?: Error): SubagentRun {
  return {
    id: 'child-session-1' as unknown as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve<SubagentResult>({ stopReason: 'completed', output } as SubagentResult),
    dispose: () => disposeError ? Promise.reject(disposeError) : Promise.resolve(),
  } as unknown as SubagentRun
}

interface Captured { provider: string; request: SubagentStartRequest }

function depsWith(run: SubagentRun, captured: Captured[]): DelegateToolDeps {
  return {
    roster: () => ROSTER,
    provider: 'spawn',
    startRun: async (provider, request) => { captured.push({ provider, request }); return run },
  }
}

const exec = { agent: parent, signal: new AbortController().signal }

async function callTool(tool: unknown, args: Record<string, unknown>, execArg: unknown = exec) {
  const execute = (tool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute
  return execute(args, execArg)
}

test('成功委派：请求字段正确，返回规范 JSON 含 childSessionId，run 被 dispose', async () => {
  const captured: Captured[] = []
  let disposed = false
  const run = okRun([{ type: 'text', text: '结论' } as ContentBlock])
  const origDispose = run.dispose
  run.dispose = async () => { disposed = true; return origDispose() }
  const tool = createDelegateTool('team_delegate', depsWith(run, captured))
  const result = await callTool(tool, { role: 'reviewer', description: '审查登录模块', prompt: '请审查 src/auth/' })
  expect(result).toMatchObject({
    kind: 'foreground', role: 'reviewer', runId: 'child-session-1', childSessionId: 'child-session-1',
  })
  expect(captured).toHaveLength(1)
  const { provider, request } = captured[0]
  expect(provider).toBe('spawn')
  expect(request.label).toBe('role:reviewer: 审查登录模块')
  expect(request.maxDepth).toBe(1)
  expect(request.persona).toContain('你是审查员。')
  expect(request.persona).toContain('不能再次委派')
  expect(request.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  expect(request.toolFilter).toBeUndefined()
  expect(request.parent).toBe(parent)
  expect(request.signal).toBe(exec.signal)
  expect(disposed).toBe(true)
})

test('角色配了 tools：透传为 toolFilter（数组拷贝，不共享引用）', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await callTool(tool, { role: 'scout', description: '探索', prompt: '任务' })
  expect(captured[0].request.toolFilter).toEqual({ deny: ['write', 'edit'] })
  expect(captured[0].request.toolFilter?.deny).not.toBe(ROSTER[1].tools?.deny)
})

test('角色未配 provider/model 时不传 agentOptions', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await callTool(tool, { role: 'worker', description: '执行', prompt: '任务' })
  expect(captured[0].request.agentOptions).toBeUndefined()
})

test('未知角色报错并列出可用角色，且不发起委派', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await expect(callTool(tool, { role: 'nobody', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/未知角色 "nobody"。可用角色：reviewer, scout, worker/)
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
  expect(tool.presentResult({ role: 'reviewer' }, { isError: false })).toEqual({ card: 'generic' })
  expect(tool.presentResult({ role: 'reviewer' }, { isError: true })).toBeUndefined()
  expect(tool.output.presentationMeta({}, {
    kind: 'foreground', role: 'reviewer', runId: 'r1', childSessionId: 'c1', output: [{ type: 'text', text: 'x' }],
  })).toEqual({ role: 'reviewer', runId: 'r1', childSessionId: 'c1' })
})
