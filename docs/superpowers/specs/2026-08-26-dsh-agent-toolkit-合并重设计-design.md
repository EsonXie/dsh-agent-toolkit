# dsh-agent-toolkit 合并与 Agent 管理重设计

- 日期：2026-08-26
- 状态：已批准（用户逐节确认），待实现计划
- 范围：packages/ 下 4 个插件包合并为单包 `dsh-agent-toolkit`；agent-team 以「Agent 管理」为核心重设计；spec/plan 文档归档整理

## 1. 背景与动机

现状：packages/ 下 4 个独立插件包（token-usage、agent-team、prompt-stack、project-bot；feishu-bot 早已并入 project-bot），250 个测试全绿，但存在三个痛点：

1. **重复代码难维护**：tsdown 客户端 bundle 配置拷了 3 份（~150 行/份）；侧边栏底栏入口组件近乎逐行相同；可选 webServer 路由、storage domain 打开、Modal 加载状态机等模式同款复制。
2. **agent-team 需要内部集成**：角色要复用提示词分层（prompt-stack）与飞书渠道（project-bot），跨包无法直接引用，走 cordis 服务改造代价更高。
3. **它们是一体的产品**：总是一起使用，分开安装/挂载/发版没有意义。

重设计诉求（用户确认）：

- 委托流程类似 opencode Task 工具：**同步并行**多 Agent 委托（现状的一次性同步语义保留，但角色来源与提示词装配重做）。
- **一个角色一个飞书 bot**：飞书 bot 按项目绑定主 Agent 或某个子 Agent 角色。
- 不同角色定制不同系统提示词，**复用分层提示词**机制。
- Agent 管理（角色提示词/模型/工具）在**浏览器 UI 管理面板**中编辑。
- 归并形态：**单 npm 包 + 单 cordis 插件入口**。
- spec/plan：**归档 + 修复**（不重写总览、不清空重来）。

## 2. 技术可行性验证（已对照 deepseek-harness 源码闭环）

| 问题 | 结论 | 证据 |
|---|---|---|
| 子 Agent 启动可定制 persona/model/tools | ✅ `SubagentStartRequest` 含 `persona` / `agentOptions{provider,model,maxTokens}` / `toolFilter` | `packages/subagent/subagent/src/types.ts:100-149` |
| 子 Agent 并行启动 | ✅ 无内置互斥；工具需标 `isConcurrencySafe`（现有 team_delegate 已标） | `subagent/src/types.ts:281,305`、`packages/core/tools/src/index.ts:1278-1280`、`agent-team/src/tool.ts:118` |
| 不落盘 preset 创建定制会话 | ✅ `ctx.agents.create` 的 `setup: AgentSetup` 回调可内存注册 `systemPrompt.section` + `tools.restrict`；`agentOptions` 指定模型 | `packages/core/agent/src/index.ts:80-133,202,405` |
| providers/models 列表 | ✅ `ctx.llm.listProviders()` / `listModels(provider)` | `packages/llm/llm/src/index.ts:419-421,581-608` |
| 浏览器半 RPC | ✅ 沿用 webServer 前缀路由 + fetch（project-bot 已验证的最轻路径） | `packages/host/webserver/src/index.ts:94-101` |
| storage 加表/加字段 | ✅ 同 version 新增表两后端自动就位；已有表只能加 optional/default 字段 | `packages/storage/storage-json/src/format.ts:72-76`、`storage-sqlite/src/index.ts:111-119` |

关键推论：**team preset 机制可整体移除**——委派与飞书建会话全部走 `ctx.agents.create` 的内存 `setup`，不再依赖磁盘 preset。

## 3. 总体架构

**一个 npm 包 `dsh-agent-toolkit`、一个 cordis 插件入口、内部七模块**：

```
packages/toolkit/
├─ package.json               name: dsh-agent-toolkit；exports "."（Node 半）+ "./client"（浏览器半）
├─ src/
│  ├─ index.ts                插件入口：name/Config/apply；全局挂载基础工具组合；按 Config 开关启用模块
│  ├─ agents/                 ★ Agent 管理核心：注册表 CRUD、storage、RPC
│  ├─ prompt/                 分层提示词引擎（吸收 prompt-stack：layers + 模型规则 + match）
│  ├─ delegate/               team_delegate 工具（同步并行委托）
│  ├─ bots/                   飞书 bot 管理 + 绑定（吸收 project-bot 的 bots/bindings/register-app/api）
│  ├─ channels/feishu/        飞书渠道（吸收 project-bot channels + core runtime/router/inbound/outbound/cards）
│  ├─ usage/                  token 用量统计（吸收 token-usage 全部）
│  └─ shared/                 tsdown 配置工厂、侧栏入口工厂、LoadState 模式、storage/webServer 助手
├─ src/client/                单浏览器 bundle：Agents 面板 + Bots 面板 + Usage 面板 + 委派卡
└─ 测试随模块迁移（约 250 个现有测试 + 新增）
```

