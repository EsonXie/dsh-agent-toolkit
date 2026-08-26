# project-bot（项目机器人）插件设计

> 日期：2026-08-24
> 状态：设计已获用户批准，待实现
> 前置文档：`docs/2026-08-18-插件组技术可行性评估.md` 第二节（飞书机器人，源码闭环）

## 需求

1. 一个项目（dsh workspace，cwd）可以绑定多个机器人，每个机器人作为 Agent 的交互入口
2. 每个机器人绑定的 Agent 可使用提示词分层插件（prompt-stack）配置提示词
3. 机器人使用飞书卡片消息与用户交互
4. 提供配置 UI：侧边栏入口 → 机器人列表 → 编辑/创建表单；飞书机器人支持扫码一键创建或手动填写 app 信息
5. 飞书只是机器人的一个消息渠道，架构上渠道可扩展

## 关键决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 包名 | `project-bot`（项目机器人），飞书为第一个渠道实现 |
| 渠道抽象 | 单包 + 内部 `BotChannel` 接口，第二个渠道出现时再拆包（不预防性拆分 seam） |
| 项目绑定 | 一 bot 一项目（`project` 单值）；一项目多 bot = 多条 bot 记录指向同一 cwd |
| prompt-stack 集成 | prompt-stack 不动；bot 差异走 agent 创建参数 `persona` 透传，prompt-stack 继续按模型做公共分层，两者正交叠加 |
| 会话粒度 | （botId + chatId）→ 一个长期 dsh session；群内多人共享同一 agent 上下文；`/new` 开新会话 |
| 多机器人组织 | 单插件条目管理全部 bot |
| 飞书接入库 | 官方 `@larksuiteoapi/node-sdk`（≥1.61.1，长连接 + API + `registerApp` 扫码创建） |
| 卡片交互范围 | v1：流式更新回复卡片（无审批按钮等交互回调） |
| 卡片映射 | 一个 turn（一轮 ReAct 循环）= 一张流式卡片；内容超长同 turn 内顺序拆多张续卡；新 turn 开新卡 |
| 配置 UI 入口 | `sidebar.footer.action` 按钮 → 自持 Modal（token-usage 同款）；项目行更多菜单不可扩展（`ui-workspace/.../Rows.tsx:125-128` 硬编码 rename/delete，拒绝式分发），已排除 |
| 配置存储 | bot 配置存 storage domain 表（UI 可写）；appSecret 进 `ctx.credentials`，表里只存 CredentialRef；cordis.yml Config 只留全局可调参数 |

## 架构

```
packages/project-bot/
├─ package.json          ← peerDeps 拷贝 ACP 依赖集；dependencies 加 @larksuiteoapi/node-sdk；
│                           dsh.client manifest（platform: 'web'）+ ./client → lib/client.js
├─ src/
│   ├─ index.ts          ← 命名导出 name / inject / Config(Schemastery) / apply(ctx)
│   ├─ core/             ← 渠道无关核心
│   │   ├─ channel.ts    ← BotChannel 接口 + ChannelIO（入站回调 + 出站回复句柄）
│   │   ├─ registry.ts   ← bot 名册（storage domain 表 + 内存索引 + 校验）
│   │   ├─ router.ts     ← (botId, chatId) → sessionId 绑定路由；agent 创建/复用
│   │   ├─ inbound.ts    ← 准入（单会话单 in-flight 槽）→ createUserMessage → followup
│   │   └─ outbound.ts   ← session/event → per-session Promise 链 → turn 级卡片流
│   ├─ channels/
│   │   └─ feishu/       ← BotChannel 实现：WS 长连接、事件解析、卡片渲染（CardKit 流式更新）
│   ├─ store.ts          ← defineDomain：bots 表 + bindings 表（zod schema）
│   ├─ api.ts            ← webServer HTTP 路由（浏览器半 RPC）
│   └─ client/           ← 浏览器半：sidebar.footer.action 入口 + Modal（列表 + 表单）
└─ tests/                ← vitest 单测
```

`inject: ['agents', 'credentials', 'storageDomain', 'tools', 'llm', 'agentDefaultModel']`（实现阶段新增 `llm` 与 `agentDefaultModel`）；`workspaceRegistry` 为可选服务，走 `ctx.get('workspaceRegistry')`，缺失时 attach 降级 no-op + 日志。

