# Agent 团队插件设计（团队模式 preset + 会话内团队选择）

> 日期：2026-08-18（2026-08-19 第三次修订：standing scope 语义修正——preset 插件实例按 preset 代共享、跨会话单例（`agent-presets/src/index.ts:491-534`），`ctx.agent` 在 standing scope 恒 undefined（`core/agent/src/index.ts:40-48`），v2 的"按会话挂载"假设不成立。团队状态改 `Map<sessionId, TeamState>` 懒建；名册对模型可见性改走 prompt section 函数 text（按 agent 求值，`system-prompt/src/index.ts:67,514`）；工具单次共享注册 + execute 按会话校验；路由改 prefix；浏览器半接入 = 同一包在 cordis.yml 全局挂 `clientOnly: true` 行（单 npm 包，不拆包）。另修正：激活期失败不标 preset broken（broken 仅限 discovery，真实报错在 chip hover title / select RPC reason）。第二版：取消 /team 命令与 team/selected 会话事件，改 HTTP + KV。）
> 依据：`docs/2026-08-18-插件组技术可行性评估.md`（源码闭环）+ 三轮设计讨论与一次真机调试（v2 激活崩溃与浏览器半时序均已源码实证定位）
> 状态：设计已获用户确认，待实现

## 1. 核心命题

- **preset = "团队模式"入口**：preset 的选择/复制/删除/设默认全部复用原生 preset 机制与 Web UI，插件不自建团队管理界面。
- **团队 = preset 目录内 `teams/` 下的名册文件**：每团队一个 `teams/<id>.yml`（格式见 §4），一个 preset 可装多个团队；无全局 `Config.teams`，无合并语义。
- **会话内团队选择（blank 期限定）**：会话为空（无 `turn/start` 事件）时，用户经输入框上方 dock 下拉切换团队；**首条消息发出后锁定**（UI 禁用 + 宿主 POST 拒绝，双层强制）——与官方 preset chip"A control that spends most of its life disabled belongs on the screen where it still works"同哲学。**无 /team 命令**：锁定语义下命令唯一的用途就是 blank 期切换，UI 下拉已完全覆盖，命令只会带来第二条需要守护的写路径。
- **选择结果持久化 = 插件自有 KV**（`storageDomain` KvTable，key = sessionId，value = teamId；token-usage `ctx.storageDomain.open` 先例）：**不写任何自定义会话事件**。blank 期刷新恢复已选团队；已开始会话重载/跨进程恢复时名册与锁定团队一致。
- **委派 = 一次性 spawn 子 Agent**：主 Agent 自主决策，前台同步等待结果。不做后台并行、不做长期队友、不做角色 scoped 注入（评估报告 §1.4）。
- **插件 = Node 半 + 浏览器半 bundle**（token-usage 同款结构）：Node 半管名册/工具/切换状态机，浏览器半管 dock 下拉。
- **挂载模型 = standing scope，按 preset 代共享（v3 修正）**：preset 插件实例按 preset id 每代一个、**跨会话单例**（`agent-presets/src/index.ts:491-534`，注释 "held for whole-tree teardown, never per-session"），且 **`ctx.agent` 在 standing scope 恒 undefined**（agent 经 dsh-scope `bindScopeParent` 路由绑定而非 cordis 父子，`core/agent/src/index.ts:40-48`）。因此：禁止在 apply 期触碰 `ctx.agent`；团队状态为 `Map<sessionId, TeamState>` **惰性建**（首次触碰时创建，KV 恢复）；按 sessionId 经 host 根服务 `ctx.sessions`/`ctx.agents` 访问会话（`core/session/src/index.ts:1055-1057`、`core/agent/src/index.ts:583-585`）；`ctx.on('session/disposed')` 清理 Map。
- **单 npm 包、双挂载点**：preset 内挂同一包（Node 半真实工作）；cordis.yml 全局挂一行 `config: { clientOnly: true }`——Node 半立即返回（纤维 ACTIVE 即可），作用仅是**让 `dsh.client` 进浏览器 boot 清单**（client-modules 扫描只要求活 fiber），否则浏览器半依赖"建会话后刷新整页"的脆弱时序（boot 图页载定格、无新增行推送）。忘配 `clientOnly` 时全局挂载撞 `loadTeams` 响亮报错（fail loud，不致错乱）。

