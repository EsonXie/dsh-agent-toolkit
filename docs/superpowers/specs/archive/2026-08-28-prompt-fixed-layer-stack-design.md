# 分层提示词固定层栈重设计 — 设计 spec

日期：2026-08-28
状态：已与用户逐节确认，待实施

## 背景与目标

现状两个不符合预期的问题（2026-08-28 用户反馈，已定位根因）：

1. **面板只有 base 层**：`DEFAULT_LAYERS`（`src/prompt/defaults.ts`）只定义 base 一层，存储首启种子即只有 base，UI 如实渲染。非 UI bug，是默认层集本身只有一层。
2. **层可增删/改名/改序**：`PromptLayersModal.tsx` 提供新建层/删除层/上移下移/层名与 order 编辑，与「层结构固定、只能编辑文本」的期望相反。

目标：面板展示**完整层栈**（原生段 + 插件层 + 动态层）；插件层固定为 `persona` / `base` / `domain` / `task` 四层，**不可增删、不可改名、不可改序，仅文本可编辑**（UI 与服务端双重强制）。

## 已确认的决策（来自两轮讨论）

1. **固定层集**：persona / base / domain / task。persona 默认作用于主 Agent，可被 agent（角色）配置覆盖；model-notes 保留自动层、动态层（contexts）只读展示。
2. **persona 优先级**：UI 总是优先——assemble waterfall 无条件把 persona 层文本填入原生 `deployment:persona` 段，cordis.yml 的 `systemPrompt.persona` 被覆盖。
3. **默认文本**：persona / domain / task 默认空串（dsh 空段不渲染，未填写时行为零变化）。
4. **存量迁移**：按种子结构 reconcile——保留已有层文本、补入缺失层、丢弃多余层。
5. **只读区范围**：仅 contexts 快照（动态层），不罗列全部原生段。
6. **规则（rules）仍由 cordis.yml 配置**，面板只读展示（现状保留）。

## 第 0 节 · dsh 原生提示词面事实（调研结论，方案依据）

- system prompt = **sections**（按 order 拼接）+ **contexts**（渲染为 user 角色 "Current runtime context" 快照消息）。见 `deepseek-harness/packages/core/system-prompt/src/index.ts`。
- 原生 sections：`harness:identity`(-100)、`harness:source`(-99)、`app:web-surface`(-98)、`deployment:persona`(0，systemPrompt 服务自身 Config.persona，默认空)。
- **`deployment:persona` 是原生 persona 槽位**：agent 作用域注册同名段即 shadow 覆盖（`system-prompt/src/index.ts:128-131`；子 Agent 由 `subagent/child-agent.ts:172` 注册）。这就是「persona 可被 agent 配置覆盖」的原生机制。
- 无公开「列出所有段」API，但插件可调 `ctx.systemPrompt.assemble({})` 裸组装探测全局 sections/contexts 全列表。
- 主 Agent 当前无 persona：`main` 内置角色无 persona 字段；web 主会话不走 `setupAgentScope`（仅飞书 bot 会话走）；`deployment:persona` 默认空。

## 第 1 节 · 固定层栈（面板自上而下 = 渲染顺序）

| # | 层 | order | 可编辑性 | 来源/实现 |
|---|---|---|---|---|
| 1 | `harness:identity` | -100 | 只读 | 原生；文本来自裸 assemble 探测 |
| 2 | `persona` | 0 | **可编辑** | 文本存 `prompt_layers` 表；运行时填入 `deployment:persona` 槽位 |
| 3 | `base` | 0 | 可编辑 | 现状不变（`prompt-stack:base` 段；稳定排序在 persona 槽位之后） |
| 4 | `domain` | 20 | 可编辑 | 新增；`prompt-stack:domain` 段 |
| 5 | `task` | 50 | 可编辑 | 新增；`prompt-stack:task` 段 |
| 6 | `model-notes` | 末尾自动 | 只读（标注「由规则 append 渲染」） | 保留层，现状不变 |
| 7 | 动态层（contexts） | — | 只读列出名称 + 当前快照 | 裸 assemble 探测 |

面板展示序硬编码为上行序；persona/base 同 order 0 靠种子数组序 + 稳定排序（ES2019+ Array.sort 稳定）。

## 第 2 节 · 数据模型与存量迁移

- 存储不变：`dsh_agent_toolkit` 域 `prompt_layers` 表单行（key `'layers'`）。
- `DEFAULT_LAYERS` 扩为四层：`{persona,0,''}` / `{base,0,BASE_TEXT}` / `{domain,20,''}` / `{task,50,''}`。`DEFAULT_RULES` 不变（仍只覆盖 base；persona/domain/task 成为合法 overrides 目标）。
- `openLayerSource` 增加 **reconcile**：读出现有层后，按种子结构对齐——同名层保留已存储文本（order 以种子为准）、缺失层补入、多余层丢弃，结果写回表。首启种子逻辑不变。
- `LayerSource.set` 增加**固定结构校验**：name 多重集合必须等于种子 name 集（仅 text 可变），不符抛错。校验在 `set` 内执行，任何调用方（含 API）都无法绕过。
- `validateLayers`（通用校验：非空/名唯一/禁保留名）保持不变；固定结构校验是 `set` 的附加步骤，不进 `validateLayers`（setupPrompt 的运行时校验不需要种子参照）。