## BotChannel 接口（渠道抽象）

```ts
interface BotChannel {
  readonly type: string                        // 'feishu'
  start(bot: ResolvedBotConfig, io: ChannelIO): Promise<Disposer>
}

interface ChannelIO {
  onMessage(msg: InboundMessage): Promise<void>
  // InboundMessage: { chatId, userId, text, reply: ReplyHandle }
}

interface ReplyHandle {
  beginTurn(): Promise<void>      // 开新卡片（流式模式）
  update(markdown: string): Promise<void>   // 更新当前卡片（渠道内部节流/拆卡）
  finalize(status: 'done' | 'error' | 'cancelled', detail?: string): Promise<void>
  notice(text: string): Promise<void>       // 普通文本消息（准入拒绝、/status 等）
}

interface InboundMessage {
  chatId: string
  userId: string
  text: string
  reply: ReplyHandle
  ackProcessing(): Promise<Disposer>   // 给该用户消息加「处理中」表情回复；disposer = 删除表情
}
```

插件核心与渠道严格分工：**核心**负责名册/校验、绑定路由、agent 生命周期、入站准入、turn 事件归集；**渠道**只负责协议、卡片渲染与频率控制。

## 数据模型

### bots 表（storage domain，zod schema）

```ts
{
  id: string                // 机器人标识（唯一）
  name: string              // 展示名
  channel: 'feishu'         // 渠道类型（v1 唯一值）
  feishu: { appId: string, appSecretRef: CredentialRef }
  project: string           // cwd 绝对路径（一 bot 一项目）
  persona?: string          // 透传 agent 创建参数
  preset?: string           // 挂载的 agent preset id（缺省 = 名册默认 preset）
  tools?: string[]          // 可用工具白名单（缺省 = 不限制）
  agentOptions?: { provider?: string, model?: string }  // 新建 bot 恒为 { provider, model }（均必填）；
                                                         // 存量 undefined 记录在运行时回退宿主默认模型（见下入站段）
}
```

### bindings 表

`(botId, chatId) → { sessionId }`，进程重启后凭此 `agents.resume()` 恢复。

### cordis.yml Config（仅全局可调参数）

`cardUpdateThrottleMs`（默认 500）、`registerAppTimeoutMs`（扫码轮询超时，默认 600000）、`processingReactionEmoji`（「处理中」表情类型，默认值在实现时对照飞书 emoji_type 目录校验）、`errorDetailMaxChars`（回传飞书的错误摘要最大字符数，默认 500）等；**不含 bot 定义**。

## 消息流

### 入站

```
飞书 WS 事件(im.message.receive_v1) → 渠道解析 → core.onMessage
  → 文本指令分流（不走模型）：/new 新会话、/stop 取消、/status 绑定与状态
  → 路由：botId 查名册 → (botId, chatId) 查 bindings
      无绑定：agents.create({ sessionId: uuid, meta: { cwd: project, agentPreset: 解析出的preset },
              agentOptions, persona? })（setup 内先 `agentPresets.mount(agentCtx, presetId)` 挂 preset——
              基础编码工具层与原生 UI 会话同源，再叠 persona/tools 白名单；restrict 必须在 mount 之后；
              presetId 取 bot.preset ?? 名册默认，解析失败 warn 降级裸跑不阻塞创建）
              （agentOptions 缺省时回退 `ctx.agentDefaultModel.currentSelection()`——宿主默认模型服务；
               agent-loop 工厂自身不兜底，无 provider/model 会抛 no provider/model）
              → 按 bot.tools 白名单做 agent-scoped tools.restrict({ allow })（未命中响亮失败）
              → 写 bindings
      有绑定：复用进程内 handle 或 agents.resume(sessionId)
      create/resume 成功后均 → workspace.attach(project, sessionId)（WorkspacePort 窄端口；
              组装层 `ctx.get('workspaceRegistry')` → `registry.create(project)` 按 canonical path
              幂等复用/自动建 → `attachSession(sessionId)` 幂等；与原生 UI session.create 同款挂载路径，
              会话归入 bot 项目对应 workspace 而非未分组；attach 失败仅日志告警，不阻塞消息处理）
  → 单会话单 in-flight 槽准入；失败 → reply.notice('上一条还在处理中')（v1 不排队）
  → 准入成功 → ackProcessing()：给用户该条消息加「处理中」表情回复（飞书 reaction）
  → createUserMessage({ content, source: { kind: 'project-bot', channel: 'feishu', botId, chatId, userId } })
  → agent.followup()
  → turn 定格（done/error/cancelled 任一）→ 调 ack 的 disposer 删除表情回复
```

