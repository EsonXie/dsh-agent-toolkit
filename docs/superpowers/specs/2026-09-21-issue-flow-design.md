# Issue 驱动的多 Agent 开发流水线设计

> 日期：2026-09-21 · 状态：待实施
>
> 新独立插件包 `@dsh-agent-toolkit/issue-flow`（`packages/flow`）：人编写 issue 驱动多个 Agent 按状态流水线开发；每个状态至少一次会话并产出交接文档（随仓库走），状态间由人做验收门禁；Gitea 等外部平台作为单向投影（写单向、读按需拉取），首期同步目标为私有部署 Gitea。UI 层本期不涉及（见 §10）。

## 1. 背景与定位

已有底座：toolkit 提供 Agent 注册表（角色 persona/工具白名单）、team_delegate 委派、会话管理、存储域、credentials 等。本插件在其上加一层**编排**：issue 状态机 + 交接文档链 + 人工门禁 + 外部平台同步。

与市面产品的差异化（调研结论：值得做）：

- GitHub Copilot coding agent / Devin / Jules / Codex 云端版：**单阶段派单制**（issue → Agent → PR），无状态流水线、无交接文档、绑定 GitHub + 云端。
- Claude Code GitHub Actions / OpenHands resolver：评论触发器，无流水线与门禁。
- ChatDev / MetaGPT（学术）：多阶段文档交接同构，但无 issue 跟踪、无人工门禁、demo 级。
- 空白组合：**按项目可配置的状态流水线 + 状态间人工验收门禁 + 每状态交接文档随仓库走 + 自托管 Gitea 同步**。

**核心边界**：issue 状态机不依赖 Gitea——Gitea 离线时核心流程完整可用，同步是旁路。文档唯一载体是仓库文件 `docs/issues/{seq}/`，不依赖任何平台。

## 2. 包与宿主关系

新包 `packages/flow`，npm 名 `@dsh-agent-toolkit/issue-flow`，结构照 `packages/toolkit` 蓝本（package.json/peerDeps 拷贝 ACP 依赖集；`src/index.ts` 命名导出 `name`/`inject`/`Config`/`apply`，无 default export；双半 bundle `lib/index.js` + `lib/client.js`）。

**跨插件服务消费（方案 A 的前置改动）**：cordis 原生支持 `ctx.provide(name, value)` 暴露服务、他插件 `inject` 消费，提供方卸载/热替换时消费方自动卸载并重载（docs/refer/develop/cordis-tutorial/03-services.md）。toolkit 当前未 provide 任何服务，registry 为 apply 内部私有对象（packages/toolkit/src/index.ts:170）。故 toolkit 需一处增量改动：

```ts
ctx.provide('agentToolkit', { registry, presetId /* agent-team preset id 或 undefined */ })
```

issue-flow 侧 `inject`：`['agentToolkit', 'storageDomain', 'agents', 'llm', 'tools', 'credentials', 'commands', 'systemPrompt']`（集合在实施时按实际消费收窄）。对 toolkit 只经服务契约消费，**不 import 其代码**；`agentToolkit` 服务的类型在 issue-flow 内定义最小接口（结构化类型）。

## 3. 数据模型与存储

存储域 `dsh_issue_flow`，schema 与 domain 布局单一来源 `packages/flow/src/core/store.ts`。五张表：

### `projects` 表（key = projectId）

```ts
interface Project {
  id: string
  name: string
  repoPath: string              // 本地 clone 绝对路径（bare 或工作区）
  defaultBranch: string         // 如 main
  remote?: {                    // 同步目标；缺省 = 纯本地模式
    kind: 'gitea'               // 接口预留 'github' 等
    url: string                 // https://gitea.internal
    owner: string
    repo: string
    credentialRef: string       // 走宿主 credentials 服务，不存明文 token
  }
  pipelineRef?: string          // 指向 pipelines 表；缺省用内置默认流水线
  envStrategy: EnvStrategy      // 项目默认，issue 可覆盖
}

type EnvStrategy =
  | { kind: 'worktree' }                        // 默认：主 clone + 每 issue 独立 worktree
  | { kind: 'branch' }                          // 本地新建分支，在主工作区切换
  | { kind: 'custom'; setup: string; cwd: string }  // 自定义命令
```

