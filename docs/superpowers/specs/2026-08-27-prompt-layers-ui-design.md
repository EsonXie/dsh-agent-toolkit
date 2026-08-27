# 分层提示词 UI 管理界面 — 设计 spec

日期：2026-08-27
状态：已与用户逐节确认，待实施

## 背景与目标

分层提示词（prompt-stack）当前 100% 由插件 Config（`cordis.yml`）驱动：`layers`/`rules` 都是 schemastery Config 字段，无任何存储域、无 UI。角色 persona 是唯一落在存储域且可 UI 管理的「层」（Agents 面板）。

目标：为 `layers`（层）提供一个 UI 管理界面。**只管层**，不管规则（rules 仍由 cordis.yml 配置，UI 只读展示）。层编辑结果存存储域，Config 降级为首启种子。

## 已确认的决策（来自 brainstorming）

1. **数据源**：UI 存储为主，Config 作种子（首启一次性导入，之后运行一律读存储）。
2. **管理范围**：只管层（层增删改排序 + 文本），规则只读展示。
3. **辅助功能**：CRUD + 重置为默认层 + 规则只读视图。
4. **运行时生效机制**：方案 A——内存层源 + sections 重注册（改完立即生效）。

## 第 1 节 · 存储与数据模型

- 扩展 `src/agents/store.ts` 的 `agentToolkitDomain`（域名 `dsh_agent_toolkit`，version 1），新增一张表 `prompt_layers`：
  - 表名 snake_case（`prompt_layers`），满足 `UNIT_NAME_RE`（`^[a-z][a-z0-9_]*$`，不允许大写/连字符）。
  - 单行 JSON 存储：key 常量 `'layers'`，value `{ layers: LayerConfig[] }`。
  - 复用现有 `LayerConfigSchema`（store.ts:22-26，`{name: z.string(), order: z.number(), text: z.string()}`）。
  - schema 在 durable boundary 校验，与 agents 表同构。
  - 加表安全：SQLite 后端按 descriptor 的 table 名单 `CREATE TABLE IF NOT EXISTS`（storage-sqlite/src/index.ts:111-119），version 不因加表变化；memory 后端按 descriptor 动态建表。
- 首启种子：复用 `meta` 表，新键 `prompt_layers_seeded`（与 `roles_yaml_imported` 同模式，值 `{ value: '1' }`）。
- 语义变化：`config.layers` 从「运行时数据」降级为「首启种子 / Reset 默认值」；`config.rules` 仍是唯一规则来源。

## 第 2 节 · 运行时层源 + 重注册

新模块 `src/prompt/layer-source.ts`：

```ts
export interface LayerSource {
  get(): LayerConfig[]
  set(layers: LayerConfig[]): Promise<void>  // 校验 → 写表 → 更新内存 → notify
  reset(): Promise<void>                     // 清表 + 清种子标记 → 重写 seedLayers → notify
  subscribe(listener: () => void): () => void
}
export async function openLayerSource(
  ctx: Context,
  tables: {
    promptLayers: KvTable<string, { layers: LayerConfig[] }>
    meta: KvTable<string, { value: string }>
  },
  seedLayers: LayerConfig[],
): Promise<LayerSource>
```

`openLayerSource` 只消费传入的表句柄，不 open 域（域由 apply 统一 open，见「apply 接线」）。

- 域句柄由 `apply()` 统一打开一次并分发表句柄（storage-domain 对同名域二次 `open` 抛 `already-open`，DomainFacility.open 见 storage-domain/src/index.ts:101-103）：`openLayerSource` **不自行 open 域**，接收已打开的 `promptLayers`/`meta` 表句柄（见下「apply 接线」）。
- 种子：`meta.prompt_layers_seeded` 缺失 → 写 seedLayers 进表 + 置标记；已存在 → 读表加载为内存缓存。
- `set`/`reset` 后 `notify` 触发订阅者。

改造 `src/prompt/index.ts` 的 `setupPrompt`：

- 签名 `{ layers: LayerConfig[]; rules: Rule[] }` → `{ source: LayerSource; rules: Rule[] }`。
- 把「按层注册 section + model-notes section」抽成 `registerSections()`：
  - 先 dispose 上一轮的 disposer 数组（`ctx.systemPrompt.section()` 返回 disposer，system-prompt/src/index.ts:381），再按 `source.get()` 重新注册全部层 section 与 model-notes section。
  - `model-notes` 的 order 每次重算（`max(order)+1`）。
  - 首轮无 disposer，直接注册。
- `source.subscribe(registerSections)` 接线重注册（经 `ctx.effect` 退订）。
- assemble waterfall 监听器与钉住 WeakMap 保留（语义不变：会话首次组装钉住模型，clear/新会话重解析），内部 `config.layers` 引用全部改为 `source.get()`。
- `validateConfig(config)` 仍在 `apply()` 校验 config 的 layers+rules（种子合法性）；运行期层改动走 `validateLayers`（见第 5 节）。
- 子 Agent 隔离逻辑（`isSubagent` → 空串、model-notes 主子共用）保持不变。

委派路径 `src/delegate/index.ts`：

- `DelegateConfig.layers: LayerConfig[]` → `getLayers: () => LayerConfig[]`。
- `mountTool` 内 `buildPersona` 改传 getter：`buildAgentPersona({ getLayers, rules }, role, role.model)`，`buildAgentPersona`（`src/prompt/persona.ts`）内部 `config.layers` 改 `getLayers()`，每次委派实时取当前层。

`src/index.ts` `apply()` 接线（域在此统一 open 一次，分发句柄）：

1. `validatePromptConfig({ layers: config.layers, rules: config.rules })`（照旧）。
2. `const domain = await openDomainSafely(ctx, agentToolkitDomain, warn)`；取表句柄
   `agents = domain.table('agents')`、`meta = domain.table('meta')`、`promptLayers = domain.table('prompt_layers')`。
