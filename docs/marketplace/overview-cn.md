### dsh-agent-toolkit

**一句话简介**：把 DeepSeek Harness 变成一个多 Agent 工作台——可视化 Agent 注册表、分层提示词、并行委派、飞书机器人、定时任务与 token 用量统计，合进一个插件。

### 它是什么

dsh-agent-toolkit 是 DeepSeek Harness（dsh）的单体插件，把五个围绕「Agent 团队」的生产力功能打包进一次安装：给 dsh 加上可复用的 Agent 名册、按模型自动适配的系统提示词、一键委派子 Agent 的能力、飞书渠道机器人、cron 定时任务，以及按日/按小时的 token 用量面板。所有界面收编在宿主设置面板的「Agent 工具箱」页，无侵入式融入 dsh web。

### 功能一览

**Agent 注册表** —— 在设置面板里用卡片流管理可复用角色：每个角色有自己的人设提示词（persona）、可选的模型覆盖和工具白名单（仅白名单语义，分 preset 工具与全局工具两组）。内置 `main` / `explorer`（只读探索）/ `general`（通用执行）三个角色，支持 YAML 首启导入与删除守卫（名下有 bot 时拒绝删除）。

![Agent 注册表卡片流](https://raw.githubusercontent.com/EsonXie/dsh-agent-toolkit/master/docs/usage/images/agents-cards.png)

**分层提示词** —— 系统提示词组织为固定四层：identity（原生身份段，可整份覆盖）→ 模型层（内置行为规范，按模型命中规则整体替换）→ persona（唯一自由编辑层）→ 动态层。同一份配置下，Claude、GPT、Kimi 等不同模型家族自动获得各自适配的提示词。

![分层提示词四层卡片](https://raw.githubusercontent.com/EsonXie/dsh-agent-toolkit/master/docs/usage/images/prompt-layers.png)

**并行委派** —— 主 Agent 通过 `team_delegate` 工具把任务派给名册角色：子 Agent 以前台一次性会话执行，携带角色的 persona/模型/工具白名单，禁止嵌套委派（maxDepth 1）；web UI 渲染实时委派卡，可一键查看子对话。

**飞书 bots** —— 把任意 Agent 绑定到飞书自建应用：扫码一键创建应用（OAuth 2.0 Device Authorization Grant，App Secret 只存宿主凭据服务），消息走长连接、回复以流式卡片实时更新；支持权限审批卡、忙时消息排队、撤回撤销，以及 `/new`、`/stop`、`/status`、`/sessions`、`/switch`、`/doc`、`/ls`、`/help` 全套运维指令。

![扫码一键创建飞书应用](https://raw.githubusercontent.com/EsonXie/dsh-agent-toolkit/master/docs/usage/images/bots-form-feishu.png)

**定时任务** —— cron 表达式 / 一次性时间 / 固定间隔三种调度，在独立新会话中执行提示词任务；停机漏跑可补跑，保留每任务最近 20 次运行历史并可跳转对应会话；表单内实时预览未来 3 次触发。

![定时任务行式列表](https://raw.githubusercontent.com/EsonXie/dsh-agent-toolkit/master/docs/usage/images/cron-list.png)

**Token 用量** —— 按日/按小时计量全部会话的 token 消耗：13 周活动热力图（点击跳单日）+ 趋势范围查询（单日按小时/多日按天堆叠图，按模型/按项目聚合，缓存命中单列），另有 `/token-usage` 命令与基于会话日志的 refresh 重建。也可独立安装 `@dsh-agent-toolkit/token-usage`（功能完全一致，二选一）。

![Token 用量活动热力图](https://raw.githubusercontent.com/EsonXie/dsh-agent-toolkit/master/docs/usage/images/usage-modal.png)

### 安装

```bash
# 完整套件
dsh plugin --profile <profile 名> add dsh-agent-toolkit

# 只要 token 用量
dsh plugin --profile <profile 名> add @dsh-agent-toolkit/token-usage
```

### 运行前提

- DeepSeek Harness 0.1.5-rc.1 及以上（已在 0.1.5-rc.x 全量验证）
- 管理界面与用量面板需要 `dsh web` 模式；飞书渠道与定时任务为 Node 半功能，headless 环境照常工作

### 链接

- GitHub：<https://github.com/EsonXie/dsh-agent-toolkit>
- npm（套件）：<https://www.npmjs.com/package/dsh-agent-toolkit>
- npm（用量独立包）：<https://www.npmjs.com/package/@dsh-agent-toolkit/token-usage>
- 使用手册：<https://github.com/EsonXie/dsh-agent-toolkit/tree/master/docs/usage>

License：MIT
