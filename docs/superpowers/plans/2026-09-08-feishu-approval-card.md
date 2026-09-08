# 飞书侧审批卡片 + ask_user 处理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飞书 bot 会话的工具提权申请改为飞书审批卡片（允许/拒绝按钮）处理；ask_user 维持"bot 会话工具面不含 + 模型直接提问"并加守护。

**Architecture:** toolkit Node 半注册 `approval/request` waterfall answerer（`prepend: true` 抢在 web api-proxy 前），命中自有 bot 会话时发 cardkit 2.0 审批卡片并挂起；按钮点击经同一条 WS 长连接的 `card.action.trigger` 回调 resolve。渠道无关核心 `ApprovalCenter` + 飞书 presenter 薄层。ask_user 侧仅加引导文案与守护测试（bot 会话工具面本就不含）。

**Tech Stack:** TypeScript / vitest / cordis（`ctx.on(..., { prepend: true })`）/ `@larksuiteoapi/node-sdk` 1.7.x（`normalizeCardAction`、cardkit v1）。

**设计 spec：** `docs/superpowers/specs/2026-09-08-feishu-approval-card-design.md`（决策记录：飞书独占、仅发起人可批、不超时、ask_user 方向 1）。

## Global Constraints

- 仓库规则：`packages/toolkit` 测试 `pnpm --filter dsh-agent-toolkit test`，类型检查 `pnpm --filter dsh-agent-toolkit typecheck`；任何 src 改动后跑 `pnpm --filter dsh-agent-toolkit bundle`。
- 可调参数进 Config schema，不硬编码。
- `deepseek-harness/` 只读，不改其中文件。
- 飞书 WS 事件 handler 必须 3 秒内返回：回调里只做同步 resolve，卡片更新 fire-and-forget。
- 飞书独占语义：命中自有 bot 会话的 ask **不再** `next()` 给 web（发卡失败等回退路径除外）。
- 审批无超时；取消出口 = `req.signal` abort（`/new`、`/stop`、会话取消、插件卸载）。
- 不引入新 npm 依赖。

---

### Task 1: SessionRuntime 落发起人 open_id

**Files:**
- Modify: `packages/toolkit/src/channels/ports.ts:58-71`（SessionRuntime 加字段）
- Modify: `packages/toolkit/src/channels/router.ts`（adopt 带 userId）
- Test: `packages/toolkit/src/channels/router.test.ts`

**Interfaces:**
- Produces: `SessionRuntime.initiatorOpenId: string`（后续 Task 3 的 ApprovalCenter 越权校验消费）。

- [ ] **Step 1: 写失败测试**

在 `router.test.ts` 中找 `ensure` 成功路径的现有测试，补一条断言（或新写一个 test）：

```ts
test('ensure 把发起人 open_id 落进 SessionRuntime', async () => {
  // 按本文件现有 harness 模式构造 router（fake agents.create 返回 fake AgentPort）
  const rt = await router.ensure(BOT, 'chat1', fakeReply, 'ou_initiator_1')
  expect(rt.initiatorOpenId).toBe('ou_initiator_1')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/router.test.ts`
Expected: FAIL（`initiatorOpenId` 为 undefined）

- [ ] **Step 3: 实现**

`ports.ts` SessionRuntime 接口加字段：

```ts
/** 会话发起人的渠道 open_id（审批卡片越权校验用；ensure/reset 的 userId 落入）。 */
readonly initiatorOpenId: string
```

`router.ts`：`adopt` 加形参 `userId: string`，rt 字面量加 `initiatorOpenId: userId`；`ensure` 两处 `this.adopt(...)` 调用（L44、L50）与 `reset`（经 ensure）把 `userId` 透传进去。注意 `ensure` 的"已存在会话直接返回"分支（L37-41）不改 initiatorOpenId（发起人不变）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/router.test.ts src/channels/runtime.test.ts src/channels/inbound.test.ts src/channels/outbound.test.ts`
Expected: PASS（SessionRuntime 加必填字段可能波及其他测试的 rt 字面量构造，一并补上 `initiatorOpenId: 'ou_x'`）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/ports.ts packages/toolkit/src/channels/router.ts packages/toolkit/src/channels/router.test.ts
git commit -m "feat(toolkit): SessionRuntime 落发起人 open_id（审批越权校验前提）"
```

---

### Task 2: ApprovalCenter 渠道无关核心

**Files:**
- Create: `packages/toolkit/src/channels/approval/center.ts`
- Test: `packages/toolkit/src/channels/approval/center.test.ts`

**Interfaces:**
- Consumes: `SessionRuntime`（Task 1，含 `initiatorOpenId`）。
- Produces（Task 3/4/5/6 消费，签名以此为准）:

```ts
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export interface ApprovalRequestLike {
  agent: { session: { id: unknown } }
  toolName: string
  reason?: string
  signal?: AbortSignal
}
export interface ApprovalPrompt { key: string; chatId: string; botName: string; toolName: string; reason?: string }
export interface ApprovalPresentation { finalize(status: 'allowed' | 'rejected' | 'cancelled', operatorName?: string): Promise<void> }
export interface ApprovalPresenter { present(prompt: ApprovalPrompt): Promise<ApprovalPresentation> }
export interface ApprovalChannel { presenter: ApprovalPresenter; botName: string }
export interface CardActionInput { chatId: string; operatorOpenId: string; operatorName?: string; value: unknown }
export interface CardActionAck { toast?: string }

export class ApprovalCenter {
  constructor(
    sessions: Map<string, SessionRuntime>,
    channelFor: (botId: string) => ApprovalChannel | undefined,
    warn: (message: string) => void,
    newId?: () => string,  // 默认 randomUUID
  )
  /** 自有会话 → 发卡并挂起；非自有会话 / 无审批能力 / 发卡失败 → undefined（调用方 next() 回退）。 */
  handleRequest(req: ApprovalRequestLike): Promise<ApprovalOutcome | undefined>
  /** 卡片按钮回调入核；返回 toast 文案（undefined = 非本中心卡片动作，静默忽略）。 */
  handleCardAction(action: CardActionInput): CardActionAck | undefined
  /** 卸载兜底：全部挂起项 settle 'cancelled'。 */
  dispose(): void
}
```

