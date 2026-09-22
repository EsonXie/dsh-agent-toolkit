# 飞书话题群：话题内回复 + 按话题隔离会话 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 话题群 @ 机器人时回复落在被 @ 话题内（含审批/问答卡），会话按 `(botId, chatId, threadId)` 键控，非话题行为零变化。

**Architecture:** `thread_id` 作为话题判别器与路由键第三元贯穿「解析 → 入站键控 → 路由/绑定 → 出站锚点」四层；出站锚点 = 入站消息 messageId，经 `im.message.reply` 落回话题。spec：`docs/superpowers/specs/2026-09-22-feishu-topic-thread-reply-design.md`。

**Tech Stack:** TypeScript / vitest / @larksuiteoapi/node-sdk；工作目录 `.worktrees/feishu-topic-reply`（分支 `feat/feishu-topic-reply`）。

## Global Constraints

- 所有命令在 worktree 根 `D:\work\github\dsh\dsh-agent-toolkit\.worktrees\feishu-topic-reply` 下执行。
- 测试命令：`pnpm --filter dsh-agent-toolkit test`；类型检查：`pnpm --filter dsh-agent-toolkit typecheck`；构建：`pnpm --filter dsh-agent-toolkit bundle`。
- 非话题路径（threadId 缺席）行为与现状逐字节一致：绑定 key 形态、队列键形态、出站 API、sender 文案（p2p）均不变。
- 注释/文档用中文，风格与邻代码一致；不加新 Config 可调参数；不加注释除非必要（遵循仓库既有注释密度：公共契约与不变量处保留）。
- import 路径带 `.ts` 后缀（仓库现行约定）。
- 每任务结束跑对应测试文件；Task 10 前不全量跑。

---

### Task 1: 解析层透传 threadId

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/parse.ts`
- Test: `packages/toolkit/src/channels/feishu/feishu-parse.test.ts`

**Interfaces:**
- Produces: `ParsedMessage.threadId?: string`（话题群消息为 `omt_*`；非话题缺席）。Task 9 消费。

- [ ] **Step 1: 写失败测试**（追加到 feishu-parse.test.ts）

```ts
test('话题群消息透传 threadId', () => {
  const event = {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1' } },
    message: {
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text',
      thread_id: 'omt_abc',
      content: JSON.stringify({ text: 'hi' }),
      mentions: [{ mentioned_type: 'bot', id: { open_id: BOT_OPEN_ID } }],
    },
  }
  const parsed = parseMessageEvent(event, BOT_OPEN_ID)
  expect(parsed?.threadId).toBe('omt_abc')
})

test('普通群消息 threadId 缺席', () => {
  const event = {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1' } },
    message: {
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text: 'hi' }),
      mentions: [{ mentioned_type: 'bot', id: { open_id: BOT_OPEN_ID } }],
    },
  }
  const parsed = parseMessageEvent(event, BOT_OPEN_ID)
  expect(parsed?.threadId).toBeUndefined()
})
```

（测试文件中 `BOT_OPEN_ID` 沿用既有常量名；若既有测试用字面量则用字面量。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-parse`
Expected: FAIL（`threadId` 不存在）

- [ ] **Step 3: 实现**（parse.ts）

`RawEvent.message` 接口加字段：

```ts
    thread_id?: unknown
```

`ParsedMessage` 加字段：

```ts
  /** 话题群消息的话题 ID（omt_*）；非话题消息缺席。 */
  threadId?: string
```

`parseMessageEvent` return 前计算并带上：

```ts
  const threadId = typeof msg.thread_id === 'string' && msg.thread_id.length > 0 ? msg.thread_id : undefined
  return {
    messageId: msg.message_id, chatId: msg.chat_id, chatType: msg.chat_type, userId, text, imageKeys,
    ...(threadId !== undefined ? { threadId } : {}),
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-parse`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/feishu/parse.ts packages/toolkit/src/channels/feishu/feishu-parse.test.ts
git commit -m "feat(feishu): 入站解析透传 thread_id（话题群判别器）"
```

---

### Task 2: FeishuApi 出站锚点（im.message.reply）

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/api.ts`
- Test: `packages/toolkit/src/channels/feishu/feishu-api.test.ts`