`MessageSourceMap` 扩展 `{ kind: 'project-bot', channel, botId, chatId, userId }`（照 7 处先例）。

### 出站（turn 级卡片流）

```
ctx.on('session/event') 过滤本插件 session（按 header.id 匹配 + session 对象校验防伪造）
  → per-session Promise 链串行化保序
  → turn 开始（turn/* 事件定界）→ reply.beginTurn() 建流式卡片
  → assistant/message → reply.update(markdown)（渠道内节流 ≥cardUpdateThrottleMs，合并更新）
  → 内容接近卡片上限 → 渠道定格当前卡、自动开续卡（同 turn 内追加）
  → turn/end（reason 为 TurnEndReason 对象，按 reason.kind 定状态：completed→done、
    aborted/interrupted→cancelled、error/max-tokens/blocked→error）→ reply.finalize(status)
    → 调 ack 的 disposer 删除表情回复
  → kind==='error' 时从 reason.error（结构化 LlmFailure）提取错误消息（截断至
    errorDetailMaxChars）作 detail 传 finalize('error', detail)，无卡时渠道降级为文本
```

另订阅 `ctx.on('agent/error')` 覆盖 **turn 外错误**（resume/驱动边界失败等没有 turn/end 的场景）：
按 `payload.agent.session.id` 匹配本插件 session；仅当该 session 无进行中 turn 时
`reply.notice(错误摘要)`（turn 内错误由 turn/end 报告，避免双发），同时释放 inflight 槽
并执行 ack（否则 in-flight 槽永久占用、表情残留，后续消息全被拒）。

卡片内容：Markdown 正文 + 头部状态条（进行中/完成/失败/已取消）；工具调用细节 v1 不进卡片（仅 Web UI 可见）。

## 配置 UI（浏览器半）

- 入口：`ctx.slots.inject('sidebar.footer.action', ...)` 注册「消息机器人」按钮 → 本地 `open` state → 自持 `Modal`（token-usage `UsageEntry`/`UsageModal` 模板）。
- Modal 内两个视图：
  - **机器人列表**：按项目分组，每项显示名称 + 渠道标记 + 运行状态（已连接/未连接）；点击进编辑表单；「新建机器人」按钮进创建表单。
  - **编辑/创建表单**：两步向导（创建与编辑同构，Pill 式步骤指示「1 基本信息 · 2 飞书渠道绑定」，当前步高亮）——第一步「基本信息」：名称、绑定项目（workspace 选择器）、提示词（persona）、Provider 下拉、模型级联下拉；第二步「飞书渠道绑定」：扫码 / 手动。无机器人 ID 输入框（后端生成）；无工具白名单 UI（数据模型/API 的 `tools` 字段保留，缺省 = 不限制）。
  - Provider **必选**：下拉选项全部来自宿主已注册 provider（`GET /project-bot/api/providers` → `ctx.llm.listProviders()`），无「默认」占位项，默认选中第一项；providers 清单为空时 select 置 disabled 并提示「未发现可用 Provider」。模型**必填**：级联自 `GET /project-bot/api/models?provider=<id>`（`ctx.llm.listModels`，失败/空清单回退手填 Input），默认选中第一个模型；两步校验：第一步名称 + 项目非空才放行，保存前 provider/model 非空才提交。
  - 表单组件统一使用宿主 `ui-primitives`（Modal/Button/Input/Pill/StateDot/DisclosureRow 等）+ CSS Modules。
