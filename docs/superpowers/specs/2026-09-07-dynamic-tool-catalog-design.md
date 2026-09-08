# 动态工具名册（preset 面枚举）设计

日期：2026-09-07
状态：草案（待批准）

## 背景

- Agents 面板白名单名册 = `GET /dsh-agent-toolkit/api/tools` 返回的 `{ native, global }`：`native` 是 `channels/basic-tools.ts` 的常量 `NATIVE_TOOL_NAMES`（7 个：pwsh/bash、read、write、edit、read_image、glob、grep），`global` 是 `ctx.tools.schemas()` 顶层注册表视图。
- **缺失**：委派子会话经宿主 `composeFrom` 继承父 preset（`subagent/src/child-agent.ts:168`），真实可过滤继承面 = 父 preset 全集。agent-team（= shipped standard 禁用 subagent 族 4 行）比 `native` 组多 13 个模型工具：`job_output`、`job_list`、`job_kill`、`skill`、`get_goal`、`create_goal`、`update_goal`、`exit_plan_mode`、`ask_user_question`、`todo_write`、`web_search`、`workflow`、`ralph`。它们 scope 挂载在 preset standing scope，不进顶层注册表，UI 两组都选不到。
- **后果**：配了自定义白名单的角色，其委派子会话被 restrict 到 native+global，静默丢失上述工具；用户无法给角色开 `web_search` 等。
- **不对称陷阱**：同一 `tools.allow` 喂两条路径——委派 `toolFilter`（对父 preset 面校验）与 bot 会话 `restrict`（对 agent-bot 面校验）。绕过 UI 把 `web_search` 写进存量记录，委派可用但 bot 会话 setup 抛 unknown global tools（0.2.4 事故形态）。
- **宿主能力（已核实）**：
  - `agentPresets.standingKeyFor(id)`（`preset/agent-presets/src/index.ts:485`）：返回 preset standing scope 的 `ScopeKey`，专为"无 agent 的宿主读者"设计；确保挂载但不建会话/轮次。standing mount 按 composition 文件代际缓存，文件变更自动新代际。
  - `ctx.tools.schemas(scope?)`（`core/tools/src/index.ts:1234`）：接受 `ScopeKey`，`view(scope)` 单次链遍历返回 global 层 + 祖先层 + own 层的可见工具。
  - `restrict` 校验的 `restrictableNames` = 继承面（global + 祖先层，含 preset standing 层），pre-restriction（`core/tools/src/index.ts:1088`、`1168-1175`）——白名单可以合法命名 preset 工具，只有"继承面完全缺席"的名字才抛错。
  - `run_code` 是 Code Mode 保留传输工具名：注册/遮蔽/restrict 均拒收（`core/tools/src/index.ts:1085`），但 `schemas()` 在非 native 呈现模式下会附带它；常量 `RUN_CODE_NAME` 由 `@deepseek-ai/dsh-tools` 导出。

## 决策（推荐案，待确认）

| 问题 | 决策 |
| --- | --- |
| 名册来源 | **动态枚举 `agentTeamPreset.id` 的 standing 面**（`standingKeyFor` + `schemas(key)`）。理由：agent-team 是 standard 的行级子集，父会话无论用 agent-team 还是 standard，白名单项都在子会话继承面内；父用更小 preset（minimal/用户自制）时委派 restrict 响亮报错，可接受且可诊断 |
| `native` 组 | **废除**，由 `preset` 组取代（原 7 个名字必然含在其中，平台互斥由真实挂载解决，不再 `process.platform` 推断）。常量 `NATIVE_TOOL_NAMES` 保留为 agentPresets 缺席时的兜底，注释改写语义 |
| `run_code` | **两组都排除**：保留传输工具不是能力工具，restrict 拒收它，列出只会误导 |
| 枚举时机 | **每次 `/tools` 请求现算，不缓存**：standing mount 由宿主按代际缓存，首次请求触发挂载（只挂插件不起会话），后续是纯内存 map 遍历；省掉失效策略 |
| 存量迁移 | **一次性并入**（meta 标记 `tools_preset_catalog_migrated`，`TOOLS_NATIVE_MIGRATED_KEY` 同款幂等模式）：把动态 preset 面并入存量自定义白名单。理由同 native 迁移——这些名字 UI 从未提供，存量白名单缺它们非用户本意。agentPresets 缺席时跳过且**不置标记**（下次启动重试）。**必须先落地 bot 求交（下节 4），否则 widen 后 bot 绑这些角色必炸** |
| bot 会话未知名 | **warn-drop 求交**：bot setup 时把 `hooks.tools` 与该会话真实可见面求交，未知名 warn 丢弃；**全被丢弃则抛错**（防静默零工具会话）。改变现有"响亮失败"语义，是有意的语义软化 |
| explorer 默认白名单 | **不动**：`EXPLORER_READONLY_ALLOW` 是刻意的最小只读集，不追求完整 |

