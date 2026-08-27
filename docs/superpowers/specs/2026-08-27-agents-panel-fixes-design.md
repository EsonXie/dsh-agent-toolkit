# Agents 面板 / 侧边栏 / 机器人表单修正设计

日期：2026-08-27
状态：已经用户口头确认（2026-08-27），待 spec 审阅
范围：`packages/toolkit`（Node 半 + 浏览器半）+ web profile 环境清理

## 背景

用户在 dsh web 中体验插件后提出 5 组问题，本 spec 覆盖全部修复：

1. Agent 管理：main 应彻底移出管理列表；工具白名单需含原生工具；白名单里出现第三方 `agent_teams_*` 工具；提示分层应为固定分层 + 仅 persona 可定义；表单过长显示不全。
2. 侧边栏三个入口（Agent 管理 / Token 用量 / 消息机器人）文字过宽挡住后续图标。
3. 消息机器人设置不需要提示词配置。

关键事实（已对照源码核实）：

- `agent_teams_*` 9 个工具来自 web profile 已装的第三方插件 `@nanmicoder/dsh-agent-teams@0.1.5`（`C:\Users\Eson\.dsh\profiles\web\node_modules\@nanmicoder\dsh-agent-teams\lib\tools.js`），非 toolkit 注册；toolkit 自身只注册 `team_delegate`。
- 白名单数据源是 `ctx.tools.schemas()`（`src/index.ts:97`），只枚举全局注册工具；原生工具（shell/fs/fs-search）经 `setupAgentScope` 在 agentCtx scoped 挂载（`src/channels/basic-tools.ts:14-31`），不在其中。
- 原生工具名（对照宿主源码核实）：`pwsh`（`packages/shell/tool-pwsh/src/index.ts:253`，Windows）/ `bash`；`read`、`write`、`edit`、`read_image`（`packages/fs/tool-fs/src/*.ts`）；`glob`、`grep`（`packages/fs/tool-fs-search/src/*.ts`）。
- `tools.restrict({ allow })` 在 agentCtx 作用域内按名过滤（`src/channels/agent-setup.ts:39-41`），会裁掉 scoped 挂载的原生工具；内置角色目前无 `tools` 字段故不受限。凡通过 UI 设过白名单的角色实际已丢失原生工具能力（UI 勾不到），属待修复缺陷。
- 提示分层现状：全局层仅 config（`src/index.ts:48-52`，`src/prompt/defaults.ts`），角色层 `AgentRecord.promptLayers`（`src/agents/store.ts:14`）UI 可自由增删（`src/client/agents/AgentEditor.tsx:153-176`），保留层 `model-notes`（`src/prompt/index.ts`）。
- main 现状：仅 name 只读（`AgentEditor.tsx:145`），描述/分层/模型/工具均可编辑；服务端已有 main/builtin 守卫（`src/agents/registry.ts:59-76`）。

## 逐条决策（用户已确认）

| # | 决策 |
|---|---|
| 1.1 | main 从 Agents 面板列表移除（运行时默认 Agent 地位不变，机器人绑定仍可选） |
| 1.2 | 白名单纳入原生工具，分组展示 |
| 1.3 | 从 web profile 卸载 `@nanmicoder/dsh-agent-teams`，toolkit 代码不改 |
| 1.4 | 角色提示词收敛为单一 `persona` 文本，不可新增其他层 |
| 1.5 | 表单布局不变，编辑区内部滚动 |
| 2 | 侧边栏入口恒为仅图标 + Tooltip |
| 3 | BotForm 删除提示词字段；`BotRecord.persona` 后端保留兼容存量 |

## 详细设计

### 1.1 main 移出列表

- `src/client/agents/AgentsModal.tsx`：列表渲染过滤 `a.id !== 'main'`；`selectedId` 初始值从 `'main'` 改为第一个非 main 角色的 id（空列表时进入新建态或空态提示）；`handleDeleted` 后选中回退同样取第一个非 main。删除 main 行的「锁定」徽标渲染（main 不再出现）。
- 服务端 `registry.ts` 守卫不动（兜底）。
- BotForm 绑定 Agent 下拉走 `registry.list()`，不经 AgentsModal 过滤，main 仍可选——无需改动。

### 1.2 工具白名单含原生工具

- `src/channels/basic-tools.ts` 新增导出常量 `NATIVE_TOOL_NAMES: readonly string[]`，平台互斥：win32 为 `['pwsh', 'read', 'write', 'edit', 'read_image', 'glob', 'grep']`，其余平台 `pwsh`→`bash`。注释标注名字来源文件（宿主 tool-pwsh/tool-fs/tool-fs-search），与 BASIC_TOOLS 同源维护。
- `GET /dsh-agent-toolkit/api/tools`（`src/agents/api.ts:60-63`）返回从 `string[]` 改为 `{ native: string[]; global: string[] }`：`native` = `NATIVE_TOOL_NAMES`，`global` = `ctx.tools.schemas()` 名字列表。客户端 `fetchTools` 同步改型。
- `AgentEditor.tsx` 白名单区分两组 checkbox 渲染：「原生工具」「扩展工具」。
- **存量迁移**：registry 读取路径（与 1.4 迁移同一处，见下）对带 `tools.allow` 的记录并入 `NATIVE_TOOL_NAMES` 缺失项（union、去重、保持原顺序后追加原生名）。理由：UI 从未提供原生工具勾选项，存量白名单缺失原生名非用户本意。
- 新建角色：默认全勾（native + global 全量）。

### 1.3 卸载第三方插件