### `pipelines` 表（key = pipelineId）

```ts
interface Pipeline {
  id: string                    // 'builtin:default' 或项目自定义 id
  name: string
  states: PipelineState[]       // 线性数组；首期不做分支/并行状态
}

interface PipelineState {
  key: string                   // 'designing' | 'implementing' | ...
  label: string
  interaction: 'dialog' | 'autonomous' | 'gate'
  agentRef: string              // toolkit 注册表角色 id（'main' 或自定义角色）
  instructions?: string         // 该状态附加提示词（产出要求等）
  docFile: string               // 交接文档文件名，如 '01-design.md'
}
```

内置默认流水线：

| key | interaction | 职责 |
|---|---|---|
| `triaging` | dialog | 需求澄清、范围界定 |
| `designing` | dialog | 方案设计，产出设计文档 |
| `implementing` | autonomous | 编码实现 |
| `reviewing` | gate | 人工验收 |
| `done` | —（终态） | 归档 |

### `issues` 表（key = issueId，单一事实源）

```ts
interface Issue {
  id: string                    // 内部 id（短 hash），不复用
  projectRef: string
  seq: number                   // 项目内序号；对应 docs/issues/{seq}/ 与 Gitea 关联
  title: string
  body: string                  // 人编写的 issue 正文（markdown）
  status: string                // 当前状态 key；'awaiting:<stateKey>' 表示待确认子状态
  envStrategy?: EnvStrategy     // issue 级覆盖
  sessions: IssueSession[]
  comments: IssueComment[]
  giteaRef?: { number: number } // 同步后回写的 Gitea issue number；投影指针，非数据源
  ledger: {
    createdAt: number
    stateHistory: { stateKey: string; enteredAt: number; leftAt?: number; approvedBy?: string }[]
  }
}

interface IssueSession {
  stateKey: string
  sessionId: string             // dsh 会话 id（dialog 模式 = 人可直接进入对话）
  startedAt: number
  endedAt?: number
  outcome?: 'completed' | 'rejected' | 'aborted'
}

interface IssueComment {
  source: 'local' | 'gitea'
  author: string
  body: string
  at: number
  delivered: boolean            // 是否已投递给 Agent（攒批投递依据）
  remoteId?: string             // Gitea 评论 id（入站去重游标）
}
```

### `outbox` 表（key = outboxId，同步出站队列）

```ts
interface OutboxEntry {
  id: string
  kind: 'ensure-issue' | 'edit-issue' | 'comment' | 'labels' | 'close'
  projectRef: string
  issueRef: string
  payload: unknown              // 按 kind 结构化
  attempts: number
  nextRetryAt: number
  dead?: boolean                // 重试超限标记，可手动重放
}
```

### `meta` 表

一次性迁移标记、项目级 `seq` 计数器（`seq:<projectRef>`）等，沿用 toolkit agents store 的 meta 模式。

**设计要点**：

- **Gitea 是投影不是源**：`giteaRef` 只是指针，Gitea 数据丢失不损坏本地流程。
- **评论统一入 `comments` 数组**：本地与拉取的同构；评论天然只增不改，无冲突面。
- **文档不进存储域**：文档唯一载体是仓库文件，存储域只存会话/状态机读元数据。

## 4. 流水线引擎

