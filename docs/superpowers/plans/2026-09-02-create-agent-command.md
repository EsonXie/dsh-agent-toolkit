# /create-agent 交互式创建 Agent 命令 实施计划

> **面向 Agent 执行者：** 必需子技能：使用 superpower-subagent-driven-development（推荐）或 superpower-executing-plans 按任务逐项执行本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 在 dsh-agent-toolkit 插件中新增 `/create-agent` 命令：返回引导文本驱动主 Agent 完成「访谈（≤5 次提问）→ 推荐 id/name/description/persona/tools → 用户确认 → 经面板既有 HTTP API 落库（PUT 后 GET 复核取证）」全流程。

**架构：** 单文件 `packages/toolkit/src/agents/create-command.ts` = 纯函数 `buildCreateAgentGuidance`（拼引导文本）+ `setupCreateAgentCommand`（注册命令，经 `ctx.get('webServer')` 取 port 组装 origin）；在 `src/index.ts` 的 `apply` 中接线。无新工具、无新 API、无存储/配置变更。

**技术栈：** TypeScript + vitest；宿主服务 `commands`（已在 inject）、可选服务 `webServer`（`ctx.get`）。

**规格：** `docs/superpowers/specs/2026-09-02-create-agent-command-design.md`（规格为准，执行者需同时阅读）

## 全局约束

- 本 checkout 的 `.git` 已恢复（2026-09-02 核实：master，HEAD 1fed178）。在 feature 分支执行，按任务提交。
- `packages/toolkit/src/agents/create-command.ts` 与测试均为**新建**（2026-09-02 核实：头脑风暴期间的抢跑草稿已不存在，全仓库无 create-agent 引用，`src/index.ts` 未接线）。任务 1/2 含完整实现代码，照单施工即可。
- 引导文本是模型面契约：文案为中文完整指令；id 规则、现有 id 列表、工具清单、落库步骤（含 PUT 后 GET 复核取证）、降级文案均为规格锁定内容。
- 不新增工具、不新增/修改 HTTP API、不动存储 schema、不加配置项、不动浏览器半。
- 测试命令：`pnpm --filter dsh-agent-toolkit test`；类型检查：`pnpm --filter dsh-agent-toolkit typecheck`；构建：`pnpm --filter dsh-agent-toolkit bundle`。
- 单文件测试：`pnpm --filter dsh-agent-toolkit exec vitest run src/agents/create-command.test.ts`。

---

### 任务 1：引导文本纯函数 buildCreateAgentGuidance

**文件：**
- 新建：`packages/toolkit/src/agents/create-command.ts`
- 测试：`packages/toolkit/src/agents/create-command.test.ts`（新建）

**接口：**
- 依赖输入：无前置任务。
- 对外产出：
  - `CreateAgentGuidanceInput`：`{ requirement: string; agentIds: string[]; globalTools: string[]; origin: string | undefined }`
  - `buildCreateAgentGuidance(input: CreateAgentGuidanceInput): string`

- [ ] **步骤 1：编写失败的测试**

新建 `packages/toolkit/src/agents/create-command.test.ts`：

```ts
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
  expect(text).toContain('在返回列表中找到该 id 的记录')
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
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm --filter dsh-agent-toolkit exec vitest run src/agents/create-command.test.ts`
预期：FAIL——4 个用例全挂，报错 `Cannot find module './create-command.ts'`。

- [ ] **步骤 3：写实现**

新建 `packages/toolkit/src/agents/create-command.ts`：

```ts
/**
 * /create-agent 命令：返回引导文本驱动主 Agent 完成
 * 「访谈澄清 → 推荐配置 → 用户确认 → 复用面板 HTTP API 落库」全流程。
 * 设计：docs/superpowers/specs/2026-09-02-create-agent-command-design.md
 */
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'

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
```

- [ ] **步骤 4：运行测试并确认通过**

运行：`pnpm --filter dsh-agent-toolkit exec vitest run src/agents/create-command.test.ts`
预期：PASS（4 个用例全绿）。

- [ ] **步骤 5：验证记录**

记录步骤 4 的完整通过输出（替代 git 提交，见全局约束）。

---

### 任务 2：命令注册 setupCreateAgentCommand

**文件：**
- 修改：`packages/toolkit/src/agents/create-command.ts`（任务 1 新建的文件末尾追加 `setupCreateAgentCommand`）
- 测试：`packages/toolkit/src/agents/create-command.test.ts`（追加用例）

