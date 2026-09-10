# Agent 注册表、工具白名单与会话工具面（现行事实）

> 本文是该功能域**现行状态**的权威描述（2026-09-10 自 AGENTS.md 拆出）；改动该域时同步本文。「为什么这样设计」的决策考古见 `docs/superpowers/specs/archive/`。

## 注册表与存储

Agent 注册表：UI 管理（Agents 面板，创建/编辑/删除）+ YAML 首启导入（`roles_yaml_imported` 一次性标记）；存储域 `dsh_agent_toolkit`（表 `agents` + `meta`），schema 与 domain 布局的单一来源在 `src/agents/store.ts`。内置 explorer 默认携带只读白名单 10 个（旧 5 个派生 + web_search/todo_write/job_list/job_output/skill），general 默认显式 preset 面 20 个（不含 team_delegate/run_code），存量仍是旧默认值的 builtin 记录经 meta 标记 `builtin_tools_recatalog_migrated` 一次性条件迁移（用户改过的跳过）；Agents 面板工具区块为「不限制 / 自定义白名单」radio 二选一（不限制 = 省略 tools 字段），deny 语义不存在。

## 工具名册与白名单求交

`/tools` 名册 = 动态枚举 agent-team standing 面（`agents/tool-catalog.ts`，agentPresets 缺席/枚举失败回退 `NATIVE_TOOL_NAMES` 兜底）；存量自定义白名单一次性并入「preset 面 − 内置常量」差集（`meta` 表 `tools_preset_catalog_migrated` 标记，幂等；内置角色不 widen，枚举失败下次启动重试）；bot 会话与委派两条路径加载角色白名单时均与会话可见面求交、未知名 warn-drop、空交集抛错（`channels/agent-setup.ts` / `delegate/tool.ts`，不再抛 unknown global tools）。

## 内置 preset 自动生成

启动时自动生成/刷新用户 preset `agent-team`（派生 shipped standard、文本级禁用 subagent 工具族 4 行，写入首个 trust=user root；`.generated-by` 标记保护用户同名目录；`agentPresets` 为可选服务经 ctx.get 读取，缺席静默跳过）与 `agent-bot`（bot 会话最小 preset，composition 从 `BASIC_TOOLS` 序列化，id 由 `agentTeamPreset.botsId` 配置），实现与测试在 `src/agents/team-preset.ts`（bot 序列化在 `src/agents/bot-preset.ts`）。

## 会话创建与工具面（setup / scope / restrict）

内存 setup 建会话：`ctx.agents.create` + `setup` 建实时 agent；基础工具行（persona/instructions/shell/fs/fs-search）由 `tool-scope.ts` 的 standing scope 一次性挂载（祖先 scope 层），`setupAgentScope` 在 setup 里 join（`bindScopeParent`）后叠 persona/tools 白名单。bot 会话例外（preset 优先 joiner，`scope-joiner.ts` `createScopeJoiner`）：`agent-bot` preset（`agentTeamPreset.botsId`，默认 'agent-bot'，启动时与 agent-team 同处生成于 `team-preset.ts`）mount 成功即挂、失败 warn 回退 bots-tools standing scope；preset standing mount 父链让宿主 `composeFrom` 认父，bot 会话委派子会话继承同一基础工具行。**restrict 只能过滤继承面（global + 祖先 scope 层），own 层（agentCtx 直挂）的名字既不可 restrict 也不受 restrict 影响**——直挂后 restrict 白名单会抛 unknown global tools（2026-09-03 第二起"fake 单测掩盖宿主语义"事故，第一起是未声明包的 tsx 兜底）。