- **定义加载**：`builtin:default` 内置；项目经 UI（二期）或存储直接写入自定义流水线（复制内置后改）。创建/更新时校验：状态 key 唯一、终态存在、gate 状态至少一个、docFile 非空且互不重复。
- **流转规则**：线性推进 `states[i] → states[i+1]`；每个工作状态完成后停在 `awaiting:<stateKey>` **待确认子状态**，人确认才真正进入下一状态——统一所有状态的验收门禁。打回 = 回到同一状态（新会话携带打回评论）。
- **状态权威**：状态机永远以本地为准。Gitea 侧改 label 不驱动本地状态机（单向语义，避免双脑）。
- **文档硬条件**：状态标记完成前执行器检查 `docs/issues/{seq}/{docFile}` 存在且非空，否则拒绝推进并提示。
- **台账**：每次状态流转/会话结束，重生成 `docs/issues/{seq}/README.md`（进度台账 + 状态文档索引 + 会话历史），提交进 git。

## 5. 状态执行器与交互模式

**状态进入统一流程**（人推进或打回时触发，`src/execute/executor.ts`）：

1. 环境准备：按 envStrategy 建 worktree（默认，路径 `<repoPath>/.worktrees/issue-{seq}`、分支 `issue/{seq}-{slug}`）/本地分支/自定义命令。
2. 拉取 Gitea 新评论入队（会话唤起前的固定动作）。
3. 上下文组装：issue 正文 + 未投递评论 + **前序状态全部交接文档**（从 `docs/issues/{seq}/` 读，文档是唯一交接载体，Agent 不靠记忆）。
4. 建会话：`agentRef` 经 `agentToolkit.registry` 取角色（persona + 工具白名单），工作目录指向 worktree，系统提示附加该状态 `instructions` 与文档产出要求；会话装配复用 toolkit 的 setup/scope 路径经验（角色白名单与会话可见面求交、未知 warn-drop）。
5. 写入 `sessions[]` 记录。

**三种交互模式运行期行为**：

| | dialog（设计/决策） | autonomous（实现） | gate（验收） |
|---|---|---|---|
| Agent 形态 | 常驻会话，人直接在 dsh 会话界面聊 | 一次性/续作式任务会话，跑完即停 | Agent 不运行 |
| 评论处理 | 评论仅存档：Agent 把对话结论摘要回写 issue（→ Gitea） | 评论攒批，当前会话结束或 checkpoint 时批量投递 | 评论积攒，作为打回意见 |
| 离开状态 | 人点「完成本状态」→ Agent 产出状态文档 → 待确认 | Agent 自检完成 → 产出文档 → 待确认 | 人二选一：通过（推进）/打回（评论带入同状态新会话） |

**机制说明**：

- **打回不丢上下文**：打回时新会话拿到该状态已有文档 + 打回评论，在原 worktree 上继续。
- **dialog 评论不做实时双向**（首期收窄）：人想实时聊就进会话界面；Gitea 评论只在会话唤起时拉取。实时插入进行中会话需宿主能力支持，列入二期候选。
- **会话中断恢复**：会话异常中断 → issue 停在原状态、会话标记 `aborted`，可重启同状态会话。

## 6. 环境策略（`src/execute/env.ts`）

策略注册表模式，issue 级可选、项目级默认：

- `worktree`（默认）：`git worktree add <repoPath>/.worktrees/issue-{seq} -b issue/{seq}-{slug}`，隔离性最好，天然支持多 issue 并行。
- `branch`：主工作区 `git checkout -b issue/{seq}-{slug}`（要求工作区干净，检出前校验）。
- `custom`：执行用户配置的 `setup` 命令，产出的 `cwd` 作为会话工作目录。

issue 完成（done）后 worktree/分支保留（清理策略二期定）。

## 7. Gitea 同步层（`src/sync/`）

**适配器接口**（Gitea 为首实现，GitHub 等后续可加）：

```ts
interface IssueSyncAdapter {
  ensureIssue(project: Project, issue: Issue): Promise<{ number: number }>
  pushComment(project: Project, num: number, body: string): Promise<{ remoteId: string }>
  pushLabels(project: Project, num: number, labels: string[]): Promise<void>
  pullComments(project: Project, num: number, since?: string): Promise<RemoteComment[]>
  close(project: Project, num: number): Promise<void>
}
```

