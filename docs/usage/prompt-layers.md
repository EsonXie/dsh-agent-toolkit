# 分层提示词

把系统提示词组织成有序的语义层（layers），再按当前模型用规则（rules）整体替换或追加文本——同一份配置下，Claude、GPT、Gemini、Kimi 等不同模型家族自动获得各自适配的提示词。该机制对主 Agent 与委派子 Agent 都生效，无需手工干预。

## 分层结构

`layers` 配置是一个有序数组，每层 `{name, order, text}`：

```yaml
- id: dsh-agent-toolkit
  config:
    layers:
      - name: base
        order: 0
        text: |
          你是一个专业的软件工程 Agent。……
```

- 每层注册为一个系统提示词 section，按 `order` 排序拼接
- 保留层名 **`model-notes`**：不能用作自定义层名；它自动追加在最大 order 之后，用于渲染规则命中时的 `append` 文本（无命中则为空）
- 默认配置只有一层：`base`（order 0，内置通用工程 Agent 提示文本）

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

自定义 `layers` / `rules` 会**整体替换**默认值（不是合并），想保留默认行为需把默认内容一并写入。

## 运行时行为

- **首条消息钉住**：每个会话首次组装系统提示词时确定 provider/model，会话中途切换模型**不会**改写已发出的系统提示词；开新会话/clear 后按新模型重新解析
- **运行时模型优先**：web 会话的运行时模型选择优先于创建期配置
- **子 Agent 隔离**：委派子 Agent 组装时普通层返回空（主 Agent 的层不泄漏给子 Agent），但 `model-notes` 主子共用、按子 Agent 的生效模型各自命中规则
- **角色 persona**：Agent 注册表角色的 persona 是角色唯一可自定义的层（见 [agents.md](agents.md)）；委派时 persona 作为 order 0 层插入，再叠加委派契约段与能力守则

## 激活期校验

配置非法时在插件激活阶段直接抛错（开任何存储域之前）：

- `layers` 非空、层名不重复、不得使用保留层名 `model-notes`
- `overrides` 只能引用已定义的层名
- 每条规则 `match` 至少填一个字段，`modelPattern` 必须是合法 glob