## 2. 包结构

```
packages/agent-team/
├─ package.json          ← peerDeps 拷贝 ACP 依赖集 + 浏览器半所需 client 包
├─ tsconfig.json
├─ tsdown.config.ts      ← 浏览器半 bundle（照 token-usage 先例）
├─ src/
│   ├─ index.ts          ← Node 半入口：命名导出 name/inject/Config/apply（无 default export）
│   ├─ types.ts          ← 纯类型：HTTP GET/POST 的 wire 契约（Node 半/浏览器半/测试共用）
│   ├─ roles.ts          ← teams/*.yml 加载 + Schemastery 校验（多文件）
│   ├─ prompt.ts         ← 两层提示词拼装
│   ├─ tool.ts           ← team_delegate 工具（含 presenter）
│   ├─ teams.ts          ← 团队状态机：当前团队 ref、trySelect、blank 锁定（纯逻辑；每会话一个实例）
│   └─ client/
│       ├─ index.ts      ← 浏览器半入口：slots.inject 注册 TeamDock
│       └─ TeamDock.tsx  ← 团队下拉组件（纯 props，fetch 由 inject 面注入）
└─ presets/team/         ← 随包发行的示例"团队模式" preset
    ├─ agent.cordis.yml  ← 挂载本插件（config 可全省略）
    ├─ preset.yml        ← name/description/order（仅展示文本）
    └─ teams/            ← 默认团队名册 default.yml（v3 定案：opencode 风格两角色——
                           explorer 快速只读探索 / general 通用多步骤执行；不内置第二团队）
```

## 3. 插件 Config

```ts
Config = {
  teamsDir?: string         // 默认 './teams'，相对 preset 目录（经 ctx.baseUrl 解析，
                            // preset 挂载时 baseUrl 被重写到 preset 目录，
                            // agent-presets/src/mount.ts:48 及 cordis preset skills 先例）
  defaultTeam?: string      // 默认团队 id；缺省取 teams/ 下按文件名字典序第一个
  provider?: string         // 默认 'spawn'
  toolName?: string         // 默认 'team_delegate'
  clientOnly?: boolean      // cordis.yml 全局挂载用：true 时 Node 半立即返回，
                            // 仅让浏览器半 bundle 进 boot 清单（见 §1 双挂载点）
  promptTemplates?: {       // 基础层 C 段（模型适配）模板覆盖入口
    default: string
    families?: Record<string, string>   // 如 { 'deepseek-reasoner': '...' }
  }
}
```

## 4. teams/<id>.yml 格式

- 团队 id = 文件名去 `.yml` 后缀；校验规则同角色 name（字母数字 + `-_`），重名（大小写归一后）加载报错。
- 文件内容与旧版 roles.yml 相同：

```yaml
roles:
  - name: reviewer            # 必填；标识符（字母数字 + -_）；重名加载报错
    description: 代码审查员    # 必填；一句话职责，主 Agent 选角的唯一依据
    persona: |                # 必填；角色层提示词
      你是资深代码审查员……
    provider: deepseek        # 可选；缺省继承主 Agent
    model: deepseek-reasoner  # 可选；缺省继承主 Agent
```

- 角色字段只有 `name/description/persona/provider/model`。**不做 toolFilter**：成员工具与主 Agent 保持一致。
- provider/model 都不写 = 完全继承主 Agent；写了走 `resolveChildAgentOptions` 覆盖（父 agent 为底），provider 无适配器时响亮失败。
- 校验用 Schemastery；**任一团队文件非法或 teams/ 目录缺失/为空** → 插件激活时抛错 → preset 挂载被拒（misconfiguration fails loud；**不标 broken**，真实原因见 chip hover title / select RPC reason，§7.5 失败反馈②）。
- 不监听 teams/ 热更：standing mount 的 generation 语义保证"改名册 → 下一个新会话生效"，已开会话保留旧团队集。