- [ ] **Step 1: 写失败测试**（`center.test.ts`，fake presenter 模式照 `runtime.test.ts` 的 fake 风格）

```ts
import { randomUUID } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { ApprovalCenter, type ApprovalPresentation, type ApprovalPrompt, type ApprovalRequestLike } from './center.ts'
import type { SessionRuntime } from '../ports.ts'

function fakeRt(sessionId: string, botId = 'reviewer', initiatorOpenId = 'ou_initiator'): SessionRuntime {
  return {
    botId, chatId: 'oc_chat1', sessionId, initiatorOpenId,
    agent: { sessionId, followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined },
    reply: undefined, inflight: undefined, tail: Promise.resolve(), turn: undefined,
  }
}

function harness(opts: { presentError?: Error } = {}) {
  const sessions = new Map<string, SessionRuntime>()
  const warns: string[] = []
  const presented: ApprovalPrompt[] = []
  const finalized: { status: string; operatorName?: string }[] = []
  const presentation: ApprovalPresentation = {
    finalize: async (status, operatorName) => { finalized.push({ status, ...(operatorName !== undefined ? { operatorName } : {}) }) },
  }
  const center = new ApprovalCenter(
    sessions,
    (botId) => botId === 'reviewer'
      ? {
          botName: '评审',
          presenter: {
            present: async (prompt) => {
              if (opts.presentError !== undefined) throw opts.presentError
              presented.push(prompt)
              return presentation
            },
          },
        }
      : undefined,
    (m) => { warns.push(m) },
    () => randomUUID(),
  )
  return { sessions, warns, presented, finalized, center }
}

function ask(sessionId: string, signal?: AbortSignal): ApprovalRequestLike {
  return { agent: { session: { id: sessionId } }, toolName: 'write', reason: '需要写入文件', ...(signal !== undefined ? { signal } : {}) }
}

test('非自有会话 → undefined（调用方回退 next）', async () => {
  const { center } = harness()
  expect(await center.handleRequest(ask('s_unknown'))).toBeUndefined()
})

test('正常链路：发卡挂起，点允许 resolve allowed-once 并定格卡片', async () => {
  const { sessions, presented, finalized, center } = harness()
  sessions.set('s1', fakeRt('s1'))
  const pending = center.handleRequest(ask('s1'))
  // present 是异步的，先让它落定拿到 key
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  expect(presented[0]).toMatchObject({ chatId: 'oc_chat1', botName: '评审', toolName: 'write', reason: '需要写入文件' })
  const ack = center.handleCardAction({ chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', operatorName: '张三', value: { key: presented[0]!.key, decision: 'allow' } })
  expect(ack).toEqual({ toast: '已允许' })
  await expect(pending).resolves.toBe('allowed-once')
  await vi.waitFor(() => { expect(finalized).toEqual([{ status: 'allowed', operatorName: '张三' }]) })
})

test('点拒绝 resolve rejected', async () => {
  const { sessions, presented, center } = harness()
  sessions.set('s1', fakeRt('s1'))
  const pending = center.handleRequest(ask('s1'))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const ack = center.handleCardAction({ chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', value: { key: presented[0]!.key, decision: 'reject' } })
  expect(ack).toEqual({ toast: '已拒绝' })
  await expect(pending).resolves.toBe('rejected')
})

test('越权：非发起人点击只 toast 不 resolve', async () => {
  const { sessions, presented, center } = harness()
  sessions.set('s1', fakeRt('s1'))
  const pending = center.handleRequest(ask('s1'))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  const ack = center.handleCardAction({ chatId: 'oc_chat1', operatorOpenId: 'ou_someone_else', value: { key: presented[0]!.key, decision: 'allow' } })
  expect(ack).toEqual({ toast: '仅会话发起人可审批' })
  // 仍挂起：abort 收尾防泄漏
  const controller = new AbortController()
  void controller
  center.dispose()
  await expect(pending).resolves.toBe('cancelled')
})

test('失效 key（重复点击/已取消）→ toast 已失效', async () => {
  const { center } = harness()
  expect(center.handleCardAction({ chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', value: { key: 'gone', decision: 'allow' } }))
    .toEqual({ toast: '该申请已处理或已失效' })
})

test('非本中心 value 形态 → undefined 静默忽略', () => {
  const { center } = harness()
  expect(center.handleCardAction({ chatId: 'c', operatorOpenId: 'o', value: null })).toBeUndefined()
  expect(center.handleCardAction({ chatId: 'c', operatorOpenId: 'o', value: { unrelated: 1 } })).toBeUndefined()
})

test('signal abort → resolve cancelled 并定格已取消', async () => {
  const { sessions, presented, finalized, center } = harness()
  sessions.set('s1', fakeRt('s1'))
  const controller = new AbortController()
  const pending = center.handleRequest(ask('s1', controller.signal))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  controller.abort()
  await expect(pending).resolves.toBe('cancelled')
  await vi.waitFor(() => { expect(finalized).toEqual([{ status: 'cancelled' }]) })
})

test('signal 已 aborted：立即 cancelled（不注册监听防 zombie）', async () => {
  const { sessions, presented, center } = harness()
  sessions.set('s1', fakeRt('s1'))
  const controller = new AbortController()
  controller.abort()
  await expect(center.handleRequest(ask('s1', controller.signal))).resolves.toBe('cancelled')
  // 已 aborted 的 ask 不应发卡（无意义的卡片）
  expect(presented).toHaveLength(0)
})

test('发卡失败 → undefined + warn（回退其他审批通道）', async () => {
  const { sessions, warns, center } = harness({ presentError: new Error('cardkit boom') })
  sessions.set('s1', fakeRt('s1'))
  expect(await center.handleRequest(ask('s1'))).toBeUndefined()
  expect(warns.some((m) => m.includes('cardkit boom'))).toBe(true)
})

test('渠道无审批能力 → undefined + warn', async () => {
  const { sessions, warns, center } = harness()
  sessions.set('s1', fakeRt('s1', 'no-presenter-bot'))  // channelFor 只认 reviewer
  expect(await center.handleRequest(ask('s1'))).toBeUndefined()
  expect(warns).toHaveLength(1)
})

test('dispose 兜底：全部挂起项 settle cancelled', async () => {
  const { sessions, presented, center } = harness()
  sessions.set('s1', fakeRt('s1'))
  const pending = center.handleRequest(ask('s1'))
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  center.dispose()
  await expect(pending).resolves.toBe('cancelled')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/approval/center.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `center.ts`**

```ts
/** 审批中心（渠道无关）：自有 bot 会话的 approval ask → 渠道审批卡片挂起 → 卡片回调 resolve。
 *  spec: docs/superpowers/specs/2026-09-08-feishu-approval-card-design.md（飞书独占 / 仅发起人 / 不超时）。 */
