# 定时任务（cron）能力设计

> 日期：2026-09-07 · 状态：已确认（待实施）
>
> 为 dsh-agent-toolkit 增加通用 cron 调度基础设施：定时让主 Agent 或注册表角色在独立新会话中执行提示词任务，UI 面板 + 模型工具双入口管理，保留运行历史。

## 1. 背景与定位

宿主 `@deepseek-ai/dsh-schedule` 是 opt-in 的**会话内提醒**插件（`schedule_create/list/delete`）：session-local 交付（原会话必须 live）、无 cron 表达式、无冷会话调度、无管理 UI。本能力与其语义不同：全局、跨会话、cron 规则、独立新会话执行、运行历史面板。

**与宿主 schedule 互斥**（理由：两套工具并存时模型误选率高，且 session-local 提醒在会话冷时静默失败；宿主 schedule 直挂在 agent.ctx own 层，插件无法物理移除他人注册的工具）：

1. 组合层：不加载 `@deepseek-ai/dsh-schedule`（其默认即不加载）；
2. toolkit 防护：在 `agent/created` 钩子里用 `tools.get('schedule_create', scope)` 探测宿主 schedule 工具是否在场，在场则响亮 warn 提示从组合中移除；
3. 文档写明二选一及理由；未来"会话内带上下文提醒"需求由本体系以 `target: {kind:'session'}` 收编（本期不实现）。

消息推送（如发飞书群）**不内建**进调度器：由执行 Agent 在任务提示词指引下自行调用飞书 CLI/skill 等工具完成（该能力已存在）。

## 2. 数据模型与存储

新模块 `packages/toolkit/src/schedule/`。存储域 `dsh_agent_toolkit_schedule`，schema 单一来源 `src/schedule/store.ts`，三个表：

### `tasks` 表（key = taskId）

```ts
interface CronTask {
  id: string                    // 生成 id，不复用
  name: string
  prompt: string                // 触发时作为 user message 的任务内容
  cwd: string                   // 执行工作目录，必填，须通过 validateProject 校验
  schedule:                     // 三选一
    | { kind: 'cron'; expr: string; timeZone?: string }  // timeZone 省略 = 服务器进程时区
    | { kind: 'at'; at: string }                         // RFC 3339，一次性
    | { kind: 'every'; seconds: number }                 // ≥60s，以创建时间为锚
  target:
    | { kind: 'main' }                 // 主 Agent：宿主默认模型，无 persona/restrict
    | { kind: 'role'; roleId: string } // 注册表角色：persona/model/工具白名单随角色
  catchup: boolean              // 停机漏跑：true = 重启后补跑一次；false = 跳到下一未来触发点
  enabled: boolean
  nextRunAt: string | null      // UTC，调度器维护的持久缓存（重启 rearm 依据）
  createdAt: string
  updatedAt: string
}
```

### `runs` 表（key = runId，按 taskId 查询）

```ts
interface CronRun {
  id: string
  taskId: string
  triggeredAt: string
  finishedAt?: string
  status: 'running' | 'ok' | 'error' | 'skipped-overlap'
  sessionId?: string            // 本次执行新建的会话 id
  error?: string                // 错误摘要（截断）
}
```

每任务环形保留最近 N 次运行（N 进 Config，默认 20），超出删最旧。删除任务时连带清运行历史。

### `meta` 表

schema 版本等一次性标记（沿用 agents store 的 meta 模式）。

## 3. 调度引擎（`src/schedule/scheduler.ts`）