## 5. 成员系统提示词：两层结构

**成员系统提示词 = 基础层（插件内置，三段） + persona 层（名册）**。名册文件只写 persona 层。

基础层三段：

| 段 | 内容 | 说明 |
|---|---|---|
| A. 身份与契约 | 被主 Agent 委派的成员；任务自包含、看不到主对话；最终输出作为结果返回；禁止再委派 | 所有模型通用 |
| B. 能力使用守则 | 工具使用规范、MCP 资源使用边界、动手前先读项目 AGENTS.md 等 | 所有模型通用 |
| C. 模型适配段 | 按 provider/model 族切换措辞（如 reasoning 模型不加"逐步思考"类指令，chat 模型加输出格式约束） | 模型族 → 模板映射 |

- C 段实现：插件内置"模型族 → 模板"映射表（含 `default` 兜底），按 `resolveChildAgentOptions` 解析出的最终 model 匹配；`Config.promptTemplates` 可覆盖。
- 背景：子 Agent 的 `persona` 会遮蔽 deployment 级 persona（"shadows deployment:persona"），基础层必须由插件主动补。

## 6. team_delegate 工具契约

模型可见面（对齐内置 tool-subagent 的"配置在 Config、任务在输入"范式）：

```jsonc
// 参数
{ "role": "reviewer",            // 必填，必须命中当前团队名册
  "description": "审查登录模块",  // 必填，3-5 词展示用短标签
  "prompt": "请审查 src/auth/…" } // 必填，自包含任务书
// 返回（规范 JSON）
{ "kind": "foreground", "role": "reviewer", "runId": "…", "output": [/* content blocks */] }
```

- **工具 description = 静态通用语义**（v3 修正）：standing scope 下工具注册跨会话共享，description 无法按会话内嵌名册——固定写委派语义（成员看不到本对话、任务要自包含、`role` 必须命中当前会话团队）+ "可用成员见系统提示团队段"。**注册一次，不随切换重注册**。
- **名册动态可见性走 prompt section**（v3 修正）：团队介绍段的 `text` 用函数形式（`system-prompt/src/index.ts:67` `section(options)` 类型 + `:514` 求值，`dispatch.ts:174-176` 注入 `{ agent, scope, signal }`）——按 `context.agent` 取 sessionId → 该会话 TeamState → 渲染"当前团队 + 每角色一行 `name: description`"。模型看到的名册随该会话当前团队，无需触碰工具 schema 管道（dsh-tools 的 wireSchemas 从注册表按请求组装，叠加 provider 有重复/覆盖风险，不走此路）。section order 参考内置 `116.5` 附近。
- **执行管线**（照抄内置 `settleForegroundRun` 语义；role 校验按会话）：
  1. `exec.agent` 为空 → 报错
  2. 按 `exec.agent.session.id` 取该会话 TeamState；role 未命中**该会话当前团队** → 报错并列出可用角色名（主 Agent 可自愈重试）
  3. `ctx.subagents.start(provider, { label: 'role:<name>: <description>', persona: 两层拼装, agentOptions?（角色配了才传）, maxDepth, prompt, parent: exec.agent, signal: exec.signal })`
  4. `await run.result`；stopReason 非 `completed` → 报错并附成员部分产出（`withPartialText` 语义）
  5. 结果收集与 `run.dispose()` 走 `Promise.allSettled`，dispose 失败不掩盖结果失败（AggregateError）
  6. 返回规范 JSON
- **并发**：`isConcurrencySafe: () => true`。
- **防套娃**：委派请求携带 `maxDepth: 1`，成员（深度 1）再调 team_delegate 会被 provider 响亮拒绝（`resolveChildDepth` = 父深度+1，`childDepth > maxDepth` 抛 `SubagentDepthError`，`subagent/src/child-agent.ts:48-57`）。toolFilter 路线不可用（只过滤全局工具，team_delegate 是 preset scoped 注册）。

