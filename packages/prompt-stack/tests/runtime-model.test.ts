import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { type AssembleContext, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply, Config } from '../src/index.ts'

/** 构造只带 options 的最小 agent 替身（assemble 路径只读 agent.options）。 */
function fakeAgent(options: { provider?: string; model?: string }): Agent {
  return { options } as unknown as Agent
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

/**
 * 模拟 dsh model-selection（packages/core/agent/src/model-selection.ts）：
 * agent 创建期在 agent scope 注册 waterfall 监听器，next() 之后把
 * variables.provider/model 覆盖为运行时选择。
 */
function installRuntimeSelection(scope: Scope, selected: { provider: string; model: string }): void {
  scope.ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, _context: AssembleContext, next: () => Promise<PromptAssembly>) => {
    const assembled = await next()
    return {
      ...assembled,
      variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
    }
  })
}

function sectionTexts(sections: Array<{ name: string; text: string }>): Record<string, string> {
  return Object.fromEntries(sections.map(section => [section.name, section.text]))
}

describe('运行时模型匹配（web 会话运行切模型场景）', () => {
  test('运行时选择覆盖创建期 options：规则按运行时模型命中', async () => {
    const ctx = await boot()
    const scope = await mintScope(ctx, 'agent')
    // 创建期 deepseek，运行时切到 claude —— 复刻用户两个会话的场景
    installRuntimeSelection(scope, { provider: 'anthropic', model: 'claude-sonnet-4' })
    const assembly = await ctx.systemPrompt.assemble({
      scope: scopeKeyOf(scope),
      agent: fakeAgent({ provider: 'deepseek', model: 'deepseek-v4' }),
    })
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('CLAUDE-BASE')
    expect(texts['prompt-stack:task']).toBe('TASK')
    // claude 规则无 append；创建期的 deepseek 规则不再生效
    expect(texts['prompt-stack:model-notes']).toBe('')
  })

  test('无运行时选择时回退创建期 options（不回归）', async () => {
    const ctx = await boot()
    const scope = await mintScope(ctx, 'agent')
    const assembly = await ctx.systemPrompt.assemble({
      scope: scopeKeyOf(scope),
      agent: fakeAgent({ provider: 'deepseek', model: 'deepseek-v4' }),
    })
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('BASE')
    expect(texts['prompt-stack:model-notes']).toBe('DS-NOTES')
  })
})