- **计时**：`ctx.setInterval(30s)` 周期 tick（Cordis 自动清理）；tick 扫描 `enabled && nextRunAt <= now` 的任务并触发。
- **cron 解析**：引入 [`croner`](https://github.com/hexagon/croner)（零依赖、纯 ESM、原生 IANA 时区，~5KB）。创建/更新时即校验 expr 与 timeZone，非法直接拒绝不入库。
- **启动 rearm**：apply 时加载全部任务，对每条 enabled 任务重算 `nextRunAt`：
  - 仍在未来 → 保持；
  - 已过期且 `catchup: true` → 设为"立即"（首个 tick 补跑一次）；
  - 已过期且 `catchup: false` → 算下一个未来触发点；`at` 一次性任务无未来触发点，直接 `enabled = false, nextRunAt = null`（即过期即作废）。
- **触发后推进**：
  - `cron`：now 之后下一 occurrence；
  - `every`：创建锚点对齐的下一间隔（跳过中间错过的，不枚举积压）；
  - `at`：一次性，触发后 `enabled = false, nextRunAt = null`。
- **重叠保护**：内存 `Set<runningTaskId>`，同任务上次未结束则本次记 `skipped-overlap` 的 run，不并发执行。

## 4. 执行路径（`src/schedule/executor.ts`）

输入一条 task，输出一条 run 记录：

1. `sessionId = randomUUID()`；run 记录落库（`status: 'running'`）。
2. **解析装配**（main/role 共用序列，仅装配不同）：
   - `main`：`agentOptions = 宿主默认模型`，`hooks = {}`；
   - `role`：`agentOptions = role.model ?? 宿主默认模型`；`hooks` = 角色 persona 段（`dsh-agent-toolkit:agent:persona`）+ `tools.restrict(role.tools.allow)`（有白名单时）——与 Router 的 `resolveSession` 角色形态同款逻辑，抽公共函数复用；roleId 不存在时降级 main 形态并 warn（同 Router 语义）；
   - 两种形态均追加来源段 `dsh-agent-toolkit:schedule:task`（order 20）："本会话由定时任务「{name}」（id: …）于 {triggeredAt} 触发。"
3. `agents.create({ sessionId, cwd: task.cwd, agentOptions, hooks })`：内部走既有 `setupAgentScope`——joiner（`agent-bot` preset 优先、standing scope 回退，基础工具行 = persona/instructions/shell/fs/fs-search）挂祖先层 → 叠 hooks。
4. `workspace.attach(task.cwd, sessionId)`（失败仅 warn，会话降级未分组——同 Router.attach）。
5. `agent.followup(task.prompt)` 驱动首个 turn。
6. `await agent.whenIdle()` → run 标记 `ok`；异常 → `error` + 摘要。
7. **超时**：Config `schedule.runTimeoutMinutes`（默认 60，单位分钟——单次运行 followup→whenIdle 超 60 分钟即 `agent.cancel()` + run 记 `error('timeout')`），防失控任务永占重叠锁。

依赖面：`agents` / `tools` / `storageDomain` / `webServer`（可选）/ `agentPresets`（可选）+ 复用 channels 的 `setupAgentScope`/joiner——`inject` 列表不加新服务。

## 5. 模型工具（`src/schedule/tools.ts`）

注册在主 Agent scope（不进 subagent/bot 会话），`cron_` 前缀与宿主 `schedule_*` 区分。`execute` 返回规范 JSON、args 只读已校验（沿用仓库约定）：

| 工具 | 说明 |
|---|---|
| `cron_task_create` | 创建任务（name/prompt/cwd/target/schedule 三选一/catchup/enabled）。创建即校验 cron expr、时区、cwd、roleId 存在性，失败返回结构化错误不入库 |
| `cron_task_list` | 列出全部任务（enabled、nextRunAt、上次运行状态） |
| `cron_task_update` | 按 id 改任意字段（重算 nextRunAt） |
| `cron_task_delete` | 按 id 删除（连带清运行历史） |
| `cron_task_trigger` | 立即手动触发一次（不受 enabled 影响） |

同钩子内探测宿主 `schedule_create` 并存并 warn（见 §1）。

## 6. HTTP API（`src/schedule/api.ts`）

`registerOptionalRoutes` 注册，headless/CLI 惰性不抛错；供 UI 面板消费：

```
GET    /dsh-agent-toolkit/api/cron/tasks                列表
POST   /dsh-agent-toolkit/api/cron/tasks                创建
PUT    /dsh-agent-toolkit/api/cron/tasks/:id            更新
DELETE /dsh-agent-toolkit/api/cron/tasks/:id            删除
POST   /dsh-agent-toolkit/api/cron/tasks/:id/trigger    手动触发
GET    /dsh-agent-toolkit/api/cron/tasks/:id/runs       运行历史（最近 N 条）
GET    /dsh-agent-toolkit/api/cron/projects             候选 cwd 列表（复用/照搬 bots 的 workspace 项目列表）
```

## 7. UI 面板（`src/client/schedule/`）

- **入口**：`createSidebarEntry` 工厂，侧边栏底栏新图标「定时任务」（order 紧随 bots），点击开模态框（BotsModal 同款骨架）。
- **任务列表**：名称、调度规则摘要（cron/at/every + 时区）、目标（主 Agent / 角色名）、enabled 行内开关、nextRunAt（本地时区）、上次运行状态徽标；行内操作：编辑、删除（两段确认，复用 bots 删除确认模式）、立即触发。
- **编辑表单**：名称、提示词（多行）、项目下拉（§6 projects 端点）、目标 radio（主 Agent / 角色下拉）、调度 radio 三选一（cron：表达式 + 可选时区 + 下次 3 次触发预览；at：datetime；every：秒数）、catchup、enabled。
- **运行历史**：任务行展开/抽屉，列最近 N 次 run（触发时间、状态、耗时、错误摘要、sessionId 链接——点击打开对应会话）。
- 状态机复用 `useLoadState`；i18n 照 client 现有 locales 模式加中英词条。

## 8. Config 新增

```ts
schedule: {
  runTimeoutMinutes: number   // 默认 60
  runHistoryLimit: number     // 默认 20，每任务环形保留
}
```

（tick 间隔 30s 固定，不进 Config——YAGNI。）

## 9. 测试策略

vitest + fake ctx 既有套路：

- **store**：schema/CRUD/runs 环形裁剪/meta 标记（对齐 `agents/store.test.ts`）。
- **scheduler**：fake 时钟驱动 tick——cron 下次触发、at 一次性终结、every 锚点推进、catchup true/false 重启 rearm、重叠 skip、disabled 不触发。
- **executor**：fake AgentsPort——main/role 装配 hooks 正确性、角色缺失降级、来源段注入、whenIdle→ok、异常→error、超时 cancel、attach 失败仅 warn。
- **tools**：create 校验（非法 cron/时区/cwd/roleId 拒绝）、list/update/delete/trigger、主 Agent 可见性（subagent scope 不见）。
- **api**：七端点 round-trip + 404/校验失败路径（对齐 `bots/api.test.ts`）。
- **互斥探测**：schedule_create 在场时 warn。
- **client**：入口注册、模态框渲染、表单提交（对齐 bots-modal/bot-form 的 client.spec 模式）。
- **组合守护**：类 `scope-joiner.composition.test.ts` 真实组合测试——调度任务会话能 composeFrom 认父拿到基础工具行。
- **发布前 parity**（AGENTS.md 教训）：安装版 dsh + npm 装插件跑一遍：建 cron 任务 → 到点触发 → 面板看运行历史 → 跳会话。

## 10. 明确不做（YAGNI）

- bot 渠道投递目标（推送由执行 Agent 自行调工具完成）；
- `target: {kind:'session'}` 投递到既有会话（未来收编会话内提醒场景时再做）；
- 任务并发数上限、跨任务准入门禁、共享冷却；
- cron 秒级字段、日历规则扩展（croner 支持但首期不暴露）；
- tick 间隔可配。
