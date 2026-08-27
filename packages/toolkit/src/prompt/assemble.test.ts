import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt, type AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { setupPrompt, type LayerView } from './index.ts'
import type { Config as ConfigT } from './types.ts'

/** 构造最小 agent 替身（assemble 路径读 agent.options；钉住缓存读 agent.session.id）。 */
function agentContext(options: { provider?: string; model?: string }): AssembleContext {
  return { agent: { options, session: { id: 'test-session' } } as unknown as Agent }
}

const CONFIG: ConfigT = {
  layers: [
    { name: 'base', order: 0, text: 'BASE' },
    { name: 'task', order: 50, text: 'TASK' },
  ],
  rules: [
    { match: { modelPattern: 'claude*' }, overrides: { base: 'CLAUDE-BASE' } },
    { match: { provider: 'deepseek', model: 'deepseek-v4' }, overrides: { task: 'V4-TASK' }, append: 'V4-NOTES' },
  ],
}

function fakeSource(layers: ConfigT['layers']): LayerView {
  return { get: () => layers, subscribe: () => () => {} }
}

async function boot(config: ConfigT = CONFIG): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' })
  setupPrompt(ctx, { source: fakeSource(config.layers), rules: config.rules })
  return ctx
}

function sectionTexts(sections: Array<{ name: string; text: string }>): Record<string, string> {
  return Object.fromEntries(sections.map(section => [section.name, section.text]))
}

describe('prompt-stack 组装', () => {
  test('裸组装（无 agent）：全部默认文本，model-notes 不渲染', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble()
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('BASE')
    expect(texts['prompt-stack:task']).toBe('TASK')
    expect(texts['prompt-stack:model-notes']).toBe('')
    // 空段在渲染期被丢弃
    expect(renderPrompt(assembly)).not.toContain('model-notes')
  })

  test('命中规则：覆盖层替换、未覆盖层保持默认、append 进 model-notes 且排在最后', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble(agentContext({ provider: 'deepseek', model: 'deepseek-v4' }))
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('BASE')
    expect(texts['prompt-stack:task']).toBe('V4-TASK')
    expect(texts['prompt-stack:model-notes']).toBe('V4-NOTES')
    // model-notes order = 最大层 order(50) + 1 = 51，排在 prompt-stack 各层最后
    const names = assembly.sections.map(section => section.name)
    expect(names.indexOf('prompt-stack:model-notes')).toBeGreaterThan(names.indexOf('prompt-stack:task'))
  })

  test('通配命中另一规则：只替换被覆盖层', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble(agentContext({ model: 'claude-sonnet-4' }))
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('CLAUDE-BASE')
    expect(texts['prompt-stack:task']).toBe('TASK')
    expect(texts['prompt-stack:model-notes']).toBe('')
  })

  test('宿主提供的 model/provider 变量可插值（agent-loop 原生注册，插件不重复注册）', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    // 模拟宿主 agent-loop 的注册（agent-loop/src/index.ts:351-352），prompt-stack 不再自注册。
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    setupPrompt(ctx, { source: fakeSource([{ name: 'who', order: 0, text: 'model={{model}} provider={{provider}}' }]), rules: [] })
    const assembly = await ctx.systemPrompt.assemble(agentContext({ provider: 'deepseek', model: 'deepseek-v4' }))
    expect(renderPrompt(assembly)).toContain('model=deepseek-v4 provider=deepseek')
  })

  test('宿主已注册 model/provider 变量时 apply 不因重名抛错（回归）', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    expect(() => setupPrompt(ctx, { source: fakeSource([{ name: 'base', order: 0, text: 'B' }]), rules: [] })).not.toThrow()
  })

  test('Config 校验失败在 apply 期响亮抛错', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    expect(() => setupPrompt(ctx, { source: fakeSource([]), rules: [] })).toThrow(/at least one layer/)
  })

  test('子 Agent（origin=subagent）：人设/任务层渲染空串，model-notes 按子的模型照常命中', async () => {
    const ctx = await boot()
    const childContext = {
      agent: {
        options: { provider: 'deepseek', model: 'deepseek-v4' },
        session: { header: { origin: 'subagent' } },
      } as unknown as Agent,
    }
    const assembly = await ctx.systemPrompt.assemble(childContext)
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('')
    expect(texts['prompt-stack:task']).toBe('')          // 规则命中的覆盖层同样隔离
    expect(texts['prompt-stack:model-notes']).toBe('V4-NOTES') // 模型层共用：按子模型命中
    expect(renderPrompt(assembly)).not.toContain('BASE')
    expect(renderPrompt(assembly)).toContain('V4-NOTES')
  })

  test('非子 Agent（origin 缺省）：分层与规则照常生效', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble(agentContext({ provider: 'deepseek', model: 'deepseek-v4' }))
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:task']).toBe('V4-TASK')
  })
})