## 设计

### 1. Node 半：动态名册（新文件 `src/agents/tool-catalog.ts`）

```ts
// 结构类型先例：team-preset.ts AgentPresetsLike / scope-joiner.ts PresetMountLike
interface PresetStandingLike { standingKeyFor(id?: string): Promise<unknown> }

// createToolCatalog(ctx, presetId) 返回：
async function listPresetTools(): Promise<string[]> {
  const presets = ctx.get('agentPresets', false) as PresetStandingLike | undefined  // 惰性解析（attachments 教训）
  if (presets === undefined) return [...NATIVE_TOOL_NAMES]                          // 兜底：常量
  try {
    const key = await presets.standingKeyFor(presetId)
    const global = new Set(ctx.tools.schemas().map((s) => s.name))                 // 顶层视图
    return ctx.tools.schemas(key as ScopeKey).map((s) => s.name)
      .filter((n) => !global.has(n) && n !== RUN_CODE_NAME)                        // 去重 global、排除保留名
      .sort()
  } catch (error) {
    warn(`……枚举 preset "${presetId}" 工具面失败，回退内置常量：……`)                // preset 缺失/broken/挂载失败
    return [...NATIVE_TOOL_NAMES]
  }
}
```

- `ScopeKey` 经 `dsh-scope` 类型；`RUN_CODE_NAME` 从 `@deepseek-ai/dsh-tools` 导入（toolkit 已运行时依赖该包）。
- 每次调用现算；不在插件侧缓存。

### 2. API 变更（`src/agents/api.ts`）

- `GET /dsh-agent-toolkit/api/tools` 响应 `{ native, global }` → `{ preset, global }`：
  - `preset` = 上节 `listPresetTools()`（handler 改 async await）。
  - `global` = 现状 `deps.listTools()`，追加排除 `RUN_CODE_NAME`（顶层视图在非 native 默认模式下也会带它）。
- 双半同包同版本发布，无跨版本 wire 兼容负担。
- bots 的 `GET …/bots/tools`（`{ tools: global }`）**不动**：bots UI 当前不渲染工具区块，该端点语义不变。

### 3. UI（`src/client/agents/AgentEditor.tsx` + `api.ts`）

- `ToolsCatalog` 类型 `{ native, global }` → `{ preset, global }`。
- 分组标签：「团队 preset 工具」/「全局工具」。
- 新建模式默认全勾 = `preset + global`；radio 二选一、空勾选禁存等现有逻辑不变。

### 4. bot 会话白名单求交（`src/channels/agent-setup.ts`）

`setupAgentScope` 在 `joiner.join(agentCtx)` 之后、`restrict` 之前插入求交：

```ts
if (hooks.tools !== undefined) {
  const key = scopeOf(agentCtx)                                   // dsh-scope
  const visible = new Set(agentCtx.tools.schemas(key).map((s) => s.name))
  visible.delete(RUN_CODE_NAME)                                   // restrict 拒收保留名
  const effective = hooks.tools.filter((n) => visible.has(n))
  const dropped = hooks.tools.filter((n) => !visible.has(n))
  if (dropped.length > 0) warn(`……白名单含本会话不可见工具，已忽略：${dropped.join(', ')}`)
  if (effective.length === 0) throw new Error(`……白名单求交后为空（原 ${hooks.tools.length} 个均不可见）`)
  agentCtx.tools.restrict({ allow: effective })
}
```