**出站（dsh → Gitea），outbox 模式**：

- 每次本地变更（issue 创建/编辑、状态流转、文档完成、Agent 摘要、台账更新）先提交本地，再追加 outbox 记录；后台 worker（`ctx.setInterval` tick）消费，成功即删，失败指数退避，超限（默认 50 次）标记 `dead`，可手动重放。
- **Gitea 离线不阻塞任何本地流程**，恢复后自动追平——单向同步的最大红利。
- 推送内容映射：
  - issue 创建/正文编辑 → Gitea issue 创建/编辑（`ensureIssue` 幂等，回写 `giteaRef.number`）
  - 状态流转 → label `status:{key}`（排他组，先清同组旧 label）+ 一条流转评论（含操作人、打回原因）
  - 状态文档完成 → 评论附文档摘要 + 仓库内路径
  - dialog 会话结论 → Agent 摘要评论
  - done → `close`
- 凭据走宿主 `credentials` 服务（toolkit 飞书模块同款先例），不存明文。

**入站（Gitea → dsh），按需拉取**：

- 三个触发点：会话唤起前（必拉）、前台刷新（二期 UI）、低频轮询兜底（间隔进 Config，默认 5 分钟）。
- 增量游标：每 issue 记录已拉到的最新 `remoteId`，去重后并入 `comments[]`（`source: 'gitea'`）。
- Gitea 侧删除评论不影响本地已投递记录。

**首期收窄**：不同步 assignee/milestone/PR 关联；文档正文不进 Gitea（只进摘要 + 路径）。

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| 会话异常中断 | issue 停原状态，会话 `aborted`，可重启同状态会话 |
| outbox 重试超限 | 标记 `dead`，同步状态可查，可手动重放 |
| 文档缺失/为空 | 执行器拒绝推进并提示 |
| Gitea 凭据失效 | 出站进 outbox 退避；入站拉取失败 warn 不阻塞会话唤起 |
| 环境准备失败（worktree 冲突等） | 状态进入失败，issue 停原状态，错误入会话记录 |
| toolkit 服务卸载 | cordis inject 语义自动卸载本插件，恢复后重载 |

## 9. 测试

照 workspace 先例 vitest：

- **纯逻辑全单测**：流转规则（推进/待确认/打回/终态）、流水线校验、outbox 退避与重放、评论入站去重、台账重生成、文档硬条件。
- **Gitea 适配器**：mock fetch 覆盖各方法与错误路径。
- **环境策略**：mock git 命令层。
- **执行器**：mock registry/会话创建，验证上下文组装含前序文档与未投递评论。
- 类型检查 + bundle 照两包先例（`pnpm --filter @dsh-agent-toolkit/issue-flow test/typecheck/bundle`）；toolkit 的 provide 改动补 toolkit 单测。

## 10. 本期接口面（无 UI）

UI 层本期不涉及，能力经两类接口可用：

- **REST API**：`registerOptionalRoutes` 先例（headless 惰性不抛错），覆盖 issues CRUD / 状态推进与打回（门禁操作）/ 评论 / 项目与流水线管理 / outbox 同步状态查询与重放。
- **斜杠命令**：经 `commands` 服务注册 `/issue` 命令族（新建/列表/推进/打回/状态），供会话内与 CLI 使用。

## 11. 范围与收窄

**本期不做**：

- **UI 层**（看板/详情页/设置面板）——本期能力经 REST API + 命令可用，UI 另立 spec。
- dialog 状态的 Gitea 评论实时插入进行中会话（需宿主能力）。
- 流水线的分支/并行状态（线性数组起步）。
- assignee/milestone/PR 关联同步；文档正文进 Gitea。
- worktree/分支完成后的清理策略。
- GitHub 等其他同步源（接口预留）。

**已知前置依赖**：toolkit 加 `ctx.provide('agentToolkit', …)`（§2），先行实施并随 toolkit 发布。
