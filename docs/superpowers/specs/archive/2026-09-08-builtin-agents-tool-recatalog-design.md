# 内置 Agent 默认工具名单重选设计

> 2026-09-08。前置：动态工具名册（`2026-09-07-dynamic-tool-catalog-design.md` / 同名 plan）已落地，
> `/tools` 名册改为 agent-team preset standing 面动态枚举，bot 会话路径白名单已与会话可见面求交。

## 背景与问题

内置角色 explorer / general 的工具名单停留在旧常量时代，与真实 preset 面脱节：

| 角色 | 现状 | 问题 |
|---|---|---|
| explorer | 静态白名单 5 个：`pwsh\|bash`、`read`、`read_image`、`glob`、`grep`（`NATIVE_TOOL_NAMES` 去 write/edit 派生） | preset 面中的只读安全工具（`web_search`/`todo_write`/`job_list`/`job_output`）不可用 |
| general | 无 `tools` 字段 = 不限制 | 能力边界隐式，含 `team_delegate` 可二级委派（`maxDepth: 1` 已硬拒，但名册语义不干净） |

main 不限制，**不动**。

## 技术事实（已对宿主源码核实）

- 当前 agent-team preset standing 面 20 个工具（实测 `/dsh-agent-toolkit/api/tools`）：
  `ask_user_question`、`create_goal`、`edit`、`exit_plan_mode`、`get_goal`、`glob`、`grep`、`job_kill`、`job_list`、`job_output`、`pwsh`、`ralph`、`read`、`read_image`、`skill`、`todo_write`、`update_goal`、`web_search`、`workflow`、`write`；global 组仅 `team_delegate`。
- `run_code` 是宿主 Code Mode 保留传输工具名，任何白名单都不得包含（restrict 拒收）。
- **委派路径对未知名不容忍**：`subagent/child-agent.ts:174` 对 toolFilter 直接 `tools.restrict()`，未知名响亮抛错（`subagent-spawn-in-process` 测试 "an unknown toolFilter name fails the spawn loudly"）。bot 会话路径上一轮已做求交 warn-drop，委派路径仍是严格模式——内置名单引入更多"非基础"工具名后，换 preset 的存量环境委派会直接失败，必须对称补求交。
- 委派工具 execute 中可取父会话可见面：`exec.agent.ctx`（agent-scoped Context，`core/agent/runtime-types.ts:76`）+ `scopeOf(ctx)`（`core/scope/index.ts:154`）+ `ctx.tools.schemas(scope)`，与 bot 路径（`channels/agent-setup.ts`）同款手段。

## 决策（已与用户确认）

1. 两个可委派内置角色都按 preset 面静态重选；不做运行时动态派生（seed 语义改动大，且白名单需要静态确定性）。
2. explorer 补 `web_search`、`todo_write`、`job_list`+`job_output`、`skill`（skill 加载的是指令文本、本身只读，合并前用户追加决策：默认可用）；编排类（`ralph`/`workflow`）、写文件类（`write`/`edit`）、`job_kill`、`ask_user_question`、goal 三件套、`exit_plan_mode` 不进 explorer。
3. general = preset 全量 20 个，**不含 `team_delegate`**（禁二级委派）。
4. 存量条件式迁移：仅当记录仍等于旧默认值才更新；用户改过的跳过；meta 幂等标记。
5. 委派路径补对称求交（方案 A），彻底消除委派/bot 两条路径的白名单有效性不对称。

## 设计

### 1. `agents/builtin.ts`：名单重选

- `EXPLORER_READONLY_ALLOW`（10 个）= 现有派生段不变（`NATIVE_TOOL_NAMES` 去 write/edit：shell 平台条件 + `read`/`read_image`/`glob`/`grep`）+ 新增静态段 `['web_search', 'todo_write', 'job_list', 'job_output', 'skill']`。
- 新导出 `GENERAL_ALLOW`（20 个）= 上方 preset 面全量，shell 名平台条件（win32=`pwsh`、其余=`bash`），不含 `run_code`/`team_delegate`。
- `BUILTIN_AGENTS`：explorer 的 `tools.allow` 自动随 `EXPLORER_READONLY_ALLOW` 更新；general 新增 `tools: { allow: [...GENERAL_ALLOW] }`；main 不变。persona/description 不动。
- 保留 `LEGACY_EXPLORER_ALLOW`（旧 5 个派生式的独立常量）供迁移等值比对——不能复用改写后的 `EXPLORER_READONLY_ALLOW`，否则比对基准漂移。