**接口：**
- 依赖输入：任务 1 的 `buildCreateAgentGuidance` / `CreateAgentGuidanceInput`。
- 对外产出：
  - `CreateAgentCommandDeps`：`{ registry: AgentRegistry; listTools(): string[] }`
  - `setupCreateAgentCommand(ctx: Context, deps: CreateAgentCommandDeps): void`——注册命令 `create-agent`，handler 签名 `({ rawInput }: { rawInput: string }) => { kind: 'success'; text: string }`。

- [ ] **步骤 1：编写失败的测试**

在 `packages/toolkit/src/agents/create-command.test.ts` 顶部 import 区追加：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { setupCreateAgentCommand } from './create-command.ts'
import type { AgentRegistry } from './registry.ts'
```

文件末尾追加：

```ts
/** 捕获 commands.register 定义的最小面。 */
interface CapturedCommand {
  name: string
  handler: (invocation: { rawInput: string }) => { kind: string; text?: string }
}

function makeCommandCtx(webServer: { port: number } | undefined): { ctx: Context; captured: CapturedCommand[] } {
  const captured: CapturedCommand[] = []
  const ctx = {
    commands: { register: (def: CapturedCommand) => { captured.push(def); return () => {} } },
    get: (name: string) => (name === 'webServer' ? webServer : undefined),
  } as unknown as Context
  return { ctx, captured }
}

const fakeRegistry = {
  list: () => [
    { id: 'main', name: '主 Agent', builtin: true },
    { id: 'explorer', name: 'Explorer', builtin: true },
  ],
} as unknown as AgentRegistry

test('webServer 在场：注册 create-agent，handler 输出含回环 origin 与动态清单', () => {
  const { ctx, captured } = makeCommandCtx({ port: 3080 })
  setupCreateAgentCommand(ctx, { registry: fakeRegistry, listTools: () => ['team_delegate'] })
  expect(captured.map((c) => c.name)).toEqual(['create-agent'])
  const result = captured[0]!.handler({ rawInput: '' })
  expect(result.kind).toBe('success')
  expect(result.text).toContain('http://127.0.0.1:3080')
  expect(result.text).toContain('main, explorer')
  expect(result.text).toContain('team_delegate')
})

test('webServer 缺席（headless）：handler 输出降级文案', () => {
  const { ctx, captured } = makeCommandCtx(undefined)
  setupCreateAgentCommand(ctx, { registry: fakeRegistry, listTools: () => [] })
  const result = captured[0]!.handler({ rawInput: '' })
  expect(result.kind).toBe('success')
  expect(result.text).toContain('无法自动落库')
})

test('rawInput 带需求：trim 后进入「用户初始需求」节', () => {
  const { ctx, captured } = makeCommandCtx({ port: 3080 })
  setupCreateAgentCommand(ctx, { registry: fakeRegistry, listTools: () => [] })
  const result = captured[0]!.handler({ rawInput: '  做一个翻译 Agent  ' })
  expect(result.text).toContain('「做一个翻译 Agent」')
})
```

- [ ] **步骤 2：运行测试并确认结果**

运行：`pnpm --filter dsh-agent-toolkit exec vitest run src/agents/create-command.test.ts`
预期：FAIL——3 个新用例报错 `setupCreateAgentCommand is not a function`，任务 1 的 4 个仍 PASS。

- [ ] **步骤 3：写实现**

在 `packages/toolkit/src/agents/create-command.ts` 顶部 import 区追加：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AgentRegistry } from './registry.ts'
```

文件末尾追加：