3. `const registry = await createRegistry(ctx, warn, { agents, meta })`（`createRegistry` 签名改为接收表句柄，不再自行 open 域）。
4. `const layerSource = await openLayerSource(ctx, { promptLayers, meta }, config.layers)`。
5. `setupPrompt(ctx, { source: layerSource, rules: config.rules })`。
6. `setupDelegate(ctx, { ..., getLayers: () => layerSource.get(), rules: config.rules }, registry)`。
7. `setupPromptLayersApi(ctx, { source: layerSource, rules: config.rules, seedLayers: config.layers })`。

配套改动：`createRegistry` 从「自行 `openDomainSafely` + `domain.table(...)`」改为接收 `{ agents, meta }` 表句柄（内部 seeding/迁移逻辑不变），域打开上移到 apply。

删层导致的规则悬空引用：`rule?.overrides?.[layer.name]` 本就回退层默认文本（index.ts:114），无崩溃；UI 规则只读视图标「悬空」。

## 第 3 节 · HTTP API（Node 半）

新模块 `src/prompt/api.ts`，镜像 `agents/api.ts`：

- `GET /dsh-agent-toolkit/api/prompt-layers` → `{ layers: LayerConfig[]; rules: Rule[]; seedLayers: LayerConfig[] }`
  - `rules`/`seedLayers` 来自 apply 闭包（config），供 UI 只读展示与 Reset 提示。
- `PUT /dsh-agent-toolkit/api/prompt-layers`，body `{ layers: LayerConfig[] }` → `validateLayers` → `source.set` → `200 {ok:true}`；校验失败 400 `{error}`。
- `POST /dsh-agent-toolkit/api/prompt-layers/reset` → `source.reset()` → `200 {ok:true}`。
- 复用 `agents/api.ts` 的 `readJsonBody`（64KB 上限 413 / 非法 JSON 400）与 `json` 响应助手——抽到 `src/shared/http.ts` 供 agents/prompt 两个 api 共用（小重构，不改外部行为）。
- 经 `registerOptionalRoutes` 注册：`prefix /dsh-agent-toolkit/api/prompt-layers`。webServer 缺席时惰性不注册（headless/CLI 无面板）。

## 第 4 节 · 浏览器半 UI

新目录 `src/client/prompt/`，复刻 Agents 面板：

- `index.ts`：`ctx.slots.inject('sidebar.footer.action', ...)` 注册 `{ id: 'dsh-agent-toolkit:prompt-layers', order: 0 }`（agents 入口 order 为 -1，本入口紧随其后）；`src/client/index.ts` 的 `apply` 加 `setupPromptClient(ctx)`。
- `entry.tsx`：`createSidebarEntry`（`src/client/shared/entry.tsx`），图标 + 标题「分层提示词」，`renderModal` → `PromptLayersModal`。
- `PromptLayersModal.tsx`：
  - `useLoadState(fetchPromptLayers, [])` 打开即拉取。
  - 左栏层列表：按 order 升序；每项「上移 / 下移 / 删除」，选中高亮。
  - 右栏选中层编辑器：名称输入、order 数字输入、文本 textarea + 「保存」。
  - 底部：「重置为默认层」（确认弹窗，覆盖性操作）+「规则」折叠区只读列表（每条：match 摘要 + overrides 层映射 + append 摘要，引用不存在层的 overrides 标「悬空」）。
  - 上移/下移/增删只改内存副本并标脏，由「保存」统一 PUT（避免每次操作即写存储）。
- `api.ts`：`fetchPromptLayers` / `saveLayers(layers)` / `resetLayers`（fetch 封装照 `client/agents/api.ts`）。
- `prompt.module.css`：样式（CSS Modules + clsx，照 agents 面板）。

## 第 5 节 · 校验、种子与错误处理

- `validateLayers(layers: LayerConfig[])`（新，放 `src/prompt/layer-source.ts` 并导出）：非空、层名唯一、禁保留名 `model-notes`；order 允许任意有限数（与现状一致，不约束重复 order）。
- 种子：apply 内 `openLayerSource(ctx, warn, config.layers)`；缺失种子标记 → 写 config.layers + 置标记。Reset = 清表 + 清标记 + 重写种子。
- 错误处理：PUT 校验失败 400（前端内联展示）；写存储失败 500；加载失败经 `useLoadState` error kind 展示。
- HMR：重挂载 → apply 重跑 → 从存储重载层 → 重注册 sections；钉住缓存随新闭包重置（现状语义不变）。

## 第 6 节 · 测试与文档

- Node 半：
  - `layer-source` 测试：种子幂等（二次 open 不重复写）、`set` 校验拒绝非法层、`reset` 回种子。
  - `setupPrompt` 重注册测试：改层后新组装用新层、旧会话钉住不变、model-notes order 重算。
  - API 端点测试：GET/PUT/reset、400/413/404。
  - 现有 `src/prompt/*.test.ts` 6 个文件的 `setupPrompt` 签名随改动更新（assemble/config/persona/runtime-model/smoke）。
- 浏览器半：`PromptLayersModal` 渲染/交互测试（沿用 `agents.spec.tsx` 模式）。
- 文档：更新 `docs/usage/prompt-layers.md`（layers 由 UI 存储管理、config 仅种子）、`docs/usage/config-reference.md`、必要时 `agents.md` 嵌入段落。
- 验证：`pnpm --filter dsh-agent-toolkit test` + `typecheck` + `bundle`。

## 范围外

- 规则（rules）的编辑 UI（仍 cordis.yml）。
- 组装预览（选 provider/model 实时拼装）。
- 角色 persona 层并入本面板（persona 继续由 Agents 面板管理）。
