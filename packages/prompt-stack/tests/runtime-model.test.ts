import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { type AssembleContext, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply, Config } from '../src/index.ts'

/** 构造最小 agent 替身：options（创建期模型）+ 可变 session（钉住缓存按 session.id 失效）。 */
function fakeAgent(options: { provider?: string; model?: string }, session: { id: string } = { id: 's1' }): Agent {
  return { options, session } as unknown as Agent
}

const CONFIG = {
  layers: [
    { name: 'base', order: 0, text: 'BASE' },
    { name: 'task', order: 50, text: 'TASK' },
  ],
  rules: [
    { match: { modelPattern: 'claude*' }, overrides: { base: 'CLAUDE-BASE' } },
    { match: { modelPattern: 'deepseek*' }, append: 'DS-NOTES' },
  ],
}

/** 挂 SystemPrompt + 宿主变量（照 agent-loop）+ prompt-stack。 */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' })
  ctx.systemPrompt.variable('model', context => context.agent?.options?.model)
  ctx.systemPrompt.variable('provider', context => context.agent?.options?.provider)
  apply(ctx, Config(CONFIG))
  return ctx
}

/** 照 system-prompt scoped.spec.ts 的方式铸造一个 agent 级 scope。 */
async function mintScope(ctx: Context, name: string): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { name }) },
    { inject: ['systemPrompt'] }))
  return scope
}

function scopeKeyOf(scope: Scope): ScopeKey {
  return scopeOf(scope.ctx)!
}

/** 可变运行时选择（照 dsh ModelSelectionRef：current 随后续选择改变）。 */
interface MutableSelection { current: { provider: string; model: string } | undefined }

/**
 * 模拟 dsh model-selection（packages/core/agent/src/model-selection.ts）：
 * agent 创建期在 agent scope 注册 waterfall 监听器，next() 之后把
 * variables.provider/model 覆盖为当前运行时选择。
 */
function installRuntimeSelection(scope: Scope, selection: MutableSelection): void {
  scope.ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, _context: AssembleContext, next: () => Promise<PromptAssembly>) => {
    const assembled = await next()
    const selected = selection.current
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
    }
  })
}

function sectionTexts(sections: Array<{ name: string; text: string }>): Record<string, string> {
  return Object.fromEntries(sections.map(section => [section.name, section.text]))
}

describe('运行时模型匹配（web 会话选模型场景）', () => {
  test('首条消息按当次选择的模型解析（覆盖创建期 options）', async () => {
    const ctx = await boot()
    const scope = await mintScope(ctx, 'agent')
    const selection: MutableSelection = { current: { provider: 'anthropic', model: 'claude-sonnet-4' } }
    installRuntimeSelection(scope, selection)
    // 创建期 deepseek（全局默认），发首条消息前选了 claude —— 复刻用户场景
    const assembly = await ctx.systemPrompt.assemble({
      scope: scopeKeyOf(scope),
      agent: fakeAgent({ provider: 'deepseek', model: 'deepseek-v4' }),
    })
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('CLAUDE-BASE')
    expect(texts['prompt-stack:task']).toBe('TASK')
    // claude 规则无 append；创建期的 deepseek 规则不生效
    expect(texts['prompt-stack:model-notes']).toBe('')
  })

  test('首条消息后钉住：会话中途切模型不再改系统提示词', async () => {
    const ctx = await boot()
    const scope = await mintScope(ctx, 'agent')
    const selection: MutableSelection = { current: { provider: 'anthropic', model: 'claude-sonnet-4' } }
    installRuntimeSelection(scope, selection)
    const agent = fakeAgent({ provider: 'deepseek', model: 'deepseek-v4' })
    const first = sectionTexts((await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope), agent })).sections)
    expect(first['prompt-stack:base']).toBe('CLAUDE-BASE')
    // 会话中途切到 deepseek —— 系统提示词保持首条消息时的解析结果
    selection.current = { provider: 'deepseek', model: 'deepseek-v4' }
    const second = sectionTexts((await ctx.systemPrompt.assemble({ scope: scopeKeyOf(scope), agent })).sections)
    expect(second['prompt-stack:base']).toBe('CLAUDE-BASE')
    expect(second['prompt-stack:model-notes']).toBe('')
  })

  test('新会话（session id 变化）重新解析', async () => {
    const ctx = await boot()
    const scope = await mintScope(ctx, 'agent')
    const selection: MutableSelection = { current: { provider: 'anthropic', model: 'claude-sonnet-4' } }
    installRuntimeSelection(scope, selection)
    const key = scopeKeyOf(scope)
    // 同一 agent（blank 会话复用），session id 变化代表 clear/新会话
    const session = { id: 's1' }
    const agent = fakeAgent({ provider: 'deepseek', model: 'deepseek-v4' }, session)
    const first = sectionTexts((await ctx.systemPrompt.assemble({ scope: key, agent })).sections)
    expect(first['prompt-stack:base']).toBe('CLAUDE-BASE')
    // clear/新会话：session id 变了，按新的当前选择重新解析
    selection.current = { provider: 'deepseek', model: 'deepseek-v4' }
    session.id = 's2'
    const second = sectionTexts((await ctx.systemPrompt.assemble({ scope: key, agent })).sections)
    expect(second['prompt-stack:base']).toBe('BASE')
    expect(second['prompt-stack:model-notes']).toBe('DS-NOTES')
  })

  test('无运行时选择时回退创建期 options（不回归）', async () => {
    const ctx = await boot()
    const scope = await mintScope(ctx, 'agent')
    const selection: MutableSelection = { current: undefined }
    installRuntimeSelection(scope, selection)
    const assembly = await ctx.systemPrompt.assemble({
      scope: scopeKeyOf(scope),
      agent: fakeAgent({ provider: 'deepseek', model: 'deepseek-v4' }),
    })
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('BASE')
    expect(texts['prompt-stack:model-notes']).toBe('DS-NOTES')
  })
})
