import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../src/index.ts'

interface RegisteredTool { name: string; description: string }
type Disposer = () => void | Promise<void>
type ProviderCaps = { outputSchema: boolean; depthLimit: boolean; toolFilter: boolean; persona: boolean }
const FULL_CAPS: ProviderCaps = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
type FakeCtxOptions = {
  providerCapabilities?: Partial<ProviderCaps>
  providerAbsent?: boolean
}

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-team-home-'))
  vi.stubEnv('DSH_HOME', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

function fakeCtx(opts: FakeCtxOptions = {}) {
  const tools: RegisteredTool[] = []
  const activeTools = new Map<string, RegisteredTool>()
  const sections: { name: string; order: number; text: unknown }[] = []
  const disposers: Disposer[] = []
  const listeners: { event: string; cb: (payload: unknown) => void }[] = []
  const errors: string[] = []
  const infos: string[] = []
  const ctx = {
    tools: {
      register: (tool: RegisteredTool) => {
        tools.push(tool)
        activeTools.set(tool.name, tool)
        const disposer: Disposer = () => { activeTools.delete(tool.name) }
        disposers.push(disposer)
        return disposer
      },
    },
    systemPrompt: {
      section: (s: { name: string; order: number; text: unknown }) => {
        sections.push(s)
        const disposer: Disposer = () => {
          const i = sections.indexOf(s)
          if (i >= 0) sections.splice(i, 1)
        }
        disposers.push(disposer)
        return disposer
      },
    },
    subagents: {
      start: async () => { throw new Error('integration test 不发起真实委派') },
      getProvider: (name: string) => {
        if (opts.providerAbsent === true) return undefined
        return { name, capabilities: { ...FULL_CAPS, ...opts.providerCapabilities }, inheritsParentContext: false }
      },
    },
    on: (event: string, cb: (payload: unknown) => void) => {
      listeners.push({ event, cb })
      return () => {}
    },
    effect: (fn: () => unknown) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer as Disposer)
    },
    logger: {
      info: (msg: string) => { infos.push(String(msg)) },
      warn: () => {},
      error: (msg: string) => { errors.push(String(msg)) },
    },
  }
  return {
    ctx: ctx as unknown as Context,
    tools, activeTools, sections, disposers, errors, infos,
    emit: (event: string, payload: unknown) => {
      for (const l of listeners) if (l.event === event) l.cb(payload)
    },
  }
}

async function loadMod(): Promise<typeof import('../src/index.ts')> {
  vi.resetModules()
  return import('../src/index.ts')
}

test('挂载：工具注册一次、提示段为静态文本且列出内置角色、无路由无 KV', async () => {
  const mod = await loadMod()
  const { ctx, tools, sections } = fakeCtx()
  await mod.apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(tools).toHaveLength(1)
  expect(sections).toHaveLength(1)
  const text = sections[0].text
  expect(typeof text).toBe('string')
  expect(text).toContain('explorer:')
  expect(text).toContain('general:')
  expect(sections[0].name).toBe('plugin:agent-team')
  expect(mod.inject).toEqual(['tools', 'subagents', 'systemPrompt'])
})

test('用户目录角色进入提示段；同名覆盖写激活日志', async () => {
  const rolesDir = join(home, 'agent-team', 'roles')
  await writeFile(join(rolesDir, 'reviewer.yml'), 'description: 代码审查\npersona: 你是审查员。\n', { recursive: true } as never).catch(async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(rolesDir, { recursive: true })
    await writeFile(join(rolesDir, 'reviewer.yml'), 'description: 代码审查\npersona: 你是审查员。\n')
  })
  const mod = await loadMod()
  const { ctx, sections, infos } = fakeCtx()
  await mod.apply(ctx, {} as Config)
  expect(sections[0].text).toContain('reviewer: 代码审查')
  // 同名覆盖日志
  await writeFile(join(rolesDir, 'explorer.yml'), 'description: 定制\npersona: 定制。\n')
  const mod2 = await loadMod()
  const second = fakeCtx()
  await mod2.apply(second.ctx, {} as Config)
  expect(second.sections[0].text).toContain('explorer: 定制')
  expect(second.infos.join('\n')).toContain('explorer')
})

test('clientOnly: true：无工具/提示段注册，不读名册', async () => {
  const mod = await loadMod()
  const { ctx, tools, sections } = fakeCtx()
  await mod.apply(ctx, { clientOnly: true } as Config)
  expect(tools).toHaveLength(0)
  expect(sections).toHaveLength(0)
})

test('用户目录含非法文件：激活期响亮失败', async () => {
  const rolesDir = join(home, 'agent-team', 'roles')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(rolesDir, { recursive: true })
  await writeFile(join(rolesDir, 'bad.yml'), 'description: [未闭合')
  const mod = await loadMod()
  const { ctx } = fakeCtx()
  await expect(mod.apply(ctx, {} as Config)).rejects.toThrowError(/bad\.yml/)
})

test('HMR 安全：卸载后工具/提示段摘除，fresh ctx 重挂载成功', async () => {
  const mod = await loadMod()
  const first = fakeCtx()
  await mod.apply(first.ctx, {} as Config)
  for (const dispose of first.disposers) await dispose()
  expect(first.activeTools.size).toBe(0)
  expect(first.sections).toHaveLength(0)
  const second = fakeCtx()
  await mod.apply(second.ctx, {} as Config)
  expect(second.tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(second.sections).toHaveLength(1)
})

test('provider 缺 persona/depthLimit 能力：激活响亮失败', async () => {
  const mod = await loadMod()
  await expect(mod.apply(fakeCtx({ providerCapabilities: { persona: false } }).ctx, {} as Config))
    .rejects.toThrowError(/persona/)
  await expect(mod.apply(fakeCtx({ providerCapabilities: { depthLimit: false } }).ctx, {} as Config))
    .rejects.toThrowError(/depthLimit/)
})

test('provider 尚未注册：工具延迟挂载，provider-added 后注册；缺能力则 logger.error 且可恢复', async () => {
  const mod = await loadMod()
  const { ctx, tools, errors, emit } = fakeCtx({ providerAbsent: true })
  await mod.apply(ctx, {} as Config)
  expect(tools).toHaveLength(0)
  emit('subagent/provider-added', { name: 'spawn', capabilities: { ...FULL_CAPS, persona: false }, inheritsParentContext: false })
  expect(tools).toHaveLength(0)
  expect(errors.join('\n')).toContain('persona')
  emit('subagent/provider-removed', 'spawn')
  emit('subagent/provider-added', { name: 'spawn', capabilities: FULL_CAPS, inheritsParentContext: false })
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
})
