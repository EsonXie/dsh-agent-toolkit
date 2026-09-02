# Agent 团队模式（agent-team preset）

dsh 0.1.2-alpha.4 起，原生 `subagent` 工具族带强引导段，模型在委派意图下会优先选它而不是 `team_delegate`，导致 Agent 团队的角色配置（persona / 模型路由 / 工具白名单）不生效。「Agent 团队」模式为此而生：该模式下原生 subagent 工具族不存在，委派唯一入口是 `team_delegate`。

## 原理

插件启动时自动生成（每次启动重写）一个用户 preset `agent-team`：派生自宿主当前 shipped `standard` 的 composition，仅禁用 4 个行（`tool-subagent` / `tool-subagent-fork` / `tool-subagent-control` / `tool-subagent-list-agents`，覆盖 subagent、subagent_fork、send_message、list_agents、interrupt_agent 共 5 个工具及其引导段）。其余与 standard 完全一致。standard 模式本身不受任何影响。

生成位置：`$DSH_HOME/.agent-presets/agent-team/`（或配置的首个 trust=user root 下同名目录），含 `agent.cordis.yml` / `preset.yml` / `.generated-by` 三个文件。**勿手改，每次启动重写**；想自定义可复制为另一个 preset id。同名目录若非本插件生成（无 `.generated-by` 标记），插件不覆盖并记 warn。

## 使用

1. 启动后打开会话的模式选择器，选用「Agent 团队」（roster 与 standard 并列）。
2. 或把 settings 的 `agent-presets.default` 设为 `agent-team` 作为默认模式。
3. 之后新会话中委派统一走 `team_delegate` + Agents 面板配置的团队角色。

插件**不会**把它设为默认 preset，也不改任何 settings；卸载插件不删目录（可能有会话在用），残留的 agent-team preset 自身仍可用（团队工具随插件卸载消失）。旧宿主（无 presets 架构，如 rc2）下本功能自动静默关闭。

## 配置（cordis.yml）

```yaml
- id: dsh-agent-toolkit
  config:
    agentTeamPreset:
      enabled: true        # 总开关
      id: agent-team       # 生成的 preset id
      source: standard     # 派生源 preset
      name: Agent 团队      # roster 显示名
      description: ...     # roster 描述
```

全部字段及默认值见 [config-reference.md](config-reference.md) 的 `agentTeamPreset.*` 段。
