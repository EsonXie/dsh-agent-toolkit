# 飞书流式输出 0.1.5 迁移设计（assistant/chunk → agent/assistant-stream + assistant/message）

日期：2026-09-10
状态：已实施（2026-09-10，commit 0422164acb）
来源：`docs/superpowers/plans/2026-09-10-dsh-0.1.5-compat-upgrade.md` 待办④

## 背景与问题

宿主 0.1.5-rc.1 删除 session 事件 `assistant/chunk`（只结算 `assistant/message` + 新增 `assistant/attempt`，见台账破坏性变更清单第 2 条）。toolkit 飞书卡片流式打字机的 chunk 消费链在 `packages/toolkit/src/channels/outbound.ts:85-108`，事件源为 `bots/index.ts:183-185` 的 `ctx.on('session/event', …)`。0.1.5 不再产生 `assistant/chunk` 后该链不会报错但永远收不到流式增量 → 卡片只建卡不流式：`turn/start` 置 `rt.turn` 后无任何 chunk 进段，`turn/end` 直接定格一张空卡（或带 error detail 的降级文本）。**该功能对 0.1.5 为硬性回归，必须迁移。**

现状消费链全貌（读透）：

```
bots/index.ts:183  ctx.on('session/event', (session, event) => runtime.outbound.handleSessionEvent(session.header.id, event))
outbound.handleSessionEvent:
  turn/start   → rt.turn = { n, segments: [], began: false }        (outbound.ts:80-83，同步)
  assistant/chunk → 按 chunk.type 分流进段，enqueue beginTurn+update  (outbound.ts:85-108，已失效)
  tool/call    → process 段追加 🔧 name — args\n\n，enqueue update   (outbound.ts:110-126)
  turn/end     → mapTurnEnd + finalize + 释放 inflight + 删表情      (outbound.ts:128-142)
  每会话 rt.tail Promise 链保序（enqueue，outbound.ts:161-165）
```

段模型：`TurnSegment { kind: 'text'|'process'; content }`，`appendToSegments` 与尾段同类合并、异类开新段（outbound.ts:23-27）；流式增量只取 `text-delta`（进正文）、`reasoning-delta`（进过程）、`block-end(block.type==='reasoning')`（过程段补段落分隔 `\n\n`），其余 chunk 类型忽略。卡片侧 `FeishuReplyHandle.update(segments)` 全量快照 + 节流（`reply.ts:48-58`），`finalize(status, detail)` 定格（`reply.ts:60-86`）；卡片 op 确认式状态机（planSync/commit、seq 单调）在 `cards.ts`/`reply.ts`，本次不改。

## 宿主 0.1.5 新机制（读透，全部为源码证据）

### 1. `agent/assistant-stream`：agent 级 scoped emit，瞬态帧

- 事件声明：`packages/core/agent/src/runtime-types.ts:365-373` `'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame })`，`@mode emit`，注明「agent-scoped listeners receive only that agent」。
- 帧类型：`runtime-types.ts:128-161` `AssistantStreamFrame`：
  - `{ type:'start'; attemptId; revision; turn; step }`
  - `{ type:'chunk'; attemptId; revision; index; time; chunk: StreamChunk }`
  - `{ type:'end'; attemptId; revision; index; outcome: {kind:'committed', eventType:'assistant/message'|'assistant/attempt', seq} | {kind:'abandoned'} }`
