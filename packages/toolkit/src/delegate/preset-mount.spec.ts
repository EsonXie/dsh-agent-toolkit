/** 集成门禁：角色 preset 组合（本包子路径组合行）在真实宿主 registry 下可挂载且生效。
 *  前置：pnpm --filter dsh-agent-toolkit bundle（组合行经 lib 产物 + package exports 自引用解析）。
 *  fixture 参照 deepseek-harness/packages/preset/agent-preset-registry/tests/harness.ts 的
 *  最小集（本仓先例 src/channels/scope-joiner.composition.test.ts 已验证该组合可在 vitest 下
 *  挂载真实 registry），scope 创建/断言参照 packages/core/tools/tests/scoped.spec.ts。
 *  验收：(a) 组合行经 Node 自引用（baseUrl = 本包根）解析；(b) agentPresets.register 不报
 *  broken；(c) 绑定 scope 内 persona 段存在；(d) 白名单外工具不可见。 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, onTestFinished, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AgentRecord } from '../agents/store.ts'
import { registerRolePreset, rolePresetId } from './role-preset.ts'

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: () => Promise.resolve(name),
  }
}

test('角色 preset 组合挂载：自引用解析、persona 段与工具白名单生效', async () => {
  const ctx = new Context()
  // 组合行解析锚点 = 本包根（生产为 profile 内安装目录；registry register 以
  // record.context.baseUrl 扩展挂载 scope，src/index.ts:109 extend({ baseUrl })）。
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  ctx.baseUrl = pathToFileURL(packageRoot).href + '/'
  await ctx.plugin(Loader)
  // registry 的 inject 为 ['loader', 'sessionProjections']，缺 sessionProjections 服务不发布。
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentPresets, { default: rolePresetId('explorer') })

  // 假全局工具面：fake_read/fake_note 入白名单，fake_write 留全局但出白名单。
  ctx.tools.register(fakeTool('fake_read'))
  ctx.tools.register(fakeTool('fake_write'))
  ctx.tools.register(fakeTool('fake_note'))

  const role: AgentRecord = {
    id: 'explorer',
    name: 'Explorer',
    description: '探索',
    builtin: false,
    tools: { allow: ['fake_read', 'fake_note', 'ghost', 'run_code'] },
  }
  const persona = '你是探索者 Explorer。'
  const dispose = await registerRolePreset(ctx, role, persona)
  expect(dispose).toBeTypeOf('function')
  onTestFinished(async () => {
    await dispose?.()
    await ctx.fiber.dispose()
  })

  // 验收 (a)+(b)：自引用组合经真实 loader 解析挂载，register 不报 broken。
  const resolved = await ctx.agentPresets.resolve(rolePresetId('explorer'))
  expect(resolved.broken).toBeUndefined()

  // 绑定一个 agent scope 到该 preset（scoped.spec.ts 的 mint 形态，经 registry.mount 认父）。
  const key = { agent: 'explorer-agent' }
  const scope = createScope(ctx, key)
  onTestFinished(async () => { await scope.dispose() })
  const mounted = await ctx.agentPresets.mount(scope.ctx, rolePresetId('explorer'))
  expect(mounted.id).toBe(rolePresetId('explorer'))

  // 验收 (c)：绑定 scope 内 persona 段存在（scoped 段遮蔽全局空前缀段）。
  const assembly = await ctx.systemPrompt.assemble({ scope: key })
  const personaSection = assembly.sections.find((s) => s.name === 'deployment:persona-prefix')
  expect(personaSection?.text).toBe(persona)

  // 验收 (d)：白名单外工具不可见；全局视图不受 restrict 影响。
  expect(ctx.tools.schemas(key).map((t) => t.name).sort()).toEqual(['fake_note', 'fake_read'])
  expect(ctx.tools.get('fake_write', scopeOf(scope.ctx)!)).toBeUndefined()
  expect(ctx.tools.schemas().map((t) => t.name).sort()).toEqual(['fake_note', 'fake_read', 'fake_write'])
})
