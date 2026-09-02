# 配置参考

插件全部可调参数都在 `cordis.yml` 中按 id `dsh-agent-toolkit` 覆盖。修改配置触发 HMR 热替换，无需重启。

## 完整示例

```yaml
- id: dsh-agent-toolkit
  config:
    modules:
      feishu: true
      usage: true
    timezone: Asia/Shanghai
    provider: spawn
    toolName: team_delegate
    layers:
      - name: persona
        order: 10
        text: '...'
    rules:
      - match: { modelPattern: 'claude*' }
        overrides: { base: '...' }
    feishu:
      cardUpdateThrottleMs: 500
      cardMaxBytes: 28000
      processMaxBytes: 8000
      registerAppTimeoutMs: 600000
      processingReactionEmoji: OneSecond
      errorDetailMaxChars: 500
    agentTeamPreset:
      enabled: true
      id: agent-team
      source: standard
      name: Agent 团队
      description: '...'
```

## 顶层字段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `modules.feishu` | boolean | `true` | 启用飞书 bots 模块。`false` 时不开 `project_bot` 存储域、不注册 bots API |
| `modules.usage` | boolean | `true` | 启用 token 用量模块。`false` 时不开 `token_usage` 域、不注册 `/token-usage` 命令 |
| `layers` | array | `[{ name: 'persona', order: 10, text: '' }]` | 语义化提示词分层，见 [prompt-layers.md](prompt-layers.md)。元素：`{name: string, order: number, text: string}` 皆必填（首启种子；若已用 UI 管理分层提示词，此后由存储域生效，此处仅在重置时作为默认值）。层结构固定：UI/API 仅可改 persona 文本，增删层/改名/改序被拒绝；`base` / `model-notes` 为保留层名不可占用 |
| `rules` | array | 内置 15 条规则 | 按模型匹配的覆盖/追加规则。元素：`{match: {provider?, model?, modelPattern?}, overrides?: Record<string,string>, append?: string}` |
| `timezone` | string | `Asia/Shanghai` | 用量按日/按小时聚合的时区（IANA 时区名） |
| `provider` | string | `spawn` | 委派用的 subagent provider 名 |
| `toolName` | string | `team_delegate` | 委派工具对模型的可见名。改名后浏览器半委派卡不再生效（按固定 key 注册），落回通用工具展示 |

## `feishu.*` 字段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `feishu.cardUpdateThrottleMs` | number | `500` | 卡片流式更新节流间隔（毫秒） |
| `feishu.cardMaxBytes` | number | `28000` | 单张卡片内容字节上限（飞书硬上限 30KB，留余量），超限自动拆卡 |
| `feishu.processMaxBytes` | number | `8000` | 过程区（思考 + 工具调用折叠面板）字节上限，超限截尾保留最近内容 |
| `feishu.registerAppTimeoutMs` | number | `600000` | 扫码一键创建应用的轮询超时（毫秒，默认 10 分钟） |
| `feishu.processingReactionEmoji` | string | `OneSecond` | 「处理中」表情回复的 emoji_type |
| `feishu.errorDetailMaxChars` | number | `500` | 回传飞书的错误摘要最大字符数 |

## `agentTeamPreset.*` 字段

Agent 团队 preset 自动生成（见 [agent-team-preset.md](agent-team-preset.md)）。启动时派生源 preset 的 composition、文本级禁用 subagent 工具族 4 行后写入首个 trust=user 的 preset root；无 presets 架构的旧宿主（如 rc2）下自动静默关闭。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `agentTeamPreset.enabled` | boolean | `true` | 总开关。`false` 时启动不生成/刷新 preset |
| `agentTeamPreset.id` | string | `agent-team` | 生成的 preset id（即目录名）。须匹配 `^[a-z0-9][a-z0-9-]*$`，非法时记 warn 跳过 |
| `agentTeamPreset.source` | string | `standard` | 派生源 preset id，读其 composition 做文本级派生 |
| `agentTeamPreset.name` | string | `Agent 团队` | preset.yml 的显示名（roster 显示） |
| `agentTeamPreset.description` | string | `Agent 团队模式：禁用原生 subagent 工具族，委派统一走 team_delegate 团队角色` | preset.yml 的描述 |

## 注意事项

- **layers/rules 是整体替换**：配置了自己的 `layers` 或 `rules` 会完全替换内置默认值，不是合并。想保留默认行为需把默认内容一并写入。
- **激活期校验**：`layers`/`rules` 非法（空数组、层名重复、保留层名 `base`/`model-notes`、overrides 引用未定义层、match 全空、modelPattern 非法 glob）时插件激活直接失败并给出具体原因，见 [prompt-layers.md](prompt-layers.md)。
- **委派卡与 toolName 绑定**：见上表 `toolName` 行。
- **空 overrides 自动丢弃**：只写 `append` 的规则不需要（也不应）提供空 `overrides` 对象。
