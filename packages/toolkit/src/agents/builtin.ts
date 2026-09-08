/** 内置保底 Agent 记录：main + explorer（只读白名单 10 个）/ general（preset 面全量 20 个、禁二级委派）。 */
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'
import type { AgentRecord } from './store.ts'

const SHELL_NAME = process.platform === 'win32' ? 'pwsh' : 'bash'

/** 旧版 explorer 默认白名单（5 个）：存量条件式迁移的等值比对基准。
 *  独立于 EXPLORER_READONLY_ALLOW 保留旧派生式——比对基准不可随新名单漂移。
 *  shell 名平台互斥（win32=pwsh、其余=bash），必须从 NATIVE_TOOL_NAMES 派生不可写死。 */
export const LEGACY_EXPLORER_ALLOW: readonly string[] = NATIVE_TOOL_NAMES.filter((n) => n !== 'write' && n !== 'edit')

/** explorer 默认白名单（10 个）：只读基础五件（shell/read/read_image/glob/grep，旧派生不变）
 *  + preset 面只读安全五件（web_search/todo_write/job_list/job_output/skill——skill 加载的是
 *  指令文本，本身只读，用户决策默认可用）。
 *  编排类（ralph/workflow）、写文件类（write/edit）、job_kill、ask_user_question、
 *  goal 三件套、exit_plan_mode 不进只读名单。 */
export const EXPLORER_READONLY_ALLOW: readonly string[] = [
  ...LEGACY_EXPLORER_ALLOW,
  'web_search', 'todo_write', 'job_list', 'job_output', 'skill',
]

/** general 默认白名单（20 个）：agent-team preset standing 面全量（2026-09-08 实测枚举），
 *  不含 team_delegate（禁二级委派）与 run_code（宿主 Code Mode 保留名，restrict 拒收）。
 *  静态名单：preset 面日后新增工具不自动进入，需人工再梳理（见 spec 非目标）。 */
export const GENERAL_ALLOW: readonly string[] = [
  SHELL_NAME, 'read', 'write', 'edit', 'read_image', 'glob', 'grep',
  'todo_write', 'web_search', 'ask_user_question', 'skill', 'exit_plan_mode',
  'job_list', 'job_output', 'job_kill', 'create_goal', 'get_goal', 'update_goal',
  'ralph', 'workflow',
]

export const BUILTIN_AGENTS: readonly AgentRecord[] = [
  {
    id: 'main',
    name: '主 Agent',
    builtin: true,
  },
  {
    id: 'explorer',
    name: 'Explorer',
    description: '快速只读代码库探索：定位文件/符号、回答结构与调用关系问题，不做任何修改',
    persona: `你是代码库探索员。快速定位与任务相关的文件与符号，回答关于代码结构、
调用关系、实现位置的问题。你只读不写：不修改任何文件、不运行有副作用的命令。
输出结论清单，每条附文件路径与行号；信息不足时说明缺口，不要猜测。`,
    builtin: true,
    tools: { allow: [...EXPLORER_READONLY_ALLOW] },
  },
  {
    id: 'general',
    name: 'General',
    description: '通用多步骤任务执行：可读可写、可运行命令，完成实现/修复类任务',
    persona: `你是通用执行员。按任务书独立完成多步骤工作，可以读写文件、运行命令。
动手前先阅读相关 AGENTS.md 并遵循项目约定；完成后运行与改动相关的检查
（测试/类型检查）验证改动，并在最终输出中报告验证结果。`,
    builtin: true,
    tools: { allow: [...GENERAL_ALLOW] },
  },
]