### 2. `agents/registry.ts`：存量条件式迁移

- 新 meta 标记键 `BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY = 'builtin_tools_recatalog_migrated'`。
- 位置：preset 并入迁移之后、`seedBuiltins` 之前（遵守"全部存量迁移先于 seed"纪律）。
- 逻辑（无外部依赖，跑完即置标记，无需重试语义）：
  - explorer：仅当 `tools.allow` 匹配旧默认形状之一（含顺序）→ 替换为新 `EXPLORER_READONLY_ALLOW`。旧默认有两种形状：纯净 5 个（`LEGACY_EXPLORER_ALLOW`，seed/只读迁移写入的派生顺序）与原生并入加写后的 7 个（`[...LEGACY_EXPLORER_ALLOW, 'write', 'edit']`——0.2.x 时代 native 并入迁移不跳过 builtin 记录，真实存量多为此形状）。7 个形状替换后 `write`/`edit` 随之移除，只读约束随新名单恢复。
  - general：仅当 `tools === undefined` → 补 `tools: { allow: [...GENERAL_ALLOW] }`。
  - 用户改过的记录 = 自定义，跳过。
- 新装环境由 seed 直接携带新名单，迁移 no-op 置标记。

### 3. `delegate/tool.ts`：委派路径对称求交

- `role.tools.allow` 不再直接透传 toolFilter；execute 内先求交：
  - 可见面 = `parent.ctx.tools.schemas(scopeOf(parent.ctx))` 名集减 `RUN_CODE_NAME`；
  - `effective = allow ∩ visible`，`dropped = allow − visible`；
  - dropped 非空 → `deps.warn(...)`（列出被忽略名）；
  - effective 为空 → 抛错（防静默零工具子会话，与 bot 路径一致）。
- `DelegateToolDeps` 新增两个必需字段：
  - `visibleSurface(agent: Agent): string[]`——生产实现走 scopeOf/schemas（在 `delegate/index.ts` 接线，import `scopeOf` + `RUN_CODE_NAME`），测试注入 fake；
  - `warn(msg: string): void`——生产为 `ctx.logger.warn`。
- 工具模块保持不直接摸 cordis Context（沿用 deps 注入风格）。

### 4. 测试

- `registry.test.ts`：迁移三态——旧默认 explorer/无 tools general → 更新为新名单；用户自定义记录 → 跳过；meta 标记幂等（二次 createRegistry 不重复改）。builtin 导出断言同步（general 带 tools）。
- `delegate/tool.test.ts`：白名单与可见面求交 warn-drop；求交后为空抛错；无 tools 角色不调用 `visibleSurface`、不传 toolFilter（既有断言不破）。
- `builtin.ts` 相关既有测试（import-yaml / registry seed）按新名单更新断言。

### 5. 文档

- `docs/usage/agents.md`：内置角色名单表格更新（explorer 10 个 / general 显式 20 个不含 team_delegate）+ 迁移标记说明。
- `AGENTS.md`：「dsh 插件开发要点」内置角色描述同步（新名单 + 迁移标记 + 委派路径求交）。

## 明确不做（非目标）

- 不做运行时动态派生（名单是静态常量；preset 面日后新增工具不进内置名单，需再次人工梳理）。
- 不动 main、Agents 面板 UI、create-command、bot 路径既有求交逻辑。
- 不动两个内置角色的 persona/description。
- bot 绑内置角色的行为不变差：agent-bot preset 面本就只含 BASIC_TOOLS，白名单求交 warn-drop 语义与现状一致（explorer 的 `web_search` 等在 bot 会话被忽略，属既有语义）。

## 验收

1. `pnpm --filter dsh-agent-toolkit test` + `typecheck` + `bundle` 全过。
2. 真实环境（`pnpm dsh web --patch .../cordis.yml`）：
   - 新装/重置 profile：explorer 带 10 个白名单、general 带 20 个白名单（无 team_delegate）。
   - 存量 profile：未自定义过的 explorer 从 5 → 10、general 从无 → 20；面板里改过的记录不动。
   - 主会话 `team_delegate` 委派 explorer / general 正常工作；换不含 `web_search` 的 preset 委派 explorer 不抛错（warn-drop）。