- 发射点：`packages/core/agent-loop/src/agent.ts:380-387` `new AssistantStreamAttempt(…, frame => this.dispatch.emit('agent/assistant-stream', { frame }))`；`assistant-stream.ts:49-57`（start）、`61-71`（chunk，每次 `push` 一帧，`chunk` 为原始 `StreamChunk`）、`78-97`（end，**先 `append()` 持久结算事件、后 emit end**）、`100-109`（abandoned）。
- 订阅语义：scoped 事件用 `@deepseek-ai/dsh-scope` 载体（`agent/dispatch.ts:94-96` `agentCarrier` → `scopeTarget`）。`scope/index.ts:170-185`：未打 scope 标签的监听者**全局收到**（`tag === undefined → true`），带标签者只在「自身 key 或其祖先 key」收到，**事件只向祖先进发、不向子级下传**。宿主自身在 app 级 `ctx.on` 消费的先例：`packages/bundle/headless/src/index.ts:112`（无 global 选项）、`packages/api/session-controller/src/history.ts:54`（`{ global: true }`，因其服务在嵌套 fiber 注册）。toolkit 现有 `session/event`/`agent/error` 订阅均为 app 级无 global（`bots/index.ts:183-199`），与 headless 先例一致 → **app 级 `ctx.on('agent/assistant-stream', …)` 即可收到全部 agent 的帧，按 `agent.session.id` 过滤自有会话**。
- emit 同步且失败隔离：`agent/dispatch.ts:120-137` 逐个同步调用回调，throw/rejection 记 log 不阻断 → **帧是瞬态的，监听者丢帧后无重传**（这是后续「持久结算对账」的依据）。
- `agent/assistant-stream` 也在 `packages/core/scope/src/scoped-events.generated.ts:11` 注册为 scope-filtered 路由主体（`args[0].agent`），配 `scope/src/invariant.ts` 校验载体与 subject 一致。

### 2. 持久结算事件：`assistant/message` / `assistant/attempt`

- `packages/core/session/src/types.ts:321-329` `'assistant/message': { turn; step; message: AssistantMessage; stream: AssistantStreamRecord[]; usage?; interrupted?: true }`（注释：取消中断流的已交付前缀会以 `interrupted:true` 结算为本事件）。
- `types.ts:335` `'assistant/attempt': { turn; step; stream: AssistantStreamRecord[] }`（「committed no surface message」的失败/重试/取消/流错误尝试）。
- 结算落点 `agent-loop/src/agent.ts`：
  - 正常完成：`474-483` `settle('assistant/message', () => session.append('assistant/message', { turn, step, message, …, stream: live.stream }))`；
  - 取消且有可见前缀：`402-419`（`interrupted:true`）；取消无内容 / 流异常：`421-431` 与 `444-447` `settle('assistant/attempt')`；
  - settle 语义：先 `append()` 落持久事件（同步广播 `session/event`），后 emit end 帧（`assistant-stream.ts:78-97`）。
- 压缩流 `AssistantStreamRecord`：`packages/llm/llm/src/assistant-stream.ts:20-44`（`text-chunks`/`reasoning-chunks`/`tool-call-chunks`/`chunk`，无损、保留每个 delta 边界）；读者函数 `joinAssistantStreamText`（406-413）、`expandAssistantStream`（202-232）、`assembleAssistantStream`（425-454）等由 `@deepseek-ai/dsh-llm` 导出。
- `StreamChunk`：`packages/llm/llm/src/types.ts:390-402`——`block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish`。**与旧 `assistant/chunk` 的 chunk 载荷同构**（旧值即 `StreamChunk`，见下节），delta 字段 `{ index; text }`、block-end `{ index; block }` 形状未变 → 现有分流逻辑几乎原样平移。

### 3. `session/event` 与 `agent/assistant-stream` 的交错保序（设计的关键前提）

两者都在 loop 事件流里**同步**发射，且单 agent 的发射顺序确定：

- `session.append` 同步广播 `session/event`：`packages/core/session/src/index.ts:735-753`（`collectSessionCallbacks` → `invokeContainedSessionObservers` 同步调用）。
- `agent/assistant-stream` 同步 emit：`agent/dispatch.ts:126-136`。
- 单 step 顺序（0.1.5 源码可证）：
  1. `turn/start`（`agent.ts:278`，turn() 先于 step()）→ `step/start`（302）；
  2. `live.start()` start 帧（392）→ `for await` 逐 chunk push（394-397）发 chunk 帧；
  3. `settle` 先 append `assistant/message`/`assistant/attempt`（session/event），后 emit end 帧（`assistant-stream.ts:83-97`）；
  4. `executeToolCalls` 在 settle 之后（`agent.ts:486-491`），`tool/call` 于 `tool-calls.ts:264` append；
  5. `step/end`（312）→ 下一 step 重复 → `turn/end`（339，finally 恒发，含 abort/error）。

  因此对**同一 agent**，两通道事件到达 app 级监听者的次序 = 上述发射顺序。toolkit 两订阅都同步把工作排进**同一 `rt.tail` 链**即可保持全序（现状 `turn/start` 同步置 `rt.turn`、`turn/end` 同步清空，同样成立，见 `outbound.ts:80-142`）。