- cordis.yml 只挂一行（`dsh-agent-toolkit`）。Config schema（Schemastery）：
  - `modules: { feishu?: boolean, usage?: boolean }`——飞书与用量两个模块可关（默认开）；agents/prompt/delegate 为核心恒启用
  - `layers` / `rules`：全局提示词层与模型规则（从 prompt-stack Config 平移）
  - `timezone`：usage 模块用（从 token-usage Config 平移）
  - 飞书渠道全局可调参数（轮询/重试/节流等 6 项，从 project-bot Config 平移）
- 原 4 包作废：已发布 npm 的 token-usage/prompt-stack/project-bot 做 `npm deprecate` 指向新包；agent-team 本就 private 直接删除。
- 开发命令归一：`pnpm --filter dsh-agent-toolkit test / typecheck / bundle / watch`。

## 4. 全局工具挂载与过滤语义（用户定案）

- suite 插件在 `apply()` 中**全局挂载基础工具组合**（与 standard preset 同源：persona/instructions/shell/fs/fs-search）。
- **主 Agent**：全量工具可用（web 会话与飞书绑定 main 的会话一致）。
- **子 Agent**（委托子 Agent 与飞书绑定角色的会话）：一律用角色配置的 `tools.allow` 白名单过滤（`tools.restrict`）。
- preset 依赖彻底消除：不再使用 `$DSH_HOME/.agent-presets/team`、不再 mount 任何磁盘 preset；agent-team 的「双挂载点 + clientOnly 全局挂载」特殊接法随之作废。

## 5. Agent 管理核心（agents/）+ 提示词分层（prompt/）

### 5.1 Agent 注册表

- 新 storage domain `dsh_agent_toolkit` 的 `agents` 表，zod schema：

```ts
interface AgentRecord {
  id: string                    // 'main' 为主 Agent，内置锁定不可删
  name: string
  description?: string
  promptLayers?: LayerConfig[]  // 角色私有提示词层（见 5.2）
  model?: { provider: string; model: string }   // 缺省 = 跟随宿主默认模型
  tools?: { allow: string[] }                   // 缺省 = 不限制（仅子 Agent 语义）
  builtin?: boolean             // explorer/general 保底内置
}
```

- 内置记录：`main`（主 Agent，不可删）+ `explorer`（只读）/ `general`（可读写）保底角色。
- UI 面板增删改；RPC 提供 agents CRUD + providers/models 级联 + 工具名列表。

### 5.2 提示词分层引擎

- prompt-stack 的 layers/rules/match 机制原样搬入 `prompt/`（glob 编译、打分 model=4/modelPattern=2/provider=1、唯一规则选择、模型族改写文本、函数式 section + waterfall 监听器全部保留）。
- 层的归属分两级：**全局 base 层**（所有 Agent 共享，含按模型规则改写）+ **角色 persona 层**（AgentRecord.promptLayers）。
- 装配出口有两个：
  1. **委托**：拼成单字符串 → `SubagentStartRequest.persona`（以 `deployment:persona` section 阴影化部署）。
  2. **飞书会话**：`setup()` 里逐层注册为 `systemPrompt.section`。
- 全局层/模型规则的载体：沿用 Config（`layers`/`rules` 字段从 prompt-stack Config 平移进 suite Config），用户配置不自动迁移。

### 5.3 迁移

- 首启检测 `$DSH_HOME/agent-team/roles/*.yml`：存在则一次性导入注册表（同名覆盖内置保底），导入后不再读 YAML。
- 旧 team preset 目录（`$DSH_HOME/.agent-presets/team`）不再被引用，由用户自行清理（文档说明即可）。

## 6. 委托流程（delegate/）

- 工具签名：`team_delegate({ role: string, task: string, context?: string })` → 同步返回规范 JSON（`SubagentResult.output` + stopReason 映射，沿用现有错误回传含部分产出的做法）。
- **并行**：`isConcurrencySafe: true`，主 Agent 一个 step 内可发多个委托，运行时无并发限制。
- **角色解析**：`role` 命中注册表 agent id（不含 'main'）；未命中时返回携带可用角色清单的错误，引导主 Agent 纠正。
- **子 Agent 装配**（`ctx.subagents.start` 一次调用）：
  - `persona` = prompt 引擎装配（全局 base + 角色层 + 按模型改写）
  - `agentOptions` = 角色 `model` ?? 跟随父会话路由
  - `toolFilter` = 角色 `tools.allow`（`{ allow }` 白名单；未配置则不过滤）
- **委派卡**：浏览器半 keyed `tool.call.toolview` 保留，角色 chip 显示注册表中的 name/description。

## 7. 飞书绑定主/子 Agent（bots/ + channels/feishu/）

