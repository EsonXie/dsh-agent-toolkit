# 飞书消息排队与撤回撤销 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飞书 bot 会话在任务执行中收到的新消息排队（而非拒绝），turn 完成后立即自动执行下一条；撤回原飞书消息即撤销排队条目；`/status` 列出全部排队消息（每条前 20 字）。

**Architecture:** chat 级内存队列（`Map<botId:chatId, InboundMessage[]>`）持有于 `Inbound`；`Outbound` 新增 `onTurnIdle` 回调在两个 inflight 释放点（`turn/end`、`agent/error`）同步触发排水；飞书渠道加注册 `im.message.recalled_v1` 事件入核撤销。设计定案见 `docs/superpowers/specs/2026-09-11-feishu-message-queue-design.md`。

**Tech Stack:** TypeScript（ESM、`.ts` 后缀导入）、vitest、`@larksuiteoapi/node-sdk`。

## Global Constraints

- 测试命令：`pnpm --filter dsh-agent-toolkit test`（vitest）；类型检查：`pnpm --filter dsh-agent-toolkit typecheck`；任何 src 改动后跑 `pnpm --filter dsh-agent-toolkit bundle`。
- 代码风格照现有文件：中文注释、命名导出（无 default export）、接口窄化端口化、文案中文。
- 不变量：**inflight 空 ⇒ 队列空**——排水的占槽转移（shift 队首 → 设 `rt.inflight`/`rt.reply`）必须在释放点的同一同步段完成，先于 `await ack()`，否则新到消息与排水双发。
- 队列纯内存态，不限容量，不加 Config 开关（YAGNI）。
- commit message 用中文 conventional 格式（如 `feat: ...`），每任务末尾提交。

---

### Task 1: Inbound 队列基础设施（dispatch 重构 + 忙时入队 + drain）

**Files:**
- Modify: `packages/toolkit/src/channels/inbound.ts`
- Test: `packages/toolkit/src/channels/inbound.test.ts`

**Interfaces:**
- Produces（后续任务依赖）:
  - `Inbound.drain(botId: string, chatId: string): void` — 幂等排水：当前绑定 rt 存在、非 retiring、`inflight === undefined` 且队列非空时 shift 队首走 `dispatch`。
  - `Inbound` 私有队列 `queues: Map<string, InboundMessage[]>`，键 `${botId}:${chatId}`。
  - `queuedPreview(msg: InboundMessage): string`（命名导出）— 排队预览：text 前 20 字（`truncateDetail` 截断加 `…`）；纯图片（text 空 + 有 `loadImages`）返回 `'[图片]'`。
  - harness opts 新增 `followupThrowsOn?: string`：followup 收到 text 等于该值的消息时抛 `new Error('投递失败')`。

- [ ] **Step 1: 改写两个旧拒绝行为测试为排队行为（失败测试）**

`inbound.test.ts` 中替换 `in-flight 占用期间第二条消息被拒并提示`（:115-122）与 `处理中再发消息：rt.reply 不被替换…`（:124-134）两个测试：

```ts
test('in-flight 占用期间第二条消息排队并提示队位', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('第一条'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('第二条'))
  inbound.onMessage(msg('第三条'))
  await vi.waitFor(() => { expect(rec.notices).toContain('已排队（第 2 位），撤回原消息可取消执行') })
  expect(rec.notices).toContain('已排队（第 1 位），撤回原消息可取消执行')
  expect(rec.followups).toHaveLength(1)
})

test('排队中消息不替换 rt.reply，运行中 turn 仍在旧句柄收尾', async () => {
  const { rec, inbound, router, msg } = harness()
  inbound.onMessage(msg('任务一'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const rt = router.lookup('reviewer', 'oc_1')!
  const firstReply = rt.reply
  inbound.onMessage(msg('追问'))
  await vi.waitFor(() => { expect(rec.notices).toContain('已排队（第 1 位），撤回原消息可取消执行') })
  expect(rt.reply).toBe(firstReply)
})
```

并新增 drain 直调测试：

