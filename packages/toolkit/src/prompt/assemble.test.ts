import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt, type AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { setupPrompt, type LayerView } from './index.ts'
import { BASE_TEXT } from './defaults.ts'
import type { Config as ConfigT } from './types.ts'

function agentContext(options: { provider?: string; model?: string }): AssembleContext {
  return { agent: { options, session: { id: 'test-session' } } as unknown as Agent }
}

/** 照 runtime-model.test.ts：铸造 agent 级 scope（scoped shadow 测试用）。 */
async function mintScope(ctx: Context, name: string): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { name }) },
    { inject: ['systemPrompt'] }))
  return scope
}

const CONFIG: ConfigT = {
  layers: [{ name: 'persona', order: 10, text: 'PERSONA' }],
  rules: [
    { match: { modelPattern: 'claude*' }, overrides: { base: 'CLAUDE-BASE' } },
    { match: { provider: 'deepseek', model: 'deepseek-v4' }, append: 'V4-NOTES' },
  ],
}

function fakeSource(layers: ConfigT['layers'], identity = ''): LayerView {
  return { get: () => layers, getIdentity: () => identity, subscribe: () => () => {} }
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

describe('prompt 组装（模型层 + persona 普通段）', () => {
  test('裸组装（无 agent）：模型层为内置 BASE_TEXT，model-notes 不渲染', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble()
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe(BASE_TEXT)
    expect(texts['prompt-stack:persona']).toBe('PERSONA')
    expect(texts['prompt-stack:model-notes']).toBe('')
    expect(renderPrompt(assembly)).not.toContain('model-notes')
  })

  test('渲染顺序：模型层（order 0）在 persona（order 10）之前，notes 最后', async () => {
    const ctx = await boot()
    const names = (await ctx.systemPrompt.assemble()).sections.map(s => s.name)
    expect(names.indexOf('prompt-stack:base')).toBeLessThan(names.indexOf('prompt-stack:persona'))
    expect(names.indexOf('prompt-stack:model-notes')).toBeGreaterThan(names.indexOf('prompt-stack:persona'))
  })

  test('命中规则：模型层整体覆盖、persona 保持存储文本、append 进 model-notes', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble(agentContext({ provider: 'deepseek', model: 'deepseek-v4' }))
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe(BASE_TEXT)   // deepseek 规则以 append，不覆盖 base
    expect(texts['prompt-stack:persona']).toBe('PERSONA')
    expect(texts['prompt-stack:model-notes']).toBe('V4-NOTES')
  })

  test('通配命中 claude：模型层替换为 CLAUDE-BASE', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble(agentContext({ model: 'claude-sonnet-4' }))
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('CLAUDE-BASE')
    expect(texts['prompt-stack:model-notes']).toBe('')
  })

  test('persona 默认空串时段被丢弃（行为零变化）', async () => {
    const ctx = await boot({ ...CONFIG, layers: [{ name: 'persona', order: 10, text: '' }] })
    const assembly = await ctx.systemPrompt.assemble(agentContext({}))
    expect(sectionTexts(assembly.sections)['prompt-stack:persona']).toBe('')
    expect(renderPrompt(assembly)).not.toContain('persona')
  })

  test('宿主变量插值与重名不抛错（回归，同原语义）', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    setupPrompt(ctx, { source: fakeSource([{ name: 'who', order: 10, text: 'model={{model}} provider={{provider}}' }]), rules: [] })
    const assembly = await ctx.systemPrompt.assemble(agentContext({ provider: 'deepseek', model: 'deepseek-v4' }))
    expect(renderPrompt(assembly)).toContain('model=deepseek-v4 provider=deepseek')
  })

  test('Config 校验失败在 apply 期响亮抛错', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    expect(() => setupPrompt(ctx, { source: fakeSource([]), rules: [] })).toThrow(/at least one layer/)
  })

  test('子 Agent（origin=subagent）：模型层与 persona 渲染空串，model-notes 按子的模型照常命中', async () => {
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
    expect(texts['prompt-stack:persona']).toBe('')
    expect(texts['prompt-stack:model-notes']).toBe('V4-NOTES')
    expect(renderPrompt(assembly)).not.toContain(BASE_TEXT.slice(0, 40))
    expect(renderPrompt(assembly)).toContain('V4-NOTES')
  })
})

describe('deployment:persona 槽位还原生', () => {
  test('toolkit 不改写槽位：cordis.yml 的 systemPrompt.persona 原样渲染', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: 'NATIVE-PERSONA' })
    setupPrompt(ctx, { source: fakeSource(CONFIG.layers), rules: CONFIG.rules })
    const assembly = await ctx.systemPrompt.assemble(agentContext({}))
    const texts = sectionTexts(assembly.sections)
    expect(texts['deployment:persona']).toBe('NATIVE-PERSONA')
    // UI persona 层走自己的普通段，与槽位互不影响
    expect(texts['prompt-stack:persona']).toBe('PERSONA')
  })

  test('bot 角色 scoped 同名段 shadow 全局 persona 段', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    setupPrompt(ctx, { source: fakeSource(CONFIG.layers), rules: CONFIG.rules })
    // scoped shadow 是 agent scope 机制：根 ctx 全局重名注册会抛错，必须走 scope。
    const scope = await mintScope(ctx, 'agent')
    scope.ctx.systemPrompt.section({ name: 'prompt-stack:persona', order: 10, text: 'ROLE-PERSONA' })
    const assembly = await ctx.systemPrompt.assemble({ ...agentContext({}), scope: scopeOf(scope.ctx)! })
    expect(sectionTexts(assembly.sections)['prompt-stack:persona']).toBe('ROLE-PERSONA')
  })
})

describe('identity 段覆盖（可编辑，空 = 还原原生）', () => {
  const NATIVE = 'You are an AI agent powered by DeepSeek Harness.'

  test('空覆盖：原生句原样渲染', async () => {
    const ctx = await boot()
    const texts = sectionTexts((await ctx.systemPrompt.assemble(agentContext({}))).sections)
    expect(texts['harness:identity']).toBe(NATIVE)
  })

  test('非空覆盖：整份替换原生句（主 Agent）', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    setupPrompt(ctx, { source: fakeSource(CONFIG.layers, 'MY-IDENTITY'), rules: CONFIG.rules })
    const texts = sectionTexts((await ctx.systemPrompt.assemble(agentContext({}))).sections)
    expect(texts['harness:identity']).toBe('MY-IDENTITY')
  })

  test('子 Agent（origin=subagent）：跳过覆盖，原生句原样渲染', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    setupPrompt(ctx, { source: fakeSource(CONFIG.layers, 'MY-IDENTITY'), rules: CONFIG.rules })
    const childContext = {
      agent: {
        options: {},
        session: { id: 'child', header: { origin: 'subagent' } },
      } as unknown as Agent,
    }
    const texts = sectionTexts((await ctx.systemPrompt.assemble(childContext)).sections)
    expect(texts['harness:identity']).toBe(NATIVE)
  })

  test('scoped shadow（段文本 ≠ 原生常量）不被覆盖改写', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    setupPrompt(ctx, { source: fakeSource(CONFIG.layers, 'MY-IDENTITY'), rules: CONFIG.rules })
    const scope = await mintScope(ctx, 'agent')
    scope.ctx.systemPrompt.section({ name: 'harness:identity', order: -100, text: 'SCOPED-IDENTITY' })
    const assembly = await ctx.systemPrompt.assemble({ ...agentContext({}), scope: scopeOf(scope.ctx)! })
    expect(sectionTexts(assembly.sections)['harness:identity']).toBe('SCOPED-IDENTITY')
  })
})
