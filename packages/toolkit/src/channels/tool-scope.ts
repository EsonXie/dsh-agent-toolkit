/** 基础工具行的 standing scope：工具挂进祖先 scope 层，agent 加入后 restrict 才能过滤继承面。 */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, scopeOf, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { BASIC_TOOLS } from './basic-tools.ts'

/** 工具行模块加载器（测试注入 fake；生产经动态 import 解析宿主 node_modules 中的插件包）。 */
export type ToolModuleLoader = (specifier: string) => Promise<Plugin>

/** 默认加载器：复刻 preset mount 的模块解析——loader 的 unwrapExports 取 `default ?? 命名导出模块`。 */
async function loadToolModule(specifier: string): Promise<Plugin> {
  const mod: unknown = await import(specifier)
  return ((mod as { default?: unknown }).default ?? mod) as Plugin
}

/** 基础工具行 standing scope 的持有者：join 把 agent scope 挂到工具层下，dispose 随插件卸载。 */
export interface ToolsScope {
  /**
   * 把 agent scope 父链挂到 standing scope（工具成为继承面），并在返回前等首轮
   * 挂载落定（agent factory 会等 setup 完成，工具插件不会晚于首个 turn 就绪）。
   * agent scope 已有父链时抛错（bot 会话的 scope 父链由本方法独占绑定）。
   */
  join(agentCtx: Context): Promise<ScopeKey>
  /** 释放 standing scope（插件卸载时调用；此后 join 会按需重建）。 */
  dispose(): Promise<void>
}

/** 建一个 bot 会话共用的工具行 standing scope（所有 bot 会话挂同一套 BASIC_TOOLS）。 */
export function createToolsScope(ctx: Context, loadTool: ToolModuleLoader = loadToolModule): ToolsScope {
  let scope: Scope | undefined
  let mount: Promise<ScopeKey> | undefined
  let generation = 0

  function ensure(): Promise<ScopeKey> {
    mount ??= (async () => {
      // 失败重试换新 key：避免与失败代次的层残留状态纠缠。
      const key: ScopeKey = { origin: 'dsh-agent-toolkit', kind: 'bots-tools', gen: ++generation }
      const created = createScope(ctx, key)
      scope = created
      try {
        for (const tool of BASIC_TOOLS) {
          await created.ctx.plugin(await loadTool(tool.id), tool.config)
        }
      } catch (error) {
        if (scope === created) scope = undefined
        mount = undefined
        await created.dispose().catch(() => undefined)
        throw error
      }
      return key
    })()
    return mount
  }

  return {
    async join(agentCtx) {
      const agentKey = scopeOf(agentCtx)
      if (agentKey === undefined) {
        throw new Error('tools-scope: refusing to join an unscoped agent context; per-agent composition requires a scope key')
      }
      const standing = await ensure()
      bindScopeParent(agentKey, standing)
      return standing
    },
    async dispose() {
      mount = undefined
      const current = scope
      scope = undefined
      await current?.dispose()
    },
  }
}