```ts
test('drain：槽位空闲且队列非空时立即执行队首（幂等）', async () => {
  const { rec, inbound, router, msg } = harness()
  inbound.onMessage(msg('第一条'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('第二条'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
  const rt = router.lookup('reviewer', 'oc_1')!
  rt.inflight = undefined
  inbound.drain('reviewer', 'oc_1')
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(2) })
  expect(rec.followups[1].text).toBe('第二条')
  expect(rt.inflight).not.toBeUndefined()
  // 幂等：队列空后再 drain 无事发生
  rt.inflight = undefined
  inbound.drain('reviewer', 'oc_1')
  await new Promise((r) => setTimeout(r, 20))
  expect(rec.followups).toHaveLength(2)
})

test('drain：无绑定会话或 retiring 时不排水', async () => {
  const { rec, inbound, router, msg } = harness()
  inbound.drain('reviewer', 'oc_never')   // 无队列无会话：静默
  inbound.onMessage(msg('任务'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('排队'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
  const rt = router.lookup('reviewer', 'oc_1')!
  rt.retiring = true
  rt.inflight = undefined
  inbound.drain('reviewer', 'oc_1')
  await new Promise((r) => setTimeout(r, 20))
  expect(rec.followups).toHaveLength(1)
})
```

harness 的 `msg` 工厂不变（`messageId` 随机即可）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/inbound.test.ts`
Expected: FAIL（4 个新/改测试：notice 文案仍是旧的「上一条还在处理中」、`drain` 不存在）。

- [ ] **Step 3: 实现 dispatch 重构 + 队列 + drain**

`inbound.ts` 修改：

1. 导入处给 `ports.ts` 的类型导入加 `SessionRuntime`：

```ts
import type { Router } from './router.ts'
import type { SessionCatalogEntry, SessionCatalogPort, SessionRuntime } from './ports.ts'
```

2. 类内加队列字段（放在 `lastLists` 声明旁）：

```ts
/** 排队消息（per chat；任务执行中收到的消息在此排队，turn 落定后按序排水）。 */
private readonly queues = new Map<string, InboundMessage[]>()
```

3. 忙时分支（原 :93-97）改为入队，准入后段抽为 `dispatch`：

```ts
const rt = await this.deps.router.ensure(bot, msg.chatId, msg.reply, msg.userId)
if (rt.inflight !== undefined) {
  const key = `${bot.id}:${msg.chatId}`
  const queue = this.queues.get(key) ?? []
  queue.push(msg)
  this.queues.set(key, queue)
  await msg.reply.notice(`已排队（第 ${queue.length} 位），撤回原消息可取消执行`)
  return
}
await this.dispatch(rt, msg)
```

4. 新增 `dispatch` 与 `drain` 方法（原 :98-131 的执行段整体移入 `dispatch`，followup 抛错回滚处补 `this.drain`）：

```ts
/** 执行一条消息：占槽 → 刷新 reply → 表情 → 图片落附件库 → followup 投递。直接执行与排水共用。 */
private async dispatch(rt: SessionRuntime, msg: InboundMessage): Promise<void> {
  // 准入：先占槽再异步；表情回复失败不阻塞处理。
  // reply 句柄只在准入通过后刷新——忙时/排队消息不抢走运行中 turn 的出站。
  rt.inflight = { ack: undefined }
  rt.reply = msg.reply
  rt.inflight.ack = (await msg.ackProcessing().catch(() => undefined)) ?? undefined
  // source kind 用 'user'（与 ACP 同款）：dsh sessionTitle 服务只接纳 user 消息生成会话标题。
  // 图片：in-flight 窗口内懒下载（不占飞书 WS 3 秒窗口）→ 落附件库 → image 内容块。
  const imageRefs: ImageAttachmentRef[] = []
  if (msg.loadImages !== undefined) {
    const images = await msg.loadImages()
    if (images.length > 0) {
      const attachments = this.deps.attachments?.()
      if (attachments === undefined) {
        await msg.reply.notice('当前环境暂不支持图片消息（附件服务不可用），已按文字部分处理')
      } else {
        imageRefs.push(...await attachments.saveImages(images))
      }
    }
  }
  const message = createUserMessage({
    content: [
      ...(msg.text.length > 0 ? [{ type: 'text' as const, text: msg.text }] : []),
      ...imageRefs.map((ref) => ({ type: 'image' as const, attachment: ref })),
    ],
    source: { kind: 'user' },
  })
  try {
    rt.agent.followup(message)
  } catch (error) {
    const ack = rt.inflight.ack
    rt.inflight = undefined
    await ack?.()
    // 占槽期间可能已有新消息入队：回滚释放后继续排水，不滞留。
    this.drain(rt.botId, rt.chatId)
    throw error
  }
}

/**
 * 幂等排水：当前绑定 rt 空闲且该 chat 队列非空时 shift 队首立即执行。
 * 触发点：Outbound onTurnIdle（turn/end、agent/error 释放槽位）、/new、/switch、followup 回滚。
 * 不变量：inflight 空 ⇒ 队列空——占槽转移与释放在同一同步段，无并发窗口。
 */
