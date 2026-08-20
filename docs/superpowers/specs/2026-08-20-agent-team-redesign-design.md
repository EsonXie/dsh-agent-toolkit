# agent-team 重构设计：扁平角色名册 + 一次性委派 + 自定义委派卡

日期：2026-08-20
状态：概念层已与用户逐节确认，待实现
范围：重构现有 `packages/agent-team`（私有包 0.0.0，无对外兼容负担）

## 1. 产品定义

**Agent 团队 = 一个「Agent 团队」preset + 一个 agent-team 插件包的组合，开箱即用。**

用户新建会话时在 preset 选择器选中「Agent 团队」，主 Agent 即获得把自包含子任务委派给预配置角色的能力。每个角色可配置提示词、模型供应商、模型与工具权限；未配置的项与主 Agent 一致。

### 用户旅程

1. 安装包（pnpm 安装 `agent-team` 到 profile）
2. cordis.yml 一次性登记两行：插件全局挂载行（`clientOnly: true`，仅让浏览器半进 boot 清单）+ preset root 指向包内 `presets/` 目录
3. 新建会话 → preset 选择器选「Agent 团队」→ 直接使用，内置 explorer/general 两角色即刻可派发
4. 想自定义：往 `$DSH_HOME/agent-team/roles/` 放一个 `<name>.yml` 文件即可；同名覆盖内置角色

### 概念模型

- **角色（Role）是唯一一级概念**（扁平列表，对标 opencode 的 agent 配置）。无"团队"层、无会话级选择状态、无 KV、无 dock、无 HTTP 路由。
- **成员**：被委派的角色实例 = 一次性子 Agent（spawn），拥有自己的独立子会话。
- **调度**：主 Agent 唯一入口是 `team_delegate(role, description, prompt)` 工具，前台等待，只拿回成员最后一条 assistant 消息作为结果。

### 非目标（首期明确不做）

- v2 可继续队友（`startContinuable` / `registerContinuableSetup` / send_message 续轮）
- 成员与用户的任何交互通道（子会话只读）
- 成员再委派（maxDepth 1 钉死）
- 后台/异步委派（run_in_background）
- 工具卡片以外的 UI（dock、侧边栏、设置页均不做）

## 2. 调研结论（dsh 源码已闭环，支撑上述设计）

子 Agent 机制（详见 `docs/2026-08-18-插件组技术可行性评估.md` 及 2026-08-20 补充调研）：

- `ctx.subagents.start(provider, request)` 一次性委派，`request` 携带 `persona`/`toolFilter`/`agentOptions{provider,model}`/`maxDepth`（`deepseek-harness/packages/subagent/subagent/src/types.ts:100-149`）
- **缺省继承语义**：`resolveChildAgentOptions` 以父 Agent 的 provider/model 为底、请求值覆盖——角色不配即等于主 Agent 配置，天然满足需求（`subagent/src/child-agent.ts:68-83`）
- **跨供应商可行**：provider 是 LLM 适配器注册表 key；角色配的 provider 名必须有已注册适配器，否则启动期 `NO_ADAPTER` 响亮失败（`packages/llm/llm/src/index.ts:816-820`）
- **persona 是遮蔽式 section**：注册为 `deployment:persona`（order 0）整体替换部署级 persona，不是尾部追加（`child-agent.ts:163-175`）。角色 persona 文案必须自足
- **toolFilter 硬约束**：`{allow?, deny?}` 精确工具名白/黑名单，无通配；未知工具名启动期 fail loud（`packages/core/tools/src/index.ts:676-685, 1071-1100`）
- **只回最后一条**：`SubagentResult.output` 契约即"子的最后一条非空 assistant 消息 content blocks"，与 `subagent/end.lastAssistantMessage` 同源（`types.ts:219-238`；`lifecycle.ts:147-154`）
- **子会话可见不可交互（原生免费）**：一次性子 session 持久化保留（`session-persistence/src/coordinator.ts:1117-1120` 无 origin 过滤），header 带 `parentSession`/`origin:'subagent'`；宿主 `ui-subagent` 在会话头提供子 Agent 目录（树形、实时 token/耗时、点击 `openSubagent` 打开只读视图）；client 层拒 `subagent-not-resumable`、host 层 `subagent.prompt` 只接受 continuable、ask_user 对子抛 `DELEGATED_CALLER`、approval 钉死 `never`（四层保障）

UI 展现机制（2026-08-20 调研）：

