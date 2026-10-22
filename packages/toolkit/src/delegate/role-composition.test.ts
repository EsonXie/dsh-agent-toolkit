/** 角色组合：子 Agent 继承父 preset，再在子 scope 叠加 persona 与工具白名单。 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AgentRecord } from '../agents/store.ts'
import { applyRoleComposition, delegatedRoleId, roleIdFromLabel } from './role-composition.ts'

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] },
    execute: () => Promise.resolve(name),
  }
}

function fakeAgent(ctx: Context, label: string | undefined): Agent {
  return {
    ctx,
    session: {
      snapshotEvents: () => label === undefined
        ? []
        : [{ type: 'subagent/descriptor', data: { label } }],
    },
  } as unknown as Agent
}

async function setup(label: string | undefined, allowedTools: string[]) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  let parent!: ReturnType<typeof createScope>
  await ctx.plugin(Object.assign((inner: Context) => {
    parent = createScope(inner, { agent: 'parent' })
  }, { inject: ['tools', 'systemPrompt'] }))
  for (const name of allowedTools) parent.ctx.tools.register(fakeTool(name))
  let child!: ReturnType<typeof createScope>
  await parent.ctx.plugin(Object.assign((inner: Context) => {
    child = createScope(inner, { agent: 'child' }, { parent: scopeOf(parent.ctx)! })
  }, { inject: ['tools', 'systemPrompt'] }))
  const agent = fakeAgent(child.ctx, label)
  return { ctx, parent, child, agent, scope: scopeOf(child.ctx)! }
}

test('roleIdFromLabel：只接受本工具的角色标签', () => {
  expect(roleIdFromLabel('role:general: 执行任务')).toBe('general')
  expect(roleIdFromLabel('subagent task')).toBeUndefined()
})

test('delegatedRoleId：读最后一个 subagent descriptor 的 label', () => {
  expect(delegatedRoleId([
    { type: 'subagent/descriptor', data: { label: 'role:old: x' } },
    { type: 'other', data: {} },
    { type: 'subagent/descriptor', data: { label: 'role:new: y' } },
  ])).toBe('new')
  expect(delegatedRoleId([{ type: 'subagent/descriptor', data: {} }])).toBeUndefined()
})

test('applyRoleComposition：子 scope 注入 persona 并把继承面收窄到白名单', async () => {
  const { ctx, parent, child, agent, scope } = await setup('role:general: 执行', ['read', 'write', 'edit'])
  const warn = vi.fn()
  applyRoleComposition(agent, {
    getRole: () => ({ id: 'general', name: 'General', tools: { allow: ['read', 'ghost', 'run_code'] } } as AgentRecord),
    buildPersona: () => 'GENERAL PERSONA',
    warn,
  })
  expect(ctx.tools.schemas(scope).map(t => t.name)).toEqual(['read'])
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('ghost'))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('run_code'))
  const assembly = await ctx.systemPrompt.assemble({ scope })
  expect(assembly.sections.find(s => s.name === 'deployment:persona-prefix')?.text).toBe('GENERAL PERSONA')
  await child.dispose()
  await parent.dispose()
  await ctx.fiber.dispose()
})

test('applyRoleComposition：role.tools 未配置时不收窄工具面', async () => {
  const { ctx, parent, child, agent, scope } = await setup('role:worker: 执行', ['read', 'write'])
  applyRoleComposition(agent, {
    getRole: () => ({ id: 'worker', name: 'Worker' } as AgentRecord),
    buildPersona: () => 'WORKER',
    warn: () => {},
  })
  expect(ctx.tools.schemas(scope).map(t => t.name).sort()).toEqual(['read', 'write'])
  await child.dispose()
  await parent.dispose()
  await ctx.fiber.dispose()
})

test('applyRoleComposition：白名单求交为空时拒绝所有继承工具（fail-closed）', async () => {
  const { ctx, parent, child, agent, scope } = await setup('role:general: 执行', ['read', 'write'])
  const warn = vi.fn()
  applyRoleComposition(agent, {
    getRole: () => ({ id: 'general', name: 'General', tools: { allow: ['ghost'] } } as AgentRecord),
    buildPersona: () => 'GENERAL',
    warn,
  })
  expect(ctx.tools.schemas(scope)).toEqual([])
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('ghost'))
  await child.dispose()
  await parent.dispose()
  await ctx.fiber.dispose()
})

test('applyRoleComposition：非本工具创建的 Agent / 已删除角色不施加组合', async () => {
  const { ctx, parent, child, agent, scope } = await setup('plain subagent', ['read'])
  const warn = vi.fn()
  applyRoleComposition(agent, {
    getRole: () => ({ id: 'ghost', name: 'Ghost' } as AgentRecord),
    buildPersona: () => 'GHOST',
    warn,
  })
  expect(ctx.tools.schemas(scope).map(t => t.name)).toEqual(['read'])
  expect((await ctx.systemPrompt.assemble({ scope })).sections
    .find(s => s.name === 'deployment:persona-prefix')?.text).not.toBe('GHOST')

  const deleted = fakeAgent(child.ctx, 'role:deleted: x')
  applyRoleComposition(deleted, { getRole: () => undefined, buildPersona: () => 'X', warn })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('deleted'))
  await child.dispose()
  await parent.dispose()
  await ctx.fiber.dispose()
})

/** 真实 registry 守护：父 preset 的工具经 composeFrom 进入子 scope，再由角色 restrict 收窄。 */
test('真实 preset 组合：子级继承父 preset 工具后按角色白名单收窄', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-role-composition-'))
  await mkdir(join(tempDir, 'plugins'))
  await writeFile(join(tempDir, 'plugins', 'contribute.mjs'), `
export const name = 'contribute'
export const inject = ['tools']
export function apply(ctx, config) {
  for (const tool of config.tools) {
    ctx.effect(() => ctx.tools.register({
      name: tool,
      description: 'fixture ' + tool,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: () => Promise.resolve(tool),
    }))
  }
}
`, 'utf8')

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(tempDir).href + '/'
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentPresets, { default: 'base' })
    await ctx.agentPresets.register({
      id: 'base',
      plugins: [{
        name: pathToFileURL(join(tempDir, 'plugins', 'contribute.mjs')).href,
        config: { tools: ['read', 'write', 'team_delegate'] },
      }],
    })

    let parent!: ReturnType<typeof createScope>
    await ctx.plugin(Object.assign((inner: Context) => {
      parent = createScope(inner, { agent: 'parent' })
    }, { inject: ['tools', 'systemPrompt'] }))
    await ctx.agentPresets.mount(parent.ctx, 'base')

    let child!: ReturnType<typeof createScope>
    await parent.ctx.plugin(Object.assign((inner: Context) => {
      child = createScope(inner, { agent: 'child' })
    }, { inject: ['tools', 'systemPrompt'] }))
    expect(ctx.agentPresets.composeFrom(child.ctx, parent.ctx)).toBe('base')
    expect(ctx.tools.schemas(scopeOf(child.ctx)!).map(t => t.name).sort()).toEqual(['read', 'team_delegate', 'write'])

    applyRoleComposition(fakeAgent(child.ctx, 'role:general: 执行'), {
      getRole: () => ({ id: 'general', name: 'General', tools: { allow: ['read'] } } as AgentRecord),
      buildPersona: () => 'GENERAL',
      warn: () => {},
    })
    expect(ctx.tools.schemas(scopeOf(child.ctx)!).map(t => t.name)).toEqual(['read'])
  } finally {
    await ctx.fiber.dispose()
    await rm(tempDir, { recursive: true, force: true })
  }
})