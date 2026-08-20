# prompt-stack 插件设计：语义化提示词分层 + 按模型区分提示词

日期：2026-08-20
状态：已确认方向（方案 A），待实现

## 背景与调研结论

dsh 的系统提示词不是静态文本，而是每个 step 前由 `SystemPrompt.assemble()` 协作组装的有序段落集合（`deepseek-harness/packages/core/system-prompt/src/index.ts:467-542`）：

- **PromptSection**：按 `order` 升序拼接。惯例：`-100` harness 身份、`0` deployment persona、`100–199` 工具指引。text 可为静态字符串或 `(context: AssembleContext) => string` 函数，每次组装求值，支持 `{{variable}}` 严格插值（渲染期未定义变量报错）。
- **AssembleContext**：`dsh-agent` 声明合并出 `agent` 字段（携带当前 agent 实例，`agent.options.provider/model` 为创建期模型配置）；裸组装无 scope 无 agent。
- **scope 遮蔽**：scoped 注册遮蔽同名全局段；preset（cordis.yml 组合）挂在 agent scope 下。
- **HMR**：改 cordis.yml config 触发插件重挂载，闭包读取最新配置。

**dsh 不支持按模型区分提示词**（非一等特性）：`AssembleContext` 无 model/provider 字段；模型级配置（`settings.yaml`）只有模态/推理字段，无 prompt 字段；模型选择（`agent/request`）与提示词组装（`system-prompt/assemble`）是两条独立管线；全仓无 `modelPrompt`/`soul` 等机制。

### 方案对比与选择

| 方案 | 机制 | 结论 |
|---|---|---|
| **A（选定）** | 每层注册函数式 section，text 函数内从 `AssembleContext.agent.options` 读 provider/model 做规则匹配 | 机制最薄，全走文档化一等 API；HMR 与 scope 遮蔽免费获得 |
| B | `system-prompt/assemble` waterfall 整体改写 assembly | 能感知运行时切模型，但 expert 级 API、监听器顺序无保证、与 complete 段冲突；留作未来可选增强 |
| C | 不写插件，preset + dsh-persona 组合 | 无规则匹配、无分层抽象、配置重复，不满足需求 |

方案 A 的已知局限：`agent.options.model` 是创建期模型，会话中通过 UI 运行时切换模型时取到的不是当步生效模型。本设计的适用场景（不同模型本来对应不同 agent/preset 配置）中该局限不成立；如未来需要，再加 `matchRuntimeModel` 开关走 waterfall 路径。

## 目标形态

`packages/prompt-stack/`，独立插件，照 token-usage/ACP 蓝本：

- `package.json`（peerDeps 拷贝 ACP 依赖集）
- `src/index.ts`：命名导出 `name = 'prompt-stack'`、`inject = ['systemPrompt']`、`Config`（Schemastery schema）、`apply(ctx, config)`，无 default export
- 纯 Node 半，无浏览器 bundle
- 全局挂载（cordis.yml）服务所有 agent；挂进 preset 则 scoped section 自动遮蔽全局同名段

## Config schema

全部文本内联在 cordis.yml，可调参数全部进 Config（不硬编码）：

```yaml
prompt-stack:
  layers:                        # 语义层定义，插件不带任何默认文本
    - { name: persona, order: 0,  text: "你是 {{model}} 驱动的……" }
    - { name: domain,  order: 10, text: "……" }
    - { name: task,    order: 20, text: "……" }
  rules:                         # 模型规则
    - match: { provider: deepseek, model: deepseek-v4 }
      overrides: { task: "V4 专用任务指引……" }
      append: "该模型需注意……"   # 渲染到固定的 model-notes 层
    - match: { modelPattern: "claude-*-sonnet" }
      overrides: { persona: "……" }
```

- `layers[].name`：语义层名（同时是 section 名后缀，section 全名 `prompt-stack:<层名>`）；`order` 必填；`text` 支持 `{{variable}}`
- `rules[].match`：`provider`（精确）、`model`（精确 id）、`modelPattern`（glob，如 `deepseek-*`）三字段均可选但至少一个
- `rules[].overrides`：`层名 -> 替换文本` 字典
- `rules[].append`：可选，命中时渲染为固定追加层

**合并语义（KISS）**：`layers` / `rules` 字段一旦被用户配置即整体替换默认值，不做深合并；用户想追加需复制默认再改。

## 默认配置（参考 opencode 的分层与模型路由）

### opencode 的提示词分层（已核实，`anomalyco/opencode@dev`）

opencode 的最终拼装点在 `session/llm/request.ts`：

```ts
system = [
  agent.prompt ?? SystemPrompt.provider(model),  // ① 基座/差异层：按模型族选完整 .txt，agent.prompt 可整体覆盖
  ...input.system,                                // ② 动态层：env 块(模型id/cwd/git/平台/日期) + ③ 自定义指令层(AGENTS.md/CLAUDE.md/config.instructions，含 URL) + MCP/skills 目录
  user.system,                                    // ④ per-request 用户附加 system
].join("\n")
// ⑤ plugin hook experimental.chat.system.transform 可整体改写
```

模型路由（`session/system.ts` 的 `provider(model)`，按 `model.api.id` 包含匹配 + providerID 特例）：

| 路由 | prompt 文件 |
|---|---|
| `muse*` | `meta.txt`（含 `{{MODEL_NAME}}` 占位符） |
| `gpt-4*` / `o1` / `o3` | `beast.txt` |
| `gpt*` + `codex` | `codex.txt` |
| `gpt*` | `gpt.txt` |
| `gemini-*` | `gemini.txt` |
| `claude*` | `anthropic.txt` |
| `trinity*` | `trinity.txt` |
| `kimi*` 或 providerID ∈ `kimi-for-coding` / `moonshotai` / `moonshotai-cn` | `kimi.txt` |
| 其余（含 **deepseek、glm**——opencode 无专属文件） | `default.txt` |

