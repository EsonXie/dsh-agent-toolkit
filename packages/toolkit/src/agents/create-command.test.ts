/** /create-agent 引导文本纯函数测试：四节结构、内联需求节、headless 降级、落库防呆文案。 */
import { expect, test } from 'vitest'
import { buildCreateAgentGuidance, type CreateAgentGuidanceInput } from './create-command.ts'
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'

const BASE_INPUT: CreateAgentGuidanceInput = {
  requirement: '',
  agentIds: ['main', 'explorer', 'general'],
  globalTools: ['ask_user_question', 'team_delegate'],
  origin: 'http://127.0.0.1:3080',
}

test('无参：含工作流/现有 id/工具清单/落库四节，无「用户初始需求」节', () => {
  const text = buildCreateAgentGuidance(BASE_INPUT)
  expect(text).toContain('ask_user_question')
  expect(text).toContain('不超过 5 次')
  expect(text).not.toContain('用户初始需求')
  expect(text).toContain('main, explorer, general')
  for (const name of NATIVE_TOOL_NAMES) expect(text).toContain(name)
  expect(text).toContain('ask_user_question, team_delegate')
  expect(text).toContain('PUT http://127.0.0.1:3080/dsh-agent-toolkit/api/agents/<id>')
  expect(text).toContain('GET http://127.0.0.1:3080/dsh-agent-toolkit/api/agents')
})

test('落库防呆：PUT 成功后必须 GET 复核并展示证据', () => {
  const text = buildCreateAgentGuidance(BASE_INPUT)
  expect(text).toContain('落库证据')
  expect(text).toContain(`GET http://127.0.0.1:3080/dsh-agent-toolkit/api/agents/<id>`)
})

test('带内联需求：含「用户初始需求」节并嵌入 trim 后原文', () => {
  const text = buildCreateAgentGuidance({ ...BASE_INPUT, requirement: '做一个只做代码审查的 Agent' })
  expect(text).toContain('## 用户初始需求')
  expect(text).toContain('「做一个只做代码审查的 Agent」')
  expect(text).toContain('减少提问轮次')
})

test('无 origin（headless）：输出降级文案，不含 PUT 指令', () => {
  const text = buildCreateAgentGuidance({ ...BASE_INPUT, origin: undefined })
  expect(text).toContain('无法自动落库')
  expect(text).toContain('手动创建')
  expect(text).not.toContain('PUT ')
})
