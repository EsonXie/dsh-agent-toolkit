import { describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { setupAgentScope } from './agent-setup.ts'
import type { ToolsScope } from './tool-scope.ts'

/** fake agentCtx：记录 section / restrict 调用序列；schemas 返回注入的可见面。 */
function fakeAgentCtx(visibleNames: readonly string[] = ['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep']) {
  const calls: string[] = []
  const warns: string[] = []
  const ctx = {
    systemPrompt: { section: (input: { name: string; order?: number; text?: string }) => { calls.push(`section:${input.name}:${input.order}:${input.text ?? '-'}`) } },
    tools: {
      restrict: (input: { allow?: readonly string[]; deny?: readonly string[] }) => {
        const deny = input.deny !== undefined ? `|deny:${input.deny.join(',')}` : ''
        calls.push(`restrict:${(input.allow ?? []).join(',')}${deny}`)
      },
      schemas: () => visibleNames.map((name) => ({ name, description: '', parameters: {} })),
    },
    logger: { warn: (msg: string) => { warns.push(msg) } },
  }
  return { ctx: ctx as unknown as Context, calls, warns }
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

  test('白名单含不可见工具：warn-drop 后 restrict 有效子集', async () => {
    const { ctx, calls, warns } = fakeAgentCtx(['bash', 'read'])
    await setupAgentScope(ctx, { tools: ['bash', 'web_search', 'read'] }, fakeToolsScope(calls))
    expect(calls).toEqual(['join', 'restrict:bash,read'])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('web_search')
  })

  test('白名单含 run_code：作为不可见名 warn-drop（restrict 拒收保留名）', async () => {
    const { ctx, calls, warns } = fakeAgentCtx(['bash', 'run_code'])
    await setupAgentScope(ctx, { tools: ['bash', 'run_code'] }, fakeToolsScope(calls))
    expect(calls).toEqual(['join', 'restrict:bash'])
    expect(warns[0]).toContain('run_code')
  })

  test('白名单求交后为空：抛错（防静默零工具会话）', async () => {
    const { ctx, calls } = fakeAgentCtx(['bash'])
    await expect(setupAgentScope(ctx, { tools: ['web_search'] }, fakeToolsScope(calls)))
      .rejects.toThrow('求交后为空')
    expect(calls).toEqual(['join']) // 不 restrict
  })

  test('拒绝名单：与可见面求交后以 restrict({deny}) 生效', async () => {
    const { ctx, calls, warns } = fakeAgentCtx(['bash', 'ask_user_question'])
    await setupAgentScope(ctx, { denyTools: ['ask_user_question'] }, fakeToolsScope(calls))
    expect(calls).toEqual(['join', 'restrict:|deny:ask_user_question'])
    expect(warns).toEqual([])
  })

  test('拒绝名单含本会话不可见工具：warn-drop 后不抛错（宿主工具缺席安全）', async () => {
    const { ctx, calls, warns } = fakeAgentCtx(['bash'])
    await setupAgentScope(ctx, { denyTools: ['ask_user_question'] }, fakeToolsScope(calls))
    expect(calls).toEqual(['join'])   // 求交为空 → 不 restrict，绝不向宿主 restrict 抛未知工具
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('ask_user_question')
  })

  test('白名单 + 拒绝名单：单次 restrict({allow, deny})', async () => {
    const { ctx, calls } = fakeAgentCtx(['bash', 'read', 'ask_user_question'])
    await setupAgentScope(ctx, { tools: ['bash', 'read'], denyTools: ['ask_user_question'] }, fakeToolsScope(calls))
    expect(calls).toEqual(['join', 'restrict:bash,read|deny:ask_user_question'])
  })

  test('拒绝名单部分不可见：可见项生效，未知名 warn-drop', async () => {
    const { ctx, calls, warns } = fakeAgentCtx(['bash', 'ask_user_question'])
    await setupAgentScope(ctx, { denyTools: ['ask_user_question', 'ghost_tool'] }, fakeToolsScope(calls))
    expect(calls).toEqual(['join', 'restrict:|deny:ask_user_question'])
    expect(warns[0]).toContain('ghost_tool')
  })
})
