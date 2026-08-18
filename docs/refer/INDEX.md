# dsh 插件开发文档索引

> 本文档是 `docs/refer/` 下 DeepSeek Harness（dsh）官方文档的索引与开发指南，用于指导后续插件开发。
> 文档来源：<https://deepseek-harness.github.io/deepseek-harness/>（中文站，2026-08 抓取）。

---

## 一、学习路径

按此顺序阅读，从入门到精通：

| 阶段 | 文档 | 目标 |
|------|------|------|
| 1. 跑通环境 | [guide/quickstart.md](guide/quickstart.md)、[guide/providers.md](guide/providers.md) | 启动 Web UI、配置模型 |
| 2. 第一个插件 | [develop/basic/index.md](develop/basic/index.md) | 理解插件结构、`ctx`、自动清理 |
| 3. 第一个工具 | [develop/basic/tool.md](develop/basic/tool.md) | 用 `defineTool` 注册模型可调用的工具 |
| 4. 插件配置 | [develop/basic/config.md](develop/basic/config.md) | 用 Schemastery 让插件接受用户配置 |
| 5. 打包分发 | [develop/basic/publish.md](develop/basic/publish.md) | bundle / profile、`dsh plugin add` |
| 6. 框架深入 | [develop/framework/](develop/framework/index.md)（3 篇） | 生命周期、服务、事件 |
| 7. 实战模式 | [develop/practice/](develop/practice/index.md)（2 篇） | 能力三层拆分、LLM 适配器 |
| 8. 概念参考 | [reference/index.md](reference/index.md)（架构）→ [reference/cordis-primer.md](reference/cordis-primer.md) | 理解整体架构与扩展点 |
| 9. 按需查阅 | reference/ 下其余参考文档 | 具体子系统、cookbook、API |

动手实践可选 [develop/cordis-tutorial/](develop/cordis-tutorial/index.md)（7 章动手教程，在临时目录中构建，无需 API 密钥）。

---

## 二、核心概念速查

### 2.1 插件是什么

插件是一个导出 `apply` 函数的 TypeScript 模块，框架加载时调用并传入 `ctx`：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'           // 插件名
export const inject = ['tools']           // 依赖的服务（就绪后才执行 apply）
export const Config = Schema.object({...}) // 可选：配置 schema（Schemastery）

export function apply(ctx: Context, config: Config) {
  // 通过 ctx 注册能力：工具、事件监听、服务……
}
```

三种形态：**函数形式**（最常用）、**对象形式**（`export default { name, inject, apply }`）、**类形式**（`extends Service`，用于对外提供服务）。
→ 详见 [develop/basic/index.md](develop/basic/index.md)

### 2.2 生命周期（Fiber 状态机）

```
PENDING → LOADING → ACTIVE     ACTIVE → UNLOADING → DISPOSED
                 ↘ FAILED