**Interfaces:**
- Consumes: 无（纯端口扩展）
- Produces: `FeishuApi.sendCardMessage(chatId, cardId, replyToMessageId?)`、`sendText(chatId, text, replyToMessageId?)`、`sendFile(chatId, fileKey, replyToMessageId?)`。Task 3/7/8 消费。

- [ ] **Step 1: 写失败测试**（追加到 feishu-api.test.ts；既有 fake client 形态沿用文件内模式）

```ts
test('sendText 带锚点时走 im.message.reply', async () => {
  const calls: { method: string; args: unknown }[] = []
  const fakeClient = {
    im: {
      message: {
        create: async (args: unknown) => { calls.push({ method: 'create', args }) },
        reply: async (args: unknown) => { calls.push({ method: 'reply', args }) },
      },
    },
  }
  const api = createFeishuApi(fakeClient as never)
  await api.sendText('oc_1', 'hello', 'om_anchor')
  expect(calls).toEqual([{
    method: 'reply',
    args: { path: { message_id: 'om_anchor' }, data: { msg_type: 'text', content: JSON.stringify({ text: 'hello' }) } },
  }])
})

test('sendText 无锚点维持 create', async () => {
  const calls: string[] = []
  const fakeClient = {
    im: {
      message: {
        create: async () => { calls.push('create') },
        reply: async () => { calls.push('reply') },
      },
    },
  }
  const api = createFeishuApi(fakeClient as never)
  await api.sendText('oc_1', 'hello')
  expect(calls).toEqual(['create'])
})
```

sendCardMessage / sendFile 同款各一条带锚点用例（msg_type 分别为 `interactive`/`file`；interactive 的 content 为 `JSON.stringify({ type: 'card', data: { card_id } })`，file 为 `JSON.stringify({ file_key })`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-api`
Expected: FAIL（第三参不存在）

- [ ] **Step 3: 实现**（api.ts）

接口签名三个方法各加 `replyToMessageId?: string`；实现抽取私有 helper：

```ts
async function sendMessage(client: lark.Client, chatId: string, replyToMessageId: string | undefined, msgType: string, content: string): Promise<void> {
  if (replyToMessageId !== undefined) {
    await client.im.message.reply({ path: { message_id: replyToMessageId }, data: { msg_type: msgType, content } })
    return
  }
  await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: msgType, content } })
}
```

三个方法改为调用 `sendMessage`（既有 content 拼装原样搬入）。

- [ ] **Step 4: 跑测试确认通过**（含既有用例回归）

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-api`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/feishu/api.ts packages/toolkit/src/channels/feishu/feishu-api.test.ts
git commit -m "feat(feishu): 出站 API 支持锚点回复（im.message.reply）"
```

---

### Task 3: FeishuReplyHandle 锚点贯穿

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/reply.ts`
- Test: `packages/toolkit/src/channels/feishu/feishu-reply.test.ts`、`packages/toolkit/src/channels/feishu/feishu-stream-integrity.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `sendCardMessage/sendText/sendFile` 第三参。
- Produces: `new FeishuReplyHandle(api, chatId, replyToMessageId: string | undefined, tunables, log, debugLog?)`。Task 9 消费。

- [ ] **Step 1: 写失败测试**（feishu-reply.test.ts 追加；构造 fake FeishuApi 记录 sendText/sendCardMessage 入参）

```ts
test('带锚点句柄的 notice 与发卡均走锚点', async () => {
  const sent: unknown[][] = []
  const api = {
    createCard: async () => 'card_1',
    sendCardMessage: async (...args: unknown[]) => { sent.push(['sendCardMessage', ...args]) },
    sendText: async (...args: unknown[]) => { sent.push(['sendText', ...args]) },
    setCardStreaming: async () => undefined,
    replaceCard: async () => undefined,
    insertElement: async () => undefined,
    updateCardElement: async () => undefined,
  } as unknown as FeishuApi
  const handle = new FeishuReplyHandle(api, 'oc_1', 'om_anchor', TUNABLES, () => undefined)
  await handle.notice('hi')
  expect(sent).toEqual([['sendText', 'oc_1', 'hi', 'om_anchor']])
})
```

（`TUNABLES` 沿用测试文件既有常量。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-reply`
Expected: FAIL（构造签名不符）

- [ ] **Step 3: 实现**（reply.ts）

