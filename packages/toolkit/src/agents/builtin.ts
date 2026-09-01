/** 内置保底 Agent 记录：main + explorer（只读白名单）/ general（不限制）。 */
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'
import type { AgentRecord } from './store.ts'

/** explorer 默认白名单：原生工具去掉写类（write/edit）。shell 名平台互斥（win32=pwsh、其余=bash），
 *  必须从 NATIVE_TOOL_NAMES 派生不可写死——宿主 tools.restrict 对未知名响亮失败。 */
export const EXPLORER_READONLY_ALLOW: readonly string[] = NATIVE_TOOL_NAMES.filter((n) => n !== 'write' && n !== 'edit')

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
  },
]
