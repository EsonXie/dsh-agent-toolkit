# 分层提示词

把系统提示词组织成有序的语义层（layers），再按当前模型用规则（rules）整体替换或追加文本——同一份配置下，Claude、GPT、Gemini、Kimi 等不同模型家族自动获得各自适配的提示词。该机制对主 Agent 与委派子 Agent 都生效，无需手工干预。

## 分层结构

面板自上而下即渲染顺序，层栈是**固定**的四层模型（层不能增删、改名、改序）：

| 层 | section | order | 可编辑 | 说明 |
|---|---|---|---|---|
| identity | `harness:identity` | -100 | **可编辑（覆盖式）** | dsh 原生身份段；填写整份替换原生句，留空还原原生；仅主 Agent 生效 |
| 模型层 | `prompt-stack:base` | 0 | 只读 | 内置固定注册；文本 = 命中规则 `overrides.base` ?? 内置默认文本 |
| persona | `prompt-stack:persona` | 10 | **可编辑** | 层文本可编辑；文本存 `prompt_layers` 表，默认空串（空段不渲染） |
| model-notes | `prompt-stack:model-notes` | 11 | 只读 | 自动层，规则命中 `append` 时渲染 |
| 动态层 | `tool:*` / contexts | 100+ | 只读展示 | 原生动态追加内容 |

- 可编辑：identity（覆盖文本）与 persona（层文本）；其余层只读
- 空文本层不渲染（dsh「空段不渲染」），persona 未填写时对提示词无影响
- **模型层按模型命中规则整体覆盖**：`base` 是内置保留层名（不进存储、不占 UI 可编辑层），但仍是规则 `overrides` 的合法目标
- **domain/task 层已取消**：旧存储升级时 reconcile 按新种子结构对齐，多余层连同已编辑文本直接丢弃，persona 文本保留
- **cordis.yml 的 `systemPrompt.persona` 恢复原生语义**：配置了则渲染在 identity 之后、模型层之前，与 UI persona 层各自独立、互不影响
- 自定义 `layers` 配置（cordis.yml）仅作首启种子/重置默认值；已存储的层在插件升级时按种子结构自动对齐：保留同名层文本、丢弃多余层

## UI 管理（层）

层文本由 UI 管理：`dsh-agent-toolkit` 插件浏览器半新增「分层提示词」侧边栏入口（Agents 之后）。
- 左栏固定层栈：`harness:identity`（可覆盖，无只读徽标）→ **模型层**（只读，tab 栏切换「内置默认」与各 `overrides.base` 规则查看文本）→ **persona**（可编辑层文本）→ `model-notes`（只读徽标，tab 栏切换各 `append` 规则查看文本；无 append 规则时显示空态提示）。
- 可编辑：选中 identity 显示「身份段覆盖文本」textarea（placeholder 为原生句，填写整份替换、留空还原原生）；选中 persona 可编辑「层文本」。保存全量替换。服务端同样拒绝结构变更（增/删/改名/改序返回 400）。
- 「重置为默认层」用 cordis.yml 的 `layers` 种子覆盖当前层，**连带清空 identity 覆盖**（覆盖性操作，需确认）。
- 规则（rules）内容由 cordis.yml 配置（见下文「规则匹配」），面板只读查看：模型层 / model-notes 行的 tab 标签为规则匹配条件（`provider: X` / `model: X` / modelPattern 原样，多条件 ` + ` 连接）；动态层（contexts）由 dsh 原生按运行时追加，不在面板展示。
- 存储：`dsh_agent_toolkit` 域 `prompt_layers` 表（单行 `layers`，只含 persona 层 + 可选 `identity` 覆盖字段；identity 仅非空时落字段，空 = 还原原生），`meta` 表 `prompt_layers_seeded` 首启种子标记。`config.layers` 仅在首次启动（或重置后）作为种子写入，此后运行一律读存储。

## 规则匹配

`rules` 按模型匹配，命中后执行两种操作：

- `overrides`：`{层名: 新文本}`，**整体替换**指定层的文本（合法目标 = 内置保留层 `base` + 存储层名 persona）
- `append`：追加文本，渲染进 `model-notes` 层

规则匹配条件三选一或组合：`provider`（精确）、`model`（精确）、`modelPattern`（glob，支持 `*` / `?`）。打分仲裁：`model` 精确 = 4 分，`modelPattern` = 2 分，`provider` = 1 分，组合累加，**取最高分**；同分取配置中靠后的规则；都不命中则用层默认文本。

示例：

```yaml
rules:
  - match: { modelPattern: 'claude*' }
    overrides: { base: '（针对 Claude 的 base 层文本）' }
  - match: { modelPattern: 'deepseek*' }
    append: '（追加到 model-notes 的文本）'
```

## 内置默认规则

默认 15 条规则覆盖主流模型家族（全部只换模型层 `base`，除非注明追加）：

| 匹配 | 生效文本 |
|---|---|
| `claude*` | Anthropic 系提示文本 |
| `gemini-*` | Gemini 系提示文本 |
| `gpt-4*` / `o1*` / `o3*` | GPT 高能力档提示文本 |
| `gpt*codex*` | Codex 系提示文本 |
| `gpt*` | GPT 系提示文本 |
| `kimi*` / `k2*` / `k3*` / provider 为 `moonshotai`、`moonshotai-cn`、`kimi-for-coding` | Kimi 系提示文本 |
| `deepseek*` | **仅追加** DeepSeek 补充说明 |
| `glm-*` | **仅追加** GLM 补充说明 |

自定义 `layers` / `rules` 会**整体替换**默认值（不是合并），想保留默认行为需把默认内容一并写入。`layers` 若已由 UI 管理，cordis.yml 的 `layers` 仅作种子/重置默认值，不再动态生效。

## 运行时行为

- **首条消息钉住**：每个会话首次组装系统提示词时确定 provider/model，会话中途切换模型**不会**改写已发出的系统提示词；开新会话/clear 后按新模型重新解析
- **运行时模型优先**：web 会话的运行时模型选择优先于创建期配置
- **子 Agent 隔离**：委派子 Agent 组装时全局 persona 层不泄漏给子 Agent（子的 persona 由委派装配的角色 persona 提供）；模型层文本按子 Agent 的生效模型各自命中（契约段 + 模型层 + 角色 persona + 规则 append），`model-notes` 主子共用
- **角色 persona**：Agent 注册表角色的 persona 是角色自己的人设层（见 [agents.md](agents.md)）；bot 会话中用 scoped 同名段 `prompt-stack:persona` 覆盖（shadow）全局 persona 层，委派会话中角色 persona 拼进子 Agent persona

## 激活期校验

配置非法时在插件激活阶段直接抛错（开任何存储域之前）：

- `layers` 非空、层名不重复、不得使用保留层名 `base` / `model-notes`（用户层不得占用）
- `overrides` 只能引用保留层 `base` 或已定义的存储层名
- 每条规则 `match` 至少填一个字段，`modelPattern` 必须是合法 glob