构造函数在 `chatId` 后插入参数：

```ts
  constructor(
    private readonly api: FeishuApi,
    private readonly chatId: string,
    /** 话题回复锚点（入站消息 messageId）；undefined = chat 级 create（非话题现状）。 */
    private readonly replyToMessageId: string | undefined,
    private readonly tunables: ChannelTunables,
    private readonly log: (message: string) => void,
    private readonly debugLog?: DebugSink,
  ) {}
```

三处出站调用补第三参 `this.replyToMessageId`：
- `invokeThenCommit` 的 send 分支：`this.api.sendCardMessage(this.chatId, this.state.cardId!, this.replyToMessageId)`
- `finalize` 的 detail 降级与 `notice`：`this.api.sendText(this.chatId, ..., this.replyToMessageId)`
- `abandon` 的 ABANDON_NOTICE：`this.api.sendText(this.chatId, ABANDON_NOTICE, this.replyToMessageId)`
- `sendFile`：`this.api.sendFile(this.chatId, fileKey, this.replyToMessageId)`

同步更新两个测试文件全部 `new FeishuReplyHandle(...)` 调用点（无锚点语义传 `undefined`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-reply feishu-stream-integrity`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/feishu/reply.ts packages/toolkit/src/channels/feishu/feishu-reply.test.ts packages/toolkit/src/channels/feishu/feishu-stream-integrity.test.ts
git commit -m "feat(feishu): ReplyHandle 携带话题锚点，全部出站经锚点回复"
```

---

### Task 4: 绑定键三元化 + 端口/运行时字段

**Files:**
- Modify: `packages/toolkit/src/bots/store.ts:59-62`
- Modify: `packages/toolkit/src/channels/ports.ts`（BindingStore、SessionRuntime）
- Modify: `packages/toolkit/src/channels/runtime.ts`（绑定适配 206-208、drain 回调 68、consumeAnswer 65）
- Test: `packages/toolkit/src/channels/runtime.test.ts`

**Interfaces:**
- Produces:
  - `bindingKey(botId: string, chatId: string, threadId?: string): string`（threadId 存在 → `bot:chat:thread`，缺席 → `bot:chat`）
  - `BindingStore.get/set/delete` 均加第三参 `threadId?: string`（set 为 `(botId, chatId, threadId, sessionId)`）
  - `SessionRuntime.threadId?: string`（readonly）、`SessionRuntime.replyAnchor?: string`（mutable，Task 6 写入、Task 7/8 读取）

- [ ] **Step 1: 写失败测试**（runtime.test.ts 追加）

```ts
test('绑定键：话题消息独立键，非话题维持旧形态', async () => {
  // bindings 适配器经 bindingKey：话题键与 chat 键互不可见
  await deps.bindings.put('b:oc_1:omt_a', { sessionId: 's-topic' })
  await deps.bindings.put('b:oc_1', { sessionId: 's-chat' })
  expect(deps.bindings.get('b:oc_1:omt_a')).toEqual({ sessionId: 's-topic' })
  expect(deps.bindings.get('b:oc_1')).toEqual({ sessionId: 's-chat' })
})
```

（直接测 `bindingKey` 纯函数亦可：`expect(bindingKey('b','oc_1','omt_a')).toBe('b:oc_1:omt_a')`、`expect(bindingKey('b','oc_1')).toBe('b:oc_1')`、`expect(bindingKey('b','oc_1',undefined)).toBe('b:oc_1')`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- runtime`
Expected: FAIL

- [ ] **Step 3: 实现**

`bots/store.ts`：

```ts
/** bindings 表 key：(botId, chatId[, threadId]) → sessionId；非话题维持 bot:chat 旧形态（存量绑定零迁移）。 */
export function bindingKey(botId: string, chatId: string, threadId?: string): string {
  return threadId === undefined ? `${botId}:${chatId}` : `${botId}:${chatId}:${threadId}`
}
```

`ports.ts` BindingStore：

```ts
export interface BindingStore {
  get(botId: string, chatId: string, threadId?: string): string | undefined
  set(botId: string, chatId: string, threadId: string | undefined, sessionId: string): Promise<void>
  delete(botId: string, chatId: string, threadId?: string): Promise<void>
  deleteBot(botId: string): Promise<void>
}
```

`ports.ts` SessionRuntime 加：

```ts
  /** 话题路由键第三元（话题群会话）；非话题缺席。 */
  readonly threadId?: string
  /** 当前 turn 触发消息 id（审批/问答卡的话题锚点；dispatch 准入通过后刷新）。 */
  replyAnchor?: string
