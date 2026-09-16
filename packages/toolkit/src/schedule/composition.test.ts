/** 真实组合守护：schedule 任务会话的 joiner 栈（preset 优先 + toolsScope 回退）与 bots 同源，
 *  composeFrom 认父继承 preset 工具（spec §9 组合守护；0.2.3/0.2.4 fake 单测事故对策同族）。
 *  镜像 channels/scope-joiner.composition.test.ts 的最小集。 */
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
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { createScopeJoiner } from '../channels/scope-joiner.ts'
import { createToolsScope } from '../channels/tool-scope.ts'

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

const COMPOSITION = `- id: fixture
  name: ../../plugins/contribute.mjs
  config:
    tool: cron-fixture
`

let ctx: Context
let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dsh-toolkit-cron-composition-'))
  await mkdir(join(tempDir, 'plugins'))
  await writeFile(join(tempDir, 'plugins', 'contribute.mjs'), FIXTURE_PLUGIN, 'utf8')
  await mkdir(join(tempDir, 'presets', 'agent-bot'), { recursive: true })
  await writeFile(join(tempDir, 'presets', 'agent-bot', 'agent.cordis.yml'), COMPOSITION, 'utf8')

  ctx = new Context()
  ctx.baseUrl = pathToFileURL(tempDir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // 0.1.5-rc.1 起 AgentPresets inject ['loader', 'sessionProjections']，缺 sessionProjections
  // 时服务不发布（ctx.agentPresets 恒 undefined）。镜像宿主 mount.spec.ts 的 harness 补上。
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentPresets, { default: 'agent-bot', roots: [{ path: join(tempDir, 'presets'), trust: 'user' }], includeUserRoot: false, includeShippedRoot: false })
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('schedule 任务会话组合守护', () => {
  test('setupSchedule 同款 joiner 栈：mount 路径 composeFrom 认父，子 scope 继承 preset 工具', async () => {
    // 与 schedule/index.ts 内部构造逐行同源：createToolsScope → createScopeJoiner(presetId)。
    const toolsScope = createToolsScope(ctx, async () => ((() => undefined) as never))
    const joiner = createScopeJoiner(ctx, 'agent-bot', toolsScope, vi.fn())
    const parentScope = createScope(ctx, { fake: 'cron-parent' })
    await joiner.join(parentScope.ctx)
    expect(ctx.agentPresets.composedPreset(parentScope.ctx)).toBe('agent-bot')
    const childScope = createScope(ctx, { fake: 'cron-child' })
    expect(ctx.agentPresets.composeFrom(childScope.ctx, parentScope.ctx)).toBe('agent-bot')
    expect(ctx.tools.get('cron-fixture', scopeOf(childScope.ctx)!)).toBeDefined()
    await toolsScope.dispose()
  })
})