- 执行 `pnpm dsh plugin --profile web remove @nanmicoder/dsh-agent-teams`（deepseek-harness 目录下）。
- 卸载后白名单「扩展工具」组只剩 `team_delegate` 等宿主/toolkit 全局工具。
- 无代码变更；归入实施步骤与验证项。

### 1.4 提示分层 → 单一 persona

Schema 与迁移：

- `src/agents/store.ts`：`AgentRecord.promptLayers?: LayerConfig[]` 替换为 `persona?: string`；`AgentRecordSchema` 同步（`persona: z.string().optional()`，删除 LayerConfigSchema 引用）。domain version 不变（读取侧迁移兜底，无需升 version 重建）。
- **读取迁移**（registry/store 读取路径单点实施）：parse 前检查 raw 记录含 `promptLayers` 时，按 `order` 升序取各层 `text` 以 `\n\n` 拼接为 `persona`（空结果则省略该字段），剥离 `promptLayers` 后再过 schema；迁移结果写回存储。注意：zod 默认 strip 未知键，必须先迁移再 parse，否则旧分层静默丢失。
- 与 1.2 的 tools union 迁移合并在同一读取迁移函数中（一次读取、一次写回）。

消费方改造：

- `src/agents/builtin.ts`：explorer/general 的 `promptLayers: personaLayer(...)` 改为 `persona: '...'`；删除 `personaLayer` 辅助函数。
- `src/agents/import-yaml.ts:82`：YAML 的 `persona` 字段直写 `persona`，不再包成单元素 `promptLayers`。
- `src/prompt/persona.ts` 的 `buildAgentPersona`：`role` 参数从 `{ name; promptLayers? }` 改为 `{ name; persona? }`；合并逻辑改为 `[...config.layers, ...(role.persona ? [{ name: 'persona', order: 0, text: role.persona }] : [])]` 按 order 排序（全局层默认 order 0 时 persona 排在其后——沿用数组稳定排序现状，或显式给 persona 较大 order，实施时以保持现有输出顺序为准并补测试锁定）。
- `src/channels/router.ts:72-74`：角色形态从"promptLayers 逐层 section"改为单个 persona section（name `dsh-agent-toolkit:agent:persona`，order 取 0，与现 personas 注入语义一致）。
- `src/client/agents/AgentEditor.tsx`：「提示词分层」区块替换为「Persona」单 textarea（rows=6），删除 `newLayer`/`addLayer`/`updateLayer`/`removeLayer`/`moveLayer` 与 LayerConfig 导入；保存载荷 `promptLayers` → `persona`（空串省略字段）。
- main 无 persona（builtin.ts 现状），移除列表后不可编辑，无影响。

### 1.5 表单内部滚动

- `src/client/agents/agents.module.css`：`.editorPane` 加 `max-height`（如 `70vh`）与 `overflow-y: auto`；`.editor` 的 `.actions` 操作栏 `position: sticky; bottom: 0`（带背景色避免内容透出），保证长表单滚动时保存/删除按钮恒可见。
- 对话框宽度、split 结构不动。

### 2 侧边栏仅图标 + Tooltip

- `src/client/shared/entry.tsx`：删除 `{wide && <span className={css.triggerLabel}>{title}</span>}` 分支，宽栏窄栏统一渲染图标 + Tooltip（title 作 Tooltip 文案）。
- `src/client/shared/entry.module.css`：删除 `.triggerLabel`；`.trigger` 收敛为固定尺寸（对齐窄栏 36×36 或现状高度，实施时以宿主底栏视觉对齐为准）。
- `src/client/agents/agents.module.css:1-31` 残留的重复 `.trigger`/`.triggerLabel` 定义一并删除。

### 3 机器人表单去提示词

- `src/client/bots/BotForm.tsx`：第一步删除「提示词」textarea（`:228-231`）与相关 state/保存载荷；保留名称、绑定项目、绑定 Agent、Provider、模型五项。
- `BotRecord.persona`（`src/bots/store.ts:26`）与服务端 API 处理保留：存量 bot 已配 persona 继续经 `hooksOf` 注入，仅 UI 不再可编辑。

## 错误处理

- 迁移失败（raw 记录 promptLayers 形态非法）：跳过该条迁移、保留原值过 schema（schema 不过则按现有读取错误路径上抛），不静默吞。
- `/api/tools` 分组响应中 `global` 求值失败沿用现有错误处理；`native` 为常量无失败路径。

## 测试

更新：`src/agents/store.test.ts`（persona schema + 迁移）、`src/agents/api.test.ts`（tools 分组响应、迁移写回）、`src/agents/import-yaml.test.ts`、`src/prompt/persona.test.ts`（单 persona 合并）、`src/channels/router.test.ts`（单 persona section）、客户端 AgentsModal（main 不渲染）/AgentEditor（persona textarea、分组白名单、新建默认全勾）相关测试。

新增：迁移函数用例（promptLayers 拼接 + tools union + 已迁移记录幂等）；`/api/tools` 分组结构用例。

门禁：`pnpm --filter dsh-agent-toolkit test`、`typecheck`、`bundle` 全绿；随后重启 dsh web 人工验证（列表无 main、白名单两组、侧边栏仅图标、机器人表单五项、委派功能正常）。

## 非目标（YAGNI）

- 不做全局层（base/rules）的 UI 编辑入口（仍仅 config）。
- 不动委派工具 `team_delegate` 的注册与可见性语义。
- 不删除 `BotRecord.persona` 后端字段。
- 不为侧边栏入口增加配置项（恒仅图标）。
