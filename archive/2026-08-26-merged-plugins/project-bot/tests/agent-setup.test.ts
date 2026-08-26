import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { resolvePresetId, setupAgentScope, type PresetsLike } from '../src/agent-setup.ts'

function fakeAgentCtx() {
  const calls: string[] = []
  const ctx = {
    systemPrompt: { section: (input: { name: string }) => { calls.push(`section:${input.name}`) } },
    tools: { restrict: (input: { allow: readonly string[] }) => { calls.push(`restrict:${input.allow.join(',')}`) } },
  }
  return { ctx: ctx as unknown as Context, calls }
}

function fakePresets(calls: string[], id = 'standard'): PresetsLike {
  return {
    resolve: async () => ({ id }),
    mount: async (_agentCtx, mountId) => { calls.push(`mount:${mountId ?? 'default'}`) },
  }
}

describe('setupAgentScope', () => {
  test('preset 已解析：先 mount 该 preset，再注入 persona 与 tools 白名单', async () => {
    const { ctx, calls } = fakeAgentCtx()
    await setupAgentScope(ctx, fakePresets(calls), 'standard', { persona: '你是评审助手', tools: ['bash'] })
    expect(calls).toEqual(['mount:standard', 'section:project-bot:persona', 'restrict:bash'])
  })

  test('preset 未解析（undefined）：跳过 mount，persona/tools 照常注入', async () => {
    const { ctx, calls } = fakeAgentCtx()
    await setupAgentScope(ctx, fakePresets(calls), undefined, { persona: 'p', tools: ['bash'] })
    expect(calls).toEqual(['section:project-bot:persona', 'restrict:bash'])
  })

  test('无 hooks：只 mount，不注册 section/restrict', async () => {
    const { ctx, calls } = fakeAgentCtx()
    await setupAgentScope(ctx, fakePresets(calls), 'standard', {})
    expect(calls).toEqual(['mount:standard'])
  })
})

describe('resolvePresetId', () => {
  test('缺省：解析名册默认 preset', async () => {
    await expect(resolvePresetId(fakePresets([]), undefined, () => undefined)).resolves.toBe('standard')
  })

  test('Config 指定 agentPreset：按指定 id 解析', async () => {
    const resolved: (string | undefined)[] = []
    const presets: PresetsLike = { resolve: async (id) => { resolved.push(id); return { id: id ?? 'standard' } }, mount: async () => undefined }
    await expect(resolvePresetId(presets, 'team', () => undefined)).resolves.toBe('team')
    expect(resolved).toEqual(['team'])
  })

  test('presets 服务缺失：返回 undefined（不 mount、meta 不带 agentPreset）', async () => {
    await expect(resolvePresetId(undefined, undefined, () => undefined)).resolves.toBeUndefined()
  })

  test('默认/指定 preset 不在名册：warn 告警并降级 undefined（不阻塞创建）', async () => {
    const warn = vi.fn()
    const broken: PresetsLike = {
      resolve: async () => { throw new Error('preset "standard" not found (available: team)') },
      mount: async () => undefined,
    }
    await expect(resolvePresetId(broken, undefined, warn)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toContain('available: team')
  })
})