## 7. 界面交互方案（团队选择 + 委派呈现）

**原则：团队管理复用原生 preset UI；团队选择用插件自带 dock 下拉；成员运行过程复用原生子代理机制。**

### 7.1 团队选择 dock（浏览器半）

- **槽位**：`conversation.input.dock`（list/session，owner `InputZone`，渲染点 `ConversationRoot.tsx:164`，输入卡片正上方整宽行；hero 新会话页同样渲染）。注册 `id: 'team'`、`order: -10`（现有 occupant：todo=0、goal=10、queue=20；order 升序，负值栈顶——`ui-slots/src/index.ts:861-868` + `web-react/src/scoped-slots.tsx:839`）。组件内下拉左对齐。
- **为何不放 hero 行**：heroWorkspaceRow 构成硬编码（WorkspaceChip + hero.workspace + hero.agentPreset 两 single 槽位，`ConversationRoot.tsx:100-124`），preset chip 右侧无可插槽位；dock 是不改上游条件下离目标最近的位置。
- **数据源**：插件自建 HTTP 端点 `GET /agent-team/<sessionId>/state` 返回 `{ currentId, options: [{ id, summary }] }`（summary = 首角色 description）；**非团队 preset 的会话该路由不存在（404）→ dock 不渲染**。不用会话投影：投影只能由会话事件 fold 驱动（session-projection 公开面无写入口，`session-projection/src/index.ts:194-385`），本设计不产生会话事件，投影无法反映切换。
- **锁定 UI**：`useSession(s => s.blank)`（`ConversationSnapshot.blank`，`conversation.ts:475`——首个被接受的 prompt 后翻 false）；`!blank` 时下拉 disabled（沿用 `.chip:disabled` opacity 先例），tooltip 说明"会话已开始，团队已锁定"。
- **选中提交**：inject 面回调 → `POST /agent-team/<sessionId>/select`（body `{ team }`）→ 200 后组件本地更新当前值；409/400 时回退选中值并展示错误文本。会话事件投影不存在，组件对切换结果的即时回显靠 POST 响应 + 本地 state。
- 组件守 client 规范：纯 props（fetch 封装经 inject 面注入，组件不直接 fetch）、无订阅机器、中文文案、CSS Modules + `--dsw-*` token。

### 7.2 团队切换状态机与 HTTP 通道（Node 半）

- **当前团队 = 每会话 TeamState**（v3 修正）：`Map<sessionId, TeamState>`（standing 实例级），首次触碰（GET/POST/工具/prompt）时惰性创建：初值 = KV 命中（按 sessionId）?? `Config.defaultTeam` ?? 字典序首个团队。`ctx.on('session/disposed')` 时删除对应条目（KV 记录保留，供重载/跨进程恢复）。
- **HTTP 端点**（webServer 可选能力，`ctx.inject(['webServer'], …)` 条件注册；headless/CLI 无 webServer 时整个团队切换面不存在，工具仍按初始团队工作）：
  - 注册**一条 prefix 路由**（`webServer.register({ kind: 'prefix', path: '/agent-team', handler })`，`webserver/src/index.ts:24-33,241-249`：`path` 无尾斜杠，匹配 `/agent-team` 及 `/agent-team/<任意>`，最长前缀优先；v3 修正：standing 实例跨会话共享，无法按会话注册 exact 路由；handler 从 `req.url` 解析 `<sessionId>/state|select`，方法/路径不符 → 404）。
  - GET state：惰性建/取该 sessionId 的 TeamState → 200 `{ currentId, options }`；未知 sessionId 不 404（惰性建态即"该 preset 下任意会话都有团队态"——dock 的非团队 preset 判定由"路由是否被挂载"承担，与本端点无关）。
  - POST select：① team 未命中团队集 → 400 + 列出可用团队；② 经 `ctx.sessions.get(sessionId)` 取会话，`isSessionBlank(session.events)` 为 false（存在 `turn/start` 事件）→ 409 "会话已开始，团队已锁定"；③ 更新该会话 TeamState → 写 KV（`sessionId → teamId`）→ 200 返回新 state。**不再有工具重注册**（名册可见性在 prompt section，§6）。