```

- **自动清理**：通过 `ctx` 注册的一切（事件监听、工具、适配器）在卸载时自动撤销，无需手动 remove/clear
- **手动资源**：用 `ctx.effect(() => { ...; return () => cleanup() })`，返回的函数在卸载时运行
- **依赖消失**：必需服务卸载 → 插件自动 dispose；服务恢复 → 自动重新加载
- **清理顺序**：处置器按注册逆序并发执行；有顺序依赖的清理必须放进同一个 `ctx.effect()`
- **子插件**：`ctx.plugin(childPlugin)` 创建子 Fiber；`await fiber.dispose()` 手动卸载
- **HMR**：加载 HMR 插件后，改源码或 `cordis.yml` 中的 config 都会触发热替换

→ 详见 [develop/framework/index.md](develop/framework/index.md)

### 2.3 服务与依赖

- 服务 = 挂载在 `ctx` 上的命名能力（`ctx.tools`、`ctx.llm`、`ctx.agents`…）
- **使用服务**：`export const inject = ['tools']`，`apply` 执行时保证就绪；可选依赖用 `ctx.get('metrics')`
- **提供服务**：继承 `Service` 基类，`super(ctx, 'name')` 后即可通过 `ctx.name` 被消费
- **类型声明**：用 `declare module '@deepseek-ai/cordis' { interface Context { metrics: MetricsService } }` 声明合并
- **服务隔离**：`cordis.yml` 中 `group: true` + `isolate` 让不同插件组看到不同服务实例

→ 详见 [develop/framework/service.md](develop/framework/service.md)

### 2.4 事件系统

| 分发模式 | 语义 | 是否 await | 返回值 |
|---|---|---|---|
| `emit` | 广播，所有监听器同步执行 | 否 | 无 |
| `bail` | 首个非 null/false/undefined 的返回值为结果 | 否 | 有 |
| `serial` | 按序执行并等待异步结果，首个有效返回终止 | 是 | 有 |
| `parallel` | 所有监听器并行 | 是 | 无 |
| `waterfall` | 流水线/中间件，**监听器必须调用 `next()`**，不调则短路 | 否 | 有 |

- 类型安全：`declare module '@deepseek-ai/cordis' { interface Events { 'my-plugin/ready': (...) => void } }`
- 命名约定：`namespace/action`（如 `agent/step`、`tools/result`、`session/event`）
- **关键区分**：`turn/*`、`step/*`、`tool/call`、`tool/result`、`compaction/*` 是**持久会话事件**（不是 Cordis 事件），观察它们要监听 `session/event` 并检查 `event.type`
- 事件三域：**会话事件**（持久事实，重载后仍在）、**Agent 事件** `agent/*`（进行中的工作）、**能力事件**（`fs/*`、`tools/*` 等策略/适配器挂点）

→ 详见 [develop/framework/events.md](develop/framework/events.md)、[reference/cordis-primer.md](reference/cordis-primer.md)

### 2.5 插件配置

- 导出同名 `interface Config` + `const Config: Schema<Config>`（Schemastery），默认值写在 schema 里
- 加载时校验，非法配置加载失败并报明确错误；**不要**导出普通对象（不满足 Standard Schema 接口）
- 设计原则：**凡是不同部署可能取不同值的参数，都必须定义为配置字段**（无硬编码可调参数）
- 改 `cordis.yml` 中的 config 触发插件热替换（HMR）

→ 详见 [develop/basic/config.md](develop/basic/config.md)

### 2.6 工具开发（最常用扩展点）

```ts
ctx.tools.register(defineTool({
  name: 'greet',
  description: 'Greet someone by name.',
  parameters: { name: { type: 'string', required: true } },
  output: {
    schema: { type: 'string' },                              // 规范值类型
    render: (_args, value) => [{ type: 'text', text: value }], // 转为模型可见内容
  },
  async execute(args, exec) { return `Hello, ${args.name}!` },
}))
```

`execute()` 约定（以 [reference/cookbook/adding-a-tool.md](reference/cookbook/adding-a-tool.md) 为准）：

- `args` 已按 schema 校验，视为**只读**；schema 表达不了的约束（非空、正数、跨字段）需手动检查
- 返回 `output.schema` 声明的**规范 JSON 值**，不要返回内容块；抛异常 = `isError`
- 遵守 `exec.signal` 取消；用 `exec.agent.inject()` 发异步通知（追加持久上下文，非唤醒）
- **长时间任务**：`ctx.jobs.start({ kind, label, owner: exec.agent, run })`，发布后改用任务自有取消信号
- **UI 卡片**：`presentCall`/`presentResult` 必须是纯函数（无 I/O、无时钟），返回 `card` 渲染意图（generic/terminal/diff/search/web）；`presentationMeta` 投影可回放的持久数据

工具执行流水线的扩展点（策略不要内建到工具里）：

| 扩展点 | 用途 |
|---|---|
| `tools/pre-execute`（waterfall） | 允许/拒绝/询问策略（权限门禁） |
| `ctx.tools.guard()` | 单调最终拒绝，不可撤销 |
| `tools/execute`（waterfall） | 包裹分发：截止时间、重试、指标 |
| `tools/post-execute`（waterfall） | 替换/阻止结果、附加模型可见上下文 |
| `tools/result` | 观察不可变的最终结果 |

Code Mode 下每个已注册工具自动可用 `await tools.<name>(args)` 调用，无需额外集成。

### 2.7 能力三层拆分（Seam）

当能力需要**可替换的提供方**时，拆分为三种角色（完整能力构成一个 seam）：

| 角色 | 职责 | 示例（Bash 能力） |
|---|---|---|
| Service Definition | 定义服务接口 + Request/Result 类型 | `dsh-shell` |
| Service Provider | 实现接口，可被替换 | `dsh-bash-local` |
| Consumer | 消费接口（通常是面向模型的工具） | `dsh-tool-bash` |

Provider 和 Consumer 都只依赖 Definition，**互不依赖**。原则：**不要预防性拆分**——简单工具插件无需拆分。
→ 详见 [develop/practice/index.md](develop/practice/index.md)、[reference/capability-seams.md](reference/capability-seams.md)（全部内置 seam 清单）

### 2.8 LLM 适配器

继承 `LlmAdapter` 实现 `stream()`，`ctx.llm.registerAdapter(['my-provider'], adapter)` 注册：

- `StreamChunk` 协议：`block-start` → `text-delta`/`tool-call-delta`（可多次）→ `block-end`（每个块必须配对）；`usage` → `finish`（必须最后一个）
- 错误：抛带稳定 code 的 `LlmError`；HTTP 请求必须合并 `attributionHeaders()` 并传递 `options.signal`
- 覆写 `resolveModel()` 报告模型身份/推理强度；可覆写 `listModels()` 公布模型选项

→ 详见 [develop/practice/llm-adapter.md](develop/practice/llm-adapter.md)、[reference/cookbook/adding-an-llm-adapter.md](reference/cookbook/adding-an-llm-adapter.md)

### 2.9 打包与安装

- **组合包（bundle）**：npm 包 + `dsh.bundle` manifest（指向一个 patch 文件），回答"这个包贡献什么"
- **profile**：`$DSH_HOME/profiles/<name>` 目录 + `dsh.profile` manifest（有序 `bundles` 列表），回答"这套配置由哪些包组成"
- 安装：`dsh plugin --profile demo add ./hello-plugin`（内部转发 pnpm；remove 同时移除层）
- **加载顺序**（后者按行胜出，patch 替换目标行的**整个** `config`，不做深度合并）：
  1. profile 的 `bundles` 列表（先 `@deepseek-ai/dsh-base`，再按安装顺序）
  2. profile 自己的 `cordis.patch.yml`
  3. home 级 `$DSH_HOME/cordis.patch.yml`
  4. `--patch <path>` overlays（按 argv 顺序）
- 从 GitHub 安装：作者需提供自包含的 `prepare` 构建脚本；用户需在 `pnpm-workspace.yaml` 的 `allowBuilds` 授权；不想授权就发 npm 或 `pnpm pack` 交付 tarball
- 调试验证：`dsh --profile demo --dump-config`

→ 详见 [develop/basic/publish.md](develop/basic/publish.md)

### 2.10 架构关键认知

- **模型可见即已记录**：抵达模型请求的一切都必须能从会话日志重建（有运行时不变量断言）；新增模型可见输入 = 扩展 `SessionEventMap` + 从日志渲染
- **没有特权内核**：扩展 dsh = 把插件挂载到其他插件旁边；每个产品功能都映射到文档化的扩展点
- 一个**步骤** = 一次模型请求 + 它调用的工具；一个**轮次** = 零或多个步骤
- 开发调试：在仓库中用 `pnpm dsh web --patch ./your/cordis.yml` 加载本地插件（插件路径必须绝对路径）

→ 详见 [reference/index.md](reference/index.md)（架构）、[reference/agent-lifecycle.md](reference/agent-lifecycle.md)（轮次时序图）

---

## 三、任务导向索引（我要做 X → 看哪里）

| 我要做… | 机制 | 文档 |
|---|---|---|
| 添加一个模型可调用的工具 | `ctx.tools.register(defineTool(...))` | [basic/tool](develop/basic/tool.md) → [cookbook/adding-a-tool](reference/cookbook/adding-a-tool.md)（权威约定） |
| 工具要跑后台长任务 | `ctx.jobs.start()` | [cookbook/adding-a-tool](reference/cookbook/adding-a-tool.md) + [subsystems/jobs](reference/subsystems/jobs.md) |
| 工具要好看的 UI 卡片 | `presentCall`/`presentResult`/`presentationMeta` | [cookbook/adding-a-tool](reference/cookbook/adding-a-tool.md) |
| 拦截/审批工具调用（权限门禁） | 监听 `tools/pre-execute` 返回类型化决策 | [cookbook/extension-cookbook](reference/cookbook/extension-cookbook.md)（钩子插件示例） |
| 给工具加超时/重试/指标 | 包裹 `tools/execute` | 同上 |
| 审计/记录工具结果 | 监听 `tools/result`（只观察） | [framework/events](develop/framework/events.md) 日志插件示例 |
| 接入新模型提供方 | `LlmAdapter` 子类 + `registerAdapter` | [practice/llm-adapter](develop/practice/llm-adapter.md) + [cookbook/adding-an-llm-adapter](reference/cookbook/adding-an-llm-adapter.md) |
| 提供可替换能力（新 seam） | 三角色拆分 | [practice/index](develop/practice/index.md) + [capability-seams](reference/capability-seams.md) |
| 让插件接受配置 | 导出 Schemastery `Config` | [basic/config](develop/basic/config.md) |
| 提供插件间服务 | `extends Service` + `super(ctx, 'name')` | [framework/service](develop/framework/service.md) |
| 添加用户斜杠命令 | `ctx.commands` 注册（不经过模型） | [架构「新行为的归属位置」](reference/index.md) + [subsystems/commands](reference/subsystems/commands.md) |
| 注入模型可见上下文 | `agent.inject()` / `ctx.systemPrompt.section()` | [架构](reference/index.md) + [subsystems/system-prompt](reference/subsystems/system-prompt.md) |
| 监听会话做 UI/日志/遥测 | `ctx.on('session/event', ...)` 检查 `event.type` | [cookbook/extension-cookbook](reference/cookbook/extension-cookbook.md)（UI 插件） |
| 拦截模型请求/轮次 | `agent/pre-step`、`agent/request`、`llm/stream`（waterfall）、`agent/turn-stopping`（serial） | [reference/agent-lifecycle](reference/agent-lifecycle.md) |
| 添加 Web Client Chat 节点 | `ConversationNodeDefinition` + keyed renderer | [cookbook/adding-a-conversation-node](reference/cookbook/adding-a-conversation-node.md) |
| 添加设置卡片 | settings namespace + UI 卡片 | [cookbook/adding-a-settings-card](reference/cookbook/adding-a-settings-card.md) |
| 添加文件系统/shell/子进程等新后端 | 注册对应 seam 的提供方（`ctx.fs`/`ctx.shell`/`ctx.subprocess`/`ctx.terminals`/`ctx.sandbox`） | [架构映射表](reference/index.md) + 各子系统页 |
| 打包分发给用户 | bundle + `dsh plugin add` | [basic/publish](develop/basic/publish.md) |
| 在 monorepo 新增 package | 检查清单 | [cookbook/adding-a-package](reference/cookbook/adding-a-package.md) |
| 功能→机制速查 | — | [cookbook/extension-cookbook](reference/cookbook/extension-cookbook.md) 的「功能→机制映射」表（钩子、/goal、/loop、压缩、plan mode、subagent、MCP、skill、记忆、cron 等） |

---

## 四、完整文档清单

### 4.1 入门（guide/）

| 文档 | 内容 |
|---|---|
| [guide/quickstart.md](guide/quickstart.md) | 使用 Web UI：配置模型、选择工作区、运行任务 |
| [guide/providers.md](guide/providers.md) | 配置模型：其他提供方与 OpenAI 兼容端点 |
| [guide/python-sdk.md](guide/python-sdk.md) | Python SDK：在自己程序中驱动同一套 agent API |

### 4.2 开发（develop/）

**基础 basic/**
| 文档 | 内容 |
|---|---|
| [index.md](develop/basic/index.md) | 第一个插件：插件结构、自动清理、inject、三种插件形态 |
| [tool.md](develop/basic/tool.md) | 开发一个 Tool：`defineTool` DSL 入门 |
| [config.md](develop/basic/config.md) | 插件配置：Schemastery schema、校验、设计原则、HMR |
| [publish.md](develop/basic/publish.md) | 打包与安装：bundle/profile manifest、加载顺序、GitHub 安装 |

**框架能力 framework/**
| 文档 | 内容 |
|---|---|
| [index.md](develop/framework/index.md) | 插件与生命周期：Fiber 状态机、自动清理、嵌套上下文、dispose、HMR |
| [service.md](develop/framework/service.md) | 服务与依赖：Service 基类、类型合并、可选依赖、服务隔离 |
| [events.md](develop/framework/events.md) | 事件系统：emit/bail/serial/waterfall、类型化事件、持久事件 vs Cordis 事件 |

**实战 practice/**
| 文档 | 内容 |
|---|---|
| [index.md](develop/practice/index.md) | 能力三种角色：Definition/Provider/Consumer 拆分与完整教程 |
| [llm-adapter.md](develop/practice/llm-adapter.md) | LLM 适配器：StreamChunk 协议、注册、错误处理 |

**Cordis 框架教程 cordis-tutorial/**（动手实践，7 章）
| 文档 | 内容 |
|---|---|
| [index.md](develop/cordis-tutorial/index.md) | 总览与准备工作 |
| [01-first-plugin.md](develop/cordis-tutorial/01-first-plugin.md) | 编写第一个插件 |
| [02-lifecycle-and-effects.md](develop/cordis-tutorial/02-lifecycle-and-effects.md) | 生命周期与 effect |
| [03-services.md](develop/cordis-tutorial/03-services.md) | 服务 |
| [04-events.md](develop/cordis-tutorial/04-events.md) | 事件 |
| [05-config.md](develop/cordis-tutorial/05-config.md) | 配置 |
| [06-composition-and-hmr.md](develop/cordis-tutorial/06-composition-and-hmr.md) | 组合与 HMR（热模块替换） |
| [07-into-the-harness.md](develop/cordis-tutorial/07-into-the-harness.md) | 进入 harness：注册真实工具并观察事件 |

### 4.3 参考（reference/）

**概念**
| 文档 | 内容 |
|---|---|
| [index.md](reference/index.md) | **架构总览**（改代码前必读）：Cordis、profile/bundle、核心包、事件三域、轮次流程、会话日志、能力 seam、新行为归属位置映射表 |
| [cordis-primer.md](reference/cordis-primer.md) | Cordis 入门：五个核心概念、分发模式、waterfall 语义、Loader 配置 |
| [capability-seams.md](reference/capability-seams.md) | 能力 seam 全景图：所有 ctx 键、所属包、实现与消费方（生成） |
| [agent-lifecycle.md](reference/agent-lifecycle.md) | Agent 轮次与步骤生命周期时序图 |
| [tool-execution-pipeline.md](reference/tool-execution-pipeline.md) | 工具执行流水线：钩子、子代理、沙箱、UI 渲染如何参与 |

**生成参考**（自动生成的目录）
| 文档 | 内容 |
|---|---|
| [config-catalog.md](reference/config-catalog.md) | 插件配置项目录：`cordis.yml` 每个 `config:` 块的完整字段 |
| [tool-catalog.md](reference/tool-catalog.md) | Tool Schema 目录：所有已注册工具的 name/description/parameters |
| [persistence-catalog.md](reference/persistence-catalog.md) | 会话持久化事件目录：`SessionEvent` 词汇与 `SessionEventMap` 成员 |

**Cordis API（cordis-api/）**
| 文档 | 内容 |
|---|---|
| [context.md](reference/cordis-api/context.md) | 上下文：所有服务/事件/注册 API 的入口 `ctx` |
| [events.md](reference/cordis-api/events.md) | 事件 API |
| [fiber.md](reference/cordis-api/fiber.md) | Fiber：已加载插件实例及其状态 |
| [registry.md](reference/cordis-api/registry.md) | 插件注册表与依赖注入 |
| [service.md](reference/cordis-api/service.md) | Service 基类 |
| [inherited.md](reference/cordis-api/inherited.md) | 继承接口面（仅英文） |

**开发手册（cookbook/）**
| 文档 | 内容 |
|---|---|
| [extension-cookbook.md](reference/cookbook/extension-cookbook.md) | **扩展模式总览**：工具/钩子/UI/协议驱动插件模式 + 功能→机制映射表 |
| [adding-a-tool.md](reference/cookbook/adding-a-tool.md) | **工具编写权威参考**：execute 约定、后台任务、策略钩子、Code Mode、UI 卡片 |
| [adding-a-package.md](reference/cookbook/adding-a-package.md) | 新增 workspace 包的检查清单 |
| [adding-an-llm-adapter.md](reference/cookbook/adding-an-llm-adapter.md) | 新增 LLM 适配器实操 |
| [adding-a-settings-card.md](reference/cookbook/adding-a-settings-card.md) | 新增设置卡片 |
| [adding-a-conversation-node.md](reference/cookbook/adding-a-conversation-node.md) | 新增 Web Client Conversation Node |
| [adding-a-vendored-package.md](reference/cookbook/adding-a-vendored-package.md) | 新增 vendored 包（第三方 Cordis 插件固定版本引入） |

**子系统（subsystems/）**——每个子系统一页，含生成的 Cordis API 区块

| 分组 | 文档 |
|---|---|
| 总览 | [index.md](reference/subsystems/index.md) |
| 内核与作用域 | [core.md](reference/subsystems/core.md)（核心：agent 接口/驱动器/事件）、[scope.md](reference/subsystems/scope.md)（按 agent 划分作用域）、[invariants.md](reference/subsystems/invariants.md)（运行时不变式） |
| 会话与持久化 | [session.md](reference/subsystems/session.md)、[session-query.md](reference/subsystems/session-query.md)、[session-reference.md](reference/subsystems/session-reference.md)、[session-title.md](reference/subsystems/session-title.md)、[session-projection.md](reference/subsystems/session-projection.md)、[persistence.md](reference/subsystems/persistence.md)、[spill.md](reference/subsystems/spill.md)（过大工具输出外置存储）、[session-telemetry.md](reference/subsystems/session-telemetry.md) |
| 模型与上下文 | [llm-streaming.md](reference/subsystems/llm-streaming.md)、[token-meter.md](reference/subsystems/token-meter.md)、[system-prompt.md](reference/subsystems/system-prompt.md)、[compaction.md](reference/subsystems/compaction.md)（上下文压缩） |
| 执行与工具 | [tools.md](reference/subsystems/tools.md)、[shell.md](reference/subsystems/shell.md)（Bash）、[subprocess.md](reference/subsystems/subprocess.md)、[terminal.md](reference/subsystems/terminal.md)（PTY）、[jobs.md](reference/subsystems/jobs.md)（后台任务）、[filesystem.md](reference/subsystems/filesystem.md)、[lsp.md](reference/subsystems/lsp.md)、[code-runtime.md](reference/subsystems/code-runtime.md)、[web.md](reference/subsystems/web.md)（搜索/抓取）、[skills.md](reference/subsystems/skills.md)、[workflow.md](reference/subsystems/workflow.md)、[subagent.md](reference/subsystems/subagent.md) |
| 策略与交互 | [approval.md](reference/subsystems/approval.md)（审批）、[permission-presets.md](reference/subsystems/permission-presets.md)、[sandbox.md](reference/subsystems/sandbox.md)、[plan.md](reference/subsystems/plan.md)（计划模式）、[user-questions.md](reference/subsystems/user-questions.md)、[commands.md](reference/subsystems/commands.md)、[goal.md](reference/subsystems/goal.md)、[schedule.md](reference/subsystems/schedule.md)（定时提醒） |
| 平台与接入 | [web-server.md](reference/subsystems/web-server.md)、[typert.md](reference/subsystems/typert.md)（远程调用）、[client-modules.md](reference/subsystems/client-modules.md)、[storage.md](reference/subsystems/storage.md)、[workspace.md](reference/subsystems/workspace.md)、[settings.md](reference/subsystems/settings.md)、[credentials.md](reference/subsystems/credentials.md) |
| 其他 | [attachment.md](reference/subsystems/attachment.md)（会话图片附件）、[extensions.md](reference/subsystems/extensions.md)（动态 Cordis 扩展）、[feedback.md](reference/subsystems/feedback.md)（消息反馈） |

---

## 五、开发注意事项（从文档提炼的硬规则）

1. **注册即副作用**：所有通过 `ctx` 的注册都会随插件卸载自动清理；有手动资源必须 `ctx.effect()` 返回 disposer；有顺序依赖的清理放同一个 effect
2. **waterfall 必须调用 `next()`**，除非故意短路（策略拦截场景）
3. **工具 `args` 只读**；返回规范 JSON 值而非内容块；UI 格式（围栏块、diff）不进入模型结果
4. **presentCall/presentResult 必须是纯函数**——回放时也会运行
5. **不内建部署策略到工具**：用 `tools/pre-execute` 等扩展点
6. **配置优先**：可调参数都进 Config schema，不硬编码；无效配置要在加载时响亮失败
7. **patch 覆盖是整行替换**：覆盖前面层的行时必须重述该行所有键
8. **模型可见即已记录**：新的模型可见输入需要扩展 `SessionEventMap`
9. **不要预防性拆分 seam**：简单插件一个包足矣
10. **服务接口以生成为准**：`ctx` 服务名/方法/事件签名看各子系统页生成的 `cordis-surface` 区块和 TS 接口，不要维护静态清单
