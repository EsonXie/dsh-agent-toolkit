/** agent 创建/恢复的作用域组合：基础工具行 scoped 挂载 → persona/tools 创作期注入。 */
import type { Context, Plugin } from '@deepseek-ai/cordis'
// type-only 激活 dsh-system-prompt / dsh-tools 对 cordis Context 的声明合并（agentCtx.systemPrompt / agentCtx.tools）。
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { BASIC_TOOLS } from './basic-tools.ts'
import type { AgentHooks } from './ports.ts'

/** 工具行模块加载器（测试注入 fake；生产经动态 import 解析宿主 node_modules 中的插件包）。 */
export type ToolModuleLoader = (specifier: string) => Promise<Plugin>

/** 默认加载器：复刻 preset mount 的模块解析——loader 的 unwrapExports 取 `default ?? 命名导出模块`。 */
async function loadToolModule(specifier: string): Promise<Plugin> {
  const mod: unknown = await import(specifier)
  return ((mod as { default?: unknown }).default ?? mod) as Plugin
}

/**
 * 组合 agent 作用域：先 scoped 挂载基础工具行（persona/instructions/shell/fs/fs-search，
 * 与原生 UI 会话的 standard preset 同源），再叠 bot 的 persona 与 tools 白名单。
 * 顺序敏感：restrict 必须在工具行挂载之后，否则白名单命中不到挂载带入的工具名。
 */
export async function setupAgentScope(
  agentCtx: Context,
  hooks: AgentHooks,
  loadTool: ToolModuleLoader = loadToolModule,
): Promise<void> {
  for (const tool of BASIC_TOOLS) {
    await agentCtx.plugin(await loadTool(tool.id), tool.config)
  }
  if (hooks.persona !== undefined) {
    agentCtx.systemPrompt.section({ name: 'dsh-agent-toolkit:persona', order: 0, text: hooks.persona })
  }
  if (hooks.tools !== undefined) {
    agentCtx.tools.restrict({ allow: hooks.tools })
  }
}
