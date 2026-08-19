import { expect, test } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { createDelegateTool, type DelegateToolDeps } from '../src/tool.ts'
import type { Team } from '../src/roles.ts'

const teamAlpha: Team = {
  id: 'alpha',
  roles: [
    { name: 'reviewer', description: '代码审查员', persona: '你是审查员。', provider: 'deepseek', model: 'deepseek-reasoner' },
    { name: 'researcher', description: '资料调研', persona: '你是调研员。' },
  ],
}

const teamBeta: Team = {
  id: 'beta',
  roles: [
    { name: 'writer', description: '文案撰写', persona: '你是写作者。' },
    { name: 'tester', description: '测试设计', persona: '你是测试员。' },
  ],
}

const parent = { id: 'parent-1', options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as Agent
const otherParent = { id: 'parent-2', options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as Agent

function okRun(output: ContentBlock[], disposeError?: Error): SubagentRun {
  return {
    id: 'run-1',
    result: Promise.resolve<SubagentResult>({ stopReason: 'completed', output } as SubagentResult),
    dispose: () => disposeError ? Promise.reject(disposeError) : Promise.resolve(),
  } as unknown as SubagentRun
}

interface Captured { provider: string; request: SubagentStartRequest }

function depsWith(run: SubagentRun, captured: Captured[], currentTeamFor?: (agent: Agent) => Team): DelegateToolDeps {
  return {
    currentTeamFor: currentTeamFor ?? (() => teamAlpha),
    provider: 'spawn',
    startRun: async (provider, request) => { captured.push({ provider, request }); return run },
  }
}

const exec = { agent: parent, signal: new AbortController().signal }

async function callTool(tool: unknown, args: Record<string, unknown>, execArg: unknown = exec) {
  const execute = (tool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute
  return execute(args, execArg)
}

test('成功委派：请求字段正确，返回规范 JSON，run 被 dispose', async () => {
  const captured: Captured[] = []
  let disposed = false
  const run = okRun([{ type: 'text', text: '结论' } as ContentBlock])
  const origDispose = run.dispose
  run.dispose = async () => { disposed = true; return origDispose() }
  const tool = createDelegateTool('team_delegate', depsWith(run, captured))
  const result = await callTool(tool, { role: 'reviewer', description: '审查登录模块', prompt: '请审查 src/auth/' })
  expect(result).toMatchObject({ kind: 'foreground', role: 'reviewer', runId: 'run-1' })
  expect(captured).toHaveLength(1)
  const { provider, request } = captured[0]
  expect(provider).toBe('spawn')
  expect(request.label).toBe('role:reviewer: 审查登录模块')
  expect(request.maxDepth).toBe(1)
  expect(request.persona).toContain('你是审查员。')
  expect(request.persona).toContain('不能再次委派')
  expect(request.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  expect(request.parent).toBe(parent)
  expect(request.signal).toBe(exec.signal)
  expect(disposed).toBe(true)
})

test('角色未配 provider/model 时不传 agentOptions，persona 按主 Agent 模型选模板', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await callTool(tool, { role: 'researcher', description: '调研', prompt: '任务' })
  expect(captured[0].request.agentOptions).toBeUndefined()
  expect(captured[0].request.persona).toContain('先结论，后依据') // parent model deepseek-chat → chat 族
})

test('未知角色报错并列出可用角色，且不发起委派', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await expect(callTool(tool, { role: 'nobody', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/未知角色 "nobody"。可用角色：reviewer, researcher/)
  expect(captured).toHaveLength(0)
})

test('未知角色经 currentTeamFor 取该会话团队校验，报错列出该团队角色名', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  // writer 在 teamBeta，当前会话团队（默认 teamAlpha）没有 → 按 alpha 名册报错
  await expect(callTool(tool, { role: 'writer', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/未知角色 "writer"。可用角色：reviewer, researcher/)
  expect(captured).toHaveLength(0)
})

test('两个不同 agent 按各自当前团队校验并委派', async () => {
  const captured: Captured[] = []
  const currentTeamFor = (agent: Agent): Team => agent === otherParent ? teamBeta : teamAlpha
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured, currentTeamFor))
  await expect(callTool(tool, { role: 'writer', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/reviewer, researcher/)
  await callTool(tool, { role: 'writer', description: 'x', prompt: 'y' }, { agent: otherParent, signal: new AbortController().signal })
  expect(captured).toHaveLength(1)
  expect(captured[0].request.persona).toContain('你是写作者。')
})

test('成员异常终止（max-tokens）报错并附部分产出', async () => {
  const run: SubagentRun = {
    id: 'run-2',
    result: Promise.resolve<SubagentResult>({ stopReason: 'max-tokens', output: [{ type: 'text', text: '半截结论' }] } as SubagentResult),
    dispose: () => Promise.resolve(),
  } as unknown as SubagentRun
  const tool = createDelegateTool('team_delegate', depsWith(run, []))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/半截结论/)
})

test('dispose 失败不掩盖执行结果失败（AggregateError）', async () => {
  const run: SubagentRun = {
    id: 'run-3',
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
  expect(tool.description).not.toContain('writer')
  expect(tool.description).toMatch(/does NOT see this conversation/)  // 成员看不到本对话
  expect(tool.description).toMatch(/self-contained/)                 // 任务须自包含
  expect(tool.description).toMatch(/current session/)                // role 须命中当前会话团队
  expect(tool.description).toMatch(/system prompt/)                  // 可用成员见系统提示团队段
})

test('presentCall 生成「委派 · role: 短标签」卡片，rawInput 为任务书', () => {
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [])) as {
    presentCall: (args: Record<string, unknown>) => unknown
  }
  expect(tool.presentCall({ role: 'reviewer', description: '审查登录模块', prompt: '请审查 src/auth/' }))
    .toEqual({ card: 'generic', title: '委派 · reviewer: 审查登录模块', rawInput: '请审查 src/auth/' })
})

test('presentResult 成功保留 generic 卡，isError 返回 undefined 走默认错误卡', () => {
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [])) as unknown as {
    presentResult: (args: Record<string, unknown>, result: { isError: boolean }) => unknown
  }
  const args = { role: 'reviewer', description: 'x', prompt: 'y' }
  expect(tool.presentResult(args, { isError: false })).toEqual({ card: 'generic' })
  expect(tool.presentResult(args, { isError: true })).toBeUndefined()
})