## 旧语义对照（deepseek-harness.old-0.1.2/，只读参考）

- 旧 loop 每个原始 chunk 立即 `session.append('assistant/chunk', { turn, step, chunk })`（`packages/core/agent-loop/src/agent.ts:349`，chunk 即 `StreamChunk`）；`assistant/message` 携带 `sourceEventSeqs: chunkSeqs` 显式列出其 chunk seq（旧 agent.ts:381-390）。事件类型声明 `packages/core/session/src/types.ts:266`。
- 语义差距：
  1. **持久性**：旧每个 chunk 是带 seq 的持久事件；新 chunk 是瞬态帧，每 attempt 只落一个持久结算事件（内嵌无损压缩流，可事后重建精确序列）。
  2. **结算时机**：旧 chunk 事件逐条先于 `assistant/message`；新 chunk 帧先于持久 `assistant/message`，`assistant/message` 先于 end 帧。
  3. **新增 `assistant/attempt`**：旧失败的尝试仍留 chunk 痕迹 + 无 message；新以显式 attempt 结算（失败/重试/取消无内容/流错误），**表示「本 attempt 无表面消息」**。
  4. **`tool/call` 与流相对位置不变**：新旧都在结算 message 之后、`step/end` 之前。
  5. **`turn/start`/`turn/end`/`tool/call`/`agent/error` 事件名与 payload 兼容**：`turn/start`（types.ts:276）、`turn/end`（285，reason kinds `completed|aborted|blocked|error|interrupted`，200-224）、`tool/call`（341）、`agent/error`（runtime-types.ts:403，payload 增 `turn`/`step` 字段，toolkit 现有 `({agent,error})` 解构仍兼容）。toolkit `mapTurnEnd`（outbound.ts:49-53）对 0.1.5 五类 reason 的映射不变（含测试断言 outbound.test.ts:35-42）。

## 候选机制对比

| 候选 | 机制 | 证据 | 流式实时性 | 内容权威性/可恢复 | 结论 |
|---|---|---|---|---|---|
| A. `agent/assistant-stream` 帧 + `assistant/message` 对账 | app 级订阅 scoped 帧驱动打字机；每 step 结算时用持久 message 对账尾段 | 帧：runtime-types.ts:365-373、agent.ts:386；持久：types.ts:321-329、agent.ts:474-483；订阅先例：headless index.ts:112、history.ts:54 | ✅ 逐 chunk 帧实时 | ✅ 结算事件为权威；对账**有界**兜住部分瞬态帧丢失（尾 text 段存在且归属正确时） | **推荐** |
| B. 仅消费持久 `assistant/message`（内嵌 `stream` 重建） | 从 `session/event` 收到的 `assistant/message` 里用 `assembleAssistantStream`/`joinAssistantStreamText` 重建文本 | types.ts:321-329；llm/assistant-stream.ts:406-454 | ❌ 无打字机：结算在整段流完成后才到达（agent.ts:474-483 在 stream 结束后 settle） | ✅ 完全权威 | 丢失飞书流式打字机核心体验，否决 |
| C. 轮询 `session.seq`/`eventAt` 增量 | 定时拉取会话新事件 | types.ts 事件均带 seq/time | ❌ 无流式：增量里只有整段结算，无逐 chunk 记录（旧 chunk 已删） | ✅ | 无实时收益且引入轮询状态，否决 |

否决说明：B 与 C 都只能拿到「整段结算」，而 `assistant/attempt`/`assistant/message` 是 step 结束才落，卡片会从「无」直接跳到「全量」，打字机（`cardPrintStep`，channel.ts:68）失去意义，且多 step 回合的中间 tool 过程反馈（`tool/call` 行）仍要靠 `session/event`，并不比 A 简单。

## 推荐方案与理由