- join 之后 agent scope 的 `schemas(key)` = global + 祖先层（preset standing 或 BASIC_TOOLS fallback standing），正是 restrict 的合法命名空间；preset 优先 / fallback 回退两条 join 路径自动各自正确。
- 同时覆盖 `bot.tools` 与 `role.tools.allow`（都经 `hooksOf`/`resolveSession` 进 `hooks.tools`），不对称陷阱消除。

### 5. 存量迁移（`src/agents/registry.ts`）

- 新 meta 键 `tools_preset_catalog_migrated`：未置位且 `listPresetTools()` 可用时，对每个 `tools !== undefined` 的记录并入 `preset 面 - 已有 allow` 的差集；置位标记。
- `agentPresets` 缺席或枚举失败：跳过且不置标记（下次启动重试），与兜底常量不混用（避免把 7 个常量当 preset 面并入——它们本来就会被 native 迁移覆盖，重复并入无害但语义要干净）。
- 排序约束：本迁移在原生并入（`TOOLS_NATIVE_MIGRATED_KEY`）之后、`seedBuiltins` 之前执行，沿用既有顺序纪律。

### 6. `/create-agent` 命令（`src/agents/create-command.ts`）

- 引导文本的"原生工具：…"行改用动态名册（`preset + global` 两组罗列），不再打印 `NATIVE_TOOL_NAMES` 常量。

### 7. 测试

- `tool-catalog.test.ts`：fake `standingKeyFor` + scoped `schemas`：正常枚举（减 global、减 run_code、排序）；agentPresets 缺席回退常量；standingKeyFor 抛错回退常量 + warn。
- `api.test.ts`：`/tools` 响应形状改 `{preset, global}`。
- `agent-setup.test.ts`：求交（部分 drop + warn、全 drop 抛错、run_code 被排除）；join 后枚举顺序敏感（先 join 后 schemas）。
- `registry.test.ts`：迁移幂等；缺席不置标记下次重试；已置位不再迁移。
- `agents.spec.tsx`：catalog 新形状下新建默认全勾、分组渲染。
- **防"fake 掩盖宿主语义"**（2026-09-03 事故教训）：手动验收清单——真实环境（安装版 dsh + link: 插件）① Agents 面板可见 `web_search`/`todo_write` 等；② 建白名单含 `web_search` 的角色 → 委派验证子会话可用；③ bot 绑该角色 → `/new` 建会话不抛错、warn 丢弃不可见名。
- 验证三件套：`pnpm --filter dsh-agent-toolkit test` + `typecheck` + `bundle`。

## 影响面

仅 `packages/toolkit`：

- 新增 `src/agents/tool-catalog.ts`（+ 测试）；
- 改 `src/agents/{api.ts, registry.ts, create-command.ts}`、`src/channels/{agent-setup.ts}`、`src/channels/basic-tools.ts`（常量注释改语义为兜底）、`src/index.ts`（接线 `listPresetTools`）；
- 浏览器半 `src/client/agents/{api.ts, AgentEditor.tsx}` + 对应 spec；
- `docs/usage/agents.md`（白名单分组说明更新）；
- 无 schema 结构变更（`AgentRecord.tools` 不变）；`@dsh-agent-toolkit/token-usage` 不受影响。

## 明确的非目标

- 不做"按父会话实际 preset 逐会话枚举"——白名单是创作期配置，需要一个稳定名册；agent-team 面是团队场景的定约基线。
- 不改 `team_delegate` 的 `toolFilter` 透传逻辑（宿主 restrict 语义已正确）。
- 不动 agent-bot preset 内容（BASIC_TOOLS 5 行不变）。
