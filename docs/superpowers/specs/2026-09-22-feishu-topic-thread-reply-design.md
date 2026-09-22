# 飞书话题群：话题内回复 + 按话题隔离会话 — 设计 spec

日期：2026-09-22
状态：已裁定（用户四条裁定见 §2），待实施
工作分支：`feat/feishu-topic-reply`（从 master 切出，worktree `.worktrees/feishu-topic-reply`）

## 1. 背景与根因

**问题**：在飞书话题群（chat_mode=topic）的话题中 @ 机器人，机器人的回复不在该话题内，而是新开一个话题。

**根因**（三层证据链，2026-09-22 定位）：

1. 入站解析丢弃话题维度：`parseMessageEvent`（`src/channels/feishu/parse.ts`）只取 `message_id/chat_id`，事件中的 `thread_id`（话题群消息必带）未进 `ParsedMessage`。
2. 出站只会「往群里发新消息」：`FeishuApi` 的 `sendCardMessage`/`sendText`/`sendFile`（`src/channels/feishu/api.ts`）全部走 `im.message.create`（`receive_id_type: chat_id`）。话题群语义下 chat 级 create = 开新话题；话题内回复须用 `im.message.reply`（`POST /im/v1/messages/{message_id}/reply`）。
3. 路由/绑定以 `(botId, chatId)` 为最小寻址单位（`src/channels/router.ts`、`bots/store.ts` `bindingKey`），话题维度从未建模；`FeishuReplyHandle` 只持有 chatId，连回复锚点都无从谈起。

## 2. 裁定（用户四条，全部纳入本次范围）

1. 话题群 @ 机器人时**不创建新话题**，回复落在被 @ 的话题内。
2. **审批卡 / 问答卡一并修复**（同一锚点机制，不再是 turn 卡片独占）。
3. **会话按话题键控**：`(botId, chatId, threadId)`，同一话题群的不同话题不共享 session。
4. **sender 提示段区分会话形态**：单聊 / 群聊 / 话题三种文案。

## 3. 设计

### 3.1 threadId：话题判别器 + 路由键第三元

- `im.message.receive_v1` 事件的 `message.thread_id`（`omt_xxx`）只在话题群消息上出现；普通群/单聊缺席。`ParsedMessage` 新增 `threadId?: string`，`InboundMessage` 同步新增 `threadId?: string` 与 `chatType: 'p2p' | 'group'`（后者为裁定 4 文案与兼容判定所需，parse 已解析但此前未透传）。
- 路由键第三元：**有 threadId = 话题；缺席 = 普通群/单聊，全部行为与现状逐字节一致**（含绑定 key 形态不变，见 §3.4）。

### 3.2 出站锚点：im.message.reply

- `FeishuApi` 三个出站方法加可选锚点参数（第三参 `replyToMessageId?: string`）：有锚点走 `client.im.message.reply({ path: { message_id }, data: { msg_type, content } })`，无锚点维持 `im.message.create` 现状。
- 锚点来源：每条入站消息的 `messageId`。话题群消息（threadId 存在）时锚点=该消息；非话题不传锚点。
- `FeishuReplyHandle` 构造新增锚点参数，句柄内全部出站（卡片 send op、notice、sendFile、ABANDON_NOTICE、finalize detail 降级文本）经同一锚点。reply 句柄每条入站消息新建（`feishu/index.ts` handler 内），锚点天然指向最新消息；turn 中途 in-flight 准入后的 reply 刷新机制不变，锚点随之更新。
- 锚定回复的消息与被 @ 消息同属一个话题，即满足裁定 1。

### 3.3 审批卡 / 问答卡锚点（裁定 2）

- `SessionRuntime` 新增 `replyAnchor?: string`（mutable；`Inbound.dispatch` 准入通过后写入当前消息 messageId）。
- `ApprovalPrompt` / `QuestionPrompt` 新增 `replyToMessageId?: string`；两个 center 发卡时从 `rt.replyAnchor` 取——即「当前 turn 触发消息」，与裁定一致；presenter（`approval/feishu.ts`、`questions/feishu.ts`）的 present 走同一锚点参数。
- 卡片回调路由（审批 key / 问答 kind+key）不感知话题，无需改。

### 3.4 会话按话题键控（裁定 3）