**方案 A**：新增 app 级订阅 `agent/assistant-stream`，chunk 帧驱动现有段构建/打字机逻辑（分流逻辑原样平移）；保留 `session/event` 消费 `turn/start`/`tool/call`/`turn/end`，并在 `assistant/message` 结算时对账「尾 text 段」，**在可安全对账的范围内**（`turn.lastTextStep` 命中结算 step）保证终卡正文与持久记录一致。`assistant/attempt` 有意忽略。对账**不覆盖**「本 step 正文帧全丢且无前序 text 段」的缺席场景（宁缺勿错，见边界 7）。

理由：
1. **实时性**：帧逐 chunk 同步到达，打字机语义完整保留（与现状无感迁移）。
2. **权威对账（有界）**：帧是瞬态（dispatch.ts:120-137 丢帧无重传），持久 `assistant/message` 的 `message.content` 是最终事实（`publish state only at its commit point` 惯例）；对账把「瞬态视图」收敛到「已提交视图」，兜住**部分**丢帧（尾 text 段存在且归属正确时）。全丢 step 因无安全替换目标而跳过，不伪造内容。
3. **改动最小**：分流逻辑、段模型、卡片状态机（cards.ts/reply.ts）、`rt.tail` 保序机制全部复用；只改订阅源 + `outbound.ts` 消费分支。
4. **与宿主自身消费模式一致**：headless bundle 与 session-controller history 都用 app 级订阅 + 按 session/agent 过滤，属官方先例而非猜 API。

## 消费链改造设计（落点文件/函数级）

### 1. `packages/toolkit/src/bots/index.ts` — 新增订阅（约 +3 行）

在现有 `ctx.on('session/event', …)`（183-185）旁新增：

```ts
// 出站：瞬态流式帧 → runtime.outbound（session 匹配自有 runtime，其余忽略）。
ctx.on('agent/assistant-stream', ({ agent, frame }) => {
  runtime?.outbound.handleAssistantFrame(String(agent.session.id), frame)
})
```

- 不加 `{ global: true }`：与现有 `session/event`/`agent/error` 订阅同风格；headless bundle 先例即无 global（headless/src/index.ts:112）。
- 类型：仅 type-only 导入 `import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'`（toolkit devDeps 已有 `@deepseek-ai/dsh-agent` link，package.json:58；类型导入 bundle 期擦除，不新增运行时依赖）。`agent.session.id` 与现有 `agent/error` handler 同款（bots/index.ts:198）。

### 2. `packages/toolkit/src/channels/outbound.ts` — 消费链改造

**删除** `assistant/chunk` 分支（85-108）。

**新增** `handleAssistantFrame(sessionId: string, frame: AssistantStreamFrame)`：

```ts
handleAssistantFrame(sessionId: string, frame: AssistantStreamFrame): void {
  const rt = this.sessions.get(sessionId)
  if (rt === undefined) return
  const turn = rt.turn
  if (turn === undefined) return
  if (frame.type === 'start') {
    // 本 attempt 的 turn/step 基线：chunk 帧不携带 turn/step，只能从 start 帧取（宿主 accumulator 同款）。
    if (turn.n !== frame.turn) return
    turn.attemptStep = frame.step
    return
  }
  if (frame.type !== 'chunk') return
  const step = turn.attemptStep
  if (step === undefined) return
  if (!applyStreamChunk(turn.segments, frame.chunk)) return
  if (frame.chunk.type === 'text-delta') turn.lastTextStep = step  // 对账防护：尾 text 段的归属 step
  const snapshot = turn.segments.map((s) => ({ ...s }))
  this.enqueue(rt, async () => {
    if (rt.reply === undefined) return
    if (!turn.began) { await rt.reply.beginTurn(); turn.began = true }
    await rt.reply.update(snapshot)
  })
}
```

