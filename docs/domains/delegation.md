# 委派（现行事实）

> 本文是该功能域**现行状态**的权威描述（2026-09-10 自 AGENTS.md 拆出）；改动该域时同步本文。「为什么这样设计」的决策考古见 `docs/superpowers/specs/archive/`。

## 路由持久化与子会话 chip

委派路由持久域 `dsh_agent_toolkit_routes`（表 `routes`，key=childSessionId），schema 单一来源在 `src/delegate/routes.ts`；子会话头部 chip 经 `GET /dsh-agent-toolkit/api/delegate/route` 读取。

## team_delegate 与名册段

委派走 `team_delegate`（一次性），浏览器半渲染委派卡（含 `provider / model` chip：运行中读在途端点、结束后读 presentationMeta）；团队名册段（delegate/index.ts `teamSectionText`）按 `tools.get(name, scope)` 联动工具可见性——白名单 restrict 掉委派工具或 provider 未挂载的会话不再出现委派段落（restrict 只作用 tools 视图，管不到 systemPrompt sections，须段落自查）。
