import { describe, expect, test } from 'vitest'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { setupAgentScope, type ToolModuleLoader } from './agent-setup.ts'
import { BASIC_TOOLS } from './basic-tools.ts'

/** fake 加载器：把每个 id 转成一个可识别名称的函数插件（生产经动态 import 解析宿主模块）。 */
function fakeLoader() {
  const loaded: string[] = []
  const loadTool: ToolModuleLoader = async (id) => {
    loaded.push(id)
    const fn = new Function('') as Plugin
    Object.defineProperty(fn, 'name', { value: id, configurable: true })
    return fn
  }
  return { loaded, loadTool }
}

/** fake agentCtx：记录 plugin / section / restrict 调用序列。 */
function fakeAgentCtx() {
  const calls: string[] = []
  const ctx = {
    plugin: (plugin: unknown, config?: unknown) => {
      const id = (plugin as { name?: unknown }).name
      calls.push(`plugin:${String(id)}:${config === undefined ? '-' : JSON.stringify(config)}`)
    },
    systemPrompt: { section: (input: { name: string }) => { calls.push(`section:${input.name}`) } },
    tools: { restrict: (input: { allow: readonly string[] }) => { calls.push(`restrict:${input.allow.join(',')}`) } },
  }
  return { ctx: ctx as unknown as Context, calls }
}

const mountCalls = BASIC_TOOLS.map((t) => `plugin:${t.id}:${t.config === undefined ? '-' : JSON.stringify(t.config)}`)

describe('setupAgentScope', () => {
  test('基础工具行按 BASIC_TOOLS 顺序 scoped 挂载，再注入 persona 与 tools 白名单', async () => {
    const { loadTool, loaded } = fakeLoader()
    const { ctx, calls } = fakeAgentCtx()
    await setupAgentScope(ctx, { persona: '你是评审助手', tools: ['bash'] }, loadTool)
    expect(loaded).toEqual(BASIC_TOOLS.map((t) => t.id))
    expect(calls).toEqual([...mountCalls, 'section:dsh-agent-toolkit:persona', 'restrict:bash'])
  })

  test('无 hooks：只挂载基础工具行，不注册 section/restrict', async () => {
    const { loadTool } = fakeLoader()
    const { ctx, calls } = fakeAgentCtx()
    await setupAgentScope(ctx, {}, loadTool)
    expect(calls).toEqual(mountCalls)
  })

  test('只带 persona：挂载 + 注册 persona 段，不 restrict', async () => {
    const { loadTool } = fakeLoader()
    const { ctx, calls } = fakeAgentCtx()
    await setupAgentScope(ctx, { persona: 'p' }, loadTool)
    expect(calls.at(-1)).toBe('section:dsh-agent-toolkit:persona')
    expect(calls).not.toContain('restrict:')
  })
})