- **提取纯函数** `applyStreamChunk(segments: TurnSegment[], chunk: StreamChunk): boolean`：把旧 89-97 的分流体（text-delta → text、reasoning-delta → process、block-end(block.type==='reasoning') 且尾段为 process → 追加 `\n\n`，其余返回 false）平移进来，便于单测。
- **`start` 帧只建 attempt 基线、`end` 帧不消费**：turn 生命周期仍由 `turn/start`/`turn/end` 驱动（start/end 帧不驱动生命周期）；`end` 帧的 `outcome.seq`/`eventType` 为宿主内部结算信息，toolkit 不需要（对账用 `assistant/message` 事件本身）。
- **`turn.attemptStep`（attempt 基线，裁定）**：宿主 `AssistantStreamFrame` 的 **chunk 帧不携带 `turn`/`step`**（`runtime-types.ts:137-146`，仅 `start` 帧有，134-135），因此 `handleAssistantFrame` 在 `start` 帧校验 `turn.n === frame.turn` 并把 `frame.step` 记入 `rt.turn.attemptStep`；chunk 帧按基线归属当前 attempt，错 turn 过滤在 start 帧完成。取数与宿主官方 accumulator 同款（`packages/api/session-controller/src/assistant-stream.ts:52-59` 在 start 帧取 turn/step、chunk 帧按 attemptId/index 归并）。> **Adjudication 注记（2026-09-10 实现期裁定）**：chunk 帧无 turn/step 字段，start 帧取基线；原稿误读 chunk 帧的 `frame.turn`/`frame.step`，经实现期冲突上报后裁定方案 A。
- **`turn.lastTextStep`（对账防护前提，必需）**：`SessionRuntime.turn` 形态从 `{ n, segments, began }` 扩展为 `{ n, segments, began, lastTextStep?: number, attemptStep?: number }`（`ports.ts:73`），`turn/start` 处置 `undefined`。每个**成功应用**的 text-delta 帧把 `lastTextStep` 置为该帧所属 attempt 的 `step`（`turn.attemptStep`）。它回答「尾 text 段属于哪个 step」——这是对账「只替换本 step 尾段」的安全前提，见下节 `assistant/message` 分支的防护守卫。
- **不校验 `frame.index` 连续性 / revision**：chunk 帧无 turn 号，turn 匹配移到 start 帧（`turn.n !== frame.turn`）；toolkit 无「重连基线」需求（区别于宿主 session-controller accumulator 需为 Web follower 重建快照，`packages/api/session-controller/src/assistant-stream.ts:38-78`）；帧按投递序 append 即可。若实现时希望多一层保险，可仿 accumulator 在 chunk 帧 `frame.index` 不连续时置一个 `dirty` 标记、触发对账——但**不作为必需**（见未决点 2）。

**`handleSessionEvent` 新增 `assistant/message` 分支（对账）**：

```ts
if (event.type === 'assistant/message') {
  const turn = rt.turn
  if (turn === undefined || turn.n !== (event.data.turn as number)) return
  // 防护（必需）：仅当尾 text 段确实属于本结算 step（本 step 至少成功应用过一帧 text-delta，
  // 即 turn.lastTextStep === event.data.step）才对账。dispatch 逐帧隔离 throw（agent/dispatch.ts:129-135）
  // 使 session/event 照常送达——若本 step 正文帧全部丢失，lastTextStep 仍指向上一步，此时用本 step
  // 权威全文覆盖会篡改上一步已提交正文（从「缺字」恶化成「内容被改」），因此必须跳过。
  if (turn.lastTextStep !== (event.data.step as number)) return
  const content = (event.data.message as { content?: readonly unknown[] }).content ?? []
  const authoritative = lastTextOf(content)                    // 该 step 最后一个 text 块（见下）
  // 尾 text 段对账：本 step 正文段应为 authoritative；与已流式段前缀比对，补齐丢帧。
  if (!reconcileTrailingText(turn.segments, authoritative)) return
  const snapshot = turn.segments.map((s) => ({ ...s }))
  this.enqueue(rt, async () => {
    if (rt.reply === undefined) return
    if (!turn.began) { await rt.reply.beginTurn(); turn.began = true }
    await rt.reply.update(snapshot)
  })
  return
}
```

- `lastTextOf(content): string`（返回契约钉死）：返回 `content` 里**最后一个 `type==='text'` 块的 `text`**；**无 text 块时返回 `''`（不是 `undefined`）**，使下文 `authoritative === ''` 守卫成立。复用现有 `textOf` 的过滤模式（outbound.ts:12-17）。为什么不是 `textOf` 全量拼接：一个 step 结算 message 的正文通常单 text 块，`lastTextOf === textOf`；极少数多 text 块且块间夹非 text 块时，段模型的「最后 text 段」只对应最后那个 text 块，用全量拼接会**错误替换**掉前序段，因此对账只对最后一个 text 块（同段内更早 text 块内容已在早先段里，未流到不补——与过程区丢帧同样接受，见未决点 2 的成本权衡）。

