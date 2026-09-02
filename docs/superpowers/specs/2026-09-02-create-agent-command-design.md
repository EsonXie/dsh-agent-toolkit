# /create-agent 交互式创建 Agent 命令 — 设计规格

日期：2026-09-02
状态：已批准（对话确认）
所属包：`packages/toolkit`（dsh-agent-toolkit）

## 背景与目标

Agent 团队（Agents 面板管理的注册表）目前只能在 UI 面板手动创建 Agent，或经 YAML 首启导入。本设计新增一个 slash 命令 `/create-agent`，让用户在会话中以对话方式创建 Agent：命令返回一段引导文本，驱动当前会话的主 Agent 完成「访谈澄清 → 推荐配置 → 用户确认 → 落库」全流程。

原始需求工作流：
1. 用户需求不够明确时，以提问方式明确需求，整体提问不超过 5 次；
2. 根据确认的需求，推荐 Agent 名称、描述、persona 个性和可使用的工具，输出给用户确认；
3. 用户有修改意见时，按意见修改名称、描述、个性和工具后再次确认。

## 关键约束（宿主能力核实结论）

- slash 命令由 UI 适配器在用户敲入时调 `CommandRuntime.execute` 分发，`CommandSourceMap` 仅 `user` 一种来源，命令**不经模型**——主 Agent（LLM）无法直接触发任何 slash 命令（`deepseek-harness/packages/interaction/commands/src/index.ts:296`、`types.ts:54-57`）。
- 因此否决了「save 落库子命令由主 Agent 直接调用」与「新增 create_agent 常驻工具」两个方案：
  - 前者技术上不成立（模型无命令触发通道）；
  - 后者被用户否掉（常驻工具污染所有会话的工具面）。
- 选定落库通道：**复用 Agents 面板既有 HTTP API**，主 Agent 用其已有 shell 工具调用。零新增工具面、零新增 API。
- `webServer` 服务暴露 `host`（'127.0.0.1' | '0.0.0.0'）与 `port`（实际监听端口）（`deepseek-harness/packages/host/webserver/src/index.ts:78-86`）；本机回环恒可达，origin 恒用 `127.0.0.1`。
- 面板创建端点为 `PUT /dsh-agent-toolkit/api/agents/<id>`，服务端已做 zod 校验（`AgentRecordSchema`）、剥离 `builtin`、id 以路径为准（`packages/toolkit/src/agents/api.ts:58-87`）。

## 架构与组件

新增单文件 `packages/toolkit/src/agents/create-command.ts`，含两个导出：

- `buildCreateAgentGuidance(input: CreateAgentGuidanceInput): string` — 纯函数，拼装引导文本。输入：
  - `requirement: string` — 命令行内联需求（已 trim，可空串）
  - `agentIds: string[]` — 现有 Agent id 列表（含 main）
  - `globalTools: string[]` — 顶层注册表全局工具名
  - `origin: string | undefined` — web 宿主回环 origin（如 `http://127.0.0.1:3080`）；`undefined` = headless/CLI 降级
- `setupCreateAgentCommand(ctx, deps: { registry: AgentRegistry; listTools(): string[] }): void` — 经 `ctx.commands.register` 注册命令。

在 `packages/toolkit/src/index.ts` 的 `apply` 中接线：提取 `listTools` 闭包（与 `setupAgentsApi` 共用），调用 `setupCreateAgentCommand(ctx, { registry, listTools })`。`commands` 已在 inject 中，无需改动 inject/Config。

**无新工具、无新 API、无存储变更、无配置项、无浏览器半改动。**

## 命令行为

| 调用形态 | 行为 |
|---|---|
| `/create-agent` | 返回完整引导文本 |
| `/create-agent <需求描述>` | 返回引导文本，另附「用户初始需求」节（见下） |

无其他子命令。命令元数据：
- `name: 'create-agent'`
- `description: '交互式创建 Agent 团队成员：访谈澄清需求 → 推荐配置 → 确认后经面板 API 落库'`
- `input.hint: '初始需求描述，可空'`

handler 逻辑：经 `ctx.get('webServer')`（可选服务，按仓库规则不走 inject）读取 port 组装 origin `http://127.0.0.1:<port>`；`registry.list().map(a => a.id)` 取现有 id；`listTools()` 取全局工具名；调用纯函数返回 `{ kind: 'success', text }`。handler 无失败路径（纯文本组装）。

