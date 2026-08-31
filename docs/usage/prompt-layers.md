# 分层提示词

把系统提示词组织成有序的语义层（layers），再按当前模型用规则（rules）整体替换或追加文本——同一份配置下，Claude、GPT、Gemini、Kimi 等不同模型家族自动获得各自适配的提示词。该机制对主 Agent 与委派子 Agent 都生效，无需手工干预。

## 分层结构

层栈是**固定**的：层不能增删、改名、改序，只能编辑文本。面板自上而下即渲染顺序：

| 层 | order | 说明 |
|---|---|---|
| `harness:identity` | -100 | dsh 原生身份段，只读 |
| `persona` | 0 | 主 Agent 人设。运行时填入原生 `deployment:persona` 槽位；bot/委派会话用角色自己的 persona 覆盖它（见 [agents.md](agents.md)） |
| `base` | 0 | 通用行为契约（内置默认文本） |
| `domain` | 20 | 领域知识（默认空） |
| `task` | 50 | 当前任务（默认空） |
| `model-notes` | 末尾自动 | 保留层：规则命中 `append` 时渲染，只读 |

- 可编辑的四层（persona/base/domain/task）各注册为一个系统提示词 section，按 `order` 排序拼接
- 空文本层不渲染（dsh「空段不渲染」），未填写时对提示词无影响
- `persona` 层**总是覆盖** cordis.yml 里 `systemPrompt` 的原生 `persona` 配置（默认空串 = 丢弃原生配置）
- 自定义 `layers` 配置（cordis.yml）仅作首启种子/重置默认值；已存储的层在插件升级时按种子结构自动对齐：保留同名层文本、补入缺失层、丢弃多余层

## UI 管理（层）

层文本由 UI 管理：`dsh-agent-toolkit` 插件浏览器半新增「分层提示词」侧边栏入口（Agents 之后）。
- 左栏固定层栈：`harness:identity`（只读）→ persona/base/domain/task（可编辑）→ `model-notes`（只读）。
- 可编辑层：层名与 order 只读，仅「层文本」可改；保存全量替换。服务端同样拒绝结构变更（增/删/改名/改序返回 400）。
- 「重置为默认层」用 cordis.yml 的 `layers` 种子覆盖当前层（覆盖性操作，需确认）。
- 「规则（只读）」折叠区展示当前 `rules`（仍由 cordis.yml 配置，不在本面板编辑）；引用不存在层的 overrides 会标「悬空」。
- 「动态层（只读）」折叠区展示当前运行时上下文快照（contexts，渲染为 user 角色的 "Current runtime context" 消息）。
- 存储：`dsh_agent_toolkit` 域 `prompt_layers` 表（单行 `layers`），`meta` 表 `prompt_layers_seeded` 首启种子标记。`config.layers` 仅在首次启动（或重置后）作为种子写入，此后运行一律读存储。

## 规则匹配

`rules` 按模型匹配，命中后执行两种操作：

- `overrides`：`{层名: 新文本}`，**整体替换**指定层的文本
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

默认 15 条规则覆盖主流模型家族（全部只换 `base` 层，除非注明追加）：

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
- **子 Agent 隔离**：委派子 Agent 组装时普通层（base/domain/task）与 persona 层都不泄漏给子 Agent（子的 persona 由委派装配提供），但 `model-notes` 主子共用、按子 Agent 的生效模型各自命中规则
- **角色 persona**：Agent 注册表角色的 persona 是角色自己的人设层（见 [agents.md](agents.md)）；bot/委派会话中它在场时，全局 persona 层不填充（角色覆盖主 Agent 人设）

## 激活期校验

配置非法时在插件激活阶段直接抛错（开任何存储域之前）：

- `layers` 非空、层名不重复、不得使用保留层名 `model-notes`
- `overrides` 只能引用已定义的层名
- 每条规则 `match` 至少填一个字段，`modelPattern` 必须是合法 glob
