# 飞书 bot 会话工具面对齐 web 端 — 设计

> 状态：已实施。本文是实施期权威设计；完成并发布后移入 `specs/archive/`，现行事实并入 `docs/domains/{agents,feishu,delegation}.md`。

## 背景与目标

飞书 bot 会话统一挂 toolkit 生成的最小 preset `agent-bot`（`BASIC_TOOLS` 5 行：persona / agent-instructions / shell / fs / fs-search），与 web 端会话（`standard` / `agent-team` preset）相比缺 tool-jobs、tool-web、tool-todo、tool-skill、tool-goal、plan-mode、compaction、workflow、ralph、present、cron_* 等——且角色白名单只能与该最小面求交，名册里选了不存在的工具被 warn-drop，「在 Agents 面板配工具」的设计意图落空。

当年（`archive/2026-09-07-bot-delegation-preset-mount-design.md`）拒绝挂 agent-team 的唯一实质理由是「ask_user 等工具在飞书渠道语义不明」。本设计新增飞书 user-questions 应答端消灭该理由，随后统一底面。

**目标**：飞书 bot 会话的模型工具面与 web 端挂 `agent-team` 的用户完全一致；收窄机制只剩 Agents 面板角色白名单一种。

**非目标**：审批通道（飞书审批卡片 vs web 审批 UI 是交互通道差异，不动）；web 端 UI；`/switch` 接管 web 存活会话的「保持原装配」语义。

## 决策汇总（已与用户确认）

1. **统一底面**：所有 bot 会话（主 Agent 形态 + 角色形态）挂 `agent-team` preset；丢弃 `agent-bot` preset。
2. **参照面** = `agent-team`（standard − subagent 族 4 行；委派统一走 `team_delegate`）。
3. **ask_user**：做飞书 user-questions 应答端（方案 C），同时打通 `ask_user_question` 与 plan-mode 评审（`exit_plan_mode` 走同一 `userQuestions.ask` 通道）。
4. **cron_\***：bot 聊天会话对齐 web 主会话（可建/管定时任务）；cron 执行会话仍排除（防任务递归建任务）。
5. 问答卡片作答完成后定格为只读（仅保留问题 + 所选答案），后续输出开新卡续接。

## §1 统一底面：bot 会话挂 agent-team

- `createScopeJoiner`（`channels/scope-joiner.ts`）的 preset id 来源从 `agentTeamPreset.botsId` 改为 `agentTeamPreset.id`（agent-team）。主/角色形态不再分流 preset。
- **删除** `agent-bot`：`agents/bot-preset.ts` 及测试、`agentTeamPreset.botsId` 配置项、`team-preset.ts` 的 agent-bot 生成块；`setupBots` 的 `botPresetId` 依赖改名/改源（`bots/index.ts`、`schedule/index.ts` 共用该 joiner 栈，schedule 执行会话同样改挂 agent-team）。
- **存量清理**：preset roots 下带 `.generated-by: dsh-agent-toolkit` 标记的 `agent-bot/` 目录，启动时删除；无标记的用户同名目录不动（warn 跳过）。
- **回退路径保留**：preset mount 失败仍 warn 回退 `BASIC_TOOLS` standing scope（`tool-scope.ts` 不动），此时降级为最小面，日志可见。
- **IM 引导句搬家**：`BASIC_TOOLS` persona prefix 里的「If you need information or a decision from the user, ask directly in your reply…」句抽出，改为渠道段注入（`hooks.sections`，与 sender 段同机制，所有 bot 会话都带）；`BASIC_TOOLS` persona 行回落为与 standard 同源。这样角色白名单收窄掉 ask_user 时引导句依然在，且 fallback 面下也成立。
- **白名单求交底面变化**：`agent-setup.ts` / `delegate/tool.ts` 的求交逻辑不变，底面从 agent-bot 面变为 agent-team 面——角色「不限制」时行为变宽（完整面），名册里所有工具真正可选。
- **委派子会话**：`composeFrom` 认父继承面自动变为 agent-team 面，与 web 端 team_delegate 行为一致，零额外代码。
- **存量会话**：活跃内存会话不翻转装配；新会话与冷 resume 按新规则；`/switch` 接管 web 存活会话保持原装配（现状语义不变）。

## §2 cron_* 门控调整

- 现状：`ownedSessions`（`index.ts` 创建，bots 与 schedule 执行器共用登记）一刀切排除所有插件自有会话。
- 调整：**bots 侧停止记入排除集**；schedule 执行器继续登记（集合改名 `cronExcludedSessions`，仅 `setupCronTools` 消费）。
- 结果：飞书 bot 聊天会话与 web 主会话一样获得 `cron_task_create/list/update/delete/trigger`；cron 执行会话、subagent 仍排除（原有 `origin === 'subagent'` 判断不动）。
- 宿主 schedule 互斥探测（schedule_create 并存警告）逻辑不变。

## §3 飞书 user-questions 应答端

镜像 `channels/approval/` 的「渠道无关核心 + 飞书 presenter」架构，新增 `channels/questions/`。

### 3.1 接线（answerer）

`ctx.on('user-questions/request', …, { prepend: true })` 注册 answerer：按 `sessions` map 过滤——自有 bot 会话进 `QuestionCenter`，非自有 `next()` 透传（web 会话照常走浏览器 UI）。与审批 answerer 事件名不同，互不冲突。开关 `feishu.questions`（默认 true，对齐 `feishu.approval` 先例）。