```

`runtime.ts` 绑定适配：

```ts
      get: (b, c, t) => bindings.get(bindingKey(b, c, t))?.sessionId,
      set: async (b, c, t, s) => { await bindings.put(bindingKey(b, c, t), { sessionId: s }) },
      delete: async (b, c, t) => { await bindings.delete(bindingKey(b, c, t)) },
```

**本任务不动** runtime.ts 的 drain 回调（68 行）与 consumeAnswer 接线（65 行）：drain 回调在 Task 6 补 `rt.threadId`，consumeAnswer 在 Task 8 补 threadId 透传。中间态可编译（TS 少参函数可赋多参签名），行为待 Task 8 闭合。

**注意**：BindingStore 签名变化会让 `inbound.test.ts`、`router.test.ts` 的 fake bindings 编译失败，属预期，Task 5/6 内修复。

- [ ] **Step 4: 跑测试确认通过**（runtime.test.ts；router/inbound 编译错误留待后续任务）

Run: `pnpm --filter dsh-agent-toolkit test -- runtime`
Expected: PASS（runtime.test.ts 内 fake bindings 同步加第三参）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/bots/store.ts packages/toolkit/src/channels/ports.ts packages/toolkit/src/channels/runtime.ts packages/toolkit/src/channels/runtime.test.ts
git commit -m "feat(channels): 绑定键三元化（botId:chatId[:threadId]），SessionRuntime 携带 threadId/replyAnchor"
```

---

### Task 5: Router 三元键 + sender 三形态文案

**Files:**
- Modify: `packages/toolkit/src/channels/router.ts`
- Test: `packages/toolkit/src/channels/router.test.ts`

**Interfaces:**
- Consumes: Task 4 的 BindingStore/SessionRuntime。
- Produces:
  - `Router.ensure(bot, chatId, threadId: string | undefined, reply, userId, chatKind: ChatKind)`、`reset(...)`、`switchTo(bot, chatId, threadId, sessionId, reply, userId, chatKind)`、`lookup(botId, chatId, threadId?)`、`boundSessionId(botId, chatId, threadId?)`
  - `type ChatKind = 'p2p' | 'group' | 'topic'`（导出，Task 6 消费）
  - `senderSectionText(channel: string, userId: string, chatKind: ChatKind): string`

- [ ] **Step 1: 写失败测试**（router.test.ts 追加）

```ts
test('同一 chat 不同话题各自建独立会话', async () => {
  const rt1 = await router.ensure(bot, 'oc_1', 'omt_a', reply, 'ou_u1', 'topic')
  const rt2 = await router.ensure(bot, 'oc_1', 'omt_b', reply, 'ou_u1', 'topic')
  expect(rt1.sessionId).not.toBe(rt2.sessionId)
  expect(rt1.threadId).toBe('omt_a')
  expect(router.lookup(bot.id, 'oc_1', 'omt_a')?.sessionId).toBe(rt1.sessionId)
  expect(router.lookup(bot.id, 'oc_1', 'omt_b')?.sessionId).toBe(rt2.sessionId)
})

test('sender 段三形态文案', () => {
  expect(senderSectionText('feishu', 'ou_1', 'p2p')).toContain('单聊会话')
  expect(senderSectionText('feishu', 'ou_1', 'group')).toContain('群聊会话')
  expect(senderSectionText('feishu', 'ou_1', 'topic')).toContain('话题')
  expect(senderSectionText('feishu', 'ou_1', 'topic')).toContain('ou_1')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- router`
Expected: FAIL

- [ ] **Step 3: 实现**（router.ts）

