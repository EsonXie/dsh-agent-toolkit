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
      - name: base
        order: 0
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
```

## 顶层字段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `modules.feishu` | boolean | `true` | 启用飞书 bots 模块。`false` 时不开 `project_bot` 存储域、不注册 bots API |
| `modules.usage` | boolean | `true` | 启用 token 用量模块。`false` 时不开 `token_usage` 域、不注册 `/token-usage` 命令 |
| `layers` | array | 内置 `base` 单层 | 语义化提示词分层，见 [prompt-layers.md](prompt-layers.md)。元素：`{name: string, order: number, text: string}` 皆必填 |
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

## 注意事项

- **layers/rules 是整体替换**：配置了自己的 `layers` 或 `rules` 会完全替换内置默认值，不是合并。想保留默认行为需把默认内容一并写入。
- **激活期校验**：`layers`/`rules` 非法（空数组、层名重复、保留层名 `model-notes`、overrides 引用未定义层、match 全空、modelPattern 非法 glob）时插件激活直接失败并给出具体原因，见 [prompt-layers.md](prompt-layers.md)。
- **委派卡与 toolName 绑定**：见上表 `toolName` 行。
- **空 overrides 自动丢弃**：只写 `append` 的规则不需要（也不应）提供空 `overrides` 对象。
