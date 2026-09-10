/** 真实组合守护测试：joiner 的 mount 路径产生的父链真实可被执行中的 composeFrom 认到，
 *  子 scope 继承 preset 注册的工具（本仓库 0.2.3/0.2.4 两起"fake 单测掩盖宿主语义"事故的直接对策）。
 *  harness 镜像宿主 agent-presets/tests/mount.spec.ts 的最小集：真实 @deepseek-ai/dsh-agent-presets
 *  服务 + cordis Loader + fixture 插件，不建真 agent，只用 createScope 造 scoped context。 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { createScopeJoiner } from './scope-joiner.ts'
import { createToolsScope } from './tool-scope.ts'

// fixture 插件镜像宿主 agent-presets/tests/fixtures/plugins/contribute.js：注册一个按 config 命名的工具。
const FIXTURE_PLUGIN = `
export const name = 'contribute'
export const inject = ['tools', 'systemPrompt']
export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register({
    name: config.tool,
    description: 'fixture tool ' + config.tool,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: () => Promise.resolve(config.tool),
  }))
}
`

/** 单行 preset composition：相对 composition 目录解析（../../plugins/contribute.mjs → tempDir/plugins/）。 */
const COMPOSITION = `- id: fixture
  name: ../../plugins/contribute.mjs
  config:
    tool: bot-fixture
`

let ctx: Context
let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dsh-toolkit-composition-'))
  await mkdir(join(tempDir, 'plugins'))
  await writeFile(join(tempDir, 'plugins', 'contribute.mjs'), FIXTURE_PLUGIN, 'utf8')
  await mkdir(join(tempDir, 'presets', 'agent-bot'), { recursive: true })
  await writeFile(join(tempDir, 'presets', 'agent-bot', 'agent.cordis.yml'), COMPOSITION, 'utf8')

  ctx = new Context()
  ctx.baseUrl = pathToFileURL(tempDir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentPresets, { default: 'agent-bot', roots: [{ path: join(tempDir, 'presets'), trust: 'user' }], includeUserRoot: false, includeShippedRoot: false })
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('createScopeJoiner 真实组合守护', () => {
  test('joiner mount 路径：composeFrom 认父，子 scope 继承 preset 工具', async () => {
    const parentScope = createScope(ctx, { fake: 'parent' })
    const fallback = createToolsScope(ctx, async () => ((() => undefined) as never))
    await createScopeJoiner(ctx, 'agent-bot', fallback, vi.fn()).join(parentScope.ctx)
    expect(ctx.agentPresets.composedPreset(parentScope.ctx)).toBe('agent-bot')
    const childScope = createScope(ctx, { fake: 'child' })
    expect(ctx.agentPresets.composeFrom(childScope.ctx, parentScope.ctx)).toBe('agent-bot')
    expect(ctx.tools.get('bot-fixture', scopeOf(childScope.ctx)!)).toBeDefined()
    await fallback.dispose()
  })

  test('回退路径（负例守护）：toolsScope 父链不被 composeFrom 认到，子 scope 无工具', async () => {
    const parentScope = createScope(ctx, { fake: 'parent-fb' })
    const fallback = createToolsScope(ctx, async () => ((() => undefined) as never))
    // mount 一个 roster 里不存在的 id → 抛错 → 回退。
    await createScopeJoiner(ctx, 'nonexistent', fallback, vi.fn()).join(parentScope.ctx)
    const childScope = createScope(ctx, { fake: 'child-fb' })
    expect(ctx.agentPresets.composeFrom(childScope.ctx, parentScope.ctx)).toBeUndefined()
    expect(ctx.tools.get('bot-fixture', scopeOf(childScope.ctx)!)).toBeUndefined()
    await fallback.dispose()
  })
})