- 顶部导出 `export type ChatKind = 'p2p' | 'group' | 'topic'`。
- `senderSectionText` 加第三参并分形态（spec §3.5 文案逐字）；p2p 分支即现文案。
- `withChannelSections(hooks, bot, userId, chatKind)`、`resolveSession(bot, userId, chatKind)` 透传。
- 全方法签名加 threadId / chatKind：`ensure(bot, chatId, threadId, reply, userId, chatKind)`、`reset(bot, chatId, threadId, reply, userId, chatKind)`、`lookup(botId, chatId, threadId?)`、`boundSessionId(botId, chatId, threadId?)`、`switchTo(bot, chatId, threadId, sessionId, reply, userId, chatKind)`、`releaseUnbound(botId, chatId, threadId, ...)`、`adopt(botId, chatId, threadId, ...)`（adopt 组装的 SessionRuntime 带 `threadId`）。
- 全部 `this.bindings.*` 调用补 threadId。
- router.test.ts 既有 fake bindings 与调用点同步补参（非话题传 `undefined`、chatKind 传 `'p2p'` 或 `'group'`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- router`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/router.ts packages/toolkit/src/channels/router.test.ts
git commit -m "feat(channels): Router 按话题键控会话，sender 段区分单聊/群聊/话题"
```

---

### Task 6: InboundMessage + Inbound 全键控话题化

**Files:**
- Modify: `packages/toolkit/src/channels/channel.ts`（InboundMessage）
- Modify: `packages/toolkit/src/channels/inbound.ts`
- Modify: `packages/toolkit/src/channels/runtime.ts`（drain 回调 68 行补 `rt.threadId`）
- Test: `packages/toolkit/src/channels/inbound.test.ts`

**Interfaces:**
- Consumes: Task 1 threadId、Task 5 Router 签名与 ChatKind。
- Produces:
  - `InboundMessage.chatType: 'p2p' | 'group'`、`InboundMessage.threadId?: string`
  - `Inbound.drain(botId, chatId, threadId?)`、`revokeQueued(botId, chatId, messageId)`（签名不变，内部改前缀扫描）
  - `InboundDeps.consumeAnswer?: (botId, chatId, threadId: string | undefined, userId, text) => boolean`
  - dispatch 副作用：`rt.replyAnchor = msg.messageId`
  - （errata 2026-09-22 终审：锚点仅话题消息写入——非话题保持 create 发卡形态，全局约束「非话题零变化」优先；代码已按 `if (msg.threadId !== undefined)` 门控实现。）

- [ ] **Step 1: 写失败测试**（inbound.test.ts 追加；`msg(...)` helper 返回对象补 `chatType: 'p2p'`，另加话题消息工厂）

```ts
function topicMsg(text: string, threadId: string, chatId = 'oc_1'): InboundMessage {
  return { ...msg(text, chatId), chatType: 'group', threadId }
}

test('话题 A 执行中，话题 B 消息走独立会话、不进 A 的队列', async () => {
  // 两话题先后各发一条：应各建各的 session（绑定键不同）
  inbound.onMessage(topicMsg('任务A', 'omt_a'))
  await flush()
  inbound.onMessage(topicMsg('任务B', 'omt_b'))
  await flush()
  const rtA = router.lookup(BOT.id, 'oc_1', 'omt_a')
  const rtB = router.lookup(BOT.id, 'oc_1', 'omt_b')
  expect(rtA).toBeDefined()
  expect(rtB).toBeDefined()
  expect(rtA!.sessionId).not.toBe(rtB!.sessionId)
})

test('撤回撤销排队按 messageId 匹配（撤回事件不带 threadId 也能命中话题队列）', async () => {
  // 占住话题 A 的槽后排队一条，再撤回排队消息
  inbound.onMessage(topicMsg('任务A1', 'omt_a'))
  await flush()
  // A 执行中（in-flight fake 挂起），第二条进队列
  const queued = topicMsg('任务A2', 'omt_a')
  inbound.onMessage(queued)
  await flush()
  inbound.revokeQueued(BOT.id, 'oc_1', queued.messageId)
  // 断言队列已空：/status 路径或 queues 内部状态（按文件既有断言手段）
})
```

（`flush` 指文件既有的微任务排空手段——若文件无此 helper，用 `await Promise.resolve()` 若干次或既有同款写法；router 用真实 Router + fake bindings，与文件既有 setup 一致。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- inbound`
Expected: FAIL

- [ ] **Step 3: 实现**

`channel.ts` InboundMessage 加：

```ts
  chatType: 'p2p' | 'group'
  /** 话题群话题 ID；非话题缺席。 */
  threadId?: string