## 第 3 节 · 运行时装配（`src/prompt/index.ts`）

- `registerSections`：**跳过 persona 层**（不注册 `prompt-stack:persona` 段），其余层与 model-notes 照旧。
- assemble waterfall 增加 persona 分支，优先级与隔离规则：
  - 段名 `deployment:persona` 且 **非子 Agent**（`origin !== 'subagent'`）且**组装中不存在 `dsh-agent-toolkit:persona` scoped 段**（bot 会话的角色 persona 在场 = 角色覆盖主 Agent persona）时：改写为 `hitRule(context)?.overrides?.['persona'] ?? personaLayer.text`（UI 总是优先于 cordis.yml 原生配置；overrides 可命中 persona 层，与其他层语义一致）。
  - 子 Agent：不改写（其 `deployment:persona` 由委派装配提供）。
  - persona 层文本为空串 → 改写为空串，段被丢弃（与原生默认行为一致）。
- persona 文本改动无需重注册段：waterfall 每次组装实时读 `source.get()`。
- 子 Agent 隔离（普通层返回空）、首条消息钉住、model-notes 主子共用，全部不变。

## 第 4 节 · HTTP API（`src/prompt/api.ts`）

- `GET /dsh-agent-toolkit/api/prompt-layers` 响应扩展：
  - 现有 `layers` / `rules` / `seedLayers` 不变。
  - 新增 `native: { sections: Array<{name, text}>; contexts: Array<{name, text}> }`——由注入的 `probe` 回调（apply 内闭包：`() => ctx.systemPrompt.assemble({})`）裸组装获得。handler 改为 async 调用 probe；probe 失败降级为 `{ sections: [], contexts: [] }` 不阻塞主数据。
- `PUT`：`source.set` 抛固定结构错误 → 400（与现有校验失败同通道）；UI 只改文本天然满足。
- `POST /reset`：不变（回种子四层）。

## 第 5 节 · 浏览器半 UI（`src/client/prompt/PromptLayersModal.tsx`）

- 左栏层列表（硬编码顺序）：`harness:identity`（只读徽标）→ persona/base/domain/task（可编辑）→ `model-notes`（只读徽标）。移除「新建层」按钮。
- 右栏编辑器：
  - 可编辑层：层名、order 改**只读文本**展示；仅「层文本」textarea 可编辑；移除上移/下移/删除层按钮。
  - 只读行（identity / model-notes）：只读展示当前文本（identity 来自 probe；model-notes 显示说明「由规则 append 渲染」+ 命中时文本）。
- 底部：「重置为默认层」（保留，确认后覆盖为种子四层）、「规则（只读）」（保留）、新增「动态层（只读）」折叠区——列出 probe contexts 的名称 + 文本快照，空时显示「当前无动态层」。
- `api.ts`：`fetchPromptLayers` 返回类型扩展 `native` 字段。
- 选择键：层行 key 用 name（固定层集无重名），移除 `order` 参与 key 的逻辑。

## 第 6 节 · 测试与文档

- Node 半：
  - `defaults.test.ts`：DEFAULT_LAYERS 为四层、序与默认文本断言。
  - `layer-source.test.ts`：reconcile（保留已改文本/补缺失/丢多余/写回）；`set` 固定结构校验拒绝增删层。
  - `prompt/index` 相关测试：persona 不注册 `prompt-stack:persona` 段；waterfall 填 `deployment:persona`（主 Agent 填充 / 子 Agent 不改写 / 有 scoped persona 段时不改写 / overrides 命中 persona）；现有 assemble/persona/runtime-model/smoke 用例同步。
  - `api.test.ts`：GET 带 native 字段（probe 失败降级）；PUT 结构不符 400。
- 浏览器半：`prompt-layers.spec.tsx` 删除「新建/上移/删除」用例；新增固定层栈渲染（只读行徽标）、仅文本可编辑、动态层折叠区断言。
- 文档：`docs/usage/prompt-layers.md` 重写「分层结构」「UI 管理」两节；根 `AGENTS.md` 要点同步。
- 验证：`pnpm --filter dsh-agent-toolkit test` + `typecheck` + `bundle` 全绿。

## 范围外

- 规则（rules）编辑 UI（仍 cordis.yml）。
- persona 并入 `main` 角色记录 / Agents 面板（persona 层文本独立存 prompt_layers 表）。
- `tool:*` 等 scoped 工具段的展示（裸 assemble 探不到，且非本面板管理对象）。
- 组装预览（选 provider/model 实时拼装）。
