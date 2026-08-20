# prompt-stack

DeepSeek Harness 插件：语义化提示词分层 + 按模型规则覆盖层文本。

- 每个语义层注册为 `prompt-stack:<层名>` section，按 `order` 升序拼接。
- 规则按当前 agent 创建期的 `provider`/`model` 匹配（`provider` 精确 / `model` 精确 / `modelPattern` glob），打分 model=4、pattern=2、provider=1，取最高分一条（同分取配置序靠前）；命中规则的 `overrides[层名]` 替换该层文本，`append` 渲染为固定追加层 `prompt-stack:model-notes`（order = 最大层 order + 1）。
- 裸组装（无 agent）全部使用默认文本；无规则命中是正常路径，不告警。
- 默认仅一层 `base`（order 0）+ 13 条模型族规则；默认文本改写自 opencode（MIT 许可）的 session/prompt/*.txt，剔除其专有内容、保留模型族行为指导。
- 层文本支持 dsh 严格插值；插件注册 `{{model}}` / `{{provider}}` 变量（取自创建期模型配置）。

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

`agent.options.model` 是创建期模型；会话中通过 UI 运行时切换模型时取到的不是当步生效模型。适用场景是不同模型对应不同 agent/preset 配置；运行时切模型感知留作未来增强（`system-prompt/assemble` waterfall 路径）。