```

`inbound.ts`：

- 路由键 helper：`const routeKey = (botId: string, chatId: string, threadId?: string) => `${botId}:${chatId}:${threadId ?? ''}``（模块级私有函数）。
- `queues`、`lastLists` 全部改用 routeKey；`/stop`、`/status` 查队列同款。
- `chatKindOf(msg)` = `msg.threadId !== undefined ? 'topic' : msg.chatType`，ensure/reset/switchTo 调用传入 msg.threadId 与 chatKind。
- `dispatch` 内 `rt.reply = msg.reply` 之后加 `rt.replyAnchor = msg.messageId`。
- `drain(botId, chatId, threadId?)`；`clearQueues` 前缀 `${botId}:` 不变（天然覆盖）。
- `revokeQueued`：不再单键查找，遍历 `queues` 中 key 以 `${botId}:${chatId}:` 开头的全部队列按 messageId 匹配。
- `consumeAnswer` 调用点传 `msg.threadId`。
- `runtime.ts` drain 回调：`(rt) => this.inbound.drain(rt.botId, rt.chatId, rt.threadId)`。
- inbound.test.ts 既有 fake：`msg()` helper 补默认 `chatType: 'p2p'`；bindings fake 补第三参；router fake 或真实 Router 调用点补参。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- inbound`
Expected: PASS（含既有 84 文件内全部 inbound 用例回归）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/channel.ts packages/toolkit/src/channels/inbound.ts packages/toolkit/src/channels/inbound.test.ts
git commit -m "feat(channels): 入站键控话题化（队列/指令/作答拦截按话题隔离），replyAnchor 落位"
```

---

### Task 7: 审批卡话题锚点

**Files:**
- Modify: `packages/toolkit/src/channels/approval/center.ts`
- Modify: `packages/toolkit/src/channels/approval/feishu.ts`
- Test: `packages/toolkit/src/channels/approval/center.test.ts`、`packages/toolkit/src/channels/approval/feishu.test.ts`

**Interfaces:**
- Consumes: Task 4 `SessionRuntime.replyAnchor`、Task 2 `sendCardMessage` 第三参。
- Produces: `ApprovalPrompt.replyToMessageId?: string`

- [ ] **Step 1: 写失败测试**

center.test.ts：rt 带 `replyAnchor: 'om_turn1'` 时 presenter 收到的 prompt 含 `replyToMessageId: 'om_turn1'`。
feishu.test.ts：prompt 带 `replyToMessageId` 时 `sendCardMessage` 收到第三参。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- approval`
Expected: FAIL

- [ ] **Step 3: 实现**

`center.ts`：`ApprovalPrompt` 加 `replyToMessageId?: string`；`handleRequest` 的 present 调用带 `...(rt.replyAnchor !== undefined ? { replyToMessageId: rt.replyAnchor } : {})`。
`feishu.ts`：`present` 里 `this.api.sendCardMessage(prompt.chatId, cardId, prompt.replyToMessageId)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- approval`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/approval/center.ts packages/toolkit/src/channels/approval/feishu.ts packages/toolkit/src/channels/approval/center.test.ts packages/toolkit/src/channels/approval/feishu.test.ts
git commit -m "feat(channels): 审批卡锚定当前 turn 触发消息（话题内发卡）"
```

---

### Task 8: 问答卡话题锚点 + 文本拦截话题隔离

**Files:**
- Modify: `packages/toolkit/src/channels/questions/center.ts`
- Modify: `packages/toolkit/src/channels/questions/feishu.ts`
- Modify: `packages/toolkit/src/channels/runtime.ts`（consumeAnswer 接线 65）
- Test: `packages/toolkit/src/channels/questions/center.test.ts`、`packages/toolkit/src/channels/questions/feishu.test.ts`

**Interfaces:**
- Consumes: Task 4/2 同上；Task 6 的 consumeAnswer 新签名。
- Produces: `QuestionPrompt.replyToMessageId?: string`；`QuestionCenter.tryConsumeText(botId, chatId, threadId: string | undefined, userId, text): boolean`

- [ ] **Step 1: 写失败测试**

center.test.ts：
- present 收到的 prompt 含 rt.replyAnchor。
- `tryConsumeText('b', 'oc_1', 'omt_b', ...)` 不消费挂在 `omt_a` 话题会话上的 pending 问答（两 rt 同 chatId 不同 threadId）。

feishu.test.ts：prompt 带 `replyToMessageId` 时 `sendCardMessage` 收到第三参。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- questions`
Expected: FAIL