- 扫码创建流：创建模式第二步默认选中「扫码一键创建」tab，进入即自动发起 `registerApp` 生成二维码（零点击）；「手动填写」为备选 tab。前端把返回 URL 渲染为二维码 + 链接 → 用户飞书扫码确认 → 前端轮询 status 端点 → 拿到 appId/appSecret 自动回填（secret 直入 credentials，不回显）；扫码失败「重试」直接重新发起。
- `registerApp` 默认模板已含所需全部权限：`cardkit:card:read/write`、`im:message:send_as_bot`、`im:message:update`、事件 `im.message.receive_v1`（长连接）、回调 `card.action.trigger`（v1 暂不消费，留作后续卡片交互）。

### HTTP API（webServer 路由，token-usage 模式）

| 路由 | 用途 |
|---|---|
| `GET /project-bot/api/bots` | 机器人列表（含运行状态） |
| `POST /project-bot/api/bots` | 创建（`id` 可选，缺省后端生成 `bot-<8位[a-z0-9]>`，过 BOT_ID_RE，冲突重试）/ `PUT` 更新 / `DELETE` 删除 |
| `POST /project-bot/api/register-app` | 发起扫码创建，返回 `{ id }`（轮询凭据） |
| `GET /project-bot/api/register-app/status?id=<id>` | 轮询扫码结果（pending{url} / done{credentialRef, appId} / error） |
| `GET /project-bot/api/providers` | 宿主已注册 provider 清单（Provider 下拉数据源） |
| `GET /project-bot/api/models?provider=<id>` | 该 provider 已配置模型清单（失败降级 200 空数组） |
| `GET /project-bot/api/presets` | 名册 preset 清单（Preset 下拉数据源；失败降级 200 空数组） |
| `GET /project-bot/api/workspaces` | 可选项目列表（workspace 选择器数据源） |

bot 增删改 → 核心就地重连该 bot 的 WS 渠道（不重载整个插件）；新建即生效。

## 生命周期与错误处理

- **卸载/HMR**（照 ACP 模式）：`ctx.effect` 内：拒新消息 → `agent.cancel({ kind: 'user' })` 取消在飞会话 → 未定格卡片定格为"已中断" → 等 quiesce → 断开全部 WS → 关闭 storage domain 句柄。
- **Config 非法**（节流值越界等）：加载时响亮失败；bot 记录非法（project 路径不存在等）：该 bot 标记不可用并告警，不影响其他 bot。
- **WS 断连**：SDK 自动重连，期间消息由飞书侧重推。
- **卡片 API 失败**（限流等）：指数退避重试；最终失败降级 `reply.notice` 普通文本兜底。
- **扫码流程**：`AbortSignal` 取消（关弹窗/超时）；`access_denied`/`expired_token` 映射为表单内错误提示。
- **表情回复失败**（reaction API 限流/消息已撤回等）：仅日志告警，不阻塞消息处理；删除失败同样只告警（表情残留无害）。所需权限 `im:message.reactions:write_only` 已含在扫码创建的默认模板内。

## 测试

- **核心层**：fake `BotChannel` + fake `agents` 服务单测——路由/绑定/准入/turn 归集/卸载时序，不碰真实飞书。
- **飞书渠道层**：卡片渲染决策（turn 事件流 → beginTurn/update/finalize 序列、拆卡时机、节流合并）做成纯函数单测；SDK 交互薄封装不单测，靠开发回路手测。
- **API 层**：路由 handler 单测（内存 store）。
- **开发回路验证**：`pnpm dsh web --patch` 挂插件 + 真实飞书测试机器人（扫码创建）收发。

## 非目标（v1 不做）

- 审批按钮、user-questions 等卡片交互回调（`card.action.trigger` 权限已预留）
- 钉钉/企微等第二渠道（接口已预留）
- 消息排队（v1 准入失败直接提示）
- 会话创建后切换 preset（preset 只在 create/resume 创作期挂载；改 bot.preset 需 /new 开新会话生效）
- 工具调用过程在卡片内展示

## 实施偏差记录（2026-08-24，实现收尾时核对实际代码）

