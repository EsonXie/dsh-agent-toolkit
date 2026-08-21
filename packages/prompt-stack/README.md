# @dsh-agent-toolkit/prompt-stack

DeepSeek Harness 插件：语义化提示词分层 + 按模型规则覆盖层文本。

## 安装

```sh
dsh plugin --profile web add @dsh-agent-toolkit/prompt-stack
```

依赖 dsh 提供 `systemPrompt` 服务（`@deepseek-ai/dsh-base` 含）。

- 每个语义层注册为 `prompt-stack:<层名>` section，按 `order` 升序拼接。
- 规则按当前生效模型匹配（`provider` 精确 / `model` 精确 / `modelPattern` glob），打分 model=4、pattern=2、provider=1，取最高分一条（同分取配置序靠前）；命中规则的 `overrides[层名]` 替换该层文本，`append` 渲染为固定追加层 `prompt-stack:model-notes`（order = 最大层 order + 1）。
- 首条消息钉住：web 会话的模型选择是运行时值（dsh model-selection 在 assemble waterfall 内层把 `variables.provider/model` 覆盖为当次选择）；prompt-stack 在同一 waterfall 外层用最终 variables 解析，**每个会话在首次组装（首条消息）时按当次选择的模型命中规则并钉住**——会话中途切模型不改写系统提示词，保持对话的行为契约稳定；clear/新会话（session id 变化）自动重新解析。无运行时选择时回退创建期 `agent.options`。
- 裸组装（无 agent）全部使用默认文本；无规则命中是正常路径，不告警。
- 默认仅一层 `base`（order 0）+ 15 条模型族规则；默认文本改写自 opencode（MIT 许可）的 session/prompt/*.txt，剔除其专有内容、保留模型族行为指导。
- 层文本支持 dsh 严格插值；`{{model}}` / `{{provider}}` 变量由 dsh 提供（agent-loop 注册创建期值，model-selection 在 waterfall 覆盖为运行时值），prompt-stack 直接引用、不重复注册（重复注册会在激活期因重名抛错）。

## 配置示例

```yaml
prompt-stack:
  layers:
    - { name: persona, order: 0,  text: "你是 {{model}} 驱动的……" }
    - { name: task,    order: 50, text: "……" }
  rules:
    - match: { provider: deepseek, model: deepseek-v4 }
      overrides: { task: "V4 专用任务指引……" }
      append: "该模型需注意……"
```

order 建议区间（与 dsh 惯例对齐）：`-100` harness identity（原生，不动）、`0` persona、`10–40` domain/领域知识、`50` task/任务指引、`100–199` 工具指引（原生，不动）；插件的 model-notes 追加层自动取最大层 order + 1。

## 已知局限

- 运行时解析依赖 waterfall 顺序：prompt-stack 全局注册（boot 期）须早于 dsh model-selection 的 per-agent 监听器（agent 创建期）才能拿到覆盖后的 variables；当前 dsh 拓扑恒满足。若未来宿主改变注册时序，行为静默回退为创建期匹配（不报错）。
- 钉住缓存是进程内的（WeakMap，按 agent + session id）：进程重启后恢复的旧会话在首次组装时按当时的当前选择（= 日志里最近一次请求的模型）重新解析，不一定是该会话首条消息时的模型。
