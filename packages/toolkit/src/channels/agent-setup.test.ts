import { describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { setupAgentScope } from './agent-setup.ts'
import type { ToolsScope } from './tool-scope.ts'

/** fake agentCtx：记录 section / restrict 调用序列。 */
function fakeAgentCtx() {
  const calls: string[] = []
  const ctx = {
    systemPrompt: { section: (input: { name: string; order?: number; text?: string }) => { calls.push(`section:${input.name}:${input.order}:${input.text ?? '-'}`) } },
    tools: { restrict: (input: { allow: readonly string[] }) => { calls.push(`restrict:${input.allow.join(',')}`) } },
  }
  return { ctx: ctx as unknown as Context, calls }
}

/** fake standing scope：join 记入同一 calls 序列，断言其先于 restrict。 */
function fakeToolsScope(calls: string[]) {
  const toolsScope: ToolsScope = {
    join: async () => {
      calls.push('join')
      return { fake: 'standing' }
    },
    dispose: async () => undefined,
  }
  return toolsScope
}

describe('setupAgentScope', () => {
  test('先 join standing scope（工具成为继承面），再注入 persona 与 tools 白名单', async () => {
    const { ctx, calls } = fakeAgentCtx()
    await setupAgentScope(ctx, { persona: '你是评审助手', tools: ['bash'] }, fakeToolsScope(calls))
    expect(calls).toEqual(['join', 'section:prompt-stack:persona:10:你是评审助手', 'restrict:bash'])
  })

  test('无 hooks：只 join，不注册 section/restrict', async () => {
    const { ctx, calls } = fakeAgentCtx()
    await setupAgentScope(ctx, {}, fakeToolsScope(calls))
    expect(calls).toEqual(['join'])
  })

  test('只带 persona：join + 注册 persona 段，不 restrict', async () => {
    const { ctx, calls } = fakeAgentCtx()
    await setupAgentScope(ctx, { persona: 'p' }, fakeToolsScope(calls))
    expect(calls.at(-1)).toBe('section:prompt-stack:persona:10:p')
    expect(calls).not.toContain('restrict:')
  })

  test('hooks.sections：逐层注册 systemPrompt.section（按 name/order/text）', async () => {
    const { ctx, calls } = fakeAgentCtx()
    await setupAgentScope(ctx, {
      sections: [
        { name: 'dsh-agent-toolkit:agent:base', order: 10, text: '你是团队的评审成员。' },
        { name: 'dsh-agent-toolkit:agent:skill', order: 30, text: '只审查 diff，不修改代码。' },
      ],
    }, fakeToolsScope(calls))
    expect(calls).toEqual([
      'join',
      'section:dsh-agent-toolkit:agent:base:10:你是团队的评审成员。',
      'section:dsh-agent-toolkit:agent:skill:30:只审查 diff，不修改代码。',
    ])
  })

  test('sections + tools 组合（角色绑定形态）：逐层 section 后 restrict', async () => {
    const { ctx, calls } = fakeAgentCtx()
    await setupAgentScope(ctx, {
      sections: [{ name: 'dsh-agent-toolkit:agent:base', order: 10, text: 'b' }],
      tools: ['bash'],
    }, fakeToolsScope(calls))
    expect(calls).toEqual(['join', 'section:dsh-agent-toolkit:agent:base:10:b', 'restrict:bash'])
  })
})