与 prompt-stack 的映射：① 对应我们的 layers + rules.overrides；②③④ dsh 原生已有等价物（runtime context / agent-instructions / 工具指引段），不重复造；⑤ 对应 dsh 的 `system-prompt/assemble` waterfall（本插件不用）。

### prompt-stack 的默认值

**默认 layers**：

| 层 | order | 默认文本来源 |
|---|---|---|
| `base` | 0 | `default.txt` 的本地化改写版 |

**默认 rules**（match 对齐 opencode 路由）：

| match | 作用 | 文本来源 |
|---|---|---|
| `modelPattern: "claude*"` | overrides.base | anthropic.txt 改写版 |
| `modelPattern: "gemini-*"` | overrides.base | gemini.txt 改写版 |
| `modelPattern: "gpt-4*"` / `"o1*"` / `"o3*"` | overrides.base | beast.txt 改写版 |
| `modelPattern: "gpt*codex*"` | overrides.base | codex.txt 改写版 |
| `modelPattern: "gpt*"` | overrides.base | gpt.txt 改写版 |
| `modelPattern: "kimi*"` 或 `provider: "moonshotai" / "moonshotai-cn" / "kimi-for-coding"` | overrides.base | kimi.txt 改写版 |
| `modelPattern: "deepseek*"` | **仅 append** | DeepSeek 官方建议蒸馏 |
| `modelPattern: "glm-*"` | **仅 append** | 智谱官方建议蒸馏（reasoning_content 保留等） |

跳过 `meta.txt` / `trinity.txt`（muse/trinity 非主流）。deepseek/glm 在 opencode 走 default，故不覆盖 base 层，只给 append 适配要点（来自官方文档调研：GLM 交错/保留思考需原样回传 `reasoning_content`；Kimi/GLM 工具调用 OpenAI 风格等）。

### 默认文本改写原则

1. **剔除 opencode 专有内容**：其工具名（TodoWrite/Task）、CLI 快捷键、`/bug` 反馈、opencode 身份自述——dsh 的工具指引段已覆盖工具用法
2. **保留模型族行为指导**：指令风格、输出约束、推理模型注意事项
3. **许可**：opencode 为 MIT 许可，改写文本在源码注释与文档中注明出处
4. 默认文本内联在插件源码常量中（作为 Config schema 的 `.default()`），不是运行时读文件

## 匹配与覆盖算法

在每个 section 的 text 函数内、每次组装时执行：

1. 从 `AssembleContext.agent?.options` 读 `{ provider, model }`；裸组装（无 agent）→ 所有层直接用默认文本
2. 规则打分：`model` 精确命中 = 4 分，`modelPattern` 命中 = 2 分，`provider` 命中 = 1 分，累加；**只取最高分一条规则**，同分取配置序靠前者
3. 命中规则的 `overrides[层名]` 替换该层本次渲染文本；未覆盖层用默认文本
4. 命中规则的 `append` 渲染为固定层 `prompt-stack:model-notes`，order = 配置中最大层 order + 1（无规则命中时该层不渲染，text 返回空串被丢弃——沿用 dsh「空段不渲染」行为）

## order 约定

config 中 order 必填，插件不做隐藏映射。文档建议区间（与 dsh 惯例对齐）：

| order | 层 |
|---|---|
| -100 | harness identity（dsh 原生，不动） |
| 0 | persona |
| 10–40 | domain / 领域知识 |
| 50 | task / 任务指引 |
| 最大层 order + 1 | model-notes（插件固定追加层；order 非固定值，随用户层而定） |
| 100–199 | 工具指引（dsh 原生，不动） |

`{{model}}` / `{{provider}}` 变量由 dsh agent-loop 原生注册（`agent-loop/src/index.ts:351-353`，取自 agent 创建期 `options`），prompt-stack **不重复注册**——同名全局变量重复注册会在激活期因 `NamedEntries.insert` 重名抛错。

## 错误处理

遵循 dsh「激活期响亮报错」惯例：

- 层名重复、`overrides` 引用不存在的层名、glob 非法、`match` 三字段全空 → apply 时抛错，激活失败并给出明确消息
- text 引用未定义 `{{variable}}` → 沿用 dsh 严格插值的渲染期报错，不兜底
- 无规则命中 → 静默使用默认层文本（正常路径，不告警）

## 测试策略

照 token-usage 模式（vitest）：

- 匹配打分优先级（精确 id > 通配 > provider-only；同分取配置序）
- 按层覆盖：命中层替换、未命中层保持默认
- append 合成与 model-notes 层 order 计算
- 裸组装回退（无 agent 时全默认文本）
- 配置校验报错路径（重名层、未知覆盖层名、非法 glob、空 match）

验证命令：`pnpm --filter prompt-stack test` / `typecheck`。开发回路：`cd deepseek-harness && pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml`（cordis.yml 中插件路径用绝对路径）。

## 非目标（YAGNI）

- 不做运行时切模型感知（方案 B 的 waterfall 路径），留作未来增强
- 不做 Markdown 文件引用（本期全部内联）；默认配置文本内联为源码常量
- 默认配置只预置 `base` 层，不预置 persona/domain/task 等语义层（由用户定义）
- 不改动 dsh 原生 section（identity、工具指引等）；不重复 dsh 已有的动态层（runtime context / agent-instructions / skills）
- 无浏览器半、无 UI
