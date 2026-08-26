/** 基础工具行（与 dsh standard agent preset 同源）：persona / instructions / shell / fs / fs-search。
 *  源：archive/2026-08-26-merged-plugins/agent-team/presets/team/agent.cordis.yml 的基础工具行，
 *  逐行对照 deepseek-harness/apps/cli/config/agent-presets/standard/agent.cordis.yml 核对 id 与 config。
 *  shell 双行按平台互斥（win32 用 pwsh，其余用 bash），与两 preset 的 disabled 条件一致。
 *  这些行在 agent 创建期经 setupAgentScope scoped 挂载进各会话，不再依赖 preset 机制。 */

export interface BasicTool {
  /** 插件包名（preset 行的 name 字段）。 */
  id: string
  /** 插件 config（preset 行的 config 字段；无则省略）。 */
  config?: Record<string, unknown>
}

export const BASIC_TOOLS: BasicTool[] = [
  {
    id: '@deepseek-ai/dsh-persona',
    config: { text: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.' },
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
