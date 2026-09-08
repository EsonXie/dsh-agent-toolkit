# 飞书侧审批卡片 + ask_user 处理设计

日期：2026-09-08
状态：已与需求方逐节确认

## 背景与问题

飞书 bot 会话里 Agent 工具触发提权（`approval` ask）时，申请只在 web 界面弹窗，飞书侧无任何反应，对话卡死。

根因（已对照宿主源码核实）：

- 权限申请是宿主 waterfall 事件 `approval/request`（`deepseek-harness/packages/interaction/user-approval/src/index.ts` L257-321）。web 的 api-proxy 注册了**全局** answerer（`deepseek-harness/packages/host/apiproxy/src/api-proxy.ts` L1391-1457），从不 `next()` 让出，飞书 bot 会话的 ask 也被它接走、只弹 web 窗。
- 飞书出站只订阅 `turn/start`、`assistant/chunk`、`tool/call`、`turn/end` 四类会话事件（`packages/toolkit/src/channels/outbound.ts` L80-142），审批事件完全被忽略。

同类问题还有 `ask_user_question` 工具（`user-questions` 服务），但挂接模型不同，见第 4 节。

## 决策记录（需求方已拍板）

1. 交互形态：**交互卡片按钮**（非指令回复、非"仅通知去 web"）。
2. 通道策略：**飞书独占**。飞书 bot 会话的 ask 只在飞书弹卡片，web 不再弹（曾讨论双通道竞速，因"飞书先点后 web 弹窗无法从外部撤销、刷新会重放"的瑕疵被否决——api-proxy 的 pending 表是模块私有的，宿主无取消 API）。
3. 审批人：**仅会话发起人**（群聊中比对点击者 open_id 与发起人 open_id）。
4. 超时：**不超时**，与宿主及 web 行为对齐；取消出口为会话终止类信号。
5. ask_user：**方向 1**——bot 会话工具面不含 ask_user，模型改用普通消息提问（详见第 4 节）。

## 第 1 节：总体架构与审批链路

新增模块 `packages/toolkit/src/channels/approval/`：

1. **answerer 注册**（`approval/index.ts`）：toolkit Node 半 `apply` 里
   `ctx.on('approval/request', handler, { prepend: true })`：
   - 用 `req.agent.session.id` 反查 channels router 的 `sessions` map（`channels/router.ts` L21），**不是**自有 bot 会话 → `return next()`（web/ACP 行为完全不变）；
   - 是自有会话 → mint `approvalKey`（`randomUUID()`），向该会话的 chat 发审批卡片，把
     `{ resolve, sessionId, chatId, 卡片消息id, req.signal }` 挂进 pending map，返回挂起 Promise；
   - 发卡失败（API 抛错）→ `return next()` 回退 web 弹窗，保证不吞审批。
2. **卡片回调接入**（`channels/feishu/index.ts`）：现有 `EventDispatcher`（L20-45）上多注册一个
   `card.action.trigger` handler，与消息事件同一条 WS 长连接，无需 webhook 服务器。
   回调体携带按钮 value（含 `approvalKey` + decision）与操作者 open_id，按 key 查 pending map 后 resolve。
3. **发起人人等校验**：`SessionRuntime`（`channels/ports.ts` L58-71）增加 `initiatorOpenId` 字段，
   `router.ensure/reset` 已收到的 `userId` 落入；回调时比对操作者 open_id。

链路：工具 ask → user-approval 服务 → waterfall → toolkit answerer（prepend，命中自有会话）
→ 飞书卡片挂起 ← 发起人点按钮（`card.action.trigger`）→ resolve → 服务落 `approval/decided`
→ 工具放行/拒绝。

先例对照：ACP 包（`deepseek-harness/packages/acp/acp/src/index.ts` L271）同为"全局注册 + 按自有会话过滤 + 非己方 `next()`"的非 web answerer，本设计照搬该过滤模式；差异在本设计必须 `prepend: true`——api-proxy 的 answerer 对全部 agent 生效且从不 `next()` 让出，不抢则飞书会话的 ask 永远轮不到 toolkit。

前提验证项：`card.action.trigger` 经长连接投递需要应用侧开启卡片回传订阅，真实环境（安装版 dsh + link 插件）跑一轮验证；单测层 fake 掉。

## 第 2 节：审批卡片交互细节

**卡片内容**（cardkit JSON 2.0，复用现有 `FeishuApi`（`channels/feishu/api.ts` L5-19），非流式一次性卡片）：

- 标题「权限申请」；正文 markdown：工具名（`req.toolName`）、申请理由（`req.reason`，可空）、所属 bot 名；
- 按钮组：`允许`（primary）/ `拒绝`（danger），
  `behaviors: [{ type: 'callback', value: { key: approvalKey, decision: 'allow' | 'reject' } }]`。