- 纯 Node 半的 `presentCall/presentResult` 能力有限：generic 卡的 `title`/`rawInput`/`content` **Web 端不渲染**（无消费方）；只有 5 种结构化卡（terminal/diff/read/search/web）真正影响 UI，均不适合委派场景
- 工具卡片**无法**经 present* 携带跳转链接（无链接字段、ContentBlock 无 link 类型、Web 无 URL 深链）
- 自定义卡片唯一路径：浏览器半注册 keyed `tool.call.toolview` 槽位渲染器（`packages/client/ui-tool/src/client/contract/slots.ts:23`），组件内调 `sessions.openSubagent({parentSessionId, childSessionId, mode})`（`packages/client/runtime/src/client/contract/sessions.ts:46`）
- 运行中无中间进度机制；长任务只有 running 扫光，实时过程须点开子会话看

UI 风格体系（2026-08-20 调研，必须遵守）：

- **CSS Modules + clsx，禁止组件库/Tailwind**（`deepseek-harness/docs/web-styling.md:15`）；浏览器半 CSS 由 tsdown+lightningcss 编译注入
- 设计 token 只许消费 `--dsw-alias-*` 语义别名层；禁止 `--dsw-static-*` 原始色板；禁止组件 CSS 写主题选择器（暗黑靠 `body[data-ds-dark-theme]` 全局切换）
- 字号用 `--dsw-font-*` 角色（字号行高配对）
- 卡片几何/交互一致模式：单行 24px、默认折叠、整行 toggle（click/Enter/Space）、展开体 260px 内滚、running 扫光、状态纯颜色必须配 visually-hidden 文本
- 第三方渲染器官方姿态 = `bash-sample.tsx`：不 import 宿主 chat 域内部件，只依赖 `ToolCallViewProps` + 自带 module.css 复刻几何（`packages/client/ui-tool/src/client/toolviews/bash-sample.tsx:56-164`）
- i18n：插件自带 `locales.ts`（zh 真源 + en 键集一致），`ctx.locale.register(NS, {zh, en})` + `LocaleNamespaceMap` 声明合并（照 `ui-subagent/src/client/locales.ts`）
- 测试：vitest + testing-library + jsdom（per-file pragma），断言用户可见行为不断言 class 名

## 3. 目标形态

```
packages/agent-team/
├─ package.json          ← 两半同包：exports "." = src/index.ts（tsx 直跑），"./client" = lib/client.js；
│                          dsh.client manifest（platform web，inject client-runtime + ui-tool）
├─ src/
│   ├─ index.ts          ← Node 半：名册加载合并 → 注册 team_delegate + 团队提示段；clientOnly 早退
│   ├─ roles.ts          ← Role schema（zod）+ 单文件解析校验 + 目录加载（重构）
│   ├─ roster.ts         ← 两层来源合并：内置常量 ← 用户目录（新文件，从 roles.ts 拆出）
│   ├─ builtin-roles.ts  ← 内置 explorer/general 定义（persona 文案）（新文件）
│   ├─ prompt.ts         ← 成员提示词分层（A 身份契约 / B 能力守则 / C 模型适配）+ 角色 persona（保留微调）
│   ├─ tool.ts           ← team_delegate 工具定义（重构：透传 toolFilter、result 增 childSessionId）
│   └─ client/
│       ├─ index.ts      ← 浏览器半入口：注册 locale + keyed toolview
│       ├─ locales.ts    ← zh 真源 + en
│       ├─ delegate-card.tsx       ← 委派卡渲染器（bash-sample 姿态）
│       └─ delegate-card.module.css
├─ presets/team/
│   ├─ preset.yml        ← 展示名「Agent 团队」
│   └─ agent.cordis.yml  ← 薄壳：挂 agent-team 一行（不再带 teams/ 名册）
└─ tests/                ← vitest（Node 半纯逻辑 + 浏览器半 jsdom 组件测试）
```

**拆除清单**（相对现状）：`teams.ts`（TeamState 状态机）、`types.ts` 中团队视图类型、KV domain（selected_team）、`/agent-team` HTTP 路由、团队 dock 全部浏览器半代码、`presets/team/teams/`。`Config` 移除 `teamsDir`/`defaultTeam`。

## 4. 角色 schema 与名册管线

### Role

```yaml
# $DSH_HOME/agent-team/roles/explorer.yml —— 一角色一文件，文件名即角色名
name: explorer            # 字母数字+-_；省略时取文件名
description: 快速只读代码库探索……   # 必填；主 Agent 选角的唯一依据
persona: |                # 必填；遮蔽式 section，文案须自足
  ……
provider: anthropic       # 可选；缺省继承主 Agent
model: claude-sonnet-4    # 可选；缺省继承主 Agent
tools:                    # 可选；缺省不限制
  deny: [write, edit]
```

