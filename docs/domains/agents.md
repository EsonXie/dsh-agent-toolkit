# Agent 注册表、工具白名单与会话工具面（现行事实）

> 本文是该功能域**现行状态**的权威描述（2026-09-10 自 AGENTS.md 拆出）；改动该域时同步本文。「为什么这样设计」的决策考古见 `docs/superpowers/specs/archive/`。

## 注册表与存储

Agent 注册表：UI 管理（**设置面板 → Agent 工具箱 → Agents**，创建/编辑/删除，编辑/新建内联展开）+ YAML 首启导入（`roles_yaml_imported` 一次性标记）；存储域 `dsh_agent_toolkit`（表 `agents` + `meta`），schema 与 domain 布局的单一来源在 `src/agents/store.ts`。卡片流按 `createdAt` 升序渲染（服务端排序：main 恒置顶只读、无编辑/删除按钮；内置卡带「内置」徽标且不渲染删除按钮；存量缺时间戳记录经 `agents_timestamps_backfilled` 一次性按 id 序回填）；删除名下有 Bot 的角色返回 409 `{ error, bots }`（前端提示 Bot 数量），保存/删除成功 toast（已知收窄：设计稿的「离开编辑区前二次确认未保存修改」未实现，2026-09-17 计划有意收窄，用户确认记录不实现）。内置 explorer 默认携带只读白名单 10 个（旧 5 个派生 + web_search/todo_write/job_list/job_output/skill），general 默认显式 preset 面 20 个（不含 team_delegate/run_code），存量仍是旧默认值的 builtin 记录经 meta 标记 `builtin_tools_recatalog_migrated` 一次性条件迁移（用户改过的跳过）；Agents 页工具区块为「不限制 / 自定义白名单」radio 二选一（不限制 = 省略 tools 字段），deny 语义不存在。飞书 Bot 列表也并入本页各 Agent 卡片（见 [feishu.md](feishu.md)）。

## 工具名册与白名单求交

`/tools` 名册 = 动态枚举 agent-team standing 面（`agents/tool-catalog.ts`，agentPresets 缺席/枚举失败回退 `NATIVE_TOOL_NAMES` 兜底）；存量自定义白名单一次性并入「preset 面 − 内置常量」差集（`meta` 表 `tools_preset_catalog_migrated` 标记，幂等；内置角色不 widen，枚举失败下次启动重试）；bot 会话与委派两条路径加载角色白名单时均与会话可见面求交、未知名 warn-drop、空交集抛错（`channels/agent-setup.ts` / `delegate/tool.ts`，不再抛 unknown global tools）。

## 内置 preset 自动生成

启动时经宿主 registry 声明式注册 preset `agent-team`（dsh 0.1.7 起文件根扫描协议删除，preset 全走 registry）：`agentPresets.readDocument(source)` 读源 preset composition（Loader 方言 plugins 列表 YAML 文本）→ `disableSubagentRows` 文本级禁用 subagent 工具族 4 行（整行锚点精确匹配防前缀误中，块内已有 `disabled:` 则跳过，幂等）→ `js-yaml` 以 `entryListSchema`（`@deepseek-ai/cordis-plugin-include`，`!!js` 解析为 JsExpr）解析回 entry list → `agentPresets.register({ id, name, description, plugins })` 声明注册，注册生命周期接 `ctx.effect`（插件卸载/HMR 重组时宿主自动注销，无文件残留；0.1.5 时代的写入首个 trust=user root、`.generated-by` 标记目录保护与 `agent-bot` legacy 清理已随之删除）。`agentPresets` 为可选服务经 ctx.get 读取，缺席静默跳过（无 subagent/team_delegate 竞争问题）；id 非法、读源失败、解析失败均 warn 降级跳过，不影响插件其余功能。实现与测试在 `src/agents/team-preset.ts`。

## 会话创建与工具面（setup / scope / restrict）

内存 setup 建会话：`ctx.agents.create` + `setup` 建实时 agent；基础工具行（persona/instructions/shell/fs/fs-search）由 `tool-scope.ts` 的 standing scope 一次性挂载（祖先 scope 层），`setupAgentScope` 在 setup 里 join（`bindScopeParent`）后叠 persona/tools 白名单。bot 会话例外（preset 优先 joiner，`scope-joiner.ts` `createScopeJoiner`）：挂 `agent-team` preset（`agentTeamPreset.id`；`enabled: false` 时不下达 id、直接走 standing scope）mount 成功即挂、失败 warn 回退 `BASIC_TOOLS` standing scope；preset standing mount 父链让宿主 `composeFrom` 认父，bot 会话委派子会话继承同一 agent-team 工具面（角色白名单求交底面随 preset 从 bot 最小面变为 agent-team 面，`agent-setup.ts` / `delegate/tool.ts` 逻辑不变、「不限制」时行为变宽）。**restrict 只能过滤继承面（global + 祖先 scope 层），own 层（agentCtx 直挂）的名字既不可 restrict 也不受 restrict 影响**——直挂后 restrict 白名单会抛 unknown global tools（2026-09-03 第二起"fake 单测掩盖宿主语义"事故，第一起是未声明包的 tsx 兜底）。
