/** 真实组合守护测试：joiner 的 mount 路径产生的父链真实可被执行中的 composeFrom 认到，
 *  子 scope 继承 preset 注册的工具（本仓库 0.2.3/0.2.4 两起"fake 单测掩盖宿主语义"事故的直接对策）。
 *  harness 镜像宿主 agent-preset-registry/tests/harness.ts 的最小集：真实 @deepseek-ai/dsh-agent-preset-registry
 *  服务 + cordis Loader + fixture 插件，不建真 agent，只用 createScope 造 scoped context。 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { createScopeJoiner } from './scope-joiner.ts'
import { createToolsScope } from './tool-scope.ts'

// fixture 插件镜像宿主 agent-preset-registry/tests/fixtures/plugins/contribute.js：注册一个按 config 命名的工具。
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

let ctx: Context
let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dsh-toolkit-composition-'))
  await mkdir(join(tempDir, 'plugins'))
  await writeFile(join(tempDir, 'plugins', 'contribute.mjs'), FIXTURE_PLUGIN, 'utf8')

  ctx = new Context()
  ctx.baseUrl = pathToFileURL(tempDir).href + '/'
  await ctx.plugin(Loader)
  // 0.1.7 起 registry 声明式注册，inject 仍为 ['loader', 'sessionProjections']，缺
  // sessionProjections 时服务不发布（ctx.agentPresets 恒 undefined）。镜像宿主 harness 补上。
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentPresets, { default: 'agent-bot' })
  await ctx.agentPresets.register({
    id: 'agent-bot',
    plugins: [{ name: pathToFileURL(join(tempDir, 'plugins', 'contribute.mjs')).href, config: { tool: 'bot-fixture' } }],
  })
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
