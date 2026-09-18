# dsh-agent-toolkit 使用手册

`dsh-agent-toolkit` 是 DeepSeek Harness（dsh）的单体插件，把五个 Agent 生产力功能合进一个包：

| 功能 | 入口 | 手册 |
|---|---|---|
| Agent 注册表 | 设置面板 → 「Agent 工具箱」→ Agents | [agents.md](agents.md) |
| 并行委派 | 主 Agent 的 `team_delegate` 工具 + 委派卡 | [delegation.md](delegation.md) |
| 飞书 bots | 设置面板 → 「Agent 工具箱」→ Agents（并入各 Agent 卡片） | [feishu-bots.md](feishu-bots.md) |
| 定时任务 | 设置面板 → 「Agent 工具箱」→ 定时任务 | [cron-tasks.md](cron-tasks.md) |
| Token 用量 | 侧边栏底栏「Token 用量」+ `/token-usage` 命令 | [token-usage.md](token-usage.md) |
| 分层提示词 | 设置面板 → 「Agent 工具箱」→ 分层提示词 | [prompt-layers.md](prompt-layers.md) |
| Agent 团队模式 | 模式选择器选用「Agent 团队」 | [agent-team-preset.md](agent-team-preset.md) |
| 配置参考 | `cordis.yml` | [config-reference.md](config-reference.md) |

> 2026-09-17 设置面板收编：原侧边栏底栏的 Agents / 消息机器人 / 定时任务 / 分层提示词四个弹窗已统一迁入宿主**设置面板 → 「Agent 工具箱」**（页内三 tab：Agents（含 Bots）/定时任务/分层提示词）；仅 Token 用量底栏入口保留。
>
> 界面截图存于 `images/`。以下截图**待补拍**（设置面板收编后界面已变）：Agents 卡片流、设置面板三 tab、飞书 Bot 内联表单、定时任务行式列表、分层提示词四层卡；委派卡待真实委派后补拍；Token 用量截图沿用。

## 安装与激活

### 从 npm 安装（发布后）

```bash
dsh plugin --profile <profile 名> add dsh-agent-toolkit
```

`--profile` 为必填项（profile 位于 `$DSH_HOME/profiles/<name>`，默认 `~/.dsh/profiles/<name>`）。包自带 `cordis.patch.yml`（bundles 层），装进 profile 后自动激活，无需手工添加 patch 条目。

### 本地开发安装

```bash
cd deepseek-harness
pnpm dsh plugin --profile web add link:<packages/toolkit 的绝对路径>
```

日常启动时通过根 patch 按 id 覆盖配置（不 insert 插件本身）：

```bash
pnpm dsh web --patch <仓库根>/cordis.yml
```

> 注意：不要在根 patch 里 insert 本地插件路径——Windows 绝对路径（`D:\...`）会被 loader 当作裸 specifier 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。

## 运行前提

- 宿主 dsh 需提供以下注入服务（均为硬依赖）：`storageDomain`、`tools`、`subagents`、`systemPrompt`、`commands`、`llm`、`agentDefaultModel`、`agents`、`tokenMeter`、`credentials`。
- `webServer` 为可选服务：headless/CLI 模式下 HTTP API 自动不注册，插件其余功能不受影响。
- 委派功能需要具备 `persona` + `depthLimit` 能力的 subagent provider（如默认的 `spawn`）；provider 不在场时委派工具不挂载，其余功能正常。
- 浏览器半依赖服务：`sessions`、`slots`、`locale`。

## 配置与热更新

所有配置都在 `cordis.yml` 中按插件 id `dsh-agent-toolkit` 覆盖，例如：

```yaml
- id: dsh-agent-toolkit
  config:
    timezone: Asia/Shanghai
    modules:
      feishu: true
      usage: true
```

修改配置会触发 HMR 热替换，无需重启。全部配置字段见 [config-reference.md](config-reference.md)。

## 数据存储

插件使用三个独立的存储域（storage domain），均随 dsh home 持久化：

| 存储域 | 表 | 内容 |
|---|---|---|
| `dsh_agent_toolkit` | `agents` + `meta` | Agent 注册表记录与一次性迁移/导入标记 |
| `project_bot` | `bots` + `bindings` | 飞书 bot 配置、（bot, 群聊）→ 会话绑定 |
| `token_usage` | `daily` | 按日（含 24 小时桶）的 token 用量记录（由依赖包 @dsh-agent-toolkit/token-usage 打开） |

飞书 App Secret 不落表，统一存放在宿主 credentials 服务中。