```ts
/** setupCreateAgentCommand 的依赖。 */
export interface CreateAgentCommandDeps {
  registry: AgentRegistry
  listTools(): string[]
}

/**
 * 注册 /create-agent。webServer 为可选服务按仓库规则经 ctx.get 读取（不进 inject），
 * 缺席（headless/CLI）时 origin 为 undefined，引导文本落库节降级为手动创建指引。
 *
 * 命令结果（command/done）是 log-only、不进模型：引导文本必须经 agent.followup
 * 投递为 user 消息驱动主 Agent（与 channels/inbound.ts 同一机制），命令卡只回执短文案。
 */
export function setupCreateAgentCommand(ctx: Context, deps: CreateAgentCommandDeps): void {
  ctx.commands.register({
    name: 'create-agent',
    description: '交互式创建 Agent 团队成员：访谈澄清需求 → 推荐配置 → 确认后经面板 API 落库',
    input: { hint: '初始需求描述，可空' },
    handler: ({ rawInput, agent }: { rawInput: string; agent: { followup(message: unknown): void } }) => {
      const webServer = ctx.get('webServer') as { port: number } | undefined
      const origin = webServer === undefined ? undefined : `http://127.0.0.1:${webServer.port}`
      const text = buildCreateAgentGuidance({
        requirement: rawInput.trim(),
        agentIds: deps.registry.list().map((agent) => agent.id),
        globalTools: deps.listTools(),
        origin,
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      return { kind: 'success', text: '已向主 Agent 发出创建 Agent 引导，请继续对话完成访谈与确认。' }
    },
  })
}
```

写完后重跑步骤 2 确认全绿。

- [ ] **步骤 4：运行全部用例确认通过**

运行：`pnpm --filter dsh-agent-toolkit exec vitest run src/agents/create-command.test.ts`
预期：PASS（7 个用例全绿）。

> **勘误（2026-09-02 人工验收后修订）**：原设计「handler 返回引导文本」在宿主架构下无法驱动模型——`command/done` 是 log-only 事件，不进模型上下文、不触发 turn（`deepseek-harness/packages/interaction/commands/src/index.ts:281-286`）。已修订为：handler 经 `invocation.agent.followup(createUserMessage({ ..., source: { kind: 'user' } }))` 把引导文本投递为主 Agent 的 user 消息（唤醒 driver 开 turn），返回值仅留短回执。上方步骤 1 的三个接线测试块相应改为断言 followup 投递内容（见 `create-command.test.ts` 现行版本），步骤 3 实现块已同步为修订后代码。

- [ ] **步骤 5：验证记录**

记录步骤 4 的完整通过输出。

---

### 任务 3：apply 接线与回归断言

**文件：**
- 修改：`packages/toolkit/src/index.ts`（未接线，按步骤 3 接线）
- 测试：`packages/toolkit/src/index.test.ts:149-158`（追加断言）

**接口：**
- 依赖输入：任务 2 的 `setupCreateAgentCommand`。
- 对外产出：`apply` 注册命令清单新增 `create-agent`（恒启用，不随 modules 开关门控）。

- [ ] **步骤 1：编写失败的断言**

修改 `packages/toolkit/src/index.test.ts` 中 `describe('apply 模块接线与开关')` 的第一个用例（第 150 行 `test('默认配置：注册 /token-usage 命令、四个存储域、委派工具挂载路径', ...)`），在 `expect(h.commands).toContain('token-usage')` 之后追加一行：

```ts
    expect(h.commands).toContain('create-agent')
```

- [ ] **步骤 2：运行测试并确认结果**

运行：`pnpm --filter dsh-agent-toolkit exec vitest run src/index.test.ts`
预期：FAIL——`create-agent` 不在命令清单（尚未接线），继续执行步骤 3。

- [ ] **步骤 3：接线实现**

确认 `packages/toolkit/src/index.ts`：
- 顶部 import 区含 `import { setupCreateAgentCommand } from './agents/create-command.ts'`；
- `apply` 中 `setupAgentsApi(...)` 调用之前提取共用闭包 `const listTools = (): string[] => ctx.tools.schemas().map((s) => s.name)`，`setupAgentsApi` 的 `listTools` 字段改用该闭包；
- `setupAgentsApi(...)` 调用之后追加：

```ts
  // /create-agent 命令恒启用（引导主 Agent 访谈并复用面板 API 落库，不新增工具/API）。
  setupCreateAgentCommand(ctx, { registry, listTools })
```

修正后重跑步骤 2 确认通过。

- [ ] **步骤 4：运行 index.test.ts 全量确认通过**

运行：`pnpm --filter dsh-agent-toolkit exec vitest run src/index.test.ts`
预期：PASS（含新断言，无回归）。

- [ ] **步骤 5：验证记录**

记录步骤 4 的完整通过输出。

---

### 任务 4：全量验证（测试 + 类型检查 + 构建）

**文件：**
- 无新增/修改（纯验证任务）

**接口：**
- 依赖输入：任务 1-3 全部产出。
- 对外产出：三项验证命令的通过证据。

- [ ] **步骤 1：全量单测**

运行：`pnpm --filter dsh-agent-toolkit test`
预期：全部测试通过（361 + 新增 7 个用例，总数 368），无失败。

- [ ] **步骤 2：类型检查**

运行：`pnpm --filter dsh-agent-toolkit typecheck`
预期：exit code 0，无错误输出。

- [ ] **步骤 3：构建**

运行：`pnpm --filter dsh-agent-toolkit bundle`
预期：构建成功，产出 `packages/toolkit/lib/index.js`（Node 半）与 `packages/toolkit/lib/client.js`（浏览器半）。

- [ ] **步骤 4：验证记录**

汇总步骤 1-3 的通过输出，作为实施完成证据。
