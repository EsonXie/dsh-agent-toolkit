# @dsh-agent-toolkit/project-bot

DeepSeek Harness（dsh）插件：项目机器人——把飞书机器人作为项目 Agent 的交互入口，流式卡片回复。

- 一项目可绑定多个机器人（多条 bot 记录指向同一 cwd），一个机器人即一个 Agent 会话入口
- 创建方式两种：飞书扫码一键创建（`registerApp`）或手动填写 appId + appSecret
- 飞书内指令（不走模型）：`/new` 新会话、`/stop` 取消当前任务、`/status` 查询绑定与状态
- 回复为流式卡片（CardKit），一个 turn 一张卡，内容超长自动拆续卡
- Web UI 侧边栏「消息机器人」入口管理全部机器人（列表 / 新建 / 编辑 / 删除）

## 安装

```sh
dsh plugin --profile web add @dsh-agent-toolkit/project-bot
```

未发布 npm 时，本地安装用 `link:` 指向包路径（profile 的 dsh.profile.bundles 会列出本包并自动应用其 `cordis.patch.yml` 挂载）：

```sh
dsh plugin --profile web add link:path/to/packages/project-bot
```

## 配置 UI 使用说明

侧边栏底栏点「消息机器人」打开管理弹窗：

- **列表**：按绑定项目分组，每项显示名称 + 渠道标记（飞书）+ 运行状态（已连接/连接中/重连中/空闲/连接失败/未运行）
- **新建机器人**：填写名称、机器人 ID（小写字母/数字/连字符）、绑定项目（workspace 选择器）、提示词（persona）、可用工具白名单（默认全部）、Provider/模型（必选，Provider 下拉全量来自宿主注册 provider，默认选中第一项；模型随 Provider 级联，清单为空可手填，透传 agent 创建参数）
  - 绑定方式二选一（仅创建时）：
    - **扫码一键创建**：生成二维码 → 飞书扫码确认 → 自动回填 appId（secret 直入 credentials，不回显）
    - **手动填写**：填 appId + appSecret
- **编辑**：改名称/项目/提示词/工具/模型；飞书应用不可换绑（需删除后重建）
- **删除**：删除 bot 并回收凭据与在跑连接

## 飞书内指令

整条消息即指令时命中（带参数/前后文的按普通消息处理）：

| 指令 | 效果 |
|---|---|
| `/new` | 开启新会话（无旧上下文） |
| `/stop` | 取消当前进行中的任务 |
| `/status` | 查询绑定项目、会话 ID 与处理状态 |

群内消息须 @ 机器人才会响应；处理中再发消息会收到「上一条还在处理中」提示（v1 不排队）。

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `cardUpdateThrottleMs` | number（毫秒） | `500` | 卡片流式更新节流间隔 |
| `cardMaxBytes` | number（字节） | `28000` | 单张卡片内容字节上限（飞书硬上限 30KB，留余量） |
| `registerAppTimeoutMs` | number（毫秒） | `600000` | 扫码创建应用的轮询超时 |
| `processingReactionEmoji` | string（emoji_type） | `'OneSecond'` | 「处理中」表情回复的 emoji_type |

在 profile 的 `cordis.patch.yml` 中整行覆盖（同名 insert 行，config 与包内 `cordis.patch.yml` 合并）：

```yaml
- id: project-bot
  name: '@dsh-agent-toolkit/project-bot'
  config:
    cardUpdateThrottleMs: 300
```

bot 定义不写在 Config——bot 记录存 storage domain 表（UI 可写），appSecret 进 `ctx.credentials`。依赖 dsh 提供 `agents`、`credentials`、`storageDomain`、`tools` 服务（`@deepseek-ai/dsh-base` 均含）；`webServer` 为可选注入，headless/CLI 下不注册 HTTP 端点。

## 已知局限（v1）

- 无审批按钮等卡片交互回调（`card.action.trigger` 权限已预留，后续版本消费）
- 无消息排队：处理中再发消息直接提示，不排队
- 群内需 @ 机器人才响应（单聊无需）
- 工具调用过程不进卡片展示（仅 Web UI 可见）