- **无会话事件、无会话投影**：切换的"可重放性"由 KV 承担。
- **实现期核实点**：① prefix 路由的注册/摘除与 fiber 生命周期对齐（HMR 安全测试覆盖）；② prompt section 函数 text 在 agent 缺省（非 agent 组装场景）时返回通用文案不抛错。

### 7.3 委派卡片（host 端纯函数 presenter，仿 tool-workflow 样板）

```ts
presentCall: (args) => ({
  card: 'generic',
  title: `委派 · ${args.role}: ${args.description}`,
  rawInput: args.prompt,
})
presentResult: (args, { isError }) => (isError ? undefined : { card: 'generic' })
```

- 成功：保留待定态标题、原样渲染结果文本；失败：返回 undefined 走默认错误卡——红色错误行 + 错误首行（ToolRow 行模型自动处理）。
- 硬规则：presenter 是 args/result 的**纯函数**（无 I/O、无时钟、不读会话状态），在实时流与会话回放时都会执行；不注册 keyed 客户端 toolview（`tool.call.toolview` 槽位）。对照：内置 tool-subagent 无任何 presenter，默认 generic 卡标题为固定英文 "Tool call"、摘要取 args 首个字符串——展示语义差，故做此最小定制。

### 7.4 成员运行过程：复用原生子代理机制，不自建展示

- 成员是**独立子会话**（`origin: 'subagent'`），其工具流/输出不在父会话实时渲染；`subagent/descriptor` 为 log-only 事件。
- `label: role:<name>: <description>` 原生出现在父会话页头**子代理目录**树（ui-subagent `SubagentCatalogAction`），用户点击进入子会话查看完整过程；子会话行从侧边栏隐藏，父会话行在成员运行期间自动带蓝色活动指示器。

### 7.5 团队管理用户旅程（原生 preset UI，源码核实）

| 环节 | 位置 | 行为 |
|---|---|---|
| 选用团队模式 | 新建会话 hero 区 chip（工作区选择器旁）/ 设置→常规 "Agent preset" 下拉 | 菜单每项显示名称+描述；chip 选择为 staging 语义（消费一次），下拉设全局默认；只列健康 preset |
| 选择团队 | 输入框正上方 dock 下拉（§7.1） | blank 期可切换；首条消息后锁定 |
| 标识 | 会话头只读标签 | 图标+preset 名，hover 显描述；会话开始即固定，宿主拒绝切换 |
| 派生 | 设置→管理区卡片「复制」 | **整目录拷贝，teams/ 随之带走**；复制完成自动打开新目录；id 即目录名不可改（无重命名） |
| 编辑团队 | 文件系统 | 原生 UI 无浏览器内编辑；在 `teams/` 下增改 `.yml` 后**下个新会话生效**（standing mount generation 语义，页面不感知文件改动，原生已知行为） |
| 失败反馈 | 分两类 | ① **preset 元数据非法**（preset.yml/cordis.yml 解析失败）→ discovery 期 → preset **broken**：管理区红框+「加载失败」徽标、选择器隐藏、禁复制；② **插件激活期抛错**（teams/ 缺失/非法、插件 bug）→ standing mount 被拒但**不标 broken**（broken 仅 discovery 期产生），真实原因在 chip hover title 与 select RPC 的 `agent-preset-invalid.details.reason`（`api-proxy.ts:364-380`、`AgentPresetSeat.tsx:159`），服务端控制台默认不可见 |
| 默认 preset | 设置→常规下拉 | 用户可把团队模式设为所有新会话默认；菜单中自建 preset 带「 · 自定义」后缀 |

## 8. 错误处理汇总