**回调处理**（`card.action.trigger` handler，3 秒窗口内只做同步操作）：

1. 按 `key` 查 pending map——查不到（重复点击/已取消/插件重载）→ toast「该申请已处理或已失效」；
2. 校验操作者 open_id === `rt.initiatorOpenId`——不符 → toast「仅会话发起人可审批」；
3. 命中 → 同步 resolve（`'allowed-once'` / `'rejected'`）、从 map 删除，**fire-and-forget**
   更新卡片为终态（「已允许 · {操作者}」/「已拒绝」），走现有 `withRetry` 通道。

**取消路径**：`req.signal` abort（会话 `/new`、`/stop`、插件卸载）→ resolve `'cancelled'` +
尽力把卡片标记为「已取消」；插件 dispose 时清空 pending map（全部 settle `'cancelled'`，防 Promise 泄漏）。

**配置开关**（进 Config schema，不硬编码）：`feishu.approval: boolean`，默认 `true`；
关闭时 answerer 不注册，行为回到现状（web 弹窗）。

**应用注册**：`FEISHU_REGISTER_APP_ADDONS.events.items.tenant`（`bots/register-app.ts` L16-18）
补卡片回调事件声明（事件名以 `@larksuiteoapi/node-sdk` 1.7.x 类型为准，SDK 类型中已有
`'card.action.trigger'` 回调支持）；存量已创建的应用需在开发者后台补开卡片回传订阅，使用手册补说明。

## 第 3 节：错误处理与并发

- 发卡失败 → `return next()` 回退 web 通道（不吞审批）；回调解析异常 → fail-closed 不 resolve；
- 并发多次 ask：pending map 按 key 各自独立，无全局锁；同一 turn 并行工具 ask 各自发卡；
- 回调 3 秒窗口：resolve 与 map 操作同步完成；卡片更新 fire-and-forget，不在回调里等 API。

## 第 4 节：ask_user 处理（方向 1）

机制约束（已核实）：`user-questions` 是**单 provider** 模型（`registerProvider` 重复注册抛
`DUPLICATE_PROVIDER`，`deepseek-harness/packages/interaction/user-questions/src/index.ts` L64-75），
provider 被 web api-proxy 独占注册（`api-proxy.ts` L1338），服务内无按会话路由。
飞书侧无法像审批那样接管，除非改宿主源码（违反本仓"deepseek-harness 只读"约束）。

落地内容：

- **现状即目标态**：`agent-bot` preset 从 `BASIC_TOOLS` 序列化（`channels/basic-tools.ts` L16-33：
  persona/instructions/shell/fs/fs-search 五行），本就不含 `tool-ask-user`；
  两种 bot 形态（绑 main / 绑角色）都经 `setupAgentScope`（`channels/agent-setup.ts` L23）走同一
  joiner 挂 agent-bot 面；角色白名单与会话可见面求交也无法把 ask_user 加进来；
  委派子会话继承同一父链，且宿主 `DELEGATED_CALLER` 本就禁止子 Agent 提问。
- **守护测试**：断言 agent-bot preset 序列化结果与 bot 会话可见面**不含** `ask_user_question`，
  防未来 BASIC_TOOLS 或宿主 standard preset 变化时无意引入（standard preset 确实含
  `tool-ask-user`，`deepseek-harness/apps/cli/config/agent-presets/standard/agent.cordis.yml` L238）。
- **引导文案**：在 agent-bot preset 的 persona 行末尾补一句（语义：需要用户信息或决策时直接在回复里问），
  具体措辞实现时定，进快照测试。IM 场景下普通消息往返即最自然的提问形态。

## 测试计划

vitest + fake `FeishuApi` / fake lark dispatcher（沿用现有测试形态）：

1. answerer 过滤：自有 bot 会话发卡挂起；非自有会话 `next()` 透传；
2. 回调三路：正常 resolve（allow/reject）、越权 toast 不 resolve、失效 key toast；
3. abort 清理：signal abort → resolve `'cancelled'` + pending map 清空；dispose 清空；
4. 发卡失败回退 `next()`；
5. 守护：agent-bot preset / bot 会话可见面不含 ask_user；
6. HMR 安全：卸载后 `card.action.trigger` handler 与 answerer 均移除（cordis 自动清理 + effect disposer）。

真实环境验证（发版前 parity 回路）：安装版 dsh + link 插件，建 bot → 触发提权工具 →
飞书点允许/拒绝 → `/new` 取消路径 → 群聊越权点击。