新纯函数 `reconcileTrailingText(segments: TurnSegment[], authoritative: string): boolean`（调用前置条件：调用方已保证 `turn.lastTextStep === 结算 step`，即尾 text 段必属本 step）：
- 若 `authoritative === ''` → 本 step 无正文，不改段，返回 false；
- 取**最后一个** `kind === 'text'` 段（前置条件下它即本 step 正文段；step 内 text deltas 连续、与上一步被 process 段隔开）；
- 若其 content 已等于 `authoritative` → 返回 false（常态无操作）；
- 否则替换其 content 为 `authoritative`，返回 true（丢帧补齐）。

**防护的覆盖范围（如实标注）**：对账是**替换式**，只恢复「已存在尾 text 段」的本 step 正文。若某 step 正文帧**全部丢失**（`lastTextStep` 不匹配 → 整体跳过，不篡改上一步；见上守卫）或该 step 是首正文 step 且一帧未收（无前序 text 段可作恢复目标），本 step 正文在该卡上缺席——这是设计接受的降级，不伪造内容，宁缺勿错。

**`assistant/attempt` 不消费**：它表示该 attempt 无表面消息（types.ts:331-335）；流错误/取消时已通过帧显示的过程区内容留在段里，turn/end 兜底定格。加一行注释说明即可，不写分支。

### 3. 不变项（明确不动）

- `channels/feishu/cards.ts` / `reply.ts`：确认式状态机、seq 单调、拆卡定格、打字机参数全部不动（对账只是改喂给 `update(snapshot)` 的段内容，卡片 op 语义不变）。
- `channels/router.ts` / `runtime.ts` / `inbound.ts`：reply 句柄时序、retire/`/new` 收尾逻辑不动（turn/end 仍驱动旧卡 finalize）。
- `mapTurnEnd` / `errorDetailOf` / `processOf`（保留供测试，`processOf` 的 `tool_call` 下划线块名与 0.1.5 的 `tool-call` 不符属存量，不在本次修复范围）不动。

### 改动清单

| 文件 | 改动 |
|---|---|
| `packages/toolkit/src/bots/index.ts` | +`agent/assistant-stream` 订阅（约 3 行） |
| `packages/toolkit/src/channels/ports.ts` | `SessionRuntime.turn` 形态 +`lastTextStep?: number` / `attemptStep?: number`（attempt 基线 + 对账防护前提；`outbound.ts` `turn/start` 处置 undefined） |
| `packages/toolkit/src/channels/outbound.ts` | 删 `assistant/chunk` 分支；+`handleAssistantFrame`（含 `start` 帧建 `attemptStep` 基线 + `lastTextStep` 跟踪）、`applyStreamChunk`、`reconcileTrailingText`、`lastTextOf`、`assistant/message` 对账分支（含 `lastTextStep` 守卫） |
| `packages/toolkit/src/channels/outbound.test.ts` | chunk 事件改为帧调用；新增对账/防护/次序用例（见测试方案） |
| `packages/toolkit/src/channels/feishu/feishu-stream-integrity.test.ts` | 事件流生成器 `events()` 改为「session 事件 + 帧」混合喂入 |
| `docs/domains/feishu.md` | 出站段同步现状（0.1.5 后按 task 7 台账统一更新） |

## 边界情况