| 场景 | 时机 | 行为 |
|---|---|---|
| teams/ 缺失/为空/任一文件解析或校验失败 | 插件激活（standing mount） | 抛错 → preset 挂载被拒：选择该 preset 的 RPC 返回 `agent-preset-invalid`（原因见 chip hover title），**不标 broken**（§7.5 失败反馈②）；新建该 preset 会话失败 |
| 角色 provider 无适配器 | 首次委派该角色 | `resolveChildAgentOptions` 响亮失败 |
| role 未命中当前团队 | 委派时 | 报错 + 列出当前团队可用角色名 |
| POST select team 未命中 | 切换时 | 400 + 列出可用团队 |
| 首条消息后切换 | 切换时 | POST 409 "会话已开始，团队已锁定"（`turn/start` 判定）；UI 层下拉同时 disabled |
| 成员异常终止 | 结果收集 | 报错 + 附部分产出文本 |
| 成员试图再委派 | 成员执行时 | provider 按 maxDepth 拒绝 |
| KV/webServer 不可用 | 激活/切换 | storageDomain 在顶层 inject（激活即失败）；webServer 缺失时切换面不存在，工具按初始团队工作 |
| 插件 HMR 卸载 | 任意 | cordis 自动清理注册（工具/HTTP 路由/提示段/槽位）；团队状态是纯内存数据 + KV，无手动资源 |

## 9. preset 发行（两条官方路径 + 浏览器半接入，文档化安装步骤）

1. 部署方 patch：把 `presets/team` 加进 `agentPresets.config.roots`（`trust: 'system'`）——dsh CLI 发行内置 preset 的同款做法。
2. 用户 copy：团队模式在 UI 出现后，用户在设置管理区复制派生自己的 preset（整目录拷贝含 teams/，复制后自动打开目录），在文件系统改 `preset.yml` 显示名、增改 `teams/*.yml` 名册，下个新会话生效（详见 §7.5）。
3. **浏览器半接入（v3 新增，单包双挂载点）**：部署方 cordis.yml 追加一行全局挂载 `- name: <agent-team 包>` + `config: { clientOnly: true }`——让 `dsh.client` 进浏览器 boot 清单，dock 打开页面即在、支持 HMR；缺此行时浏览器半依赖"建会话后刷新整页"时序，不可用。开发回路（cordis.yml patch）同样加此行。

## 10. 测试策略

1. **单测**（vitest）：teams/ 解析/校验（合法多文件、缺字段、重名、缺目录、空目录）；两层提示词拼装（模型族模板选择、Config 覆盖）；presenter 纯函数（presentCall 标题与 rawInput 拼装，presentResult 成功保留 generic / isError 返回 undefined）；团队状态机（默认团队优先级、trySelect 切换、blank 锁拒绝）。
2. **浏览器半组件测试**：TeamDock 以 props 驱动（注入的 fetchState/selectTeam 桩；有/无数据渲染、blank 锁定 disabled、onSelect 调用 selectTeam、POST 失败回退）。
3. **REAL-composition 测试**：boot 测试专用 cordis.yml（preset + 插件），断言工具注册一次、prompt 团队段函数 text 按 agent 渲染当前名册（切换后同一工具注册不变、section 文案变）、未知 role 报错列该会话名册、多会话各自独立 TeamState。
4. **HMR 安全测试**：dispose 插件 fiber → 工具、HTTP 路由、提示段、dock 槽位注册全部移除。
5. 真实 LLM 端到端委派不进单测，作为开发回路手动验证项（含 UI 目测：dock 下拉、锁定、委派卡片、子代理目录、错误行、激活失败反馈（chip hover title）、刷新后团队恢复）。

## 11. 范围之外（明确不做）

- 角色 scoped 工具/技能注入（一次性路径无 seam；评估报告 §1.4）
- 后台并行委派、长期可继续队友
- 自建团队管理 UI（preset 复制/编辑之外的界面，未来纯增量）
- 自定义 toolview 富卡片（跳转子会话链接等，后续按体验反馈再议）
- 会话进行中切换团队（锁定语义是本版明确决策）
- outputSchema 结构化产出（一次性路径虽支持，当前无需求）