drain(botId: string, chatId: string): void {
  const key = `${botId}:${chatId}`
  const queue = this.queues.get(key)
  if (queue === undefined || queue.length === 0) return
  const rt = this.deps.router.lookup(botId, chatId)
  if (rt === undefined || rt.retiring || rt.inflight !== undefined) return
  const msg = queue.shift()!
  if (queue.length === 0) this.queues.delete(key)
  void this.dispatch(rt, msg).catch(async (error) => {
    // 与 onMessage 同款错误路径：摘要回传渠道 + onError（drain 是 fire-and-forget，自行兜底）。
    const detail = truncateDetail(error instanceof Error ? error.message : String(error), this.deps.maxErrorDetailChars)
    this.deps.onError(`[project-bot] 入站处理失败：${detail}`)
    await msg.reply.notice(`处理失败：${detail}`).catch(() => undefined)
  })
}
```

5. 文件尾部新增预览助手（Task 3/4 复用）：

```ts
/** 排队消息预览：text 前 20 字（超出 …）；纯图片显示 [图片]；文+图混排只取文字。 */
export function queuedPreview(msg: InboundMessage): string {
  if (msg.text.length > 0) return truncateDetail(msg.text, 20)
  return '[图片]'
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/inbound.test.ts`
Expected: PASS（本文件全部测试，含 4 个新/改测试）。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/inbound.ts packages/toolkit/src/channels/inbound.test.ts
git commit -m "feat: 飞书入站消息排队——忙时入队 + dispatch 重构 + 幂等 drain"
```

---

### Task 2: 排水接线（Outbound onTurnIdle + BotRuntime 接线 + /new /switch 兜底）

**Files:**
- Modify: `packages/toolkit/src/channels/outbound.ts:111-117`（构造函数）、`:176-182`（turn/end 释放段）、`:229-234`（agent/error 释放段）
- Modify: `packages/toolkit/src/channels/runtime.ts:59`（Outbound 构造接线）、`inbound.ts`（/new、/switch 分支）
- Test: `packages/toolkit/src/channels/outbound.test.ts`、`packages/toolkit/src/channels/inbound.test.ts`

**Interfaces:**
- Consumes: `Inbound.drain(botId, chatId)`（Task 1）。
- Produces:
  - `Outbound` 构造函数第 4 参 `onTurnIdle?: (rt: SessionRuntime) => void`（可选，在 `maxErrorDetailChars` 之后）。
  - harness opts 新增 `followupThrowsOn?: string`（见 Task 1 接口块，本任务实现）。

- [ ] **Step 1: 写失败测试**

`outbound.test.ts` 在 `describe('Outbound.handleSessionEvent')` 内新增：

```ts
test('turn/end 释放 inflight 后同步触发 onTurnIdle（占槽转移先于删表情）', async () => {
  const { reply } = recorder()
  const rt = fakeRuntime(reply)
  const ack = vi.fn()
  rt.inflight = { ack }
  // 模拟核心侧排水：回调内同步重新占槽（验证释→占同窗，finalize/ack 不覆盖新槽）。
  const idle = vi.fn(() => { rt.inflight = { ack: undefined } })
  const outbound = new Outbound(new Map([['s1', rt]]), () => undefined, 500, idle)
  outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
  outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await drain(rt)
  expect(idle).toHaveBeenCalledOnce()
  expect(idle).toHaveBeenCalledWith(rt)
  expect(idle.mock.invocationCallOrder[0]!).toBeLessThan(ack.mock.invocationCallOrder[0]!)
  expect(rt.inflight).toEqual({ ack: undefined })
})
```

`outbound.test.ts` 在 `describe('Outbound.handleAgentError')`（若无该 describe 则新建）内新增：

```ts
test('agent/error（turn 外）释放 inflight 后同样触发 onTurnIdle', async () => {
  const { reply } = recorder()
  const rt = fakeRuntime(reply)
  rt.inflight = { ack: undefined }
  const idle = vi.fn()
  const outbound = new Outbound(new Map([['s1', rt]]), () => undefined, 500, idle)
  outbound.handleAgentError('s1', 'boom')
  await drain(rt)
  expect(idle).toHaveBeenCalledOnce()
})
```

`inbound.test.ts` 的 harness opts 接口（:24-29）加 `followupThrowsOn?: string`，`fakeAgent` 的 `followup` 改为：

```ts
followup: (m) => {
  const message = m as { content: { type: string; text?: string }[]; source: Record<string, unknown> }
  if (opts.followupThrowsOn !== undefined && message.content[0]?.text === opts.followupThrowsOn) throw new Error('投递失败')
  rec.followups.push({ text: message.content[0].text ?? '', source: message.source, content: message.content })
},
```

（`fakeAgent` 当前签名是 `(sessionId, rec)`，需要能访问 `opts`——把它改为 `fakeAgent(sessionId, rec, opts)` 并更新 `create`/`resume` 两处调用。）

新增集成测试：

```ts
test('turn/end 后自动排水：排队消息立即执行', async () => {
  const { rec, inbound, sessions, router, msg } = harness()
  const outbound = new Outbound(sessions, () => undefined, 500, (rt) => inbound.drain(rt.botId, rt.chatId))
  inbound.onMessage(msg('第一条'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('第二条'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
  const sessionId = router.boundSessionId('reviewer', 'oc_1')!
  const rt = sessions.get(sessionId)!
  outbound.handleSessionEvent(sessionId, { type: 'turn/start', data: { turn: 1 } })
  outbound.handleSessionEvent(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(2) })
  expect(rec.followups[1].text).toBe('第二条')
  expect(rt.inflight).not.toBeUndefined()
})

test('/new 不清队列：新会话建好后排队消息继续执行', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('任务一'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('任务二'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
  inbound.onMessage(msg('/new'))
  await vi.waitFor(() => { expect(rec.notices).toContain('已开启新会话') })
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(2) })
  expect(rec.followups[1].text).toBe('任务二')
})

test('排水的 followup 抛错：释放槽位后继续排水下一条', async () => {
  const { rec, inbound, sessions, router, msg } = harness({ followupThrowsOn: '第二条' })
  const outbound = new Outbound(sessions, () => undefined, 500, (rt) => inbound.drain(rt.botId, rt.chatId))
  inbound.onMessage(msg('第一条'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('第二条'))
  inbound.onMessage(msg('第三条'))
  await vi.waitFor(() => { expect(rec.notices.filter((n) => n.includes('已排队'))).toHaveLength(2) })
  const sessionId = router.boundSessionId('reviewer', 'oc_1')!
  outbound.handleSessionEvent(sessionId, { type: 'turn/start', data: { turn: 1 } })
  outbound.handleSessionEvent(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await vi.waitFor(() => { expect(rec.followups.some((f) => f.text === '第三条')).toBe(true) })
  expect(rec.notices.some((n) => n.includes('处理失败') && n.includes('投递失败'))).toBe(true)
  expect(rec.followups.map((f) => f.text)).toEqual(['第一条', '第三条'])
})

test('/stop 只停当前任务：队列保留，turn/end 后续上', async () => {
  const { rec, inbound, sessions, router, msg } = harness()
  const outbound = new Outbound(sessions, () => undefined, 500, (rt) => inbound.drain(rt.botId, rt.chatId))
  inbound.onMessage(msg('任务一'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('任务二'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
  inbound.onMessage(msg('/stop'))
  await vi.waitFor(() => { expect(rec.notices).toContain('已请求停止当前任务') })
  expect(rec.cancels).toBe(1)
  const sessionId = router.boundSessionId('reviewer', 'oc_1')!
  outbound.handleSessionEvent(sessionId, { type: 'turn/start', data: { turn: 1 } })
  outbound.handleSessionEvent(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } })
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(2) })
  expect(rec.followups[1].text).toBe('任务二')
})
```

（`inbound.test.ts` 顶部需加导入：`import { Outbound } from './outbound.ts'`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/outbound.test.ts src/channels/inbound.test.ts`
Expected: FAIL（`onTurnIdle` 第 4 参不存在；turn/end 后不排水；/new 后 followups 仍 1）。

- [ ] **Step 3: 实现**

`outbound.ts` 构造函数加第 4 参：

```ts
export class Outbound {
  constructor(
    private readonly sessions: Map<string, SessionRuntime>,
    private readonly onError: (message: string) => void,
    /** 回传渠道的错误摘要最大字符数。 */
    private readonly maxErrorDetailChars = 500,
    /** 槽位释放后同步触发（核心侧排水排队消息）；实现须同步完成占槽转移，先于删表情返回。 */
    private readonly onTurnIdle?: (rt: SessionRuntime) => void,
  ) {}
```

`turn/end` 的 enqueue 任务（:176-182）改为：

```ts
this.enqueue(rt, async () => {
  // 有卡定格；无卡但有错误 detail 时也要调 finalize（渠道降级为文本送出）。
  if ((turn.began || detail !== undefined) && rt.reply !== undefined) await rt.reply.finalize(status, detail)
  const ack = rt.inflight?.ack
  rt.inflight = undefined
  // 排水先于删表情：占槽转移须同步完成（inflight 空 ⇒ 队列空 不变量），否则与新到消息双发。
  this.onTurnIdle?.(rt)
  if (ack !== undefined) await ack()
})
```

`handleAgentError` 的 enqueue 任务（:229-234）改为：

```ts
this.enqueue(rt, async () => {
  if (rt.reply !== undefined) await rt.reply.notice(`出错了：${detail}`)
  const ack = rt.inflight?.ack
  rt.inflight = undefined
  this.onTurnIdle?.(rt)
  if (ack !== undefined) await ack()
})
```

`runtime.ts` BotRuntime 构造函数中 Outbound 接线（:59）改为：

```ts
this.outbound = new Outbound(this.sessions, (m) => deps.log.warn(m), deps.maxErrorDetailChars, (rt) => this.inbound.drain(rt.botId, rt.chatId))
```

`inbound.ts` 两个指令分支补兜底 drain：

`/new` 分支（notice 之后）：

```ts
if (directive?.name === 'new') {
  await this.deps.router.reset(bot, msg.chatId, msg.reply, msg.userId)
  await msg.reply.notice('已开启新会话')
  // 队列是 chat 级：/new 不换队列；旧 rt 无 turn/end（空闲时 /new）时由此兜底排水。
  this.drain(bot.id, msg.chatId)
  return
}
```

`/switch` 成功 notice（`已切换到会话：…`）之后：

```ts
await msg.reply.notice(`已切换到会话：${target.title ?? '(无标题)'}（${target.sessionId.slice(0, 8)}）`)
this.drain(bot.id, msg.chatId)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/outbound.test.ts src/channels/inbound.test.ts src/channels/runtime.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/outbound.ts packages/toolkit/src/channels/outbound.test.ts packages/toolkit/src/channels/runtime.ts packages/toolkit/src/channels/inbound.ts packages/toolkit/src/channels/inbound.test.ts
git commit -m "feat: turn 落定自动排水——Outbound onTurnIdle 接线 + /new /switch 兜底"
```

---

### Task 3: 撤回撤销（recalled_v1 事件 → 撤销排队条目）

**Files:**
- Modify: `packages/toolkit/src/channels/channel.ts:45-50`（ChannelIO）
- Modify: `packages/toolkit/src/channels/feishu/parse.ts`（新增 `parseRecallEvent`）
- Modify: `packages/toolkit/src/channels/feishu/index.ts:22-51`（dispatcher 注册）
- Modify: `packages/toolkit/src/channels/runtime.ts:99`（io 接线）
- Modify: `packages/toolkit/src/channels/inbound.ts`（`revokeQueued`）
- Modify: `packages/toolkit/src/bots/register-app.ts:16-18`（addons 事件）
- Test: `packages/toolkit/src/channels/feishu/feishu-parse.test.ts`、`packages/toolkit/src/channels/inbound.test.ts`、`packages/toolkit/src/bots/register-app.test.ts`

**Interfaces:**
- Consumes: `queuedPreview(msg)`（Task 1）；Inbound 私有 `queues`（Task 1）。
- Produces:
  - `ChannelIO.onMessageRecalled?(botId: string, chatId: string, messageId: string): void`
  - `parseRecallEvent(data: unknown): { messageId: string; chatId: string } | null`（parse.ts 命名导出）
  - `Inbound.revokeQueued(botId: string, chatId: string, messageId: string): void`

- [ ] **Step 1: 写失败测试**

`feishu-parse.test.ts` 新增（导入处加 `parseRecallEvent`）：

```ts
test('recalled 事件：提取 message_id/chat_id；兼容 { event } 包裹；字段缺失返回 null', () => {
  expect(parseRecallEvent({ event: { message_id: 'om_1', chat_id: 'oc_1', recall_type: 'message_owner' } }))
    .toEqual({ messageId: 'om_1', chatId: 'oc_1' })
  expect(parseRecallEvent({ message_id: 'om_2', chat_id: 'oc_2' })).toEqual({ messageId: 'om_2', chatId: 'oc_2' })
  expect(parseRecallEvent({ event: { chat_id: 'oc_1' } })).toBeNull()
  expect(parseRecallEvent({})).toBeNull()
})
```

`inbound.test.ts` 新增（用 harness 返回的 `router`）：

```ts
test('撤回排队消息：撤销并提示；撤回正在执行/不存在的消息静默忽略', async () => {
  const { rec, inbound, router, msg } = harness()
  const m1 = msg('第一条')
  inbound.onMessage(m1)
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const m2 = msg('帮我总结一下这个仓库的结构')
  inbound.onMessage(m2)
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })

  inbound.revokeQueued('reviewer', 'oc_1', m2.messageId)
  await vi.waitFor(() => {
    expect(rec.notices).toContain('已撤销排队消息：帮我总结一下这个仓库的结构')
  })

  // 正在执行的第一条与不存在的 messageId：静默忽略
  inbound.revokeQueued('reviewer', 'oc_1', m1.messageId)
  inbound.revokeQueued('reviewer', 'oc_1', 'om_ghost')
  await new Promise((r) => setTimeout(r, 20))
  expect(rec.notices.filter((n) => n.includes('已撤销'))).toHaveLength(1)

  // 撤销后排水不再执行该消息
  const rt = router.lookup('reviewer', 'oc_1')!
  rt.inflight = undefined
  inbound.drain('reviewer', 'oc_1')
  await new Promise((r) => setTimeout(r, 20))
  expect(rec.followups).toHaveLength(1)
})
```

`register-app.test.ts` 新增（照 :83-84 同款风格）：

```ts
test('addons 订阅消息撤回事件（im.message.recalled_v1）', () => {
  expect(FEISHU_REGISTER_APP_ADDONS.events.items.tenant).toContain('im.message.recalled_v1')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/feishu/feishu-parse.test.ts src/channels/inbound.test.ts src/bots/register-app.test.ts`
Expected: FAIL（`parseRecallEvent`/`revokeQueued` 不存在；addons 无该事件）。

- [ ] **Step 3: 实现**

`parse.ts` 尾部新增：

```ts
export interface ParsedRecall {
  messageId: string
  chatId: string
}

/** im.message.recalled_v1 事件解析：窄化为渠道无关的 ParsedRecall（兼容 { event } 包裹）；字段缺失返回 null。 */
export function parseRecallEvent(data: unknown): ParsedRecall | null {
  const wrapped = data as { event?: { message_id?: unknown; chat_id?: unknown } } & { message_id?: unknown; chat_id?: unknown }
  const event = wrapped.event ?? wrapped
  if (typeof event.message_id !== 'string' || typeof event.chat_id !== 'string') return null
  return { messageId: event.message_id, chatId: event.chat_id }
}
```

`channel.ts` 的 `ChannelIO` 加：

```ts
/** 消息撤回事件入核（撤销排队消息；仅排队中生效）；渠道不支持撤回事件时可不实现。 */
onMessageRecalled?(botId: string, chatId: string, messageId: string): void
```

`feishu/index.ts`：导入加 `parseRecallEvent`；dispatcher 注册块内在 `'im.message.receive_v1'` 之后加：

```ts
// 消息撤回：撤销排队消息（核心按 messageId 匹配，幂等无需去重）。
'im.message.recalled_v1': async (data: unknown) => {
  const recalled = parseRecallEvent(data)
  if (recalled === null) return
  io.onMessageRecalled?.(bot.record.id, recalled.chatId, recalled.messageId)
},
```

`runtime.ts` 的 io 对象（:99）加：

```ts
{ onMessage: (msg) => this.inbound.onMessage(msg),
  onCardAction: (action) => this.approval.handleCardAction(action),
  onMessageRecalled: (botId, chatId, messageId) => this.inbound.revokeQueued(botId, chatId, messageId) },
```

`inbound.ts` 新增公开方法（放在 `drain` 旁）：

```ts
/** 撤回原消息 = 撤销排队条目；已执行/不存在/正在执行的静默忽略（幂等，重推安全）。 */
revokeQueued(botId: string, chatId: string, messageId: string): void {
  const key = `${botId}:${chatId}`
  const queue = this.queues.get(key)
  if (queue === undefined) return
  const index = queue.findIndex((m) => m.messageId === messageId)
  if (index < 0) return
  const [removed] = queue.splice(index, 1)
  if (queue.length === 0) this.queues.delete(key)
  void removed!.reply.notice(`已撤销排队消息：${queuedPreview(removed!)}`).catch(() => undefined)
}
```

`register-app.ts` 的 addons（:16-18）改为：

```ts
events: {
  items: { tenant: ['im.message.receive_v1', 'im.message.recalled_v1'] },
},
```

并把 :4 的注释改为 `/** 扫码创建应用时申请的权限/事件/回调（流式卡片 + 收发消息 + 表情 + 通讯录基础信息 + 审批卡片回传 + 消息撤回事件）。 … */`（撤回事件权限 `im:message` 已覆盖，无需加 scope）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/feishu/feishu-parse.test.ts src/channels/inbound.test.ts src/bots/register-app.test.ts src/channels/runtime.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/channel.ts packages/toolkit/src/channels/feishu/parse.ts packages/toolkit/src/channels/feishu/index.ts packages/toolkit/src/channels/runtime.ts packages/toolkit/src/channels/inbound.ts packages/toolkit/src/bots/register-app.ts packages/toolkit/src/channels/feishu/feishu-parse.test.ts packages/toolkit/src/channels/inbound.test.ts packages/toolkit/src/bots/register-app.test.ts
git commit -m "feat: 撤回原飞书消息撤销排队——recalled_v1 事件入核 + revokeQueued"
```

---

### Task 4: /status 队列段 + /stop 文案 + HELP_TEXT

**Files:**
- Modify: `packages/toolkit/src/channels/inbound.ts:28-36`（HELP_TEXT）、`:63-79`（/stop、/status 分支）
- Test: `packages/toolkit/src/channels/inbound.test.ts`

**Interfaces:**
- Consumes: `queuedPreview(msg)`（Task 1）、Inbound 私有 `queues`（Task 1）。
- Produces: 无新接口。

- [ ] **Step 1: 写失败测试**

`inbound.test.ts` 新增：

```ts
test('/status：列出全部排队消息（前 20 字截断；纯图片显示 [图片]）', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('正在跑的任务'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('这是一条特别特别特别特别特别特别长的排队消息'))
  inbound.onMessage(msg('', 'oc_1', async () => [{ data: new Uint8Array([1]), mediaType: 'image/png' }]))
  inbound.onMessage(msg('短消息'))
  await vi.waitFor(() => { expect(rec.notices.filter((n) => n.includes('已排队'))).toHaveLength(3) })
  inbound.onMessage(msg('/status'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('排队（3）'))).toBe(true) })
  const status = rec.notices.find((n) => n.includes('排队（3）'))!
  expect(status).toContain('状态：处理中')
  expect(status).toContain('1. 这是一条特别特别特别特别特别特别长的排队…')
  expect(status).toContain('2. [图片]')
  expect(status).toContain('3. 短消息')
})

test('/status：无排队时不出现队列段', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('/status'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('处理中'))).toBe(true) })
  expect(rec.notices.find((n) => n.includes('处理中'))).not.toContain('排队')
})

test('/stop：无进行中任务但有排队消息时提示排队数', async () => {
  const { rec, inbound, router, msg } = harness()
  inbound.onMessage(msg('任务'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('排队一'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
  // 模拟边界态：槽空但队列非空（正常流程不出现，防御文案分支）。
  router.lookup('reviewer', 'oc_1')!.inflight = undefined
  inbound.onMessage(msg('/stop'))
  await vi.waitFor(() => {
    expect(rec.notices).toContain('当前没有进行中的任务（1 条排队中，撤回原消息可取消）')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/inbound.test.ts`
Expected: FAIL（/status 无队列段；/stop 文案未带排队数）。

- [ ] **Step 3: 实现**

`inbound.ts` 的 `/status` 分支（:73-79）改为：

```ts
if (directive?.name === 'status') {
  const rt = this.deps.router.lookup(bot.id, msg.chatId)
  if (rt === undefined) {
    await msg.reply.notice(`项目：${bot.project}\n会话：未创建（发送消息即创建）`)
    return
  }
  const lines = [
    `项目：${bot.project}`,
    `会话：${rt.sessionId}`,
    `状态：${rt.inflight !== undefined ? '处理中' : '空闲'}`,
  ]
  const queue = this.queues.get(`${bot.id}:${msg.chatId}`) ?? []
  if (queue.length > 0) {
    lines.push(`排队（${queue.length}）：`)
    queue.forEach((m, i) => lines.push(`${i + 1}. ${queuedPreview(m)}`))
  }
  await msg.reply.notice(lines.join('\n'))
  return
}
```

`/stop` 的空闲分支（:68-70）改为：

```ts
} else {
  const count = this.queues.get(`${bot.id}:${msg.chatId}`)?.length ?? 0
  await msg.reply.notice(count > 0
    ? `当前没有进行中的任务（${count} 条排队中，撤回原消息可取消）`
    : '当前没有进行中的任务')
}
```

`HELP_TEXT`（:28-36）改为：

```ts
const HELP_TEXT = [
  '可用指令：',
  '/new 开启新会话（旧会话保留，可用 /switch 切回）',
  '/stop 停止当前任务',
  '/status 查看项目与会话状态',
  '/sessions 列出本项目可切换的会话',
  '/switch <序号|id前缀> 切换到指定会话',
  '/help 显示本帮助',
  '排队：任务执行中发送的消息自动排队，撤回原消息可取消排队',
].join('\n')
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/inbound.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/inbound.ts packages/toolkit/src/channels/inbound.test.ts
git commit -m "feat: /status 列出排队消息前 20 字 + /stop 排队提示 + 帮助补排队说明"
```

---

### Task 5: 文档同步 + 全量验证

**Files:**
- Modify: `docs/domains/feishu.md`
- Modify: `docs/usage/feishu-bots.md`

**Interfaces:**
- Consumes: Task 1-4 全部行为定案。
- Produces: 无代码接口。

- [ ] **Step 1: 更新 `docs/domains/feishu.md`**

「入站、出站与发起人提示段」一节开头段落中，在「reply 句柄在 in-flight 准入通过后才替换」之后补入（或改写该句所在分句为）：

```
忙时消息排队：任务执行中收到的非指令消息进 per-chat 内存队列（不限容量，重启即丢），notice 确认队位；turn/end 与 agent/error 释放槽位时经 Outbound onTurnIdle 回调同步排水（占槽转移先于删表情，保「inflight 空 ⇒ 队列空」无并发窗口），/new 与 /switch 完成后兜底补排（队列是 chat 级，/new 不清队列）；撤回原飞书消息即撤销排队条目（im.message.recalled_v1 事件按 messageId 匹配，仅排队中生效，撤回正在执行的消息静默忽略；扫码建应用 addons 已含该事件订阅，存量应用需在开发者后台补开）
```

「运维指令面」一段的 `/status` 相关描述后补：

```
/status 在队列非空时追加「排队（N）」段，全部列出、每条前 20 字（纯图片显示 [图片]）；/stop 只停当前任务不清队列（无任务但有排队时提示排队数）
```

- [ ] **Step 2: 更新 `docs/usage/feishu-bots.md`**

先读该文件找到「指令」/「交互」相关小节，在合适位置补一段（措辞按该手册现有风格微调）：

```
### 消息排队

任务执行中继续发送的消息不会丢失，而是进入排队：bot 会回复「已排队（第 N 位），撤回原消息可取消执行」。当前任务完成后自动按顺序执行下一条，无需任何操作。

- 撤销排队：在飞书里**撤回你发出的那条消息**即可（bot 回复「已撤销排队消息：…」）。注意只能撤销还在排队的消息；已经开始执行的消息请用 /stop。
- `/status` 会列出所有排队消息的开头（前 20 字）。
- `/new` 开启新会话不影响已排队的消息，新会话建好后会继续执行；`/stop` 只停止当前任务，不清空队列。

存量自建应用需在开发者后台的「事件订阅」中补开 **接收消息撤回 im.message.recalled_v1** 事件，否则撤回撤销不生效（排队本身不受影响）。扫码一键创建的应用已自动包含该事件。
```

- [ ] **Step 3: 全量验证**

Run:
```bash
pnpm --filter dsh-agent-toolkit test
pnpm --filter dsh-agent-toolkit typecheck
pnpm --filter dsh-agent-toolkit bundle
```
Expected: 全部测试 PASS（621 + 新增约 13 个）；typecheck 无错误；bundle 成功。

- [ ] **Step 4: Commit**

```bash
git add docs/domains/feishu.md docs/usage/feishu-bots.md
git commit -m "docs: 飞书消息排队与撤回撤销——域文档与使用手册同步"
```

---

## 自审记录

- Spec 覆盖：入队+notice（T1）、排水+时序（T2）、/new /switch 兜底（T2）、followup 回滚补排（T1 实现 + T2 测试）、撤回撤销+addons（T3）、/status（T4）、/stop 文案（T4）、HELP_TEXT（T4）、文档同步（T5）。✅
- 类型一致性：`drain`/`revokeQueued`/`queuedPreview`/`parseRecallEvent`/`onTurnIdle`/`onMessageRecalled`/`followupThrowsOn` 跨任务签名一致。✅
- 已知留白：feishu/index.ts 的 dispatcher 注册无法单测（WSClient 启动集成），由 parseRecallEvent 单测 + register-app addons 测试覆盖。