| # | 条目 | 偏差 | 核实依据 |
|---|---|---|---|
| a | 开发回路挂载 | 用户裁定：挂载走 bundle 层——包自带 `cordis.patch.yml`（含 `insert id: project-bot`），经 `dsh plugin add` 注册进 profile 的 `dsh.profile.bundles` 自动应用；根 `cordis.yml` 只留注释、不再 insert（避免 duplicate loader entry id，token-usage 同款坑） | `packages/project-bot/cordis.patch.yml`；根 `cordis.yml` |
| b | 扫码 tab 默认 | 绑定方式默认扫码一键创建并自动生成二维码，手动填写为备选（用户裁定，实现于 `src/client/BotForm.tsx`） | `src/client/BotForm.tsx:45,131-135` |
| c | 扫码轮询间隔 | `POLL_INTERVAL_MS = 200`（非 spec 无明确数值；测试裁定 2000→200） | `src/client/BotForm.tsx:25` |
| d | PUT /bots 清除语义 | `persona` / `tools` / `agentOptions` 传 `null` = 清除字段（更新 schema 为 nullable，修复计划自相矛盾的实现） | `src/api.ts:164-169`、`UpdateBodySchema` |
| e | Config 声明形态 | 用 Schemastery 函数调用形态 `z.object({...})` 声明并导出（`z<Config>` 断言），非 `.parse`（schemastery 3.18.1 无此 API） | `src/index.ts:31-36` |
| f | 浏览器半 bundle | `qrcode` 经 tsdown alias 固定到其浏览器入口 `lib/browser.js`（Node 入口图含 `require("fs")` 会被 client-modules 拒绝）；纯净度门禁扩展：Node 内建模块（builtinModules + `node:` 前缀）进浏览器半即构建错误 | `packages/project-bot/tsdown.config.ts` |
| g | 表单组件库 | 统一用宿主 `@deepseek-ai/dsh-client-ui-primitives`（不引第三方库；Checkbox/Select/Textarea 平台无组件故保留原生） | `src/client/BotForm.tsx`、`BotsModal.tsx` |
| h | footer 入口布局 | 平台 `.footerActions` 为 flex 行布局，多入口须紧凑并排：project-bot 与 token-usage 的入口按钮同步改为 `flex:none; width:auto` 紧凑样式 | `src/client/bots.module.css`、`packages/token-usage/src/client/UsageEntry.module.css` |
| i | 会话分组归属（2026-08-25 修订） | 原生 UI 会话创建时显式 `workspace.attachSession`，project-bot 此前只靠 cwd 自动归类，bootstrap 之后建的会话落未分组；修订：create/resume 后经 `WorkspacePort` attach 到 bot 项目 workspace（无则自动建） | `src/core/router.ts`、`src/index.ts` |
| j | turn/end reason 形状（2026-08-25 修复） | 宿主 `TurnEndReason` 是对象 `{ kind, ... }`，原 `mapTurnEnd` 按字符串比较导致生产环境每个 turn 都定格成 error；改按 `reason.kind` 映射 | `src/core/outbound.ts` |
| k | 报错回传飞书（2026-08-25 新增） | `kind:'error'` 的 turn/end 提取 `LlmFailure` 消息作 detail 传 `finalize`（渠道层已支持无卡降级文本）；另订阅 `agent/error` 覆盖 turn 外错误：无进行中 turn 时 `reply.notice` + 释放 inflight/ack | `src/core/outbound.ts`、`src/index.ts` |
| l | 会话工具层与 per-bot preset（2026-08-25 修复） | 原实现 `agents.create` 直传 setup，未经过宿主 preset 组合（`composeAgent` → `presets.mount`），bot 会话只有全局工具、缺基础编码工具层；修复：setup 内先 `agentPresets.mount(agentCtx, presetId)`（bot.preset ?? 名册默认），create 时 `meta.agentPreset` 记录；**解析失败 warn 降级裸跑**（根因实录：开发回路 checkout 缺 `apps/cli/config/agent-presets/` 内置 preset，名册只剩用户根，`resolve('standard')` 抛 UnknownPresetError 曾致 /new 全线失败）；preset 存在但组合损坏仍在 mount 阶段响亮失败；表单第一步新增 Preset 下拉（无「默认」项，缺省选中标准模式 standard，broken 项禁用；名册不可用时下拉禁用、提交不携带字段回退服务端名册默认） | `src/agent-setup.ts`（新）、`src/index.ts`、`src/api.ts`、`src/client/BotForm.tsx` |