- **bot 记录扩展**：`project_bot` domain 的 `bots` 表加 `agentRef?: string`（`.optional()`，同版本加可选字段零迁移）——缺省/`'main'` = 主 Agent，否则为注册表角色 id。
- **会话创建路径**：router 命中绑定后走 `ctx.agents.create({ agentOptions, setup })`：
  - `setup()`：绑定角色时，角色提示词分层注册为 `systemPrompt.section` + `tools.restrict({ allow })`；绑定 main 时不注册角色层、不过滤工具。
  - `agentOptions`：角色的 model 覆盖；main 用 `agentDefaultModel.currentSelection()`。
  - 基础工具由插件全局挂载（§4），会话内天然可用。
- **保留不动**：扫码建应用状态机、按项目分组、/new /stop /status 指令、单 in-flight 准入、表情回复、followup、卡片流式交替段序列、拆分/重试。
- **Bots 面板**：BotForm 加「绑定 Agent」下拉（主 Agent + 注册表角色）。

## 8. 浏览器半（单 bundle）

- **入口**：`sidebar.footer.action` 槽注册 3 个入口按钮（Agents / Bots / Usage），共享 `shared/` 入口工厂（消除现有 3 份重复）。
- **Agents 面板**（新核心 UI，仿 BotsModal 模式放大）：左侧角色列表（main 置顶锁定），右侧编辑器四区块：
  1. 基本信息（name/description）
  2. 提示词分层（layer 列表编辑 + 按模型规则预览）
  3. 模型（providers/models 级联下拉，缺省「跟随默认」）
  4. 工具白名单（工具名多选，RPC 列工具）
- **Bots 面板**：现有 BotsModal + BotForm 加绑定下拉，其余原样搬入。
- **Usage 面板**：现有 UsageModal + 热力图/柱状图原样搬入。
- **委派卡**：keyed toolview 保留。
- **RPC**：webServer 前缀路由 `/dsh-agent-toolkit/api` + fetch，Node 半单 handler 内部分发 agents/bots/usage/providers/models/tools 各组端点（沿用 project-bot api.ts 模式）。
- 浏览器半纯净度门禁沿用：跨模块值导入仅限同包，外部仅 `import type`。

## 9. 数据存储总览

| 数据 | domain | 表 | 迁移策略 |
|---|---|---|---|
| Agent 注册表 | `dsh_agent_toolkit`（新） | `agents` | 首启 YAML 一次性导入 |
| bots + bindings | `project_bot`（沿用） | `bots`（+`agentRef?`）、`bindings` | 同版本加可选字段，零迁移 |
| token 用量 | `token_usage`（沿用） | 日记录表 | 不动 |
| 全局提示词层/模型规则 | Config（不落 domain） | — | 用户手动平移配置 |

卸载语义照旧：经 `ctx` 注册的一切自动清理；domain close 等手动资源走 `ctx.effect`。

## 10. 共享层（shared/）消除重复清单

| 重复点 | 现状 | 归并后 |
|---|---|---|
| tsdown 客户端 bundle 配置 | 3 份 ~150 行逐字相同 | shared 单份配置工厂（含 project-bot 的 Node 内建门禁 + qrcode alias 扩展位） |
| 侧栏入口按钮 | UsageEntry/BotsEntry 近乎逐行相同 | shared 入口工厂组件 |
| 可选 webServer 路由 | token-usage/project-bot 同款 | shared 助手函数 |
| storage domain 打开 + 防 unhandled + close | 同款复制 | shared 助手函数 |
| Modal LoadState + stale 标志 | 同构复制 | shared hook |
| package.json devDependencies | 4 份雷同 | 单包一份 |

## 11. spec/plan 整理

- **归档**：`docs/superpowers/specs/` 现有 8 篇 + `plans/` 现有 9 篇全部对应已完成实现 → 移入各自 `archive/` 子目录；specs 根目录只留本篇。
- **修复**：`2026-08-25-飞书卡片过程输出与状态标记-design.md` 后半段乱码（GBK/UTF-8 混淆）——先尝试从 git 历史找回未损坏版本；找不回则在归档时于文首标注损坏段落范围。
- **AGENTS.md**：目录结构、开发命令、插件清单、agent-team 特殊接法（preset root/双挂载点，已作废）等段落全部改写为新单包结构。

## 12. 测试策略

- 现有 ~250 个测试随模块原样迁移（仅 import 路径与包名调整），保持全绿。
- 新增测试面：
  - Agent 注册表 CRUD + 内置保底 + main 锁定
  - prompt 分层装配两个出口（委托 persona 字符串 / setup sections）
  - 委托：role 解析失败清单错误、tools.allow 过滤透传、并行安全标记
  - bot 绑定 agentRef 的会话创建路由（main vs 角色）
  - YAML 首启导入
- 浏览器半：Agents 面板状态机、Bots 面板绑定下拉。

## 13. 非目标（YAGNI）

- 不做后台异步委托/任务队列（同步并行已确认够用）。
- 不做角色间互相委托/接力流水线（maxDepth 防套娃机制保留即可）。
- 不做会话内指令切换角色、@角色召唤（一个角色一个 bot 已覆盖触达需求）。
- 不做旧 domain 数据合并/迁移工具（原地保留即可）。
- 不做多 cordis 插件入口。
