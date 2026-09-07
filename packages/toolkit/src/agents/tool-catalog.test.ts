/** 动态名册：standing 面枚举（去 global、减 run_code、排序）；agentPresets 缺席/失败回退常量。*/
import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createToolCatalog } from './tool-catalog.ts'
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'

/** fake ctx：get('agentPresets') 返回注入的 fake；tools.schemas(scope) 按有无 scope 返回两个视图。*/
function fakeCtx(options: {
  presets?: { standingKeyFor(id?: string): Promise<unknown> } | undefined
  globalNames?: string[]
  presetNames?: string[]
}) {
  const warns: string[] = []
  const ctx = {
    get: (name: string) => (name === 'agentPresets' ? options.presets : undefined),
    tools: {
      schemas: (scope?: unknown) =>
        (scope === undefined ? (options.globalNames ?? []) : (options.presetNames ?? []))
          .map((name) => ({ name, description: '', parameters: {} })),
    },
    logger: { warn: (msg: string) => { warns.push(msg) } },
  } as unknown as Context
  return { ctx, warns }
}

describe('createToolCatalog', () => {
  test('preset 集 = standing 面减 global 名集、减 run_code，字典序排序', async () => {
    const { ctx } = fakeCtx({
      presets: { standingKeyFor: async () => ({ agentPreset: 'agent-team' }) },
      globalNames: ['team_delegate', 'run_code'],
      // standing 视图 = global 层 + preset 层（宿主 view() 语义）。
      presetNames: ['web_search', 'team_delegate', 'pwsh', 'todo_write', 'run_code', 'read'],
    })
    const catalog = createToolCatalog(ctx, 'agent-team')
    expect(await catalog.listPresetTools()).toEqual(['pwsh', 'read', 'todo_write', 'web_search'])
  })

  test('agentPresets 缺席（旧宿主）→ 回退 NATIVE_TOOL_NAMES 常量，不 warn', async () => {
    const { ctx, warns } = fakeCtx({ presets: undefined })
    const catalog = createToolCatalog(ctx, 'agent-team')
    expect(await catalog.listPresetTools()).toEqual([...NATIVE_TOOL_NAMES])
    expect(warns).toEqual([])
  })

  test('standingKeyFor 抛错（preset 缺失/broken）→ warn + 回退常量', async () => {
    const { ctx, warns } = fakeCtx({
      presets: { standingKeyFor: async () => { throw new Error('preset "agent-team" not found') } },
    })
    const catalog = createToolCatalog(ctx, 'agent-team')
    expect(await catalog.listPresetTools()).toEqual([...NATIVE_TOOL_NAMES])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('agent-team')
  })

  test('global 集 = 顶层视图减 run_code', () => {
    const { ctx } = fakeCtx({ globalNames: ['team_delegate', 'run_code'] })
    const catalog = createToolCatalog(ctx, 'agent-team')
    expect(catalog.listGlobalTools()).toEqual(['team_delegate'])
  })
})
