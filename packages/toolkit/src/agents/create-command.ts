/**
 * /create-agent 命令：返回引导文本驱动主 Agent 完成
 * 「访谈澄清 → 推荐配置 → 用户确认 → 复用面板 HTTP API 落库」全流程。
 * 设计：docs/superpowers/specs/2026-09-02-create-agent-command-design.md
 */
import type { Context } from '@deepseek-ai/cordis'
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'
import type { AgentRegistry } from './registry.ts'

/** buildCreateAgentGuidance 的输入。 */
export interface CreateAgentGuidanceInput {
  /** 命令行内联需求（已 trim，可空串）。 */
  requirement: string
  /** 现有 Agent id 列表（含 main），不可复用。 */
  agentIds: string[]
  /** 顶层注册表全局工具名。 */
  globalTools: string[]
  /** web 宿主回环 origin（如 http://127.0.0.1:3080）；undefined = headless/CLI 降级。 */
  origin: string | undefined
}

/** 拼装 /create-agent 的引导文本（模型面契约，文案为规格锁定内容）。 */
export function buildCreateAgentGuidance(input: CreateAgentGuidanceInput): string {
  const lines: string[] = [
    '# 交互式创建 Agent 团队成员',
    '',
    '## 工作流（三步）',
    '1. 澄清需求：需求不明确时用 ask_user_question 向用户提问，整个流程提问总次数不超过 5 次，不重复问已确认的信息；',
    '2. 生成推荐并请用户确认：推荐 id / name / description / persona / tools 五个字段（id 是团队内唯一标识，name 是显示名，description 是职责一句话描述，persona 是系统提示词个性段，tools 是工具白名单）；',
    '3. 迭代：用户有修改意见时按意见修订名称、描述、个性和工具后再次确认，直到用户明确确认。',
  ]
  if (input.requirement !== '') {
    lines.push(
      '',
      '## 用户初始需求',
      `用户已在命令中提供初始需求：「${input.requirement}」。请据此减少提问轮次，仅就不明确的点提问。`,
    )
  }
  lines.push(
    '',
    '## 现有 Agent id（不可复用）',
    input.agentIds.join(', '),
    'id 规则：小写字母开头，仅含小写字母/数字/连字符（[a-z0-9-]），最长 32 字符。',
    '',
    '## 可用工具清单',
    `原生工具：${NATIVE_TOOL_NAMES.join(', ')}`,
    `全局工具：${input.globalTools.join(', ')}`,
    '省略 tools 字段表示不限制（Agent 可使用全部工具）。一旦给出白名单，该 Agent 只有列出的工具可用：通常应保留原生工具，否则失去读文件/搜索/执行命令等基本能力（最终取舍按需求判断，如只读角色可去掉 write/edit）。',
  )
  if (input.origin === undefined) {
    lines.push(
      '',
      '## 落库',
      '当前宿主无 web 服务，无法自动落库。用户确认推荐后，请把最终配置完整输出给用户，并提示其打开 Agents 面板按推荐内容手动创建。',
    )
  } else {
    lines.push(
      '',
      '## 落库（用户明确确认后执行）',
      '用你的 shell 工具调用 Agents 面板同一 HTTP 端点完成创建：',
      `1. 先 GET ${input.origin}/dsh-agent-toolkit/api/agents 复核所选 id 仍未被占用；`,
      `2. 再 PUT ${input.origin}/dsh-agent-toolkit/api/agents/<id>，请求体为 JSON（不要在 body 中携带 id 或 builtin 字段）：`,
      '   {"name":"...","description":"...","persona":"...","tools":{"allow":["..."]}}',
      '   （description/persona/tools 均可省略；省略 tools 表示不限制）',
      '3. curl 示例（Windows 的 pwsh 里用 curl.exe）：',
      `   curl.exe -s -X PUT "${input.origin}/dsh-agent-toolkit/api/agents/<id>" -H "Content-Type: application/json" -d "{\\"name\\":\\"...\\"}"`,
      `4. 返回 200 后必须再 GET ${input.origin}/dsh-agent-toolkit/api/agents，在返回列表中找到该 id 的记录，把它的 name/description/persona/tools 关键字段展示给用户，作为落库证据；`,
      '5. 落库成功后告知用户可在 Agents 面板查看、并可被 team_delegate 委派；任一步返回 4xx 则把错误信息展示给用户，修正后重试。',
    )
  }
  return lines.join('\n')
}

/** setupCreateAgentCommand 的依赖。 */
export interface CreateAgentCommandDeps {
  registry: AgentRegistry
  listTools(): string[]
}

/**
 * 注册 /create-agent。webServer 为可选服务按仓库规则经 ctx.get 读取（不进 inject），
 * 缺席（headless/CLI）时 origin 为 undefined，引导文本落库节降级为手动创建指引。
 */
export function setupCreateAgentCommand(ctx: Context, deps: CreateAgentCommandDeps): void {
  ctx.commands.register({
    name: 'create-agent',
    description: '交互式创建 Agent 团队成员：访谈澄清需求 → 推荐配置 → 确认后经面板 API 落库',
    input: { hint: '初始需求描述，可空' },
    handler: ({ rawInput }: { rawInput: string }) => {
      const webServer = ctx.get('webServer') as { port: number } | undefined
      const origin = webServer === undefined ? undefined : `http://127.0.0.1:${webServer.port}`
      const text = buildCreateAgentGuidance({
        requirement: rawInput.trim(),
        agentIds: deps.registry.list().map((agent) => agent.id),
        globalTools: deps.listTools(),
        origin,
      })
      return { kind: 'success', text }
    },
  })
}