1. **中断（cancel / abort mid-stream）**：loop 结算 `assistant/message(interrupted:true)`（agent.ts:402-419）；已交付前缀已由帧显示，对账收敛到 interrupted content，`turn/end(aborted)` → `mapTurnEnd` 得 `cancelled` 定格。与旧行为一致（旧也显示前缀后 cancelled 定格）。
2. **流错误 / 重试**：流错误或 finish error 结算 `assistant/attempt`（agent.ts:426-431、444-447），turn/end 得 `error` 定格；已显示的过程区保留。retry 会在同 step 再开新 attempt（新 start 帧），段继续累积，语义与旧相同。
3. **多 step / 多 attempt 单 turn**：段跨 step 累积（现状即如此）；每 step 的 `assistant/message` 只对账本 step 尾 text 段，不动前序段。
4. **重连 / 重绑（`/new`、解绑后 resume）**：retire 语义不变（runtime.ts:124-132）——旧 rt 保留到 `whenIdle`+`rt.tail` 落定才摘除，期间 `turn/end` 正常送达旧句柄 finalize；新会话新 rt、`turn` 从新号起（loop 从 turnBoundary 投影续号，agent.ts:108）。帧按 sessionId 过滤天然隔离新旧。
5. **多会话并发**：`handleAssistantFrame` 与 `handleSessionEvent` 同查 `sessions.get(sessionId)`，各自的 `rt.tail` 链互不干扰（现状不变式）。
6. **非本插件 agent（委派子会话 / cron / 其他用户会话）**：帧里 `agent.session.id` 不在 sessions map → 忽略（同 session/event 现状 outbound.ts:77-78）。
7. **瞬态帧丢失（有界恢复）**：`agent/assistant-stream` 为 fire-and-forget（dispatch.ts:126-136），丢帧后无重传。对账把**正文**收敛到持久记录，但只恢复「尾 text 段存在且 `lastTextStep` 命中结算 step」的情况（部分丢帧 → 补齐；本 step 正文帧全部丢失或首正文 step 一帧未收 → **整体跳过，该 step 正文缺席**，不篡改上一步已提交正文）。过程区（reasoning/tool 行）不参与对账——丢帧时过程区可能缺字，属可接受降级（思考内容非终稿承诺），记入未决点 2 的成本权衡。
8. **卡片 commit 与 seq 语义保持**：对账只是产生**新的 segments 快照**交给 `update`，不碰 planSync/commit/seq；卡片状态机对「段内容变化」无感知差异，拆卡/重放/定格行为不变。
9. **`assistant/attempt` 独步的 turn**（只有 attempt、无 message、无 error detail）：如取消无内容（agent.ts:421-424），`turn/end(aborted)` → 无卡无 detail，finalize 空操作（现状 outbound.ts:136 的 `(turn.began || detail)` 守卫已覆盖）。

## 测试方案

1. **`outbound.test.ts` 适配与新增**：
   - 现有 4 个含 `assistant/chunk` 的用例（71-74、93-94、110-112、165）改为：`turn/start`/`tool/call`/`turn/end` 仍走 `handleSessionEvent`，chunk 改走 `handleAssistantFrame`（帧对象按 `AssistantStreamFrame` 形状构造，chunk 帧前先发 `start` 帧建 attempt 基线——chunk 帧无 turn/step），断言不变。
   - 新增：`start` 帧只建基线不产生卡操作、`end` 帧被忽略；chunk 帧在 `turn/start` 前到达被忽略；chunk 帧无 start 基线被忽略；错 turn 的 `start` 帧被忽略；`assistant/message` 对账补齐缺帧正文（先丢一个 text-delta，断言对账后 update 参数含权威全文）；对账对 process 段零改动；`assistant/attempt` 被忽略。
   - **防护用例（Important）**：step 1 正文「A」已提交 → step 2 正文帧**全部丢失**（只发 step 2 的 `assistant/message`，不发任何 step 2 帧）→ 断言对账**跳过**，step 1 的「A」不被 step 2 权威全文覆盖（`rt.turn.segments` 与 update 参数均保持「A」）；反向用例：step 2 至少应用过一帧 text-delta（`lastTextStep=2`）→ 对账正常补齐。
   - 对账纯函数 `reconcileTrailingText` / `lastTextOf` 单测：幂等（相等返回 false）；补齐前缀；`authoritative===''` 不改段；`lastTextOf` 无 text 块返回 `''`（非 `undefined`）；多 text 段只改尾段；多 text 块只取最后块（不与前序段串）。