import { randomUUID } from 'node:crypto'
import type { SessionRuntime } from '../ports.ts'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** waterfall answerer 收到的请求结构（结构子集化，不依赖宿主包类型）。 */
export interface ApprovalRequestLike {
  agent: { session: { id: unknown } }
  toolName: string
  reason?: string
  signal?: AbortSignal
}

/** 发给渠道的审批卡片内容。 */
export interface ApprovalPrompt {
  key: string
  chatId: string
  botName: string
  toolName: string
  reason?: string
}

/** 一次已展示的审批：finalize 把卡片定格为终态（实现内部 fire-and-forget 友好，失败自告警）。 */
export interface ApprovalPresentation {
  finalize(status: 'allowed' | 'rejected' | 'cancelled', operatorName?: string): Promise<void>
}

/** 渠道侧审批能力：发卡 → 返回定格句柄。 */
export interface ApprovalPresenter {
  present(prompt: ApprovalPrompt): Promise<ApprovalPresentation>
}

/** channelFor 的返回：该 bot 的审批能力 + 展示名。 */
export interface ApprovalChannel {
  presenter: ApprovalPresenter
  botName: string
}

/** 渠道回调入核的卡片动作（渠道已解析成渠道无关形态）。 */
export interface CardActionInput {
  chatId: string
  operatorOpenId: string
  operatorName?: string
  value: unknown
}

/** 回调应答（飞书侧经 WS 响应帧回 toast）。 */
export interface CardActionAck {
  toast?: string
}

interface PendingEntry {
  sessionId: string
  resolve(outcome: ApprovalOutcome): void
  presentation: ApprovalPresentation
  signal: AbortSignal | undefined
  onAbort: () => void
}

export class ApprovalCenter {
  private readonly pending = new Map<string, PendingEntry>()

  constructor(
    private readonly sessions: Map<string, SessionRuntime>,
    private readonly channelFor: (botId: string) => ApprovalChannel | undefined,
    private readonly warn: (message: string) => void,
    private readonly newId: () => string = randomUUID,
  ) {}