- [ ] **Step 3: 实现**

`center.ts`：`QuestionPrompt` 加 `replyToMessageId?: string`；`handleRequest` present 带锚点（同 Task 7 写法）；`tryConsumeText` 加第三参 `threadId`，匹配条件由 `entry.prompt.chatId !== chatId` 之外再加 `rt.threadId !== threadId` 跳过（rt 取自 `this.sessions.get(entry.sessionId)`，已有）。
`feishu.ts`：present 发卡带 `prompt.replyToMessageId`。
`runtime.ts`：consumeAnswer 接线改 `(botId, chatId, threadId, userId, text) => this.questions.tryConsumeText(botId, chatId, threadId, userId, text)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- questions`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/questions/center.ts packages/toolkit/src/channels/questions/feishu.ts packages/toolkit/src/channels/runtime.ts packages/toolkit/src/channels/questions/center.test.ts packages/toolkit/src/channels/questions/feishu.test.ts
git commit -m "feat(channels): 问答卡话题锚点 + 开放题文本拦截按话题隔离"
```

---

### Task 9: 飞书渠道接线

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/index.ts`
- Test: 无新增（接线层；由 Task 10 全量回归兜底）

**Interfaces:**
- Consumes: 全部前置任务。

- [ ] **Step 1: 接线**（feishu/index.ts 的 `im.message.receive_v1` handler）

```ts
        const reply = new FeishuReplyHandle(api, parsed.chatId, parsed.threadId !== undefined ? parsed.messageId : undefined, tunables, log, tunables.debugLog)
        io.onMessage({
          botId: bot.record.id,
          chatId: parsed.chatId,
          chatType: parsed.chatType,
          userId: parsed.userId,
          messageId: parsed.messageId,
          text: parsed.text,
          ...(parsed.threadId !== undefined ? { threadId: parsed.threadId } : {}),
          ...(loadImages !== undefined ? { loadImages } : {}),
          reply,
          ackProcessing: makeAck(api, parsed.messageId, tunables.processingReactionEmoji),
        })
```

锚点仅在话题消息时传（非话题维持 create 语义零变化）。

- [ ] **Step 2: 全量回归**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: 84 文件全绿（851+ 通过，2 skipped）

- [ ] **Step 3: Commit**

```bash
git add packages/toolkit/src/channels/feishu/index.ts
git commit -m "feat(feishu): 渠道接线——话题消息构造锚定句柄并透传 threadId/chatType"
```

---

### Task 10: 文档同步 + 门禁

**Files:**
- Modify: `docs/domains/feishu.md`
- Modify: `packages/toolkit/package.json`（version 0.4.5 → 0.4.6；发布时由 publish.ps1 门禁复核）
- 检查：`docs/usage/` 飞书篇若提及群聊行为，补话题群说明一段

- [ ] **Step 1: 域文档改写**（feishu.md 对应段落：路由键 `(botId, chatId[, threadId])`、队列 per-route、审批/问答卡锚点、sender 三形态、跨话题切换语义说明、话题群旧 chat 级绑定成孤儿不迁移）

- [ ] **Step 2: 门禁全跑**

```bash
pnpm --filter dsh-agent-toolkit test
pnpm --filter @dsh-agent-toolkit/token-usage test
pnpm --filter dsh-agent-toolkit typecheck
pnpm --filter @dsh-agent-toolkit/token-usage typecheck
pnpm --filter dsh-agent-toolkit bundle
```

Expected: 全绿。

- [ ] **Step 3: Commit**

```bash
git add docs/domains/feishu.md packages/toolkit/package.json
git commit -m "docs(feishu): 域文档同步话题键控与锚点回复；0.4.6"
```

- [ ] **Step 4: 真实宿主人工验收**（交付用户执行）：话题群建 bot → 话题内 @ → 回复落在话题内不开新话题 → 双话题并行 @ 互不串会话 → 审批卡落在话题内 → /new 只影响当前话题。验收后 spec/plan 归 archive、releases.md 追加记录、走 publish.ps1。