## 引导文本契约（模型面，中文完整指令）

固定四节结构，另在内联需求非空时插入「用户初始需求」节：

1. **工作流**（三步）：
   - 澄清需求：需求不明确时用 `ask_user_question` 提问，整个流程提问总次数不超过 5 次，不重复问已确认信息；
   - 生成推荐并请用户确认：`id` / `name` / `description` / `persona` / `tools` 五字段（字段语义见下）；
   - 迭代：用户有修改意见时按意见修订后再次确认。
2. **现有 Agent id 列表**：动态嵌入，标注不可复用；附 id 规则（小写字母开头、仅 `[a-z0-9-]`、最长 32 字符）。
3. **可用工具清单**：原生工具（`NATIVE_TOOL_NAMES`，7 个）+ 全局工具（动态）。说明：省略 `tools` = 不限制；一旦给白名单则 Agent 只有列出的工具可用，通常应保留原生工具，否则失去读文件/搜索/执行命令等基本能力（最终取舍由主 Agent 按需求判断，如只读角色可去掉 write/edit）。
4. **落库节**：见下节。

**用户初始需求节**（仅内联需求非空时）：`用户已在命令中提供初始需求：「<requirement>」。请据此减少提问轮次，仅就不明确的点提问。`

## 落库与防呆

用户明确确认后，主 Agent 用其 shell 工具执行：

1. `GET <origin>/dsh-agent-toolkit/api/agents` 复核所选 id 未被占用（PUT 是 upsert 语义，此为防覆盖软约束之一，另一道是引导文本内嵌的现有 id 列表）；
2. `PUT <origin>/dsh-agent-toolkit/api/agents/<id>`，请求体 JSON：`{"name":"...","description":"...","persona":"...","tools":{"allow":["..."]}}`；`description`/`persona`/`tools` 均可省略，**body 不携带 id/builtin**；附可直接照抄的 curl 示例（Windows pwsh 下用 `curl.exe`）；
3. **防呆（硬约束写入引导文本）：PUT 返回 200 后必须再 `GET /dsh-agent-toolkit/api/agents`（列表端点，/agents/<id> 仅支持 PUT/DELETE），在返回列表中找到该 id 的记录，把关键字段展示给用户作为落库证据**——防「口头声称已创建但实际未执行/失败」；
4. 返回 4xx 时把错误信息展示给用户，修正后重试。
5. 落库成功后告知用户可在 Agents 面板查看、并可被 team_delegate 委派。

## 错误处理与降级

- **无 webServer（headless/CLI）**：`origin` 为 `undefined`，落库节整体替换为降级文案——「当前宿主无 web 服务，无法自动落库。用户确认推荐后，请把最终配置完整输出给用户，并提示其打开 Agents 面板按推荐内容手动创建。」访谈与推荐流程照常。
- 命令 handler 本身不抛错；API 侧校验失败（zod/409）由引导文本第 4 条兜底（展示错误、修正重试）。

## 测试（vitest，`packages/toolkit/src/agents/create-command.test.ts`）

纯函数 `buildCreateAgentGuidance`：
- 无参（`requirement: ''`）：含工作流/现有 id/工具清单/落库四节，不含「初始需求」节；
- 带需求：含「用户初始需求」节且嵌入原文；
- `origin: undefined`：输出降级文案，不含 `PUT`；
- 现有 id 列表与工具清单（原生 + 全局）正确嵌入文本。

接线 `setupCreateAgentCommand`（mock ctx 捕获 handler）：
- `ctx.get('webServer')` 返回 `{ port: 3080 }` 时，handler 返回 `kind: 'success'` 且文本含 `http://127.0.0.1:3080`；
- `ctx.get('webServer')` 返回 `undefined` 时输出降级文案；
- `rawInput` 带需求时 trim 后进入「初始需求」节。

回归：`src/index.test.ts` 的命令清单断言需包含 `create-agent`（如现有断言为全量清单则同步更新）。

## 明确不做（YAGNI）

- 不推荐/设置 `model` 字段（需求未提）；
- 无 `save` 等任何子命令；
- 不新增工具、不新增/修改 HTTP API、不动存储 schema；
- 不支持覆盖已有 Agent（id 冲突靠软约束 + 用户确认拦截；PUT 本身 upsert 语义不改）；
- 不做浏览器半 UI（结果在会话内文本呈现，面板刷新由既有 subscribe 通知覆盖）。
