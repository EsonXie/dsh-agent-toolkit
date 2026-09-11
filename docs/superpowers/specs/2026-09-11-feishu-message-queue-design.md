# 飞书消息排队与撤回撤销 — 设计

> 2026-09-11。需求：任务执行中再发消息应排队（而非拒绝），当前轮完成后立即执行下一条；排队消息可经飞书「撤回原消息」撤销；`/status` 展示排队消息前若干文字。

## 需求定案（澄清结论）

1. 任务执行中（`rt.inflight` 非空）新到的非指令消息**排队**，不再拒绝；队列**不限容量**。
2. 当前 turn 完成后**立即**执行队首消息（无需用户再操作）。
3. 撤销方式 = **撤回飞书原消息**（`im.message.recalled_v1` 事件）；仅对**排队中**的消息生效，撤回正在执行的消息**忽略，任务继续**。
4. `/stop` 只停当前任务，**不清队列**（turn/end 后队列自动续上）。
5. `/new` **不清队列**：队列属于 chat 而非会话，新会话建好后排队消息继续执行。
6. 入队即时反馈 = **notice 文字确认**（含队位序号）。
7. `/status` **全部列出**排队消息，每条取**前 20 字**。

## 现状事实（改造前）

- 准入拒绝点：`packages/toolkit/src/channels/inbound.ts:93-97`（`rt.inflight !== undefined` → notice「上一条还在处理中」并丢弃）。
- inflight 释放点共三处：`turn/end`（`outbound.ts:179-181`，在 `rt.tail` 链任务内）、`agent/error`（`outbound.ts:231-233`）、followup 抛错回滚（`inbound.ts:126-130`）。
- `InboundMessage` 已携带 `messageId`（`channel.ts:36`），图片经 `loadImages` lazy 下载。
- `/new`：`router.reset` 退休旧 runtime（`router.ts:96-117`）后 `ensure` 建新 runtime——**runtime 会被整体替换**。
- `/switch`：切走的旧 runtime 不 retire，在飞卡片照常收尾（`router.ts:166-169`）。
- `/status` 现状输出：`inbound.ts:73-79`（项目/会话/状态三行）。
- 飞书事件注册：`feishu/index.ts:26-43`（`im.message.receive_v1`）+ 卡片回调（:45-50）。

## 方案（已定案：chat 级队列 + Inbound 持有 + Outbound 空闲回调排水）

对比过的备选：队列挂 SessionRuntime（`/new` 需迁移、`/switch` 语义错误，否决）；独立 Queue 模块（过度设计，否决）。

## 设计

### 队列归属与条目

- 队列存于 **Inbound**：`Map<string, InboundMessage[]>`，键 `${botId}:${chatId}`（与 `lastLists` 同款 per-chat 内存态，进程重启即丢）。
- 条目直接存 `InboundMessage`（自带 `messageId`/`reply`/`ackProcessing`/`loadImages`，无需新类型）。
- 队列是 **chat 级**而非 session 级：用户排队意图针对对话窗口，`/new` 换 runtime、`/switch` 换绑定时队列均不动。

### 入队与即时反馈

`handle` 中 `router.ensure` 后的忙时分支改为：

- 入队（push 到该 chat 队列尾部）→ `msg.reply.notice('已排队（第 N 位），撤回原消息可取消执行')`（N = 入队后队列长度）。
- **不**加处理中表情、**不**下载图片（`loadImages` 保持 lazy，执行时才调）。

### dispatch 重构与排水

- 把 `handle` 准入通过后的执行段（占槽 → `rt.reply = msg.reply` → `ackProcessing` → 图片 → `createUserMessage` → `followup`，`inbound.ts:98-131`）抽为 `private async dispatch(rt, msg)`；直接执行与排水共用同一函数。
- Outbound 构造函数新增可选回调 `onTurnIdle?(rt: SessionRuntime): void`：
  - 调用点：`turn/end` 释放段（outbound.ts:179-181）与 `handleAgentError` 释放段（:231-233）。
  - **时序约束（防双发）**：在 enqueue 任务内先**同步**完成占槽转移（`onTurnIdle` 同步触发 drain：shift 队首 → 设 `rt.inflight`/`rt.reply` → fire-and-forget `dispatch`），再 `await ack()`。保证「inflight 空 ⇒ 队列空」不变量无并发窗口——否则 drain 与新到消息的直接执行会双发。