  async handleRequest(req: ApprovalRequestLike): Promise<ApprovalOutcome | undefined> {
    const sessionId = String(req.agent.session.id)
    const rt = this.sessions.get(sessionId)
    if (rt === undefined) return undefined
    // 已取消的 ask 不发卡不回退：直接 cancelled（与 api-proxy 的同步 settle 对齐，
    // 防 abort 落在注册监听之前的 zombie 窗口）。
    if (req.signal?.aborted === true) return 'cancelled'
    const channel = this.channelFor(rt.botId)
    if (channel === undefined) {
      this.warn(`[project-bot] bot "${rt.botId}" 的渠道无审批能力，回退其他审批通道`)
      return undefined
    }
    const key = this.newId()
    let presentation: ApprovalPresentation
    try {
      presentation = await channel.presenter.present({
        key, chatId: rt.chatId, botName: channel.botName, toolName: req.toolName,
        ...(req.reason !== undefined ? { reason: req.reason } : {}),
      })
    } catch (error) {
      this.warn(`[project-bot] 审批卡片发送失败，回退其他审批通道：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: PendingEntry = {
        sessionId, resolve, presentation, signal: req.signal,
        onAbort: () => this.settle(key, 'cancelled'),
      }
      this.pending.set(key, entry)
      req.signal?.addEventListener('abort', entry.onAbort, { once: true })
    })
  }

  handleCardAction(action: CardActionInput): CardActionAck | undefined {
    const value = action.value as { key?: unknown; decision?: unknown } | null
    if (value === null || typeof value !== 'object' || typeof value.key !== 'string'
      || (value.decision !== 'allow' && value.decision !== 'reject')) return undefined
    const entry = this.pending.get(value.key)
    if (entry === undefined) return { toast: '该申请已处理或已失效' }
    const rt = this.sessions.get(entry.sessionId)
    if (rt === undefined || rt.initiatorOpenId !== action.operatorOpenId) {
      return { toast: '仅会话发起人可审批' }
    }
    this.settle(value.key, value.decision === 'allow' ? 'allowed-once' : 'rejected', action.operatorName)
    return { toast: value.decision === 'allow' ? '已允许' : '已拒绝' }
  }

  dispose(): void {
    for (const key of [...this.pending.keys()]) this.settle(key, 'cancelled')
  }

  private settle(key: string, outcome: ApprovalOutcome, operatorName?: string): void {
    const entry = this.pending.get(key)
    if (entry === undefined) return
    this.pending.delete(key)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    entry.resolve(outcome)
    const status = outcome === 'allowed-once' ? 'allowed' : outcome === 'rejected' ? 'rejected' : 'cancelled'
    void entry.presentation.finalize(status, operatorName).catch((error: unknown) => {
      this.warn(`[project-bot] 审批卡片定格失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/approval/center.test.ts`
Expected: PASS（11 条）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/approval/
git commit -m "feat(toolkit): ApprovalCenter 渠道无关审批核心（发卡挂起 + 回调 resolve + 越权校验）"
```

---

### Task 3: 渠道端口扩展 + BotRuntime 集成

**Files:**
- Modify: `packages/toolkit/src/channels/channel.ts`（ChannelIO / ChannelHandle 扩展）
- Modify: `packages/toolkit/src/channels/runtime.ts`（构造 center、io 接线、stopAll dispose）
- Test: `packages/toolkit/src/channels/runtime.test.ts`

**Interfaces:**
- Consumes: `ApprovalCenter` / `ApprovalPresenter` / `CardActionInput` / `CardActionAck`（Task 2）。
- Produces:
  - `ChannelIO.onCardAction?(action: CardActionInput): CardActionAck | undefined`（Task 5 飞书渠道实现消费）
  - `ChannelHandle.approval?: ApprovalPresenter`（Task 4 飞书 presenter 挂这里）
  - `BotRuntime.approval: ApprovalCenter`（Task 6 answerer 消费）

- [ ] **Step 1: 写失败测试**（追加进 `runtime.test.ts`）

```ts
// 文件顶部 import 增补：
// import type { ApprovalPrompt, CardActionAck, CardActionInput } from './approval/center.ts'
// import type { ReplyHandle } from './channel.ts'

/** 带审批能力的渠道 harness：capture io + 记录 present 的 key。 */
function approvalHarness() {
  let io: { onMessage(m: unknown): void; onCardAction?(a: CardActionInput): CardActionAck | undefined } | undefined
  const presented: ApprovalPrompt[] = []
  const channel: BotChannel = {
    type: 'feishu',
    start: async (_bot, channelIo) => {
      io = channelIo as typeof io
      return {
        close: async () => undefined,
        status: () => 'connected' as const,
        approval: {
          present: async (prompt: ApprovalPrompt) => {
            presented.push(prompt)
            return { finalize: async () => undefined }
          },
        },
      }
    },
  }
  const fakeReply: ReplyHandle = {
    beginTurn: async () => undefined, update: async () => undefined,
    finalize: async () => undefined, notice: async () => undefined,
  }
  const { runtime } = harness({
    channels: new Map([['feishu', channel]]),
    agents: {
      create: async (input: { sessionId: string }) => ({
        sessionId: input.sessionId,
        followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined,
      }),
      resume: async (input: { sessionId: string }) => ({
        sessionId: input.sessionId,
        followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined,
      }),
    } as unknown as RuntimeDeps['agents'],
  })
  return { runtime, fakeReply, presented, ioOf: () => io }
}

test('审批集成：渠道 approval presenter 发卡，io.onCardAction 路由回 center resolve', async () => {
  const { runtime, fakeReply, presented, ioOf } = approvalHarness()
  await runtime.startAll()
  const rt = await runtime.router.ensure(BOT, 'oc_chat1', fakeReply, 'ou_initiator')
  const pending = runtime.approval.handleRequest({ agent: { session: { id: rt.sessionId } }, toolName: 'write' })
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  // 经渠道 io 回调（与真实 card.action.trigger 同路径）
  const ack = ioOf()!.onCardAction!({ chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', value: { key: presented[0]!.key, decision: 'reject' } })
  expect(ack).toEqual({ toast: '已拒绝' })
  await expect(pending).resolves.toBe('rejected')
})

test('stopAll 兜底 dispose：挂起审批 settle cancelled', async () => {
  const { runtime, fakeReply, presented } = approvalHarness()
  await runtime.startAll()
  const rt = await runtime.router.ensure(BOT, 'oc_chat1', fakeReply, 'ou_initiator')
  const pending = runtime.approval.handleRequest({ agent: { session: { id: rt.sessionId } }, toolName: 'write' })
  await vi.waitFor(() => { expect(presented).toHaveLength(1) })
  await runtime.stopAll()
  await expect(pending).resolves.toBe('cancelled')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/runtime.test.ts`
Expected: FAIL（`runtime.approval` 不存在 / io 无 onCardAction）

- [ ] **Step 3: 实现**

`channel.ts`（import Task 2 类型，保持渠道抽象不感知飞书 SDK 的既有约束）：

```ts
import type { ApprovalPresenter, CardActionAck, CardActionInput } from './approval/center.ts'

export interface ChannelIO {
  /** fire-and-forget：渠道 handler 须快速返回（飞书 WS 3 秒限制），业务异步消化。 */
  onMessage(msg: InboundMessage): void
  /** 卡片按钮回调入核（审批）；渠道无交互卡片时可不实现。返回值经渠道应答帧回执（toast）。 */
  onCardAction?(action: CardActionInput): CardActionAck | undefined
}

export interface ChannelHandle {
  close(): Promise<void>
  status(): ChannelStatus
  /** 该渠道的审批卡片能力（有交互卡片的渠道实现；缺席 = ask 回退其他审批通道）。 */
  approval?: ApprovalPresenter
}
```

`runtime.ts`：

- import：`import { ApprovalCenter } from './approval/center.ts'`
- 类加字段与构造（constructor 末尾）：

```ts
readonly approval: ApprovalCenter
// constructor 内：
this.approval = new ApprovalCenter(
  this.sessions,
  (botId) => {
    const presenter = this.handles.get(botId)?.approval
    if (presenter === undefined) return undefined
    return { presenter, botName: this.deps.bots.get(botId)?.name ?? botId }
  },
  (m) => deps.log.warn(m),
)
```

- `reconcile` 的 io 实参（L85）改为：

```ts
{ onMessage: (msg) => this.inbound.onMessage(msg), onCardAction: (action) => this.approval.handleCardAction(action) },
```

- `stopAll` 末尾（handles.clear() 之后）加 `this.approval.dispose()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/channel.ts packages/toolkit/src/channels/runtime.ts packages/toolkit/src/channels/runtime.test.ts
git commit -m "feat(toolkit): BotRuntime 集成 ApprovalCenter（渠道端口 onCardAction/approval）"
```

---

### Task 4: 飞书审批卡片 presenter

**Files:**
- Create: `packages/toolkit/src/channels/approval/feishu.ts`
- Test: `packages/toolkit/src/channels/approval/feishu.test.ts`

**Interfaces:**
- Consumes: `ApprovalPresenter` / `ApprovalPrompt`（Task 2）、`FeishuApi`（`channels/feishu/api.ts`，复用 `createCard`/`sendCardMessage`/`replaceCard`，不新增 API 方法）、`withRetry`（`channels/feishu/reply.ts`）。
- Produces: `FeishuApprovalPresenter implements ApprovalPresenter`，构造签名 `new FeishuApprovalPresenter(api: FeishuApi, log: (message: string) => void)`（Task 5 在渠道 start 里挂到 ChannelHandle.approval）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test, vi } from 'vitest'
import { buildApprovalCardJson, buildApprovalFinalCardJson, FeishuApprovalPresenter } from './feishu.ts'
import type { FeishuApi } from '../feishu/api.ts'

const PROMPT = { key: 'k1', chatId: 'oc_chat1', botName: '评审', toolName: 'write', reason: '需要写入文件' }

test('审批卡 JSON：markdown 正文 + 允许/拒绝按钮，value 编码 key 与 decision', () => {
  const card = JSON.parse(buildApprovalCardJson(PROMPT))
  expect(card.schema).toBe('2.0')
  const body = JSON.stringify(card.body)
  expect(body).toContain('评审')
  expect(body).toContain('write')
  expect(body).toContain('需要写入文件')
  const buttons = card.body.elements.flatMap((e: { actions?: unknown[] }) => e.actions ?? [])
  expect(buttons).toHaveLength(2)
  expect(buttons[0]).toMatchObject({ tag: 'button', type: 'primary', behaviors: [{ type: 'callback', value: { key: 'k1', decision: 'allow' } }] })
  expect(buttons[1]).toMatchObject({ tag: 'button', type: 'danger', behaviors: [{ type: 'callback', value: { key: 'k1', decision: 'reject' } }] })
})

test('终态卡 JSON：无按钮，状态文案区分允许/拒绝/取消', () => {
  const allowed = JSON.stringify(JSON.parse(buildApprovalFinalCardJson(PROMPT, 'allowed', '张三')))
  expect(allowed).toContain('已允许')
  expect(allowed).toContain('张三')
  expect(allowed).not.toContain('"button"')
  expect(JSON.stringify(JSON.parse(buildApprovalFinalCardJson(PROMPT, 'rejected')))).toContain('已拒绝')
  expect(JSON.stringify(JSON.parse(buildApprovalFinalCardJson(PROMPT, 'cancelled')))).toContain('已取消')
})

function fakeApi(overrides: Partial<FeishuApi> = {}) {
  return {
    calls: [] as string[],
    createCard: vi.fn(async () => 'card_1'),
    sendCardMessage: vi.fn(async () => undefined),
    replaceCard: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as FeishuApi & { calls: string[] }
}

test('present = 建卡 + 发消息（withRetry 包裹）；finalize = replaceCard sequence 1', async () => {
  const api = fakeApi()
  const presenter = new FeishuApprovalPresenter(api, () => undefined)
  const presentation = await presenter.present(PROMPT)
  expect(api.createCard).toHaveBeenCalledTimes(1)
  expect(api.sendCardMessage).toHaveBeenCalledWith('oc_chat1', 'card_1')
  await presentation.finalize('allowed', '张三')
  expect(api.replaceCard).toHaveBeenCalledWith('card_1', expect.any(String), 1)
})

test('建卡失败：错误传播（ApprovalCenter 回退 next 的前提）', async () => {
  const api = fakeApi({ createCard: vi.fn(async () => { throw new Error('cardkit boom') }) })
  const presenter = new FeishuApprovalPresenter(api, () => undefined)
  await expect(presenter.present(PROMPT)).rejects.toThrow('cardkit boom')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/approval/feishu.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `feishu.ts`**

```ts
/** 飞书审批卡片：cardkit 2.0 静态卡（非流式）+ callback 按钮；presenter 挂在渠道 ChannelHandle.approval。 */
import type { FeishuApi } from '../feishu/api.ts'
import { withRetry } from '../feishu/reply.ts'
import type { ApprovalPresentation, ApprovalPresenter, ApprovalPrompt } from './center.ts'

const STATUS_TEXT: Record<'allowed' | 'rejected' | 'cancelled', string> = {
  allowed: '✅ 已允许',
  rejected: '❌ 已拒绝',
  cancelled: '⏹ 已取消',
}

function bodyMarkdown(prompt: ApprovalPrompt): string {
  const lines = [`**Bot**：${prompt.botName}`, `**工具**：\`${prompt.toolName}\``]
  if (prompt.reason !== undefined) lines.push(`**理由**：${prompt.reason}`)
  return lines.join('\n')
}

function button(text: string, type: 'primary' | 'danger', key: string, decision: 'allow' | 'reject'): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value: { key, decision } }],
  }
}

