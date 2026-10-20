# 委派（现行事实）

> 本文是该功能域**现行状态**的权威描述（2026-09-10 自 AGENTS.md 拆出）；改动该域时同步本文。「为什么这样设计」的决策考古见 `docs/superpowers/specs/archive/`。

## team_delegate 与 0.2.1 startActivation 模型

委派走 `team_delegate`（前台一次性）。dsh 0.2.1 删除 `ctx.subagents.start`，改 `ctx.subagents.startActivation(spec)`：`spec = { provider, label, request, signal, delivery }`，`delivery: 'caller'` 前台等待——result 作为工具返回值回到父会话，父会话不收委派消息。请求只按角色选 preset（`request.agentPreset = rolePresetId(role.id)`，不再内联 persona/toolFilter 请求字段），`maxDepth: 1` 禁止套娃（成员深度 1 再委派时 childDepth 2 > 1 被 provider 响亮拒绝）；角色 model 覆盖（provider/model，字段空串视为未配置）进 `request.agentOptions`。能力守卫：provider capabilities 缺 `agentPreset`/`depthLimit`/`agentOptions` 任一则响亮报错不挂载；工具随 provider 在场与否挂载/摘除（`subagent/provider-added`/`removed` 事件镜像），`provider-removed` 后再次出现可重挂。

## 角色 preset：persona 与工具白名单的承载

0.2.1 删除 `SubagentStartRequest` 的 `persona`/`toolFilter` 字段，子代理 persona 与工具构成改由所选 agent preset 的组合承载。每角色一个 preset，`setupRolePresets`（`delegate/role-preset.ts`）初始注册全部团队可见角色（main 排除）并订阅名册变更做增/改/删联动（改 = 先 dispose 再注册，宿主对重复 id 抛错；简化策略：任何名册变更都重建该角色 preset），全部 disposer 接 `ctx.effect` 随插件卸载/HMR 自动注销。

- **id 规约**：`rolePresetId(roleId)` = `dsh-agent-toolkit-role-<slug>`（slug = 角色 id 小写化、非 `[a-z0-9]` 串折叠为 `-`、去首尾连字符；无法 slug 化为合法 preset id 则 warn 跳过该角色）。
- **组合行**：本包 bundle 产物经 package exports 自引用的两个子路径组合行插件——`dsh-agent-toolkit/role-persona`（角色 preset 的 agent 作用域内注入 `deployment:persona-prefix` 段，order 取 `DEPLOYMENT_PERSONA_PREFIX`；prefix 中的 `{{…}}` 由宿主 systemPrompt 严格插值，persona 文案禁止字面量双花括号）+ `dsh-agent-toolkit/role-tools`（同作用域 `tools.restrict({ allow })` 白名单，等价旧 `toolFilter: { allow }` 语义）。
- **白名单求交**：注册 preset 时与全局工具面求交，未知名与 `run_code`（保留传输名）warn-drop；求交为空不挂 tools 行（`role.tools` 语义退化为不限制）。委派请求侧不再做求交（子会话工具面完全由 preset 组合决定）。
- `agentPresets` 为可选服务经 `ctx.get` 读取，缺席 warn 跳过（委派将无 persona/白名单），不影响插件其余功能。集成门禁 `preset-mount.spec.ts` 验证组合行在真实宿主 registry 下可挂载且 persona 段/白名单生效。

## settle 语义

`settleForeground`（`delegate/tool.ts`）：`Promise.allSettled` 并行等待 `activation.result` 与 `activation.dispose()`——非 `completed` 的 stopReason 映射为错误（aborted=被取消 / error=运行失败 / max-tokens=触及上限 / refusal=拒绝），报错时附成员中断前的部分文本产出，让截断/取消的真实产出仍回到主 Agent；result 与 dispose 双失败聚合为 `AggregateError`，dispose 失败不掩盖独立的结果失败。工具 output schema：`{ kind: 'foreground', role, runId, childSessionId, output, provider?, model? }`，render 拼文本块，presentationMeta 持久化子会话坐标（委派卡回放数据源）。

## 路由持久化与子会话 chip

委派路由持久域 `dsh_agent_toolkit_routes`（表 `routes`，key=childSessionId），schema 单一来源在 `src/delegate/routes.ts`；子会话头部 chip 经 `GET /dsh-agent-toolkit/api/delegate/route` 读取。浏览器半委派卡含 `provider / model` chip：运行中读在途端点（`src/delegate/active.ts` 进程内 ActiveRoutes，`startActivation` 前写入、try/finally settle 后删除，HMR/重启即清空），结束后读 presentationMeta 兜底。路由解析与 spawn driver `resolveChildAgentOptions` 同源：角色覆盖 ?? 父 options，字段空串视为未配置，任一缺失整体省略。

## 名册段

团队名册段（delegate/index.ts `teamSectionText`）按 `tools.get(name, scope)` 联动工具可见性——白名单 restrict 掉委派工具或 provider 未挂载的会话不再出现委派段落（restrict 只作用 tools 视图，管不到 systemPrompt sections，须段落自查）；段 order 动态取 `ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') + 0.1` 紧随内置 subagent 指导段（0.1.5 起该段 2800），随宿主重排而非硬编码。
