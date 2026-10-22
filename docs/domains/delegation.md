# 委派（现行事实）

> 本文是该功能域**现行状态**的权威描述（2026-09-10 自 AGENTS.md 拆出）；改动该域时同步本文。「为什么这样设计」的决策考古见 `docs/superpowers/specs/archive/`。

## team_delegate 与 0.2.1 startActivation 模型

委派由 `team_delegate`（前台一次性）完成。dsh 0.2.1 删除 `ctx.subagents.start`，改 `ctx.subagents.startActivation(spec)`：`spec = { provider, label, request, signal, delivery }`，`delivery: 'caller'` 前台等待——result 作为工具返回值回到父会话，父会话不收委派消息。请求不内联 persona/toolFilter（0.2.1 已删）也不选独立 agentPreset（会丢失父 preset 的工具面）；`maxDepth: 1` 禁止套娃（成员深度 1 再委派时 childDepth 2 > 1，provider 响亮拒绝）；角色 model 覆盖（provider/model，字段空串视为未配置）进 `request.agentOptions`。能力守卫：provider capabilities 缺 `depthLimit`/`agentOptions` 任一则响亮报错不挂载；工具随 provider 在场与否挂载/摘除（`subagent/provider-added`/`removed` 事件镜像），`provider-removed` 后再次出现可重挂。

## 角色组合：子 scope 叠加 persona 与工具白名单

0.2.1 的显式 `agentPreset` 是**完整组合**，不会继承父 Agent 的 preset；把角色白名单做成角色 preset 只会得到一个没有工具插件的空组合。因此 `team_delegate` 请求**不设置 `agentPreset`**，子 Agent 通过 `composeFrom` 继承父 Agent 的完整 preset（fs/shell 等工具随父面可见），随后由 `setupRoleComposition`（`delegate/role-composition.ts`）在 `agent/created` 监听器中按 descriptor label（`role:<id>: ...`）在**子 Agent scope** 叠加：

- **persona**：注册 `deployment:persona-prefix` 段（遮蔽父 preset 的同名段），order 取 `DEPLOYMENT_PERSONA_PREFIX`；prefix 中的 `{{…}}` 由宿主 systemPrompt 严格插值，persona 文案禁止字面量双花括号。
- **工具白名单**：`tools.restrict({ allow })`。restrict 过滤继承面（父 preset + global），own 层不受影响；白名单先与子会话当前 `tools.schemas(childScope)` 求交，未知名与 `run_code`（保留传输名）warn-drop；求交为空仍应用 `allow: []`（fail-closed，成员无工具）。`role.tools` 省略 = 不限制。

`agent/created` 是串行 await 的创建期通知，首条 prompt 在其后入队；冷恢复同样经过该监听器。`agentPresets` 不再是委派硬依赖。

## settle 语义

`settleForeground`（`delegate/tool.ts`）：`Promise.allSettled` 并行等待 `activation.result` 与 `activation.dispose()`——非 `completed` 的 stopReason 映射为错误（aborted=被取消 / error=运行失败 / max-tokens=触及上限 / refusal=拒绝），报错时附成员中断前的部分文本产出，让截断/取消的真实产出仍回到主 Agent；result 与 dispose 双失败聚合为 `AggregateError`，dispose 失败不掩盖独立的结果失败。工具 output schema：`{ kind: 'foreground', role, runId, childSessionId, output, provider?, model? }`，render 拼文本块，presentationMeta 持久化子会话坐标（委派卡回放数据源）。

## 路由持久化与子会话 chip

委派路由持久域 `dsh_agent_toolkit_routes`（表 `routes`，key=childSessionId），schema 单一来源在 `src/delegate/routes.ts`；子会话头部 chip 经 `GET /dsh-agent-toolkit/api/delegate/route` 读取。浏览器半委派卡含 `provider / model` chip：运行中读在途端点（`src/delegate/active.ts` 进程内 ActiveRoutes，`startActivation` 前写入、try/finally settle 后删除，HMR/重启即清空），结束后读 presentationMeta 兜底。路由解析与 spawn driver `resolveChildAgentOptions` 同源：角色覆盖 ?? 父 options，字段空串视为未配置，任一缺失整体省略。

## 名册段

团队名册段（delegate/index.ts `teamSectionText`）按 `tools.get(name, scope)` 联动工具可见性——白名单 restrict 掉委派工具或 provider 未挂载的会话不再出现委派段落（restrict 只作用 tools 视图，管不到 systemPrompt sections，须段落自查）；段 order 动态取 `ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 0.1` 紧随内置 subagent 指导段（0.1.5 起该段 2800），随宿主重排而非硬编码。