- `provider`/`model` 可独立缺省（`resolveChildAgentOptions` 逐项回退父级）
- `tools` 原样透传为 `request.toolFilter`；**空 filter（allow/deny 都没有）拒绝加载**（宿主语义）；未知名 fail loud 由宿主 restrict 保证，文档需注明"deny 清单里的工具名必须在宿主组合中存在"
- `name` 可省略，缺省取文件名（去 `.yml`）；若显式填写则**必须与文件名一致**，不一致在激活期响亮报错；按最终 name 去重（用户目录内重名即非法）

### 名册解析管线（`roster.ts`）

```
resolveRoster(userRolesDir):
  1. builtin:  BUILTIN_ROLES（builtin-roles.ts 的 TS 常量：explorer + general）
  2. userDir:  $DSH_HOME/agent-team/roles/*.yml
               — 目录不存在/为空 → 静默跳过（正常态）
               — 目录存在但某文件非法 → 响亮抛错，fiber FAILED（激活失败，原因进日志）
合并：Map<roleName, Role>，用户同名覆盖内置
产出：Role[]（内置保底，恒非空）
```

- `$DSH_HOME` 解析用 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()`（env `DSH_HOME` > `~/.dsh`），新增该 link 依赖；不走宿主 `dshHomePath` 可选服务
- **HMR 语义**：名册在插件激活期读一次；改 roles/*.yml 不热更新，重挂 preset/重启生效（与现状名册语义一致）。文档注明
- 覆盖关系写激活日志一行（`agent-team: 角色 explorer 被用户级名册覆盖`）

### 内置角色

| 角色 | description | tools | 模型 |
|---|---|---|---|
| explorer | 快速只读代码库探索：定位文件/符号、回答结构与调用关系问题，不做任何修改 | `deny: [write, edit]`（bash 保留，只读靠工具硬禁写 + persona 软约束双保险） | 继承主 Agent |
| general | 通用多步骤任务执行：可读可写、可运行命令，完成实现/修复类任务 | 不限制 | 继承主 Agent |

persona 文案迁移自现状 `presets/team/teams/default.yml`（内容已被验证），入 `builtin-roles.ts` 常量。

## 5. 调度工具 team_delegate

模型可见参数：`role`（必填）、`description`（必填，3-5 词任务标题）、`prompt`（必填，自包含任务书）。工具 description 为静态通用文案；**角色名册经系统提示段动态对模型可见**（standing 注册的工具 description 无法内嵌名册——现状设计保留）。

执行路径（重构点加粗）：

1. 按 `exec.agent` 所在会话解析当前名册，查 `role`；未知名报错并列出可用角色
2. **构造 `toolFilter`**：角色配了 `tools` 则透传
3. `buildMemberPersona(role, model, templates)` 拼装成员系统提示词（A/B/C + persona）
4. `ctx.subagents.start('spawn', { label: 'role:<name>: <description>', prompt, parent, persona, toolFilter?, agentOptions?, maxDepth: 1, signal })`
5. **`childSessionId` 捕获**：本地 run 的 `run.id` 契约上**就是**子 session id（"For a local run, this MUST equal the published child session id"，`types.ts:249-255`），直接写入结果，无需额外查询
6. `await run.result` → 规范 JSON 返回；`dispose` 用 allSettled 不掩盖结果失败（现状逻辑保留）

结果 schema（v2）：

```json
{ "kind": "foreground", "role": "explorer", "runId": "…", "childSessionId": "…", "output": […] }
```

- 非 completed 停因（aborted/error/max-tokens/refusal）→ 错误 + 成员中断前部分产出文本（现状 `withPartialText` 保留）
- `isConcurrencySafe: () => true`：同一条 assistant 消息允许多个 team_delegate 并发派发
- `maxDepth: 1` 钉死：成员（深度 1）再委派时 provider 响亮拒绝
- provider 能力守卫保留：激活/挂载时校验 `capabilities.persona` 与 `capabilities.depthLimit`，缺失响亮报错；镜像 provider 生命周期挂载/摘除工具（现状逻辑保留）

## 6. 系统提示词团队段

保留现状机制：`ctx.systemPrompt.section({ name: 'plugin:agent-team', order: 116.6, text: (ctx) => … })`，函数式 text 按组装上下文的 agent 求值，列出当前可用角色 `name: description` 清单。文案从"当前团队：…"改为扁平名册措辞。

## 7. UI 展现：自定义委派卡

### 架构

- 浏览器半唯一职责：注册 keyed `tool.call.toolview` 渲染器（key = Config.toolName，默认 `team_delegate`）
- 注册写法照 `read-row.tsx:54-65`：`ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name, key, locale: NS }, DelegateCard))`
- 组件姿态照 `bash-sample.tsx`：只依赖 `ToolCallViewProps` + 自带 `delegate-card.module.css`，不 import 宿主 chat 域内部件
- Node 半 `presentCall`/`presentResult` 保留 generic 兜底（回放安全 + 浏览器半缺席时降级）；注意 generic title 在 Web 不渲染，兜底显示 = `team_delegate · <description>` 摘要行 + args JSON + 结果文本

### 卡片内容

- 折叠行（24px，整行 toggle）：角色 chip（`--dsw-alias-*` 自绘）+ 任务描述 + 状态（running 扫光 / done / error，配 visually-hidden 文本）
- 展开体：prompt 全文（折叠可展开）→ 完成后结果文本（成员最后一条消息，MarkdownText 渲染）
- 「查看子对话」按钮：result 含 `childSessionId` 时显示，点击调 `sessions.openSubagent({ parentSessionId, childSessionId, mode: 'one-shot' })` 打开只读子会话。`parentSessionId` 从会话 scope 取当前会话 id——`tool.call.toolview` 是 `scope: 'session'` 槽位，卡片必在某会话视图内，照 ui-subagent 目录按钮同源做法（`SubagentCatalogAction.tsx:298-301` 的 openChild 路径）取当前会话
- 失败态：错误摘要 + 成员部分产出

### 风格合规（硬约束）

- 每组件一个 `.module.css` + `clsx`；token 只用 `--dsw-alias-*` / `--dsw-font-*`；不写主题选择器
- 24px 行高、默认折叠、整行 toggle、260px 展开内滚、visually-hidden 状态文本
- i18n：自建 `agent-team` 命名空间（zh 真源 + en 同键集），`ctx.locale.register` + `LocaleNamespaceMap` 声明合并
- 包依赖照 ui-tool peerDeps 集：`dsh-client-runtime` / `dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-ui-tool`（槽位类型）+ react 18 / clsx

## 8. preset 与安装形态

- `presets/team/` 薄壳：`preset.yml`（展示名「Agent 团队」）+ `agent.cordis.yml`（挂 agent-team 一行，config 全省略）
- **preset 内插件引用方式**：现状是绝对路径（复制后须手改）。目标改为裸包名 `agent-team`，依赖 profile 的 `node_modules` 平铺 fallback 解析（`deepseek-harness/packages/boot/app-boot/src/profile.ts:19,205` 机制）。**实现时需验证**：preset 行裸包名是否经 profile node_modules 解析成功；若不可行，则保留绝对路径并在 README 写明复制后改路径的步骤（现状行为）
- cordis.yml（部署方）两行：preset root 指向包内 `presets/`（`trust: 'system'`）+ 全局 `clientOnly: true` 挂载行（浏览器半进 boot 清单）
- 双挂载点约束沿用现状（AGENTS.md 已记录）：preset 内挂载跑真实工作，全局 clientOnly 空转

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| 用户 roles 目录某文件非法 | 激活期响亮抛错（fiber FAILED），原因进日志 |
| 角色 provider 无适配器 | 委派时宿主 `NO_ADAPTER` 响亮失败（宿主语义，不拦截） |
| toolFilter 含未知名 / 空 filter | 委派时宿主 fail loud；文档注明约束 |
| 模型传未知 role | 工具报错并列出可用角色（现状保留） |
| 成员非 completed 结束 | 工具错误 + 成员部分产出文本（现状保留） |
| 浏览器半缺席 / 回放旧事件 | present* generic 兜底，软失败不落 generic 之外的卡 |

## 10. 测试策略

- **roles/roster**（纯逻辑）：schema 校验、目录加载、内置兜底、同名覆盖、非法文件响亮报错
- **tool**：注入假 `startRun`，验证 request 构造（persona/toolFilter/agentOptions/maxDepth/label）、result 组装（含 childSessionId）、非 completed 映射、并发安全声明
- **prompt**：A/B/C 分层拼接、模型族匹配、模板覆盖
- **浏览器半**：jsdom + testing-library，断言用户可见行为（角色 chip 文案、折叠/展开交互、查看子对话按钮的出现与点击调用、错误态）；照 `tool-row.client.spec.tsx` 先例
- 门禁：`pnpm --filter agent-team test` + `typecheck`；src 改动后 `bundle`（两半同出）

## 11. 对仓库文档的连带更新

实现完成后需同步更新 `AGENTS.md`：agent-team 条目（扁平角色、纯 UI 为委派卡、用户级 roles 目录、内置角色兜底；移除 teams/dock/KV/路由相关描述）。
