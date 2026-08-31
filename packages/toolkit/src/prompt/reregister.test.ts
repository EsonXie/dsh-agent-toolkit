import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { type AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { setupPrompt, type LayerView } from './index.ts'
import type { LayerConfig } from './types.ts'

/** 可变层源：get 返回当前层；setLayers 换层并通知（模拟 LayerSource 的 set+notify）。 */
function mutableSource(initial: LayerConfig[]) {
  let layers = initial
  const listeners = new Set<() => void>()
  return {
    get: () => layers,
    getIdentity: () => '',
    setLayers: (next: LayerConfig[]) => { layers = next; for (const l of [...listeners]) l() },
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
}

function agentContext(model: string): AssembleContext {
  return { agent: { options: { provider: 'deepseek', model }, session: { id: 's1' } } as unknown as Agent }
}

async function boot(source: LayerView): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' })
  setupPrompt(ctx, { source, rules: [] })
  return ctx
}

function names(sections: Array<{ name: string }>): string[] {
  return sections.map(s => s.name)
}

describe('setupPrompt 层重注册', () => {
  test('层变更后新组装使用新层（新增层出现、被删层消失）', async () => {
    const source = mutableSource([{ name: 'persona', order: 10, text: 'P' }])
    const ctx = await boot(source)

    expect(names((await ctx.systemPrompt.assemble()).sections)).toContain('prompt-stack:persona')

    source.setLayers([
      { name: 'persona', order: 10, text: 'P' },
      { name: 'task', order: 50, text: 'T' },
    ])
    const afterAdd = names((await ctx.systemPrompt.assemble()).sections)
    expect(afterAdd).toContain('prompt-stack:task')

    source.setLayers([{ name: 'persona', order: 10, text: 'P' }])
    const afterRemove = names((await ctx.systemPrompt.assemble()).sections)
    expect(afterRemove).not.toContain('prompt-stack:task')
    // base 是内置固定段：层集如何变化都恒在场
    expect(afterRemove).toContain('prompt-stack:base')
  })

  test('model-notes 的 order 随最大层 order 重算，始终排在层之后', async () => {
    const source = mutableSource([{ name: 'persona', order: 10, text: 'P' }])
    const ctx = await boot(source)

    source.setLayers([
      { name: 'persona', order: 10, text: 'P' },
      { name: 'task', order: 100, text: 'T' },
    ])
    const sections = (await ctx.systemPrompt.assemble()).sections
    const sectionNames = names(sections)
    expect(sectionNames.indexOf('prompt-stack:model-notes')).toBeGreaterThan(sectionNames.indexOf('prompt-stack:task'))
  })
})
