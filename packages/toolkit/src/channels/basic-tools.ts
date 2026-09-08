/** 基础工具行（与 dsh standard agent preset 同源）：persona / instructions / shell / fs / fs-search。
 *  源：archive/2026-08-26-merged-plugins/agent-team/presets/team/agent.cordis.yml 的基础工具行，
 *  逐行对照 deepseek-harness/apps/cli/config/agent-presets/standard/agent.cordis.yml 核对 id 与 config。
 *  shell 双行按平台互斥（win32 用 pwsh，其余用 bash），与两 preset 的 disabled 条件一致。
 *  这些行由 tool-scope.ts 一次性挂进 bot 会话共用的 standing scope（祖先层），agent 经
 *  setupAgentScope join 加入——宿主 tools.restrict() 只能过滤继承面，挂进 agentCtx own 层
 *  的白名单会抛 unknown global tools（2026-09-03 事故）。 */

export interface BasicTool {
  /** 插件包名（preset 行的 name 字段）。 */
  id: string
  /** 插件 config（preset 行的 config 字段；无则省略）。 */
  config?: Record<string, unknown>
}

export const BASIC_TOOLS: BasicTool[] = [
  {
    id: '@deepseek-ai/dsh-persona',
    config: { text: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}. If you need information or a decision from the user, ask directly in your reply and wait for their next message.' },
  },
  {
    id: '@deepseek-ai/dsh-agent-instructions',
    config: { maxBytes: 65536 },
  },
  ...(process.platform === 'win32'
    ? [{ id: '@deepseek-ai/dsh-tool-pwsh' }]
    : [{ id: '@deepseek-ai/dsh-tool-bash' }]),
  { id: '@deepseek-ai/dsh-tool-fs' },
  {
    id: '@deepseek-ai/dsh-tool-fs-search',
    config: { sampleOverCapGlobResults: false },
  },
]

/** 内置工具名常量（兜底名单）：agentPresets 缺席或 standing 枚举失败时，Agents 面板名册
 *  与存量迁移回退到这份常量。语义已降级为"兜底"，不再承诺是完整原生工具面——完整面 =
 *  团队 preset 动态枚举（agents/tool-catalog.ts）。explorer 只读白名单仍从本常量派生
 *  （刻意的最小集，不追求完整）。 */
export const NATIVE_TOOL_NAMES: readonly string[] = [
  process.platform === 'win32' ? 'pwsh' : 'bash',
  'read',
  'write',
  'edit',
  'read_image',
  'glob',
  'grep',
]