- `Inbound.drain(botId, chatId)`（幂等）：
  1. `router.lookup(botId, chatId)` 取**当前绑定**的 rt；不存在 / `retiring` / `inflight !== undefined` / 队列空 → 返回。
  2. shift 队首 → 走 `dispatch`（内部完成占槽）。
  - 旧 rt（retiring 中）的 `turn/end` 触发 drain 时，`lookup` 找到的是 `/new` 后的新 rt，语义自动正确；`/switch` 后同理（切走的旧 rt 收尾触发的 drain 落在新绑定 rt 上）。
- 兜底触发点：`/new`（`router.reset` 返回后）与 `/switch`（`router.switchTo` 返回后）在 Inbound 各补一次 `drain`——覆盖「无任务时 /new（旧 rt 无 turn/end）」的排水空窗；`dispatch` 内 followup 抛错回滚（inbound.ts:126-130，占槽期间可能已有新消息入队）释放 inflight 后同样补一次 `drain`。
- `/stop` 零改动：`cancel()` → 宿主 `turn/end` → 释放点自动排水。
- drain 中 `dispatch` 的错误路径与 `onMessage` 一致（摘要 notice + `onError` warn）。

### 撤回撤销

- `ChannelIO` 新增可选回调 `onMessageRecalled?(botId: string, chatId: string, messageId: string): void`。
- 飞书渠道 `feishu/index.ts` 的 EventDispatcher 加注册 `im.message.recalled_v1`（事件体含 `message_id`/`chat_id`/`recall_type`；WS 长连接支持；该事件推送是 per-bot 连接，botId 渠道层已知）。
- 核心处理：从该 chat 队列删除 `messageId` 匹配项——
  - 命中 → notice `已撤销排队消息：<text 前 20 字>`；
  - 未命中（已执行 / 不存在 / 正在执行）→ 静默忽略。
  - `recall_type` 不区分（本人/群主/管理员撤回同样生效——撤了就撤）。
- 平台前提：应用需在开发者后台订阅 `im.message.recalled_v1`（权限 `im:message` 或 `im:message:readonly` 已具备）。扫码建应用 addons 与使用手册同步补充该事件订阅；未订阅时功能退化为「排队不可撤销」，不影响其余链路。

### /status 队列段

队列非空时在现有三行后追加：

```
状态：处理中
排队（2）：
1. 帮我看看这个文件有没有问题
2. [图片] 这张截图里的报错
```

- 每条取 `text` 前 20 字（复用 `truncateDetail`，超出加 `…`）。
- 纯图片消息（text 空 + 有 `loadImages`）显示 `[图片]`；文+图混排显示文字前 20 字（不另标图片）。
- 全部列出，不设条数上限。

### 边界与杂项

- `/stop` 时 `inflight` 空但队列非空：提示文案改为 `当前没有进行中的任务（N 条排队中，撤回原消息可取消）`。
- `HELP_TEXT` 的 `/stop` 行后补一句：`消息排队：任务执行中发送的消息自动排队，撤回原消息可取消排队`。
- 不加 Config 开关（YAGNI）；如需上限/开关后续再加。

## 测试计划

- `inbound.test.ts`：
  - 忙时消息入队 + notice 含队位序号（第 1 位/第 2 位）；
  - 排水：turn/end 后队首自动 dispatch（followup 收到、inflight 重新占槽）；
  - 撤回撤销：命中删除 + notice；未命中静默；正在执行的消息撤回不影响任务；
  - `/status` 队列段格式（前 20 字截断、[图片]、多条全列）；
  - `/new` 后队列续执行（drain 落在新 rt）；`/stop` 不清队列；
  - `/stop` 空闲 + 队列非空的提示文案。
- `outbound.test.ts`：`turn/end`、`agent/error` 释放点触发 `onTurnIdle`；占槽转移先于 `ack()` 完成（无双发窗口）。
- `feishu/index` 渠道测试：撤回事件注册与 `onMessageRecalled` 转发。

## 文档同步

- `docs/domains/feishu.md`：入站段补排队/撤销语义，运维指令面补 `/status` 队列段与 `/stop` 文案变化。
- 使用手册 `docs/usage/`：排队与撤回撤销的交互说明 + 应用后台事件订阅指引。