/** 审批卡（带按钮）；summary 供会话列表/推送预览。 */
export function buildApprovalCardJson(prompt: ApprovalPrompt): string {
  return JSON.stringify({
    schema: '2.0',
    config: { summary: { content: `权限申请：${prompt.toolName}` } },
    header: { title: { tag: 'plain_text', content: '权限申请' }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown', content: bodyMarkdown(prompt) },
        { tag: 'action', actions: [button('允许', 'primary', prompt.key, 'allow'), button('拒绝', 'danger', prompt.key, 'reject')] },
      ],
    },
  })
}

/** 终态卡（无按钮）：定格审批结果；operatorName 仅允许/拒绝时有。 */
export function buildApprovalFinalCardJson(prompt: ApprovalPrompt, status: 'allowed' | 'rejected' | 'cancelled', operatorName?: string): string {
  const statusLine = STATUS_TEXT[status] + (operatorName !== undefined ? ` · ${operatorName}` : '')
  const template = status === 'allowed' ? 'green' : status === 'rejected' ? 'red' : 'grey'
  return JSON.stringify({
    schema: '2.0',
    config: { summary: { content: `权限申请${STATUS_TEXT[status].slice(2).trim()}：${prompt.toolName}` } },
    header: { title: { tag: 'plain_text', content: `权限申请 · ${statusLine}` }, template },
    body: { elements: [{ tag: 'markdown', content: bodyMarkdown(prompt) }] },
  })
}