- `bindingKey(botId, chatId, threadId?)`：threadId 存在 → `${botId}:${chatId}:${threadId}`；缺席 → `${botId}:${chatId}`（**存量绑定 key 形态不变，非话题群零迁移**）。`project_bot` domain 表结构（`BindingSchema { sessionId }`）不变，key 是纯字符串，无需 domain 版本升级。`deleteBot` 的 `${botId}:` 前缀扫描天然覆盖话题键。
- `BindingStore` 端口与 `Router` 全方法（ensure/reset/lookup/boundSessionId/switchTo/releaseUnbound/adopt）加 threadId 参数；`SessionRuntime` 加 `readonly threadId?: string`。
- `Inbound` 全部 per-chat 键升级为 per-route 键（`${botId}:${chatId}:${threadId ?? ''}`，由 helper 统一生成）：排队队列、`/sessions` 序号缓存 lastLists、`consumeAnswer` 透传、`drain`、followup 回滚排水。效果：话题 A 执行中，话题 B 消息进 B 自己的队列（独立 session 独立排队），互不阻塞。
- **撤回撤销排队**（`revokeQueued`）：撤回事件解析不引入 thread_id——messageId 全局唯一，改为按 `${botId}:${chatId}:` 前缀扫描该 chat 全部话题队列匹配 messageId。简单且对事件字段零依赖。
- `/new`、`/stop`、`/status`、`/sessions`、`/switch` 全部作用于当前话题的绑定；`/switch` 候选列表仍是 bot 项目 workspace 全量（含其他话题绑定的会话），本期不限制跨话题切换（现状「跨 chat 切换同一会话」已知限制的自然延伸，域文档注明）。
- **问答卡开放题文本拦截**（`QuestionCenter.tryConsumeText`）：加 threadId 匹配（经 rt.threadId 比对），否则 A 话题的纯文本会被 B 话题 pending 的问答卡吃掉。

### 3.5 sender 段三形态文案（裁定 4）

`senderSectionText(channel, userId)` → `senderSectionText(channel, userId, chatKind)`，`chatKind: 'p2p' | 'group' | 'topic'`（来源：`msg.threadId !== undefined ? 'topic' : msg.chatType`，经 `Router.ensure/reset/switchTo` 传入 `resolveSession`/`withChannelSections`）：

- p2p：现文案不变（「单聊会话」）。
- group：「本会话由 {channel} 渠道的群聊会话发起。发起人 ID（{channel} open_id）：`{userId}`。」
- topic：「本会话由 {channel} 渠道话题群的一个话题发起。该话题绑定独立会话，同一话题群的其他话题互不共享会话。发起人 ID（{channel} open_id）：`{userId}`。」

guidance 段不变（恒注入，语义与形态无关）。

## 4. 兼容性

- 非话题（单聊/普通群）：threadId 缺席 → 绑定 key、路由、队列键、出站 API、sender 文案全部与现状一致；存量绑定照常命中。
- 话题群存量绑定（`bot:chat` 形态）成为无害孤儿：话题消息永远带 thread_id，旧键不再被命中，不删除不迁移。
- `im.message.reply` 与 create 同属 `im:message` 权限域，扫码建应用的权限预设已覆盖，无新增权限。
- 定时任务（schedule executor）不经飞书渠道建会话，不受影响；委派卡为 client 侧组件，不涉及。

## 5. 风险与验证

1. **thread_id 字段名以真实事件为准**：实施第一步用 debug-log（`feishu/debug-log.ts` 装配）在真实话题群抓一条原始事件确认 `message.thread_id` 字段存在且形态为 `omt_*`，再落解析代码。
2. **reply 锚点消息被撤回/删除**：飞书侧 reply 已删除消息的行为以平台为准（预期报错，走既有重试/日志路径）；表情 ack 与被撤回消息的既有语义不变。
3. **话题群内 in-flight 竞态**：两个话题并发各自建 session，binding 写库互不冲突（键不同）；同一话题内并发维持单 in-flight 语义不变。

## 6. 发布

- 独立发布：从 master 切 `feat/feishu-topic-reply`，只含本变更；`dsh-agent-toolkit` minor bump（0.4.5 → 0.4.6 起评）。
- 与 `feat/issue-flow` 的关系：文件级重叠仅 `channel.ts` / `feishu/index.ts` 的不同 hunk（issue-flow 加 CardSender 区块），语义无耦合；本变更先合入，issue-flow rebase 解形式冲突。
- 门禁：两包 test + typecheck + bundle 全绿；真实宿主人工验收（话题群建 bot → 话题内 @ → 回复落在话题内 → /new → 审批卡落话题内 → 双话题并行不串会话）。
- 完成后：本 spec 与 plan 归 archive，`docs/domains/feishu.md` 改写对应段落（路由键、队列粒度、审批/问答卡锚点、sender 三形态、跨话题切换语义），`docs/domains/releases.md` 追加发布记录。