2. **`feishu-stream-integrity.test.ts` 重写事件生成器**（`events()`，53-67）：`assistant/chunk` 两处改发对应帧（reasoning-delta 帧、text-delta 帧），每轮先发 `start` 帧建基线，同时喂入 `assistant/message`（content 用该轮 text 块）与既有 `tool/call`/`turn/*`；`drive()`（71-89）对 session 事件走 `handleSessionEvent`、对帧走 `handleAssistantFrame`。既有两条「正文逐字节完整」断言（含注入 200860/200850 抖动）必须保持通过——这是端到端内容完整性的回归底线。
3. **交错次序用例**：一个 turn 内两 step（step1 思考+正文 → tool/call → step2 思考+正文），按新宿主真实发射顺序（turn/start → start 帧 → chunk 帧 → assistant/message → tool/call → … → turn/end）喂入，断言段序列与 update 次数正确（复现 agent.ts:278-339 顺序）。
4. 回归：两包 `test` + `typecheck` + `bundle`（usage 先 bundle 再跑 toolkit 测试，AGENTS.md 顺序约束）。

## 迁移与回滚注意点

- **仅 0.1.5 向**：`assistant/chunk` 已删，无需保留旧分支；此改动会让 toolkit 在 0.1.2 宿主上流式失效（0.1.2 无 `agent/assistant-stream` 事件、订阅空转）——整个升级本就是 0.1.5-only，接受。
- **订阅注册时机**：`runtime` 在 `started` 落定后赋值（bots/index.ts:156-177），但订阅在 apply 期即可注册（handler 对 `runtime?.outbound` 空安全，与 session/event 同款 184 行守卫）；不得提前对 undefined runtime 调用。
- **回滚**：git revert 本 spec 对应的实现 commit（恢复 `assistant/chunk` 分支 + 移除帧订阅）；0.1.5 宿主上回滚 = 恢复「流式失效」回归，因此回滚仅用于实现中途发现框架性问题，不作为长期选项。
- **文档**：`docs/domains/feishu.md` 在实现落地后更新「出站」段（0.1.5 流式来源、对账语义）；台账 task 7 统一处理。

## 未决点与验证计划

1. **对账的视觉影响**（需真实环境验证）：对账把尾 text 段替换为权威全文后，`update` 的全量快照 diff 到卡片元素 content，打字机打印剩余增量；若帧一直没丢，对账是 no-op（content 相等）。极端情况（丢帧后一次性补齐较长增量）的打印观感需在安装版 dsh + link 插件跑一轮真实长回复确认不出现跳动/回跳。**验证方法**：真实宿主跑长回复 + 中途制造一次 listener 抛错（临时注入）观察对账补齐。未验证前以 DONE_WITH_CONCERNS 对待。
2. **过程区丢帧不可恢复**（已知局限，接受与否需拍板）：reasoning 段不参与对账，丢帧时思考面板可能缺字。选项：(a) 接受（推荐，思考非承诺内容）；(b) 用 `assistant/message` 的 `message.content` 里 reasoning 块整体重建过程区——但会与 `tool/call` 行/`block-end` 分隔符耦合，复杂度显著上升且可能重复渲染 tool-call 块（`processOf` 的 `tool_call` 下划线名与 0.1.5 `tool-call` 不符，见改动清单），不推荐。**验证方法**：实现后按帧投递路径 review listener 无 throw 路径 + 模拟注入确认对账只补正文。
3. **两通道交错保序依赖同步发射**：代码层面已证（session/index.ts:735-753 同步、agent/dispatch.ts:126-136 同步、agent.ts:278-339 顺序确定）；但「同一 app 上下文两个订阅的观察顺序恒等于发射顺序」建议加一条**交错次序单测**（测试方案 3）钉住，防宿主后续把 emit 改异步时静默破坏。

## 明确不做

- 不引入对 `assistant/attempt` 的 UI 呈现（无表面消息，静默）。
- 不校验帧 `index`/`revision` 连续性（toolkit 无重连基线需求；宿主 accumulator 的校验是为 Web follower 服务，见 `packages/api/session-controller/src/assistant-stream.ts:38-78`）。
- 不重建过程区（未决点 2 的选项 b）。
- 不改卡片状态机 / seq 语义（对账只动喂给 `update` 的段内容）。
- 不改 `agent/error` 消费路径（0.1.5 payload 兼容，现有 turn 外错误处理不变）。
