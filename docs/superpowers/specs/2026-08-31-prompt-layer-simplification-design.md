# 提示词分层简化为四层模型 — 设计 spec

日期：2026-08-31
状态：已实施（2026-08-31）；当日增补：identity 段改可编辑（覆盖式，见第 1/2/4/5/6 节加注）；面板删除右侧「规则（只读）」「动态层（只读）」折叠区
取代：`2026-08-28-prompt-fixed-layer-stack-design.md`（固定层栈 persona/base/domain/task 方案；本 spec 生效后其层栈定义作废，机制性结论——reconcile、钉住、子 Agent 隔离、裸 assemble 探测——仍然有效并被本 spec 继承）

## 背景与目标

2026-08-31 用户反馈：当前 persona/base/domain/task 四层固定栈不符合预期。对照 opencode（anomalyco/opencode dev 分支 `session/system.ts` + `session/llm/request.ts`）核实：opencode 无 persona/domain/task 语义分层，基座按模型族**整份选择** .txt，后接 env、AGENTS.md instructions、mcp、skills；`agent.prompt` 是整体替换而非叠加。

用户定案的简化分层（面板自上而下 = 渲染顺序）：

1. **identity 层**——dsh 原生 `harness:identity`（order -100），可编辑（覆盖式：填写整份替换原生句，空 = 还原原生；2026-08-31 增补）。
2. **模型识别层**——按模型命中内置模型族提示词，UI 只读。
3. **persona 层**——Agent 性格/角色/职责，可编辑（存储层中唯一）。
4. **动态层**——工具段、contexts 等原生动态追加内容，UI 只读展示。

domain/task 层取消；base 从可编辑层集移出、改为内置模型层。

## 已确认的决策（2026-08-31 逐问确认）

1. **模型层 UI 只读**：模型族提示词内置（`DEFAULT_RULES` + cordis.yml rules 追加），UI 面板只读展示；可编辑的是 identity（覆盖式，2026-08-31 增补）与 persona。
2. **domain/task 存量文本直接丢弃**：reconcile 按新种子结构对齐时，多余层连同已编辑文本一并丢弃；base 的用户已编辑文本同样丢弃。
3. **渲染顺序**：identity → 模型层 → persona → 动态层（模型层在 persona 之前）。
4. **persona 改普通段**：不再填原生 `deployment:persona` 槽位，注册 `prompt-stack:persona` 段（order 10）排在模型层之后。
5. **`deployment:persona` 槽位归还原生**：toolkit 不再触碰；cordis.yml 的 `systemPrompt.persona` 恢复原生语义（配置了则渲染在 identity 后、模型层前），与 UI persona 层各自独立。
6. **实现路径 A**：保留 `LayerConfig`/rules 架构与层名兼容，`DEFAULT_LAYERS` 缩层集；cordis.yml 存量 rules 配置零破坏。

## 第 1 节 · 层栈与 section 表

| # | section | order | 可编辑性 | 来源/实现 |
|---|---------|-------|---------|-----------|
| 1 | `harness:identity` | -100 | **可编辑（覆盖式）** | 原生段；toolkit waterfall 在非空覆盖文本时整份替换（空 = 还原原生；仅主 Agent，子 Agent 隔离；仅当段文本等于原生常量时替换，不 clobber scoped shadow） |
| 2 | `prompt-stack:base` | 0 | 只读 | **模型层**：内置固定注册；文本 = 命中规则 `overrides.base` ?? 内置 `BASE_TEXT` |
| 3 | `prompt-stack:persona` | 10 | **可编辑** | 文本存 `prompt_layers` 表；默认空串（空段不渲染） |
| 4 | `prompt-stack:model-notes` | 11 | 只读 | 自动层，规则 `append` 命中时渲染（现状不变） |
| 5 | `tool:*` / contexts | 100+ | 只读展示 | 原生动态层（现状不变） |

- `base` 成为**内置保留层名**：不是存储层，但仍是 rules `overrides` 的合法目标（cordis.yml 兼容）。`validateConfig` 的 overrides 合法目标 = `{base}` ∪ 存储层名集。
- `validateLayers` 保留名集合加入 `'base'`（与 `model-notes` 同级；用户层不得占用）。
- `DEFAULT_LAYERS = [{ name: 'persona', order: 10, text: '' }]`。
- UI 显示名：「模型层」对应 `prompt-stack:base`，「persona」对应 `prompt-stack:persona`。

## 第 2 节 · 运行时装配（`src/prompt/index.ts`）

- `registerSections`：固定注册 `prompt-stack:base`（order 0，text 回调 = 子 Agent 空串 / 命中 `overrides.base` ?? `BASE_TEXT`），再遍历存储层注册（persona → `prompt-stack:persona` order 10），最后 model-notes（order = 所有段最大 order + 1 = 11）。**不再跳过 persona 层**。
- waterfall 变化：
  - **删除** `deployment:persona` 填充分支与 `TOOLKIT_PERSONA_SECTION` 在场检测（槽位归还原生，决策 5）。
  - 保留：首条消息钉住；子 Agent 隔离（`prompt-stack:base`/`prompt-stack:persona` 对 `origin === 'subagent'` 返回空串，text 回调 + waterfall 双重保证照旧）；model-notes 主子共用、按钉住模型命中。
  - **新增（2026-08-31 增补）**：`harness:identity` 分支——存储的 identity 覆盖文本非空且非子 Agent 时整份替换该段文本；仅当段文本等于原生常量 `'You are an AI agent powered by DeepSeek Harness.'` 才替换（scoped shadow 不介入）；空覆盖 = 不动。bot 会话照常应用覆盖（非 subagent）。
