/** 角色 preset 生命周期：名册订阅 → 每角色 agentPresets 组合（persona + 工具白名单）。 */
import type { Context } from '@deepseek-ai/cordis'
import { expect, test, vi } from 'vitest'
import type { AgentRecord } from '../agents/store.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import { registerRolePreset, rolePresetId, setupRolePresets } from './role-preset.ts'

function fakeCtx(globalTools: string[]) {
  const register = vi.fn(async (_definition: unknown) => async () => {})
  const warn = vi.fn()
  const ctx = {
    get: (name: string) => (name === 'agentPresets' ? { register } : undefined),
    tools: { schemas: () => globalTools.map((name) => ({ name })) },
    logger: { warn },
  }
  return { ctx: ctx as unknown as Context, register, warn }
}

const role: AgentRecord = { id: 'explorer', name: 'Explorer', description: '探索', builtin: false, tools: { allow: ['read', 'ghost', 'run_code'] } } as AgentRecord

test('rolePresetId 合法且确定', () => {
  expect(rolePresetId('explorer')).toBe('dsh-agent-toolkit-role-explorer')
  expect(rolePresetId('Explorer A')).toBe('dsh-agent-toolkit-role-explorer-a')
})

test('注册组合：persona 行 + 白名单与全局工具面求交（warn-drop 未知名与 run_code）', async () => {
  const { ctx, register } = fakeCtx(['read', 'write', 'run_code'])
  await registerRolePreset(ctx, role, 'PERSONA')
  expect(register).toHaveBeenCalledOnce()
  const def = register.mock.calls[0]![0] as { id: string; plugins: { name: string; config: unknown }[] }
  expect(def.id).toBe('dsh-agent-toolkit-role-explorer')
  expect(def.plugins).toHaveLength(2)
  expect(def.plugins[0]).toEqual({ id: 'persona', name: 'dsh-agent-toolkit/role-persona', config: { prefix: 'PERSONA' } })
  expect(def.plugins[1]).toEqual({ id: 'tools', name: 'dsh-agent-toolkit/role-tools', config: { allow: ['read'] } })
})

test('role.tools 为 undefined 时只挂 persona 行', async () => {
  const { ctx, register } = fakeCtx(['read'])
  await registerRolePreset(ctx, { ...role, tools: undefined }, 'P')
  const def = register.mock.calls[0]![0] as { plugins: unknown[] }
  expect(def.plugins).toHaveLength(1)
})

test('求交后为空：不挂 tools 行并 warn', async () => {
  const { ctx, register, warn } = fakeCtx(['write'])
  await registerRolePreset(ctx, role, 'P')
  const def = register.mock.calls[0]![0] as { plugins: unknown[] }
  expect(def.plugins).toHaveLength(1)
  expect(warn).toHaveBeenCalled()
})

test('agentPresets 缺席：跳过注册并 warn', async () => {
  const warn = vi.fn()
  const ctx = {
    get: () => undefined,
    tools: { schemas: () => [] },
    logger: { warn },
  } as unknown as Context
  await registerRolePreset(ctx, role, 'P')
  expect(warn).toHaveBeenCalled()
})

test('slug 碰撞（宿主重复 id 抛错）：warn 跳过该角色，sync 不 reject，其余角色正常注册', async () => {
  const registered: string[] = []
  // 镜像宿主 agentPresets.register：重复 preset id 抛错。
  const register = vi.fn(async (definition: { id: string }) => {
    if (registered.includes(definition.id)) throw new Error(`duplicate preset id: ${definition.id}`)
    registered.push(definition.id)
    return async () => {}
  })
  const warn = vi.fn()
  const roles: AgentRecord[] = [
    { id: 'Explorer A', name: 'Explorer A', description: '', builtin: false, tools: undefined } as AgentRecord,
    { id: 'explorer-a', name: 'Explorer A 副本', description: '', builtin: false, tools: undefined } as AgentRecord,
    { id: 'reviewer', name: 'Reviewer', description: '', builtin: false, tools: undefined } as AgentRecord,
  ]
  const listeners: (() => void)[] = []
  const registry = {
    list: () => roles,
    subscribe: (listener: () => void) => { listeners.push(listener); return () => {} },
  } as unknown as AgentRegistry
  const cleanups: (() => void)[] = []
  const ctx = {
    get: (name: string) => (name === 'agentPresets' ? { register } : undefined),
    tools: { schemas: () => [] },
    logger: { warn },
    effect: (fn: () => () => void) => { const cleanup = fn(); cleanups.push(cleanup); return cleanup },
  } as unknown as Context
  setupRolePresets(ctx, registry, () => 'PERSONA')
  // 初始 sync 是异步 fire-and-forget：等一个宏任务排空微任务链后断言。
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(rolePresetId('Explorer A')).toBe(rolePresetId('explorer-a'))
  expect(registered).toEqual([rolePresetId('Explorer A'), rolePresetId('reviewer')])
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('preset 注册失败'))
  expect(listeners).toHaveLength(1)
  // 卸载清理同样不抛：dispose 的拒绝被 catch 到 warn。
  for (const cleanup of cleanups) cleanup()
})
