import { describe, expect, test } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import { createScope, scopeParentOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { BASIC_TOOLS } from './basic-tools.ts'
import { createToolsScope, type ToolModuleLoader } from './tool-scope.ts'

/** fake 加载器：记录 id/config 加载序列，返回可挂载的 no-op 函数插件；failOnceOn 只在首次命中时失败。 */
function fakeLoader(options: { failOnceOn?: string } = {}) {
  const loaded: { id: string; config: unknown }[] = []
  let failedOnce = false
  const loadTool: ToolModuleLoader = async (id) => {
    if (!failedOnce && options.failOnceOn === id) {
      failedOnce = true
      throw new Error(`load failed: ${id}`)
    }
    loaded.push({ id, config: BASIC_TOOLS.find((t) => t.id === id)?.config })
    const fn = (() => undefined) as Plugin
    Object.defineProperty(fn, 'name', { value: id, configurable: true })
    return fn
  }
  return { loaded, loadTool }
}

function agentContext(bare: Context): { agentKey: ScopeKey; agentCtx: Context } {
  const agentKey: ScopeKey = { fake: 'agent' }
  const agentScope = createScope(bare, agentKey)
  return { agentKey, agentCtx: agentScope.ctx }
}

describe('createToolsScope', () => {
  test('join 把 agent scope 父链绑到 standing scope，并按 BASIC_TOOLS 顺序挂载', async () => {
    const bare = new Context()
    const { loaded, loadTool } = fakeLoader()
    const toolsScope = createToolsScope(bare, loadTool)
    const { agentKey, agentCtx } = agentContext(bare)
    const standing = await toolsScope.join(agentCtx)
    expect(scopeParentOf(agentKey)).toBe(standing)
    expect(loaded.map((e) => e.id)).toEqual(BASIC_TOOLS.map((t) => t.id))
    expect(loaded.map((e) => e.config)).toEqual(BASIC_TOOLS.map((t) => t.config))
    await toolsScope.dispose()
  })

  test('unscoped agentCtx 拒绝 join', async () => {
    const bare = new Context()
    const toolsScope = createToolsScope(bare, fakeLoader().loadTool)
    await expect(toolsScope.join(bare)).rejects.toThrow(/unscoped/)
    await toolsScope.dispose()
  })

  test('并发 join 单飞：一轮挂载服务多个 agent（共享同一 standing key）', async () => {
    const bare = new Context()
    const { loaded, loadTool } = fakeLoader()
    const toolsScope = createToolsScope(bare, loadTool)
    const a = agentContext(bare)
    const b = agentContext(bare)
    await Promise.all([toolsScope.join(a.agentCtx), toolsScope.join(b.agentCtx)])
    expect(scopeParentOf(a.agentKey)).toBe(scopeParentOf(b.agentKey))
    expect(loaded).toHaveLength(BASIC_TOOLS.length)
    await toolsScope.dispose()
  })

  test('挂载失败：join 拒绝且可重试（重试换新 standing key）', async () => {
    const bare = new Context()
    const { loaded, loadTool } = fakeLoader({ failOnceOn: BASIC_TOOLS[1]!.id })
    const toolsScope = createToolsScope(bare, loadTool)
    const first = agentContext(bare)
    await expect(toolsScope.join(first.agentCtx)).rejects.toThrow('load failed')
    const second = agentContext(bare)
    const standing = await toolsScope.join(second.agentCtx)
    expect(scopeParentOf(second.agentKey)).toBe(standing)
    expect(loaded.slice(-BASIC_TOOLS.length).map((e) => e.id)).toEqual(BASIC_TOOLS.map((t) => t.id))
    await toolsScope.dispose()
  })

  test('dispose 后重新 join 重建 scope（新 standing key）', async () => {
    const bare = new Context()
    const { loaded, loadTool } = fakeLoader()
    const toolsScope = createToolsScope(bare, loadTool)
    const first = agentContext(bare)
    const firstKey = await toolsScope.join(first.agentCtx)
    await toolsScope.dispose()
    const second = agentContext(bare)
    const secondKey = await toolsScope.join(second.agentCtx)
    expect(secondKey).not.toBe(firstKey)
    expect(scopeParentOf(second.agentKey)).toBe(secondKey)
    expect(loaded).toHaveLength(BASIC_TOOLS.length * 2)
    await toolsScope.dispose()
  })
})