/** 飞书审批能力：present = 建卡 + 发消息；finalize = replaceCard 定格（sequence 从 1 起，create/send 不占）。 */
export class FeishuApprovalPresenter implements ApprovalPresenter {
  constructor(
    private readonly api: FeishuApi,
    private readonly log: (message: string) => void,
  ) {}

  async present(prompt: ApprovalPrompt): Promise<ApprovalPresentation> {
    const cardId = await withRetry(() => this.api.createCard(buildApprovalCardJson(prompt)))
    await withRetry(() => this.api.sendCardMessage(prompt.chatId, cardId))
    return {
      finalize: async (status, operatorName) => {
        try {
          await withRetry(() => this.api.replaceCard(cardId, buildApprovalFinalCardJson(prompt, status, operatorName), 1))
        } catch (error) {
          // 定格失败不吞审批结果：卡片残留按钮但回调侧已 settle（重复点击 toast 已失效）。
          this.log(`[project-bot] 审批卡片定格失败（card ${cardId}）：${error instanceof Error ? error.message : String(error)}`)
        }
      },
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/approval/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/approval/feishu.ts packages/toolkit/src/channels/approval/feishu.test.ts
git commit -m "feat(toolkit): 飞书审批卡片 presenter（cardkit 2.0 callback 按钮 + 终态定格）"
```

---

### Task 5: 飞书渠道接入 card.action.trigger

**Files:**
- Create: `packages/toolkit/src/channels/feishu/card-action.ts`（可测纯函数）
- Modify: `packages/toolkit/src/channels/feishu/index.ts`（dispatcher 注册 + handle.approval）
- Test: `packages/toolkit/src/channels/feishu/card-action.test.ts`

**Interfaces:**
- Consumes: `CardActionInput`/`CardActionAck`（Task 2）、`ChannelIO.onCardAction`/`ChannelHandle.approval`（Task 3）、`FeishuApprovalPresenter`（Task 4）、SDK 导出 `normalizeCardAction` / `RawCardActionEvent`（已核实：`@larksuiteoapi/node-sdk` 1.7.x 导出，`CardActionEvent = { messageId, chatId, operator: { openId, userId?, name? }, action: { value, tag, ... } }`）。
- Produces:
  - `toCardActionInput(raw: unknown): CardActionInput | undefined`
  - `toastResponse(ack: CardActionAck | undefined): { toast: { type: 'info'; content: string } } | undefined`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'vitest'
import { toCardActionInput, toastResponse } from './card-action.ts'

// 形状对齐 SDK normalizeCardAction 的输入（RawCardActionEvent：context 嵌套 + operator/action）
const RAW = {
  context: { open_message_id: 'om_1', open_chat_id: 'oc_chat1' },
  operator: { open_id: 'ou_initiator', name: '张三' },
  action: { tag: 'button', value: { key: 'k1', decision: 'allow' } },
}

test('raw 卡片回调 → CardActionInput（chatId/operatorOpenId/operatorName/value）', () => {
  expect(toCardActionInput(RAW)).toEqual({
    chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', operatorName: '张三',
    value: { key: 'k1', decision: 'allow' },
  })
})

test('畸形 raw → undefined', () => {
  expect(toCardActionInput(null)).toBeUndefined()
  expect(toCardActionInput({})).toBeUndefined()
  expect(toCardActionInput({ operator: {}, action: { tag: 'button' } })).toBeUndefined()
})

test('toastResponse：有 toast 才产生应答帧负载', () => {
  expect(toastResponse(undefined)).toBeUndefined()
  expect(toastResponse({})).toBeUndefined()
  expect(toastResponse({ toast: '已允许' })).toEqual({ toast: { type: 'info', content: '已允许' } })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/feishu/card-action.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `card-action.ts` + 接线 `index.ts`**

`card-action.ts`：

```ts
/** card.action.trigger 回调解析：SDK normalizeCardAction → 渠道无关 CardActionInput；toast 应答帧负载。 */
import * as lark from '@larksuiteoapi/node-sdk'
import type { CardActionAck, CardActionInput } from '../approval/center.ts'

/** raw → CardActionInput；normalize 失败（畸形/缺字段）→ undefined。 */
export function toCardActionInput(raw: unknown): CardActionInput | undefined {
  const evt = lark.normalizeCardAction(raw as lark.RawCardActionEvent)
  if (evt === null) return undefined
  return {
    chatId: evt.chatId,
    operatorOpenId: evt.operator.openId,
    ...(evt.operator.name !== undefined ? { operatorName: evt.operator.name } : {}),
    value: evt.action.value,
  }
}

/** WS 应答帧负载：handler 返回值经 WSClient 回传（lib/index.js handleEventData：truthy result → respPayload.data）。 */
export function toastResponse(ack: CardActionAck | undefined): { toast: { type: 'info'; content: string } } | undefined {
  if (ack?.toast === undefined) return undefined
  return { toast: { type: 'info', content: ack.toast } }
}
```

`feishu/index.ts` 三处改动：

1. import 增补：

```ts
import { FeishuApprovalPresenter } from '../approval/feishu.ts'
import { toCardActionInput, toastResponse } from './card-action.ts'
```

2. dispatcher.register 的 handles 对象加第三个 key（WS 3 秒窗口：normalize + 同步 resolve，无 await API）。`register<T>` 泛型容许 IHandles 之外的 key：

```ts
    const dispatcher = new lark.EventDispatcher({}).register<{ 'card.action.trigger': (raw: unknown) => unknown }>({
      // ……既有两个 key 不动……
      // 卡片按钮回调（审批）：同步入核，toast 经 WS 应答帧回执。
      'card.action.trigger': (raw: unknown) => {
        if (io.onCardAction === undefined) return undefined
        const action = toCardActionInput(raw)
        if (action === undefined) return undefined
        return toastResponse(io.onCardAction(action)) ?? undefined
      },
    })
```

3. `start` 返回的 ChannelHandle 加 approval（chatId 由 ApprovalPrompt 携带，presenter 只绑定 api）：

```ts
    return {
      approval: new FeishuApprovalPresenter(api, log),
      close: () => { …既有… },
      status: () => …既有…,
    }
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/feishu/`
Expected: PASS
Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS（若 SDK 的 `normalizeCardAction`/`RawCardActionEvent` 导出路径或 register 泛型形式不匹配，按 typecheck 报错调整 import 形态，行为不变）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/feishu/card-action.ts packages/toolkit/src/channels/feishu/card-action.test.ts packages/toolkit/src/channels/feishu/index.ts
git commit -m "feat(toolkit): 飞书渠道接入 card.action.trigger（WS 长连接回调 + toast 应答）"
```

---

### Task 6: answerer 注册 + Config 开关

**Files:**
- Create: `packages/toolkit/src/channels/approval/answerer.ts`
- Modify: `packages/toolkit/src/bots/index.ts`（BotsModuleConfig + ctx.on 注册）
- Modify: `packages/toolkit/src/index.ts`（feishu schema 加 `approval`）
- Test: `packages/toolkit/src/channels/approval/answerer.test.ts`

**Interfaces:**
- Consumes: `ApprovalCenter`（Task 2）、`BotRuntime.approval`（Task 3）。
- Produces: `createApprovalAnswerer(centerOf: () => ApprovalCenter | undefined)`，返回 `(req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test, vi } from 'vitest'
import { createApprovalAnswerer } from './answerer.ts'
import type { ApprovalCenter, ApprovalOutcome, ApprovalRequestLike } from './center.ts'

const REQ: ApprovalRequestLike = { agent: { session: { id: 's1' } }, toolName: 'write' }

function fakeCenter(outcome: ApprovalOutcome | undefined): ApprovalCenter {
  return { handleRequest: vi.fn(async () => outcome) } as unknown as ApprovalCenter
}

test('center 缺席（runtime 未启动）→ next 透传', async () => {
  const answerer = createApprovalAnswerer(() => undefined)
  const next = vi.fn(async () => 'unavailable' as const)
  expect(await answerer(REQ, next)).toBe('unavailable')
  expect(next).toHaveBeenCalledTimes(1)
})

test('center 返回 undefined（非自有会话/发卡失败）→ next 透传', async () => {
  const answerer = createApprovalAnswerer(() => fakeCenter(undefined))
  const next = vi.fn(async () => 'unavailable' as const)
  expect(await answerer(REQ, next)).toBe('unavailable')
})

test('center 给出结果 → 直接返回，不调 next（飞书独占语义）', async () => {
  const answerer = createApprovalAnswerer(() => fakeCenter('allowed-once'))
  const next = vi.fn(async () => 'unavailable' as const)
  expect(await answerer(REQ, next)).toBe('allowed-once')
  expect(next).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/approval/answerer.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`answerer.ts`：

```ts
/** approval/request waterfall answerer 工厂：自有 bot 会话走 ApprovalCenter（飞书卡片），
 *  其余 next() 透传（web api-proxy / ACP 等）。prepend 注册抢在 api-proxy 前（其从不 next 让出）。 */
import type { ApprovalCenter, ApprovalOutcome, ApprovalRequestLike } from './center.ts'

export function createApprovalAnswerer(
  centerOf: () => ApprovalCenter | undefined,
): (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome> {
  return async (req, next) => {
    const outcome = await centerOf()?.handleRequest(req)
    return outcome ?? next()
  }
}
```

`bots/index.ts`：

- `BotsModuleConfig` 加字段（含 JSDoc）：`/** 飞书审批卡片：bot 会话的工具提权申请改由飞书卡片审批（仅会话发起人可点）。 */ approval: boolean`
- `setupBots` 内（`ctx.on('session/event', …)` 附近）加：

```ts
  // 审批 answerer：prepend 抢在 web api-proxy 全局 answerer 之前（其从不 next 让出）；
  // runtime 未启动/非自有会话/发卡失败时 createApprovalAnswerer 内部 next() 透传，行为回到现状。
  if (config.approval) {
    ctx.on('approval/request', createApprovalAnswerer(() => runtime?.approval), { prepend: true })
  }
```

- import 增补：`import { createApprovalAnswerer } from '../channels/approval/answerer.ts'`

`src/index.ts` Config schema：`feishu: z.object({…})` 加 `approval: z.boolean().default(true)`，外层 `.default({…})` 字面量加 `approval: true`。

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/approval/`
Expected: PASS
Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS（`ctx.on` 第三参 `{ prepend: true }` 与 waterfall 事件类型由 cordis/宿主声明合并提供；若 `approval/request` 事件名未在 Context 事件声明里，补 type-only import：`import type {} from '@deepseek-ai/dsh-user-approval'`——照 api-proxy.ts L87-90 同款做法）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/approval/answerer.ts packages/toolkit/src/channels/approval/answerer.test.ts packages/toolkit/src/bots/index.ts packages/toolkit/src/index.ts
git commit -m "feat(toolkit): 注册飞书审批 answerer（prepend 抢 api-proxy）+ feishu.approval 开关"
```

---

### Task 7: 扫码建应用补卡片回调订阅

**Files:**
- Modify: `packages/toolkit/src/bots/register-app.ts:7-19`
- Test: `packages/toolkit/src/bots/register-app.test.ts`

**Interfaces:**
- Produces: `FEISHU_REGISTER_APP_ADDONS.callbacks.items = ['card.action.trigger']`（SDK `AppAddons.callbacks` 已核实存在，`types/index.d.ts` L31913-31916）。

- [ ] **Step 1: 写失败测试**

在 `register-app.test.ts` 追加：

```ts
test('addons 声明卡片回传回调（card.action.trigger）', () => {
  expect(FEISHU_REGISTER_APP_ADDONS.callbacks.items).toContain('card.action.trigger')
})
```

（文件若无 `FEISHU_REGISTER_APP_ADDONS` import 则补上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/bots/register-app.test.ts`
Expected: FAIL（`callbacks` undefined）

- [ ] **Step 3: 实现**

`register-app.ts` L4-19 改为（注释与结构同步更新）：

```ts
/** 扫码创建应用时申请的权限/事件/回调（流式卡片 + 收发消息 + 表情 + 通讯录基础信息 + 审批卡片回传）。
 *  故意不加 as const：readonly 元组不可赋值给 SDK AppAddons 的 mutable string[]，
 *  否则 bots/index.ts 的 lark.registerApp(options) 透传会 typecheck 失败。 */
export const FEISHU_REGISTER_APP_ADDONS = {
  scopes: {
    tenant: [
      'im:message',
      'im:message:send_as_bot',
      'cardkit:card:write',
      'contact:user.base:readonly',
    ],
  },
  events: {
    items: { tenant: ['im.message.receive_v1'] },
  },
  callbacks: {
    items: ['card.action.trigger'],
  },
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/bots/register-app.test.ts`
Expected: PASS
Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/bots/register-app.ts packages/toolkit/src/bots/register-app.test.ts
git commit -m "feat(toolkit): 扫码建应用补 card.action.trigger 回调订阅（审批卡片前提）"
```

---

### Task 8: ask_user 方向 1（引导文案 + 守护测试）

**Files:**
- Modify: `packages/toolkit/src/channels/basic-tools.ts:19`（persona 文本补引导句）
- Test: `packages/toolkit/src/channels/basic-tools.test.ts`、`packages/toolkit/src/agents/bot-preset.test.ts`

**Interfaces:**
- 无新接口；守护不变量：bot 会话工具面（BASIC_TOOLS / agent-bot preset）不含 `tool-ask-user`。

- [ ] **Step 1: 写失败测试**

`basic-tools.test.ts` 追加（或修改既有 persona 断言）：

```ts
test('bot 会话 persona 含"直接提问"引导（bot 工具面无 ask_user，IM 场景普通消息往返即提问）', () => {
  const persona = BASIC_TOOLS.find((t) => t.id === '@deepseek-ai/dsh-persona')
  expect(persona?.config?.text).toContain('ask directly in your reply')
})

test('BASIC_TOOLS 不含 ask_user（守护：防未来无意引入 web 独占的提问通道）', () => {
  expect(BASIC_TOOLS.map((t) => t.id)).not.toContain('@deepseek-ai/dsh-tool-ask-user')
})
```

`bot-preset.test.ts` 追加：

```ts
test('agent-bot preset 序列化不含 ask_user（守护）', () => {
  expect(botPresetComposition()).not.toContain('ask-user')
  expect(botPresetComposition()).not.toContain('ask_user')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/basic-tools.test.ts src/agents/bot-preset.test.ts`
Expected: 第一条 FAIL（persona 无引导句）；后两条 PASS（现状守护，防止回归）

- [ ] **Step 3: 实现**

`basic-tools.ts` persona config 文本改为：

```ts
    config: { text: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}. If you need information or a decision from the user, ask directly in your reply and wait for their next message.' },
```

注意：`tool-scope.test.ts` / `basic-tools.test.ts` 若有对该文本的**精确相等**断言，同步更新为新文本。

- [ ] **Step 4: 跑相关测试确认全绿**

Run: `pnpm --filter dsh-agent-toolkit vitest run src/channels/ src/agents/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/basic-tools.ts packages/toolkit/src/channels/basic-tools.test.ts packages/toolkit/src/agents/bot-preset.test.ts
git commit -m "feat(toolkit): bot 会话 persona 补直接提问引导 + ask_user 缺席守护测试"
```

---

### Task 9: 全量验证 + 文档收尾

**Files:**
- Modify: `AGENTS.md`（dsh 插件开发要点段补审批机制）
- Modify: `docs/usage/`（飞书 bot 使用手册补审批卡片一节；具体文件名按现有手册结构定，先 `Glob docs/usage/*.md` 找 bots 相关篇）

- [ ] **Step 1: 全量单测 + 类型检查 + bundle**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: 全 PASS
Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS
Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 产出 lib/index.js + lib/client.js 无报错

- [ ] **Step 2: AGENTS.md 更新**

在「dsh 插件开发要点」的飞书相关段落末尾补一条（措辞按该文件现有风格精简）：

> 飞书审批卡片（0.2.9 预定）：bot 会话工具提权经 `channels/approval/`（ApprovalCenter 渠道无关核心 + 飞书 presenter）处理——`ctx.on('approval/request', …, { prepend: true })` 抢在 web api-proxy 前、按 sessions map 过滤自有会话（非自有 next() 透传）；按钮回调经 WS 长连接 `card.action.trigger`（同 dispatcher 注册，toast 走应答帧返回值）；仅会话发起人可批（`SessionRuntime.initiatorOpenId` 比对）；发卡失败回退 next() 不吞审批；开关 `feishu.approval` 默认 true；扫码建应用 addons 含 `callbacks: ['card.action.trigger']`（存量应用需在开发者后台补开卡片回传）。bot 会话工具面不含 ask_user（守护测试钉住），IM 场景模型直接在回复里提问（basic-tools.ts persona 引导句）。

- [ ] **Step 3: 使用手册补审批卡片说明**

在 `docs/usage/` 的飞书 bot 篇补一小节：权限申请卡片长什么样（允许/拒绝）、仅发起人可点、`/new` 或取消会话后卡片标记已取消、存量应用需在飞书开发者后台补开「卡片回传」订阅（新扫码建的应用自动带）。界面截图留待真实委派/审批跑通后补拍（与既有"委派卡截图待补拍"惯例一致）。

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/usage/
git commit -m "docs: 飞书审批卡片机制进 AGENTS.md 与使用手册"
```

- [ ] **Step 5: 真实环境验证（人工，发版前 parity 回路）**

按 AGENTS.md 开发回路：安装版 dsh + link 插件 → 建 bot（扫码新建确认 addons 带卡片回传；存量应用开发者后台补开）→ 飞书发消息触发需提权工具 → 卡片点允许/拒绝 → 群聊越权点击 → `/new` 取消路径。发现问题回本计划修复，**不直接发版**。