- persona 文本改动实时生效（waterfall 每次组装读 `source.get()`）；模型层文本由规则驱动，无需存储订阅。

## 第 3 节 · bot 角色覆盖（`src/channels/agent-setup.ts`）

- bot 会话的 scoped 角色 persona 段**改名为 `prompt-stack:persona`**（order 10，text = 角色 persona）：利用 dsh 原生「scoped 同名段 shadow 全局段」机制自动覆盖主 Agent persona 层，无 waterfall 特判。
- `TOOLKIT_PERSONA_SECTION` 常量值改为 `'prompt-stack:persona'`（与全局段同名才能触发 shadow）；waterfall 删除在场检测后该常量仅剩 agent-setup 一处使用。
- 子 Agent（委派）路径不变：`buildAgentPersona` 产出 provider persona 参数，不经层栈。

## 第 4 节 · 存储与迁移

- `prompt_layers` 表单行结构：`{ layers: LayerConfig[]; identity?: string }`——`identity` 为 identity 段覆盖文本（2026-08-31 增补，可选字段，缺省/空串 = 原生），仅在非空时写入。
- `openLayerSource` reconcile 天然迁移：种子单层化后，已存的 base/domain/task 层连同文本直接丢弃，persona 文本保留（order 以种子为准 = 10）；`identity` 字段原样保留。
- `validateFixedLayers` 种子 = 单 persona 层；`LayerSource.set` 仅允许改 persona 文本，UI 与 API 均无法增删层。`LayerSource` 扩展 `getIdentity()` / `setIdentity(text)`（2026-08-31 增补）；`reset` 连带清空 identity 覆盖。

## 第 5 节 · HTTP API（`src/prompt/api.ts`）

- `GET /dsh-agent-toolkit/api/prompt-layers` 响应：
  - `layers`（只剩 persona）/ `rules` / `seedLayers` / `native` 不变。
  - 新增 `modelFallbackText: string`（= 内置 `BASE_TEXT`），供 UI 模型层只读行展示兜底文本。
  - 新增 `identityOverride: string`（identity 段覆盖文本，空 = 原生；2026-08-31 增补）。
- `PUT`：`source.set` 固定结构校验（种子单层）不符 → 400，同现有通道；可选 `identityOverride: string` 字段，携带时写入（2026-08-31 增补）。
- `POST /reset`：回种子单层 + 清空 identity 覆盖。

## 第 6 节 · 浏览器半 UI（`src/client/prompt/PromptLayersModal.tsx`）

- 层列表（硬编码顺序）：`harness:identity`（**可编辑行**：选中后 textarea 编辑覆盖文本，placeholder 展示原生句，空 = 还原原生；2026-08-31 增补）→ **模型层**（只读，展示 `modelFallbackText` + 说明「按模型命中规则覆盖」）→ **persona**（可编辑 textarea）→ `model-notes`（只读徽标）。
- 面板为两栏（层栈 + 编辑区）：2026-08-31 增补删除右侧「规则（只读）」「动态层（只读）」折叠区；rules 仍由 cordis.yml 配置，动态层由 dsh 原生追加，均不在面板展示。
- 删除 base/domain/task 编辑行；「重置为默认层」保留（连带清空 identity 覆盖）。
- `api.ts`：`fetchPromptLayers` 返回类型扩展 `modelFallbackText` / `identityOverride`；`saveLayers` 携带两者。

## 第 7 节 · 委派子 Agent（`src/prompt/persona.ts`，必须跟进）

现状 `buildAgentPersona` 拼接 `getLayers().filter(!= 'persona')`（即 base/domain/task）进子 Agent persona。层集单层化后不过滤即空，子 Agent 会**丢失模型行为指导**。改为显式拼接：

```
SECTION_A(角色名) + SECTION_B
+ 模型层文本（按子的 provider/model 命中 overrides.base ?? BASE_TEXT）
+ 角色 persona（非空时）
+ 命中规则的 append（model-notes）
```

全局 persona 层仍不泄漏给子 Agent（子的 persona 由角色层顶替，现状语义不变）。

## 第 8 节 · 测试与文档

- Node 半：
  - `defaults.test.ts`：DEFAULT_LAYERS 单层、base 为保留名。
  - `layer-source.test.ts`：reconcile 丢弃 base/domain/task 文本、保留 persona；set 固定结构校验。
  - `prompt/index` 相关：base 固定注册（order 0，规则覆盖生效）；persona 注册为普通段（order 10）；无 `deployment:persona` 改写（cordis.yml persona 原样通过）；子 Agent 隔离；钉住与 model-notes 不变；identity 覆盖替换 / 空串还原 / 子 Agent 跳过 / scoped shadow 不 clobber（2026-08-31 增补）。
  - `agent-setup.test.ts`：scoped `prompt-stack:persona` shadow 全局段。
  - `persona.test.ts`：委派 persona 含模型层文本 + 角色 persona + append，不含全局 persona。
  - `api.test.ts`：GET 带 `modelFallbackText`；PUT 结构不符 400。
- 浏览器半：`prompt-layers.spec.tsx` 更新层列表渲染（模型层只读行 + 说明文案）、persona 唯一可编辑。
- 文档：`docs/usage/prompt-layers.md` 重写「分层结构」「UI 管理」；根 `AGENTS.md` 分层要点同步（固定层栈描述更新为本四层模型，含 cordis.yml persona 恢复原生语义的注意事项）。
- 验证门槛：`pnpm --filter dsh-agent-toolkit test` + `typecheck` + `bundle` 全绿。

## 范围外

- 规则（rules）编辑 UI（仍 cordis.yml）。
- 组装预览（选 provider/model 实时拼装）。
- 模型族提示词文本本身的修订（沿用现有 DEFAULT_RULES/BASE_TEXT）。