### 3.2 QuestionCenter（渠道无关核心）

- `pending: Map<key, PendingQuestionSet>`：一次 `ask`（可含多问题）挂起为一个 key；**全部问题收齐才 resolve `answers[]`**。
- abort / 会话终结 / dispose → 以 `UserQuestionError` reject——signal abort / 会话终结 → `ASK_ABORTED`（宿主与 plan-mode 消费者依赖），显式取消（取消按钮）/ `dispose()` → `ASK_CANCELLED`；plan-mode 的 catch 依赖该错误类型把「用户取消评审」翻译成「留在计划模式等消息」，不得返回普通值。
- **仅发起人可答**（`initiatorOpenId` 比对，按钮与文本答案同规则）。
- 并发：多 key 并存（同审批）；**文本应答**只归属该 chat 最早未完结且含开放问题的 key。
- 不超时（与审批一致）。
- settle 时经 `rt.reply.breakCard?.()` 触发输出续接（见 3.4）。

### 3.3 飞书 presenter（卡片渲染）

一次 ask 渲染为一张**独立互动卡**（不进 turn 流式卡序列，位于当前流式卡下方）：

- **带 options 的问题** → 按钮组。单选点击即答；`multi_select` 按钮切换勾选态 + 「确认」按钮提交（勾选态由服务端整卡重渲染维护，飞书按钮无客户端状态）。
- **开放问题（无 options）** → 卡片列出问题并提示「请直接回复消息作答」。**inbound 拦截**：该 chat 有 pending 开放问题时，发起人的下一条文本消息被 QuestionCenter 截获为答案——不进排队队列、不触发新 turn（拦截点在排队逻辑之前）；非发起人消息不拦截。
- **plan-review intent**（`exit_plan_mode`）：`detail`（完整 plan markdown）渲染进卡片正文，受 `cardMaxBytes` 治理，超长截断并标注「完整计划见会话」；按钮 = approve / keep-planning 两个 label——普通带 options 问题 + detail 渲染，无特殊分支。
- **作答中更新**：每次按钮回调后整卡重放——已答问题转只读行（问题 + 已选答案），未答问题保留按钮。
- **finalize 定格**：全部收齐或取消 → 整卡替换为只读终态，仅保留每题「问题 + 所选答案/回复文本」，按钮全部移除；取消的题标注「已取消」。
- **滞留点击**：pending 条目已摘除后的回调返回 toast「该问题已作答或已失效」（审批卡同款兜底）。
- **回调路由**：`card.action.trigger` 共用 dispatcher，按按钮 value 的 `kind` 字段区分 approval / question；无 `kind` 视为 approval（存量兼容）。

### 3.4 输出续接（breakCard）

settle 时通知 reply 句柄续接：

- 当前流式卡关流定格（纯定格，**不**追加「已接续到下一张卡片」状态行——那是超长拆卡语义）；
- 后续 chunk 开新流式卡继续打字机（位于问答卡下方，时间线：输出 → 问答卡 → 定格问答卡 → 新卡继续输出）；
- ask 前 turn 无产出（无流式卡）时 break 是空操作，后续输出直接开首卡；
- `ReplyHandle` 接口加 `breakCard?()` 可选方法，测试 fake 与其他渠道默认无操作。

### 3.5 降级

- 发卡失败 → `next()` 回退（最终 NO_PROVIDER 错误回模型，模型退回文字提问；IM 引导句兜底）。
- `userQuestions` 服务缺席的旧宿主：ask/plan-mode 行由宿主 preset mount 决定，toolkit 只负责应答端，不额外门控。
- 问答 pending 期间 turn 仍占 in-flight 槽；他人消息照常排队；仅「开放问题的发起人作答消息」被拦截。

## §4 清理与兼容

- **守护测试改写**：「bot 会话工具面不含 ask_user」→「含 ask_user_question 且飞书应答端在场」。
- **文档同步**：`docs/domains/agents.md`（会话工具面段、内置 preset 段删 agent-bot）、`docs/domains/feishu.md`（新增问答卡小节）、`docs/domains/delegation.md`（子会话继承面表述）；`AGENTS.md` 功能域清单不变。
- **配置迁移**：`agentTeamPreset.botsId` 从 Config schema 删除（Schemastery 对多余键宽容，存量 cordis.yml 含该键不炸）。

## 测试策略

照 `channels/approval/` 测试结构：

- `questions/center.test.ts`：fake presenter 单测——多问题收齐 resolve、abort/取消 reject 错误类型、仅发起人、并发 key、文本答案归属最早 pending、dispose 全取消。
- `questions/feishu.test.ts`：卡片 JSON 构建（按钮组/multi_select/plan detail 截断/finalize 只读终态）快照。
- inbound 拦截测试：pending 时发起人文本被截获（不进队列不起 turn）、非发起人不拦截、无 pending 走正常流程。
- `breakCard`：reply 句柄单测（有卡定格开新卡 / 无卡空操作）。
- 接线测试：answerer 自有会话进 center、非自有 next 透传；与 approval answerer 共存。
- §1/§2：joiner 挂 agent-team、agent-bot 目录清理（有标记删/无标记留）、cron 门控（bot 会话获得 cron_*、执行会话仍排除）、守护测试改写。
- 全量回归：`pnpm --filter dsh-agent-toolkit test` + `typecheck` + `bundle`。
