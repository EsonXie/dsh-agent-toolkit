# 飞书卡片流式输出健壮性修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复飞书渠道两类症状——拆卡后旧卡状态行永远「输出中」、正文段在思考/工具块边界缺内容——并使任何卡片 API 失败都不丢内容。

**Architecture:** 按 spec `docs/superpowers/specs/2026-09-08-feishu-card-stream-robustness-design.md`：① closeCard 定格状态行；② 卡片字节记账改为真实 DSL 字节（含面板结构 190B/个、正文元素 52B/个、JSON 转义）；③ planSync 改返回逐 op commit 闭包，reply.ts 改确认式状态机（op 成功才提交状态，失败按错误码分类：300301 视为成功 / 200850·200510 重激活重放 / 200860 废弃拆卡续写 / 未知失败 seq+2 重放）；④ reply 句柄在 in-flight 准入通过后才替换，`/new` 等旧卡 finalize 后再摘 sessions 映射。

**Tech Stack:** TypeScript + vitest（fake  timers/fake FeishuApi），pnpm workspace，包 `packages/toolkit`（npm 名 `dsh-agent-toolkit`）。

## Global Constraints

- 设计唯一来源：`docs/superpowers/specs/2026-09-08-feishu-card-stream-robustness-design.md`（下称 spec）。
- 可调参数进 Config schema，不硬编码（`cardMaxBytes` 默认改为 **26_000**，新增 `cardPrintStep` 默认 **5**）。
- 文案常量（verbatim）：`STATUS_CONTINUED = '📦 内容较长，已接续到下一张卡片'`；异常提示 notice = `'⚠️ 卡片输出异常，已在新卡片继续；如有内容缺失请重发。'`
- 飞书错误码（verbatim）：`300301` insert 元素重复；`200850`/`200510` 流式超时关闭；`200860` 卡片超 30KB。
- 命令一律在仓库根跑：`pnpm --filter dsh-agent-toolkit test` / `typecheck` / `bundle`；单测文件级用 `pnpm --filter dsh-agent-toolkit exec vitest run <相对路径>`。
- 不改 `packages/usage`、不改 `deepseek-harness/`。commit 信息照仓库风格 `fix(toolkit): 中文描述`。
- 现有测试行为断言全部保留（仅按新接口/新 op 序列适配期望值），不得删测试降覆盖。

---

### Task 1: 拆卡定格——closeCard 更新状态行 + summary

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/cards.ts`（L14-22 文案常量区；L145-150 `closeCard`）
- Test: `packages/toolkit/src/channels/feishu/feishu-cards.test.ts`

**Interfaces:**
- Produces: `export const STATUS_CONTINUED = '📦 内容较长，已接续到下一张卡片'`；`closeCard` 的 op 序列从 `[settings]` 变为 `[update(status), settings(带 summary)]`（Task 3/4 依赖此 op 形状）。

- [ ] **Step 1: 写失败测试**

在 `feishu-cards.test.ts` 的 `describe('planSync')` 末尾追加：

```ts
test('拆卡定格：关流前先把旧卡状态行更新为「已接续」，summary 同步', () => {
  // maxBytes=70、CARD_FIXED_BYTES=64：每卡至多再放 6 字节 → 必拆卡
  const { ops } = planSync(initialStreamState(), [text('一二三四五')], 70, 8_000)
  const closes = ops.filter((op) => op.type === 'settings')
  expect(closes.length).toBe(2)   // 两次拆卡
  // 每次拆卡都是 update(status) 在前、settings 在后，且 summary 带上定格文案
  const firstClose = ops.slice(3, 5)
  expect(firstClose).toEqual([
    { type: 'update', elementId: STATUS_ELEMENT_ID, content: STATUS_CONTINUED, sequence: 2 },
    { type: 'settings', streaming: false, sequence: 3, summary: STATUS_CONTINUED },
  ])
})
```

同时把该文件 import 行补上 `STATUS_CONTINUED`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-cards.test.ts`
Expected: FAIL（`closes.length` 为 2 但 `firstClose` 不含 update op；`STATUS_CONTINUED` 未导出报错也算预期失败）

- [ ] **Step 3: 实现**

`cards.ts`：在 `STATUS_FINAL` 常量下方加：

```ts
/** 拆卡定格状态行文案（旧卡内容已接续到下一张卡片）。 */
export const STATUS_CONTINUED = '📦 内容较长，已接续到下一张卡片'
```

`closeCard` 改为：

```ts
  const closeCard = (): void => {
    // 先定格状态行（流式还开着，组件 content API 需要流式模式），再关流 + summary。
    seq += 1
    ops.push({ type: 'update', elementId: STATUS_ELEMENT_ID, content: STATUS_CONTINUED, sequence: seq })
    seq += 1
    ops.push({ type: 'settings', streaming: false, sequence: seq, summary: STATUS_CONTINUED })
    cardId = null
    tail = undefined
  }
```

- [ ] **Step 4: 适配存量期望并跑通**

`feishu-cards.test.ts` 中三个涉及拆卡的测试（'text 段跨卡拆分'、'跨卡 text 段跨 flush 增长'、'process 段拆卡'）的期望 ops 里，把每个 `{ type: 'settings', streaming: false, sequence: N }` 前面补 `{ type: 'update', elementId: STATUS_ELEMENT_ID, content: STATUS_CONTINUED, sequence: N }`、settings 的 sequence 改 N+1 并补 `summary: STATUS_CONTINUED`。例：'process 段拆卡' 期望变为：

```ts
    expect(ops).toEqual([
      { type: 'update', elementId: STATUS_ELEMENT_ID, content: STATUS_CONTINUED, sequence: 2 },
      { type: 'settings', streaming: false, sequence: 3, summary: STATUS_CONTINUED },
      { type: 'create', cardJson: buildCardJson() },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('process', 'seg_2', '思考内容'), sequence: 1 },
    ])
```

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-cards.test.ts`
Expected: PASS（全绿）

- [ ] **Step 5: 回归 + Commit**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/`
Expected: `feishu-reply.test.ts` 中仅涉及拆卡序列的用例若红则同步补 update op 期望（当前 reply 测试均未触发拆卡，预期无需改动）。

```bash
git add packages/toolkit/src/channels/feishu/cards.ts packages/toolkit/src/channels/feishu/feishu-cards.test.ts
git commit -m "fix(toolkit): 拆卡时定格旧卡状态行与 summary（不再残留输出中）"
```

---

### Task 2: 真实 DSL 字节记账 + sliceByEscapedBytes

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/cards.ts`（新增 `escapedLen`/`sliceByEscapedBytes`；`planSync` 的 ensureCard/insert/update/拆分支记账全部改真实 DSL 字节）
- Test: `packages/toolkit/src/channels/feishu/feishu-cards.test.ts`

**Interfaces:**
- Produces（Task 3/4/6 依赖，签名不许再变）：

```ts
/** JSON 串内内容的转义后字节数（去首尾引号）。 */
export function escapedLen(s: string): number
/** 按转义后字节上限截头（不劈多字节字符与代理对）。 */
export function sliceByEscapedBytes(text: string, maxBytes: number): string
```

- `cardBytes` 语义变为「当前卡真实 DSL 字节」：create 时 = `Buffer.byteLength(cardJson, 'utf8')`；insert 时 += `Buffer.byteLength(elementJson, 'utf8')`；update 时 += `escapedLen(new) - escapedLen(old)`。`CARD_FIXED_BYTES` 常量删除。状态行定格 update（Task 1）**不计入** cardBytes（基础卡 JSON 已含状态行，差值忽略）。

- [ ] **Step 1: 写失败测试**

`feishu-cards.test.ts` 追加 describe：

```ts
describe('escapedLen / sliceByEscapedBytes', () => {
  test('转义膨胀计入：换行/引号每个 +1 字节', () => {
    expect(escapedLen('ab')).toBe(2)
    expect(escapedLen('a\nb')).toBe(4)      // \n 在 JSON 串里占 2 字节
    expect(escapedLen('中')).toBe(3)
  })

  test('按转义后字节截断，不劈多字节字符', () => {
    expect(sliceByEscapedBytes('a\nb\nc', 4)).toBe('a\nb')   // 'a\nb'=4，'a\nb\n'=6 超
    expect(sliceByEscapedBytes('中中', 4)).toBe('中')
  })
})

describe('planSync DSL 记账', () => {
  const BASE = Buffer.byteLength(buildCardJson(), 'utf8')              // 实测 286
  const EL = Buffer.byteLength(buildSegmentJson('text', 'seg_1', ''), 'utf8')  // 实测 52

  test('insert 按 elementJson 全字节记账：预算只够一个元素时立即拆卡', () => {
    // 预算 = 基础 + 一个正文元素（空内容开销）+ 6 转义字节 → '一二' 满卡
    const maxBytes = BASE + EL + 6
    const { ops } = planSync(initialStreamState(), [text('一二三四五')], maxBytes, 8_000)
    const inserts = ops.filter((op) => op.type === 'insert')
    expect(inserts).toHaveLength(2)
    expect(JSON.parse(inserts[0].elementJson).content).toBe('一二三四'.slice(0, 2))  // 第一张卡 '一二'
    // 第一张卡第二片：贴线 6 转义字节恰好放 '三四'……见下一步精确断言
  })

  test('update 按转义差值记账：换行多的内容更早触发拆卡', () => {
    const maxBytes = BASE + EL + 12   // 首卡放 'a\nb\n'（escaped 6+2=8? 见下）
    const first = planSync(initialStreamState(), [text('a\nb')], maxBytes, 8_000)
    // 'a\nb' escapedLen=4；增长到 'a\nb\nc\nd' escapedLen=10，delta=6，剩 12-4=8 → 可 update
    const grown = planSync({ ...first.state, cardId: 'c1' }, [text('a\nb\nc\nd')], maxBytes, 8_000)
    expect(grown.ops[0]).toMatchObject({ type: 'update', content: 'a\nb\nc\nd' })
    // 再增长到 escapedLen=16，delta=6，剩 2 → 拆卡
    const over = planSync({ ...grown.state }, [text('a\nb\nc\nd\ne\nf')], maxBytes, 8_000)
    expect(over.ops.some((op) => op.type === 'settings')).toBe(true)
  })
})
```

（数值自检：escapedLen('a\nb')=4、escapedLen('a\nb\nc\nd')=10、escapedLen('a\nb\nc\nd\ne\nf')=16；若实现后实测不符，以实现为准修正测试数字并在 commit 信息注明。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-cards.test.ts`
Expected: FAIL（`escapedLen`/`sliceByEscapedBytes` 未导出）

- [ ] **Step 3: 实现**

`cards.ts`：

```ts
/** JSON 串内内容的转义后字节数（去首尾引号）；卡片 DSL 真实字节记账用。 */
export function escapedLen(s: string): number {
  return Buffer.byteLength(JSON.stringify(s), 'utf8') - 2
}

/** 按转义后字节上限截头（保留头部），不劈开多字节字符与代理对。 */
export function sliceByEscapedBytes(text: string, maxBytes: number): string {
  if (escapedLen(text) <= maxBytes) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (escapedLen(text.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  let cut = lo
  if (cut > 0) {
    const code = text.charCodeAt(cut - 1)
    if (code >= 0xd8_00 && code <= 0xdb_ff) cut -= 1
  }
  return text.slice(0, cut)
}
```

`planSync` 内改动（删除 `CARD_FIXED_BYTES`）：

```ts
  const ensureCard = (): void => {
    if (cardId !== null) return
    const cardJson = buildCardJson()
    ops.push({ type: 'create', cardJson })
    ops.push({ type: 'send' })
    cardId = PENDING_CARD_ID
    seq = 0
    cardBytes = Buffer.byteLength(cardJson, 'utf8')   // 真实 DSL 字节
    cardElements = 1
  }
```

尾段增长分支的预算判断改转义差值：

```ts
      if (elementContent !== tail.shownText) {
        const delta = escapedLen(elementContent) - escapedLen(tail.shownText)
        if (cardBytes + delta <= maxBytes) {
          seq += 1
          ops.push({ type: 'update', elementId: tail.elementId, content: elementContent, sequence: seq })
          cardBytes += delta
          tail = { ...tail, shownText: elementContent }
        } else if (seg.kind === 'text') {
          // 部分更新到满 → 拆卡，剩余经 carry 续写（预算按转义后字节）
          const piece = sliceByEscapedBytes(elementContent, escapedLen(tail.shownText) + (maxBytes - cardBytes))
          if (piece.length > tail.shownText.length) {
            seq += 1
            ops.push({ type: 'update', elementId: tail.elementId, content: piece, sequence: seq })
            cardBytes += escapedLen(piece) - escapedLen(tail.shownText)
            tail = { ...tail, shownText: piece }
          }
          carry = { segIndex: i, base: tail.base + tail.shownText.length }
          closeCard()
          continue
        } else {
          closeCard()
          continue
        }
      }
```

process insert 分支（先按 tentative id 量出真实面板字节再决策）：

```ts
    if (seg.kind === 'process') {
      const elementId = `seg_${segCounter + 1}`
      const elementJson = buildSegmentJson('process', elementId, elementContent)
      const elBytes = Buffer.byteLength(elementJson, 'utf8')
      if (cardId !== null && (cardBytes + elBytes > maxBytes || cardElements + 2 > CARD_ELEMENT_LIMIT)) {
        closeCard()
        continue
      }
      ensureCard()
      // 过程窗口由 processMaxBytes 兜底（sliceTailByBytes 已截尾）；新卡整窗插入，不再受卡预算约束。
      segCounter += 1
      seq += 1
      ops.push({ type: 'insert', elementJson, sequence: seq })
      cardBytes += elBytes
      cardElements += 2
      tail = { segIndex: i, elementId, base: 0, shownText: elementContent }
    }
```

text insert 分支（元素结构开销计入切分预算）：

```ts
      if (cardId !== null && cardElements + 1 > CARD_ELEMENT_LIMIT) {
        closeCard()
        continue
      }
      ensureCard()
      const elementId = `seg_${segCounter + 1}`
      const overhead = Buffer.byteLength(buildSegmentJson('text', elementId, ''), 'utf8')
      const piece = sliceByEscapedBytes(elementContent, maxBytes - cardBytes - overhead)
      if (piece.length === 0) {
        throw new Error(`cardMaxBytes=${maxBytes} 过小，扣基础卡与元素开销后连一个字符都容纳不了`)
      }
      segCounter += 1
      const elementJson = buildSegmentJson('text', elementId, piece)
      seq += 1
      ops.push({ type: 'insert', elementJson, sequence: seq })
      cardBytes += Buffer.byteLength(elementJson, 'utf8')
      cardElements += 1
      tail = { segIndex: i, elementId, base, shownText: piece }
      if (piece.length < elementContent.length) {
        carry = { segIndex: i, base: base + piece.length }
        closeCard()
        continue
      }
```

- [ ] **Step 4: 适配存量拆卡测试的预算数值并跑通**

三个拆卡测试的 `maxBytes` 从 70 改为按真实字节推导（`BASE = Buffer.byteLength(buildCardJson(), 'utf8')`、`EL = Buffer.byteLength(buildSegmentJson('text', 'seg_1', ''), 'utf8')` 在文件顶部定义）：

- 'text 段跨卡拆分'：`maxBytes = BASE + EL + 6`，期望卡 1 insert `'一二'`（6 转义字节贴线）、关卡、卡 2 insert `'三四'`、关卡、卡 3 insert `'五'`（op 序列含 Task 1 的 update status）；
- '跨卡 text 段跨 flush 增长'：`maxBytes = BASE + EL + 8`；Flush A `'一二三'`（escaped 9 > 8）→ insert `'一二'`；Flush B 增长到 `'一二三四五'`：delta=15-6=9 > 剩 2 → 部分更新预算 6+2=8 → piece='一二' 无 update → carry base=2 → 关卡 → 卡 2 insert `'三四'`（escaped 6 ≤ 8）→ carry base=4 → 关卡 → 卡 3 insert `'五'`；
- 'process 段拆卡'：`maxBytes = BASE + EL + 6`（text `'一二'` 恰好满卡）。

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-cards.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/feishu/cards.ts packages/toolkit/src/channels/feishu/feishu-cards.test.ts
git commit -m "fix(toolkit): 卡片预算改按真实 DSL 字节记账（含面板结构与 JSON 转义），防 30KB 超限丢内容"
```

---

### Task 3: planSync 改 PlannedOp/commit 接口

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/cards.ts`（`planSync` 返回 `{ ops: PlannedOp[] }`，不再返回整体 state）
- Modify: `packages/toolkit/src/channels/feishu/reply.ts`（仅适配调用处：暂用「执行前 fold 全部 commit」保持旧行为，Task 4 才改确认式）
- Test: `packages/toolkit/src/channels/feishu/feishu-cards.test.ts`

**Interfaces:**
- Produces（Task 4 依赖，签名不许再变）：

```ts
export interface PlannedOp {
  op: CardOp
  /** 该 op 成功后的状态迁移（快照整体替换）。 */
  commit: (s: StreamState) => StreamState
}
export function planSync(
  state: StreamState,
  segments: readonly TurnSegment[],
  maxBytes: number,
  processMaxBytes: number,
): { ops: PlannedOp[] }
```

- `planFinalize` 签名不变（仍返回 `{ ops: CardOp[] }`）。
- commit 约定：**先改规划局部变量再快照**——每个 op 的 commit 捕获的是「该 op 成功完成后」的规划状态（create 的 commit 里 `cardId = PENDING_CARD_ID`，真实 id 由执行侧覆盖；closeCard 的 settings commit 里 `cardId = null`）。

- [ ] **Step 1: 写失败测试**

`feishu-cards.test.ts` 顶部加工具函数并追加测试：

```ts
/** 测试辅助：依次应用全部 commit 得到末态（执行侧的 fold）。 */
const applyOps = (state: StreamState, ops: readonly PlannedOp[]): StreamState =>
  ops.reduce((s, p) => p.commit(s), state)

test('逐 op commit：create 后 cardId=PENDING，拆卡 settings 后 cardId=null', () => {
  const { ops } = planSync(initialStreamState(), [text('一二三四五')], BASE + EL + 6, 8_000)
  let s = initialStreamState()
  s = ops[0].commit(s)   // create
  expect(s.cardId).toBe(PENDING_CARD_ID)
  s = ops[1].commit(s)   // send
  s = ops[2].commit(s)   // insert '一二'
  expect(s.tail?.shownText).toBe('一二')
  s = ops[4].commit(s)   // settings（关第一卡）
  expect(s.cardId).toBeNull()
  expect(s.carry).toEqual({ segIndex: 0, base: 2 })
})
```

（import 补 `PlannedOp` 类型。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-cards.test.ts`
Expected: FAIL（`PlannedOp` 未导出 / `planSync(...).ops[0].commit` 不存在）

- [ ] **Step 3: 实现**

`cards.ts`：新增 `PlannedOp` 接口；`planSync` 内把 `ops: CardOp[]` 改 `ops: PlannedOp[]`，加统一推入助手：

```ts
export interface PlannedOp {
  op: CardOp
  /** 该 op 成功后的状态迁移（快照整体替换）。 */
  commit: (s: StreamState) => StreamState
}
```

planSync 内：

```ts
  const ops: PlannedOp[] = []
  let { cardId, seq, cardBytes, cardElements, segCounter, closedSegCount, tail, carry } = state

  /** 约定：先改规划局部变量再 push——commit 捕获该 op 完成后的状态快照。 */
  const push = (op: CardOp): void => {
    const snap = { cardId, seq, cardBytes, cardElements, segCounter, closedSegCount, tail, carry }
    ops.push({ op, commit: () => ({ ...snap }) })
  }
```

然后把函数体内所有 `ops.push({ ... })` 改为 `push({ ... })`，并确认每处 push 前局部变量已处于「该 op 完成后」的值：

- `ensureCard`：`cardId = PENDING_CARD_ID; seq = 0; cardBytes = ...; cardElements = 1` 之后 `push(create)`、`push(send)`；
- `closeCard`：`seq += 1` 后 `push(update status)`；再 `seq += 1`、`cardId = null`、`tail = undefined` 后 `push(settings)`；
- 各 insert/update：先更新 `seq/cardBytes/cardElements/segCounter/tail` 再 `push(...)`；
- 纯段推进（无 op 的 `closedSegCount = i + 1` 等）不产生 commit——**注意**：这会让「段被封闭但无 op」的进展丢失。修复：planSync 末尾若无 ops 但状态有推进，需补一个纯状态 commit。在 return 前加：

```ts
  // 段封闭/进位等纯状态推进也要交还执行侧：无 op 或末 op 之后状态仍有差异时补一个空操作 commit。
  const snap = { cardId, seq, cardBytes, cardElements, segCounter, closedSegCount, tail, carry }
  const last = ops[ops.length - 1]
  // 简单起见：恒追加一个 no-op 规划项携带末态（执行侧对 type:'noop' 直接 commit，不调 API）。
  ops.push({ op: { type: 'noop' }, commit: () => ({ ...snap }) })
  return { ops }
```

同时在 `CardOp` 联合类型加 `| { type: 'noop' }`（执行侧遇 noop 跳过 API 直接 commit；`planFinalize` 不产 noop）。

返回值改 `return { ops }`（删去整体 state 返回）。

> 备选（实现者二选一，取代码更简者）：不设 noop，改为 planSync 额外返回 `endState` 供执行侧在整批成功后兜底提交。但若选此方案，Task 4 的逐 op 确认语义仍以 commit 为准，endState 仅用于「全批成功且无末 op 携带末态」的场合。**默认按 noop 方案实施。**

`reply.ts` 临时适配（保持旧乐观语义，Task 4 重写）：

```ts
  private flush(): void {
    const planned = planSync(this.state, this.segments, this.tunables.cardMaxBytes, this.tunables.processMaxBytes)
    const ops = planned.ops.filter((p) => p.op.type !== 'noop')
    if (ops.length === 0) {
      // 纯状态推进也要落（段封闭），否则下一次规划重复
      this.state = planned.ops.reduce((s, p) => p.commit(s), this.state)
      return
    }
    this.enqueue(async () => {
      await this.exec(ops.map((p) => p.op))
      this.state = planned.ops.reduce((s, p) => p.commit(s), this.state)
    })
  }
```

（`finalize` 中 `planFinalize` 不变。）

- [ ] **Step 4: 适配全部 planSync 测试并跑通**

`feishu-cards.test.ts`：`planSync(...)` 的 `.state` 断言全部改为 `applyOps(initialState, ops)` 或对中间 `planSync` 结果 fold；`.ops` 断言改为 `ops.map((p) => p.op).filter((op) => op.type !== 'noop')`。`feishu-reply.test.ts` 预期不变（行为未改）。

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/feishu/cards.ts packages/toolkit/src/channels/feishu/reply.ts packages/toolkit/src/channels/feishu/feishu-cards.test.ts
git commit -m "refactor(toolkit): planSync 改返回逐 op commit 闭包，为确认式出站状态机铺路"
```

---

### Task 4: reply.ts 确认式 exec + 失败分类治理

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/api.ts`（新增 `feishuErrorCode` 导出）
- Modify: `packages/toolkit/src/channels/feishu/reply.ts`（flush 规划入队、exec 逐 op 确认、失败五分支、abandon + notice）
- Test: `packages/toolkit/src/channels/feishu/feishu-reply.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `PlannedOp`/`commit`；Task 1 的 op 序列。
- Produces：

```ts
// api.ts
/** 从 lark SDK 抛出的 axios 错误提取飞书业务错误码（无则 undefined）。 */
export function feishuErrorCode(error: unknown): number | undefined
```

- 行为契约（Task 7 守护测试依赖）：
  - op 成功（或 insert 遇 `300301`）才 `commit`；
  - `200850`/`200510` → `setCardStreaming(cardId, true, seq+1)` 重激活成功 → 以 `seq+2` 重放当前 op 一次；
  - `200860` → abandon（不重演尾段已显示部分：`carry.base = tail.base + tail.shownText.length`）；
  - 其他/无码错误 → 以 `state.seq + 2` 重放一次，仍败 → abandon（重演尾段：`carry.base = tail.base`，process 段恒 base 0）；
  - abandon = 尽力关旧卡流式 → `cardId=null` → 立即从确认状态重新规划续写，并向 chat `sendText` 异常提示（仅旧卡为真实卡时）；
  - 建卡链路（`cardId` 为 null/PENDING）失败不重放不 abandon，直接抛给 enqueue catch（状态未推进，下次 flush 自然重试）——现有两个建卡失败测试行为不变。

- [ ] **Step 1: 写失败测试**

`feishu-reply.test.ts` 顶部加错误工厂：

```ts
/** 飞书业务错误（模拟 lark SDK 的 axios error 形状）。 */
const bizError = (code: number): Error => Object.assign(new Error(`biz ${code}`), { response: { data: { code } } })
```

追加 describe：

```ts
describe('确认式出站与失败治理', () => {
  test('insert 遇 300301（元素重复）= 服务端已执行，视为成功', async () => {
    const { api, calls } = fakeApi()
    let once = true
    api.insertElement = async (...args) => {
      calls.push({ op: 'insertElement', args })
      if (once) { once = false; throw bizError(300301) }
    }
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '你好' }])
    await vi.advanceTimersByTimeAsync(500)
    await reply.update([{ kind: 'text', content: '你好' }, { kind: 'text', content: '世界' }].slice(1))  // 触发第二段
    // 简化：直接再 update 一个增长触发 update 即可；核心断言：insert 只调一次且后续 update 正常
    await reply.update([{ kind: 'text', content: '你好' }, { kind: 'process', content: '想' }])
    await vi.advanceTimersByTimeAsync(500)
    expect(calls.filter((c) => c.op === 'insertElement')).toHaveLength(1)   // 300301 未触发重插
    expect(calls.some((c) => c.op === 'updateCardElement')).toBe(true)
  })

  test('update 遇 200850（流式超时关闭）：重激活后重放，内容完整', async () => {
    const { api, calls } = fakeApi()
    let once = true
    api.updateCardElement = async (...args) => {
      calls.push({ op: 'updateCardElement', args })
      if (once) { once = false; throw bizError(200850) }
    }
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '你好' }])
    await vi.advanceTimersByTimeAsync(500)
    await reply.update([{ kind: 'text', content: '你好，世界' }])
    await vi.advanceTimersByTimeAsync(500)
    const reactivate = calls.find((c) => c.op === 'setCardStreaming' && c.args[1] === true)
    expect(reactivate).toBeDefined()                        // 重激活发生
    const updates = calls.filter((c) => c.op === 'updateCardElement')
    expect(updates[updates.length - 1].args[2]).toBe('你好，世界')   // 重放后内容完整
    expect(updates[updates.length - 1].args[3]).toBeGreaterThan(updates[0].args[3] as number)  // sequence 递增
  })

  test('update 遇 200860（超 30KB）：废弃旧卡拆新卡续写，内容零丢失零重复', async () => {
    const { api, calls } = fakeApi()
    api.updateCardElement = async (...args) => { calls.push({ op: 'updateCardElement', args }); throw bizError(200860) }
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '前半' }])
    await vi.advanceTimersByTimeAsync(500)
    await reply.update([{ kind: 'text', content: '前半后半' }])
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(5000)
    // 旧卡尝试关流；新卡从「后半」（确认点之后）续写，不重演「前半」
    const inserts = calls.filter((c) => c.op === 'insertElement')
    const newCardInsert = inserts[inserts.length - 1]
    expect(String(newCardInsert.args[1])).toContain('后半')
    expect(String(newCardInsert.args[1])).not.toContain('前半')
    expect(calls.some((c) => c.op === 'createCard')).toBe(true)
    expect(calls.filter((c) => c.op === 'createCard').length).toBe(2)
  })

  test('未知网络错误：sequence+2 重放一次成功；持续失败则废弃重演尾段并 notice', async () => {
    const { api, calls } = fakeApi()
    let fail = 1
    api.updateCardElement = async (...args) => {
      calls.push({ op: 'updateCardElement', args })
      if (fail-- > 0) throw new Error('socket hangup')
    }
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '你好' }])
    await vi.advanceTimersByTimeAsync(500)
    await reply.update([{ kind: 'text', content: '你好，世界' }])
    await vi.advanceTimersByTimeAsync(500)
    const updates = calls.filter((c) => c.op === 'updateCardElement')
    expect(updates).toHaveLength(2)                                   // 首次失败 + 重放成功
    expect(updates[1].args[3]).toBe((updates[0].args[3] as number) + 2)  // seq+2
    expect(updates[1].args[2]).toBe('你好，世界')

    // 持续失败分支
    const { api: api2, calls: calls2 } = fakeApi()
    api2.updateCardElement = async (...args) => { calls2.push({ op: 'updateCardElement', args }); throw new Error('down') }
    const { reply: reply2 } = make(api2)
    await reply2.update([{ kind: 'text', content: '前半' }])
    await vi.advanceTimersByTimeAsync(500)
    await reply2.update([{ kind: 'text', content: '前半后半' }])
    await vi.advanceTimersByTimeAsync(500)
    const inserts2 = calls2.filter((c) => c.op === 'insertElement')
    // 废弃时重演尾段：新卡 insert 含完整段（从 base 重插）
    expect(String(inserts2[inserts2.length - 1].args[1])).toContain('前半后半')
    expect(calls2.some((c) => c.op === 'sendText' && String(c.args[1]).includes('卡片输出异常'))).toBe(true)
  })

  test('建卡链路失败保持现状语义：不重放不废弃，下次 flush 重试', async () => {
    const { api, calls } = fakeApi()
    let failing = true
    api.createCard = async () => {
      calls.push({ op: 'createCard', args: [] })
      if (failing) throw new Error('rate limited')
      return 'card_back'
    }
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '你好' }])
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(5000)
    failing = false
    await reply.update([{ kind: 'text', content: '你好呀' }])
    await vi.advanceTimersByTimeAsync(500)
    const tail3 = calls.slice(-3).map((c) => c.op)
    expect(tail3).toEqual(['createCard', 'sendCardMessage', 'insertElement'])
    expect(String(calls[calls.length - 1].args[1])).toContain('你好呀')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-reply.test.ts`
Expected: FAIL（新行为未实现：300301 无特判、无重激活、无废弃续写）

- [ ] **Step 3: 实现 `feishuErrorCode`（api.ts）**

```ts
/** 从 lark SDK 抛出的 axios 错误提取飞书业务错误码（无则 undefined）。 */
export function feishuErrorCode(error: unknown): number | undefined {
  const data = (error as { response?: { data?: unknown } } | null | undefined)?.response?.data
  if (typeof data !== 'object' || data === null) return undefined
  const code = (data as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}
```

- [ ] **Step 4: 重写 reply.ts 执行核心**

完整替换 `FeishuReplyHandle`（保留 `withRetry`/`makeAck` 与类字段中 `api/chatId/tunables/log` 构造）：

```ts
/** 出站句柄：turn 级流式卡片（确认式状态机 + 失败分类治理 + 拆卡定格）。 */
import type { ChannelTunables, Disposer, ReplyHandle, TurnSegment, TurnStatus } from '../channel.ts'
import { feishuErrorCode, type FeishuApi } from './api.ts'
import {
  initialStreamState, PENDING_CARD_ID, STATUS_ELEMENT_ID,
  planFinalize, planSync, type CardOp, type PlannedOp, type StreamState,
} from './cards.ts'

/** 卡片输出异常时的用户提示（仅真实废弃一张已发卡时发送）。 */
const ABANDON_NOTICE = '⚠️ 卡片输出异常，已在新卡片继续；如有内容缺失请重发。'

/** 单次 flush 内连续废弃换卡的上限（防异常死循环；超限抛给出站链日志）。 */
const MAX_ABANDON_PER_FLUSH = 3

export class FeishuReplyHandle implements ReplyHandle {
  private state: StreamState = initialStreamState()
  private segments: readonly TurnSegment[] = []
  private tail: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private planQueued = false
  private finalized = false

  constructor(
    private readonly api: FeishuApi,
    private readonly chatId: string,
    private readonly tunables: ChannelTunables,
    private readonly log: (message: string) => void,
  ) {}

  beginTurn(): Promise<void> {
    return Promise.resolve()
  }

  update(segments: readonly TurnSegment[]): Promise<void> {
    if (this.finalized) return Promise.resolve()
    this.segments = segments
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, this.tunables.cardUpdateThrottleMs)
    }
    return Promise.resolve()
  }

  async finalize(status: TurnStatus, detail?: string): Promise<void> {
    if (this.finalized) {
      await this.tail
      return
    }
    this.finalized = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.flush()
    // 等 flush 定局（含失败恢复）后再规划定格：状态此刻是已确认态。
    await this.tail
    const hadCard = this.state.cardId !== null
    const { ops } = planFinalize(this.state, status)
    // 定格批不触发废弃重规划（卡已在收尾）：遇 abandon 直接止步。
    this.enqueue(async () => {
      for (const op of ops) {
        const outcome = await this.execOne({ op, commit: (s: StreamState) => s })
        if (outcome === 'abandoned') return
      }
    })
    if (!hadCard && detail !== undefined) {
      this.enqueue(() => withRetry(() => this.api.sendText(this.chatId, detail)).then(() => undefined))
    }
    await this.tail
  }

  notice(text: string): Promise<void> {
    this.enqueue(() => withRetry(() => this.api.sendText(this.chatId, text)).then(() => undefined))
    return this.tail.then(() => undefined)
  }

  /**
   * 规划入串行链：planSync 在执行点读最新已确认状态与最新 segments，
   * 在飞期间到达的 flush 只标位不重复规划（杜绝重复建卡/重复 insert）。
   */
  private flush(): void {
    if (this.planQueued) return
    this.planQueued = true
    this.enqueue(async () => {
      this.planQueued = false
      const { ops } = planSync(this.state, this.segments, this.tunables.cardMaxBytes, this.tunables.processMaxBytes)
      await this.exec(ops)
    })
  }

  /** 逐 op 确认执行；遇废弃从已确认状态重新规划续写（上限 MAX_ABANDON_PER_FLUSH 次）。 */
  private async exec(ops: readonly PlannedOp[]): Promise<void> {
    let pending = ops
    for (let attempts = 0; ; attempts++) {
      let abandoned = false
      for (const planned of pending) {
        if ((await this.execOne(planned)) === 'abandoned') {
          abandoned = true
          break
        }
      }
      if (!abandoned) return
      if (attempts >= MAX_ABANDON_PER_FLUSH) throw new Error('卡片连续废弃超限，本批输出放弃（下一 flush 继续）')
      pending = planSync(this.state, this.segments, this.tunables.cardMaxBytes, this.tunables.processMaxBytes).ops
    }
  }

  /**
   * 单个 op：成功（或 insert 300301 视同成功）才 commit；
   * 失败按错误码分类：流式超时重激活重放 / 200860 废弃续写 / 未知错误 seq+2 重放一次。
   */
  private async execOne(planned: PlannedOp): Promise<'ok' | 'abandoned'> {
    const { op } = planned
    if (op.type === 'noop') {
      this.commit(planned)
      return 'ok'
    }
    const liveCard = this.state.cardId !== null && this.state.cardId !== PENDING_CARD_ID
    try {
      await this.invokeThenCommit(planned)
      return 'ok'
    } catch (error) {
      // 建卡链路（尚无活卡）：状态未推进，抛给出站链日志，下次 flush 自然重试。
      if (!liveCard) throw error
      const code = feishuErrorCode(error)
      if (op.type === 'insert' && code === 300301) {
        // 元素重复 = 服务端已执行（此前响应丢失），视同成功。
        this.commit(planned)
        return 'ok'
      }
      if (code === 200850 || code === 200510) {
        // 流式被平台超时自动关闭：重激活（占一个 sequence）后以新 sequence 重放一次。
        if (await this.reactivate()) {
          try {
            await this.invokeThenCommit(planned, this.state.seq + 1)
            return 'ok'
          } catch {
            return this.abandon('流式超时重激活后重放失败', true)
          }
        }
        return this.abandon('流式超时且重激活失败', true)
      }
      if (code === 200860) {
        // 确定性超限：op 未被应用。废弃换卡，从确认点续写（不重演已显示部分）。
        return this.abandon('卡片超出平台大小上限', false)
      }
      // 未知/网络错误（op 可能已执行）：sequence 跳过可能已消耗的序号重放一次
      // （update/settings 幂等；insert 重演由 300301 兜底）。
      try {
        await this.invokeThenCommit(planned, this.state.seq + 2)
        return 'ok'
      } catch (retryError) {
        if (op.type === 'insert' && feishuErrorCode(retryError) === 300301) {
          this.commit(planned)
          return 'ok'
        }
        return this.abandon('卡片操作重放失败', true)
      }
    }
  }

  /** 执行 API 并在成功后 commit；seqOverride 用于重放（create 的真实 cardId 在此覆盖进状态）。 */
  private async invokeThenCommit(planned: PlannedOp, seqOverride?: number): Promise<void> {
    const op = withSeq(planned.op, seqOverride)
    if (op.type === 'create') {
      const id = await withRetry(() => this.api.createCard(op.cardJson))
      this.state = { ...planned.commit(this.state), cardId: id }
      return
    }
    if (op.type === 'send') {
      await withRetry(() => this.api.sendCardMessage(this.chatId, this.state.cardId!))
    } else if (op.type === 'insert') {
      await this.api.insertElement(this.state.cardId!, op.elementJson, STATUS_ELEMENT_ID, op.sequence)
    } else if (op.type === 'update') {
      await this.api.updateCardElement(this.state.cardId!, op.elementId, op.content, op.sequence)
    } else if (op.type === 'settings') {
      await this.api.setCardStreaming(this.state.cardId!, op.streaming, op.sequence, op.summary)
    }
    this.commit(planned, seqOverride)
  }

  private commit(planned: PlannedOp, seqOverride?: number): void {
    const next = planned.commit(this.state)
    this.state = seqOverride !== undefined ? { ...next, seq: seqOverride } : next
  }

  /** 流式超时后的官方恢复路径：settings 重设 streaming_mode:true（占一个 sequence）。 */
  private async reactivate(): Promise<boolean> {
    const { cardId, seq } = this.state
    if (cardId === null || cardId === PENDING_CARD_ID) return false
    try {
      await this.api.setCardStreaming(cardId, true, seq + 1)
      this.state = { ...this.state, seq: seq + 1 }
      return true
    } catch {
      return false
    }
  }

  /**
   * 废弃当前卡：尽力关流 → cardId 归零、尾段回卷为 carry → 调用方重新规划续写。
   * reshowTail=true（未知失败，op 可能已执行）时从尾段 base 重演（少量重复优于丢失）；
   * reshowTail=false（200860 确定性未应用）时跳过已显示部分（零重复）。
   */
  private async abandon(reason: string, reshowTail: boolean): Promise<'abandoned'> {
    const { cardId, tail, seq } = this.state
    const hadRealCard = cardId !== null && cardId !== PENDING_CARD_ID
    if (hadRealCard) {
      await this.api.setCardStreaming(cardId as string, false, seq + 1).catch(() => undefined)
    }
    if (tail !== undefined) {
      const kind = this.segments[tail.segIndex]?.kind
      const base = kind === 'process' ? 0 : reshowTail ? tail.base : tail.base + tail.shownText.length
      this.state = {
        ...this.state,
        cardId: null,
        tail: undefined,
        closedSegCount: tail.segIndex,
        carry: { segIndex: tail.segIndex, base },
      }
    } else {
      this.state = { ...this.state, cardId: null }
    }
    this.log(`[project-bot] 卡片输出异常（${reason}），已废弃当前卡并在新卡继续`)
    if (hadRealCard) {
      await withRetry(() => this.api.sendText(this.chatId, ABANDON_NOTICE)).catch(() => undefined)
    }
    return 'abandoned'
  }

  private enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((error) => {
      this.log(`[project-bot] 卡片操作失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

/** 重放用：仅带 sequence 语义的 op 替换序号（create/send 无序号）。 */
function withSeq(op: CardOp, sequence: number | undefined): CardOp {
  if (sequence === undefined) return op
  if (op.type === 'insert') return { ...op, sequence }
  if (op.type === 'update') return { ...op, sequence }
  if (op.type === 'settings') return { ...op, sequence }
  return op
}
```

注意：`finalize` 的 `planFinalize` ops 不含 noop；`execOne` 对 finalize 批的 `commit` 是恒等函数，失败治理照常生效（重激活/重放），abandon 时 finalize 循环直接 return。

- [ ] **Step 5: 适配存量 reply 测试并跑通**

- '建卡失败：重试耗尽只记日志不抛出…' 与 '建卡瞬时失败…' 两个用例：行为不变（建卡链路失败不重放），预期不动；
- 其余用例预期不变（happy path op 序列不变）；
- 全量跑 `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/` → PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/channels/feishu/api.ts packages/toolkit/src/channels/feishu/reply.ts packages/toolkit/src/channels/feishu/feishu-reply.test.ts
git commit -m "fix(toolkit): 卡片出站改确认式状态机——op 成功才提交状态，失败按错误码重激活/重放/废弃续写，内容零丢失"
```

---

### Task 5: reply 句柄时序——忙时不替换、`/new` 等旧卡定格

**Files:**
- Modify: `packages/toolkit/src/channels/router.ts`（`ensure` L34-51 删存量分支的 reply 替换；`reset` L97-105 改等待落定；新增 `retire` 私有方法）
- Modify: `packages/toolkit/src/channels/inbound.ts`（L64-68 准入通过后赋值 `rt.reply`）
- Test: `packages/toolkit/src/channels/router.test.ts`、`packages/toolkit/src/channels/inbound.test.ts`

**Interfaces:**
- Consumes: `SessionRuntime`（`packages/toolkit/src/channels/ports.ts` L58-73：`reply` 可写、`agent: AgentPort` 含 `cancel()/whenIdle()`、`tail: Promise<unknown>`）。
- Produces：`Router` 公有签名不变；行为契约——
  - `ensure` 对已在 `sessions` map 的会话**不再触碰** `rt.reply`；
  - `Inbound.handle` 在 `rt.inflight` 占槽成功后才执行 `rt.reply = msg.reply`；
  - `reset`/`stopBot`/`unbindBot` 取消会话后**延迟**到 `whenIdle + tail` 落定才从 `sessions` 删除（turn/end 得以在旧 reply 句柄上 finalize）。

- [ ] **Step 1: 写失败测试**

`inbound.test.ts` 追加（fake 形状照该文件现有写法：fake Router 用真 Router + fake AgentsPort，或按现有 inbound 测试的注入方式）：

```ts
test('处理中再发消息：rt.reply 不被替换，运行中 turn 仍在旧句柄收尾', async () => {
  // 依次入站两条普通消息；第一条占 inflight，第二条触发 ensure 存量分支 + 忙时 notice
  const { inbound, router, replies } = makeFixture()   // 照文件现有 fixture 命名调整
  await flushMessage(inbound, '任务一')                 // 第一条：建会话、占 inflight
  const rt = router.lookup('bot1', 'oc_1')!
  const firstReply = rt.reply
  await flushMessage(inbound, '追问')                   // 第二条：收到「请稍候」
  expect(rt.reply).toBe(firstReply)                     // 未被替换
  expect(replies[1].notices).toEqual(['上一条还在处理中，请稍候（或发送 /stop 取消）'])
})
```

`router.test.ts` 追加：

```ts
test('/new：旧会话等 turn 落定后再摘出 sessions（旧卡可 finalize）', async () => {
  const { router, sessions } = makeRouterFixture()   // 照文件现有 fixture
  const rt = await router.ensure(bot, 'oc_1', fakeReply(), 'ou_1')
  const oldSessionId = rt.sessionId
  let idle!: () => void
  rt.agent.whenIdle = () => new Promise<void>((resolve) => { idle = resolve })
  const done = router.reset(bot, 'oc_1', fakeReply(), 'ou_1')
  await done
  expect(sessions.has(oldSessionId)).toBe(true)      // 未落定前仍在 map（turn/end 可达）
  idle()
  await new Promise((r) => setTimeout(r, 0))
  expect(sessions.has(oldSessionId)).toBe(false)     // 落定后摘除
  expect(router.lookup('bot1', 'oc_1')?.sessionId).not.toBe(oldSessionId)
})
```

（若现有 fixture 名称不同，以现有文件为准调整；agent fake 需含 `cancel`/`whenIdle`/`followup`/`sessionId`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/router.test.ts src/channels/inbound.test.ts`
Expected: FAIL（`rt.reply` 被替换 / reset 同步摘除）

- [ ] **Step 3: 实现**

`router.ts`：

```ts
  async ensure(bot: BotRecord, chatId: string, reply: ReplyHandle, userId: string): Promise<SessionRuntime> {
    const bound = this.bindings.get(bot.id, chatId)
    if (bound !== undefined) {
      const existing = this.sessions.get(bound)
      // 活跃会话不替换 reply：运行中 turn 的出站必须留在原句柄收尾；
      // reply 的刷新由 Inbound 在 in-flight 准入通过后执行。
      if (existing !== undefined) return existing
      const agent = await this.agents.resume({ sessionId: bound, ...this.resolveSession(bot, userId) })
      await this.attach(bot.project, bound)
      return this.adopt(bot.id, chatId, userId, bound, agent, reply)
    }
    // ...新建分支不变...
  }

  /** /new：取消旧会话；等 turn/end 落定（旧卡在旧句柄 finalize）后再摘出 sessions。 */
  async reset(bot: BotRecord, chatId: string, reply: ReplyHandle, userId: string): Promise<SessionRuntime> {
    const bound = this.bindings.get(bot.id, chatId)
    if (bound !== undefined) {
      const old = this.sessions.get(bound)
      if (old !== undefined) this.retire(bound, old)
      await this.bindings.delete(bot.id, chatId)
    }
    return this.ensure(bot, chatId, reply, userId)
  }

  /** 取消会话并等出站链落定后摘出 sessions（让在飞 turn 的 turn/end 正常 finalize 旧卡）。 */
  private retire(sessionId: string, rt: SessionRuntime): void {
    rt.agent.cancel()
    void (async () => {
      await rt.agent.whenIdle().catch(() => undefined)
      await rt.tail.catch(() => undefined)
      if (this.sessions.get(sessionId) === rt) this.sessions.delete(sessionId)
    })()
  }
```

`stopBot`/`unbindBot` 中 `rt.agent.cancel(); this.sessions.delete(sessionId)` 两行改为 `this.retire(sessionId, rt)`（同类问题一并消除；`stopAll` 插件卸载路径本就 await 全量落定，不动）。

`inbound.ts`（L64-71 区域）：

```ts
    const rt = await this.deps.router.ensure(bot, msg.chatId, msg.reply, msg.userId)
    if (rt.inflight !== undefined) {
      await msg.reply.notice('上一条还在处理中，请稍候（或发送 /stop 取消）')
      return
    }
    // 准入：先占槽再异步；表情回复失败不阻塞处理。
    // reply 句柄只在准入通过后刷新——忙时消息不抢走运行中 turn 的出站。
    rt.inflight = { ack: undefined }
    rt.reply = msg.reply
    rt.inflight.ack = (await msg.ackProcessing().catch(() => undefined)) ?? undefined
```

- [ ] **Step 4: 跑通 + 全量回归**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/`
Expected: PASS（含 runtime.test.ts 中 stopBot/unbindBot 相关用例——若它们断言 sessions 同步清空，适配为「落定后清空」并注原因）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/router.ts packages/toolkit/src/channels/inbound.ts packages/toolkit/src/channels/router.test.ts packages/toolkit/src/channels/inbound.test.ts packages/toolkit/src/channels/runtime.test.ts
git commit -m "fix(toolkit): reply 句柄准入通过后才替换；/new 与停 bot 等旧卡 finalize 后再摘会话映射"
```

---

### Task 6: Config——cardPrintStep 新增 + cardMaxBytes 默认 26_000

**Files:**
- Modify: `packages/toolkit/src/index.ts`（Config schema L83-85 与默认快照 L92-94）
- Modify: `packages/toolkit/src/channels/channel.ts`（`ChannelTunables` L62-68 加 `cardPrintStep: number`）
- Modify: `packages/toolkit/src/bots/index.ts`（tunables 快照 L65-67 加 `cardPrintStep: config.cardPrintStep`）
- Modify: `packages/toolkit/src/channels/feishu/cards.ts`（`buildCardJson(printStep: number)`；`planSync` 加第 5 参 `printStep: number`；`reply.ts` 调用处传 `this.tunables.cardPrintStep`）
- Test: `packages/toolkit/src/bots/smoke.test.ts`（L11 tunables 字面量 + L15 键清单）、`packages/toolkit/src/index.test.ts`（L132-134 期望值）、`feishu-cards.test.ts`/`feishu-reply.test.ts`（buildCardJson/planSync/TUNABLES 适配）

**Interfaces:**
- Produces：`ChannelTunables.cardPrintStep: number`；`buildCardJson(printStep: number): string`；`planSync(state, segments, maxBytes, processMaxBytes, printStep)`（Task 4 的 reply.ts 两处 planSync 调用同步补参）。Config 键：`feishu.cardMaxBytes` 默认 **26_000**（语义 = 单卡真实 DSL 字节上限）、`feishu.cardPrintStep` 默认 **5**。

- [ ] **Step 1: 写失败测试**

`feishu-cards.test.ts` 的 buildCardJson describe 追加：

```ts
test('print_step 取配置值', () => {
  const json = JSON.parse(buildCardJson(5))
  expect(json.config.streaming_config.print_step).toEqual({ default: 5 })
  expect(json.config.streaming_config.print_strategy).toBe('fast')
})
```

`index.test.ts`：默认配置断言区把 `cardMaxBytes: 28_000` 改 `26_000`，并补 `cardPrintStep: 5`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-cards.test.ts src/index.test.ts`
Expected: FAIL（buildCardJson 无参 / 默认值不符）

- [ ] **Step 3: 实现**

- `cards.ts`：`buildCardJson(printStep: number)`，`print_step: { default: printStep }`；`planSync` 加第 5 参 `printStep`，`ensureCard` 内 `buildCardJson(printStep)`；
- `channel.ts` `ChannelTunables` 加 `cardPrintStep: number`（注释：飞书流式打字机每次打印字符数）；
- `reply.ts` 两处 `planSync(...)` 调用补第 5 参 `this.tunables.cardPrintStep`；
- `index.ts` Config schema：`cardMaxBytes: z.number().default(26_000)`（注释改为「单卡真实 DSL 字节上限（含结构与转义；平台硬上限 30KB）」），新增 `cardPrintStep: z.number().default(5)`；默认快照对象同步；
- `bots/index.ts` tunables 快照补 `cardPrintStep: config.cardPrintStep`。

- [ ] **Step 4: 适配全部测试并跑通**

- 所有测试文件的 `buildCardJson()` 调用补参（测试里统一用 `buildCardJson(5)`）；`planSync(...)` 调用补第 5 参（测试用 5）；
- `feishu-reply.test.ts` 的 `TUNABLES` 加 `cardPrintStep: 5`；`runtime.test.ts` L61 tunables 字面量同步；
- `bots/smoke.test.ts` L11 加 `cardPrintStep: 0`，L15 键清单加 `'cardPrintStep'`。

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（449+ 全绿）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src
git commit -m "feat(toolkit): cardPrintStep 进 Config（默认 5 提速打字机）；cardMaxBytes 默认降 26000 对齐真实 DSL 语义"
```

---

### Task 7: 端到端内容完整性守护测试

**Files:**
- Create: `packages/toolkit/src/channels/feishu/feishu-stream-integrity.test.ts`

**Interfaces:**
- Consumes: `Outbound`（`channels/outbound.ts`）+ `FeishuReplyHandle` + fake `FeishuApi`；spec 第 6 节测试 4。

- [ ] **Step 1: 写守护测试（先红后绿本任务不适用——这是新增守护，直接写并跑绿）**

测试骨架（模拟飞书端卡片状态机 + 可注入失败的 fake api + 确定性事件流；断言「所有卡正文元素拼接 == 模型全量正文」）：

```ts
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { FeishuReplyHandle } from './reply.ts'
import { Outbound } from '../outbound.ts'
import type { FeishuApi } from './api.ts'
import type { SessionRuntime } from '../ports.ts'

/** 模拟飞书服务端：卡片实体表 + 元素表，支持按调用序号注入错误。 */
function fakeFeishu(failures: Map<string, number[]>) {
  // key = 'updateCardElement' 等 op 名，value = 第 N 次调用（1 起）注入 200860；空 = 全成功
  const cards = new Map<string, { elements: Map<string, string>; order: string[]; streaming: boolean; sent: boolean }>()
  const counters = new Map<string, number>()
  const shouldFail = (op: string): boolean => {
    const n = (counters.get(op) ?? 0) + 1
    counters.set(op, n)
    return (failures.get(op) ?? []).includes(n)
  }
  const biz = (code: number) => Object.assign(new Error(`biz ${code}`), { response: { data: { code } } })
  let cardSeq = 0
  const api: FeishuApi = {
    createCard: async () => {
      const id = `card_${++cardSeq}`
      cards.set(id, { elements: new Map([['status', '⏳ 输出中…']]), order: ['status'], streaming: true, sent: false })
      return id
    },
    sendCardMessage: async (_chat, cardId) => { cards.get(cardId)!.sent = true },
    updateCardElement: async (cardId, elementId, content) => {
      if (shouldFail('updateCardElement')) throw biz(200860)
      if (!cards.get(cardId)!.streaming) throw biz(200850)
      cards.get(cardId)!.elements.set(elementId, content)
    },
    insertElement: async (cardId, elementJson, target) => {
      if (shouldFail('insertElement')) throw biz(200860)
      if (!cards.get(cardId)!.streaming) throw biz(200850)
      const el = JSON.parse(elementJson)
      const id = el.tag === 'collapsible_panel' ? el.elements[0].element_id : el.element_id
      const content = el.tag === 'collapsible_panel' ? el.elements[0].content : el.content
      const card = cards.get(cardId)!
      card.order.splice(card.order.indexOf(target), 0, id)
      card.elements.set(id, content)
    },
    setCardStreaming: async (cardId, streaming) => { cards.get(cardId)!.streaming = streaming },
    replaceCard: async () => undefined,
    sendText: async () => undefined,
    addReaction: async () => 'r1',
    removeReaction: async () => undefined,
    downloadImage: async () => ({ data: new Uint8Array(), mediaType: 'image/png' }),
    getBotOpenId: async () => 'ou_bot',
  }
  return { api, cards }
}

/** 生成 40 轮「思考×8 + 工具行 + 正文×10 增量」的会话事件流（driver 逐条喂 Outbound）。 */
function* events(turn: number) {
  yield { type: 'turn/start', data: { turn } }
  for (let round = 0; round < 40; round++) {
    for (let i = 0; i < 8; i++) {
      yield { type: 'assistant/chunk', data: { turn, step: round * 2 + 1, chunk: { type: 'reasoning-delta', index: 0, text: `思考片段 r${round}.${i}。` } } }
    }
    yield { type: 'tool/call', data: { turn, step: round * 2 + 1, name: 'fs_read', arguments: '{"path":"src/main.ts"}' } }
    const text = `第 ${round} 轮正文输出。`.repeat(80)
    for (let i = 1; i <= 10; i++) {
      const piece = text.slice(Math.floor((i - 1) * text.length / 10), Math.floor(i * text.length / 10))
      yield { type: 'assistant/chunk', data: { turn, step: round * 2 + 1, chunk: { type: 'text-delta', index: 1, text: piece } } }
    }
  }
  yield { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }
}

const TUNABLES = { cardUpdateThrottleMs: 50, cardMaxBytes: 26_000, cardPrintStep: 5, processMaxBytes: 8_000, processingReactionEmoji: 'OneSecond' }

async function drive(failures: Map<string, number[]>) {
  vi.useFakeTimers()
  const { api, cards } = fakeFeishu(failures)
  const reply = new FeishuReplyHandle(api, 'oc_1', TUNABLES, () => undefined)
  const rt = {
    botId: 'b', chatId: 'oc_1', sessionId: 's1', initiatorOpenId: 'ou_1',
    agent: { sessionId: 's1', followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined },
    reply, inflight: undefined, tail: Promise.resolve(), turn: undefined,
  } as SessionRuntime
  const sessions = new Map([['s1', rt]])
  const outbound = new Outbound(sessions, () => undefined)
  for (const e of events(1)) {
    outbound.handleSessionEvent('s1', e)
    await vi.advanceTimersByTimeAsync(60)   // 越过 50ms 节流
  }
  await vi.advanceTimersByTimeAsync(10_000) // 收尾退避
  vi.useRealTimers()
  return { cards }
}

function renderedText(cards: Awaited<ReturnType<typeof drive>>['cards']): string {
  const parts: string[] = []
  for (const card of cards.values()) {
    if (!card.sent) continue
    for (const id of card.order) {
      if (id === 'status') continue
      const c = card.elements.get(id)!
      if (!(c.includes('思考') || c.includes('🔧') || c.startsWith('…（已省略前文）'))) parts.push(c)
    }
  }
  return parts.join('')
}

const FULL_TEXT = Array.from({ length: 40 }, (_, r) => `第 ${r} 轮正文输出。`.repeat(80)).join('')

describe('端到端内容完整性守护', () => {
  test('无失败：正文逐字节完整，旧卡状态行全部定格', async () => {
    const { cards } = await drive(new Map())
    expect(renderedText(cards)).toBe(FULL_TEXT)
    const arr = [...cards.values()]
    expect(arr.length).toBeGreaterThan(1)   // 确认发生了拆卡
    for (const card of arr.slice(0, -1)) {
      expect(card.elements.get('status')).toBe('📦 内容较长，已接续到下一张卡片')
    }
    expect(arr[arr.length - 1].elements.get('status')).toBe('✅ 输出完成')
  })

  test('注入 200860 / 200850 抖动：正文仍逐字节完整（或仅废弃重演处可控重复）', async () => {
    const { cards } = await drive(new Map([
      ['updateCardElement', [3, 7]],     // 第 3、7 次 update 注入 200860
      ['insertElement', [4]],            // 第 4 次 insert 注入 200860
    ]))
    const rendered = renderedText(cards)
    // 完整性的弱断言：每个正文片段都至少出现一次，且相对顺序不变
    let cursor = 0
    for (let r = 0; r < 40; r++) {
      const marker = `第 ${r} 轮正文输出。`
      const idx = rendered.indexOf(marker, cursor)
      expect(idx).toBeGreaterThanOrEqual(cursor)
      cursor = idx + marker.length
    }
  })
})
```

（若注入场景下 200860 分支实现为「跳过头段已显示部分」严格无重复，可把弱断言升级为 `rendered === FULL_TEXT` 精确断言——实施时以更强者为准并固定。）

- [ ] **Step 2: 跑通**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-stream-integrity.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/toolkit/src/channels/feishu/feishu-stream-integrity.test.ts
git commit -m "test(toolkit): 飞书卡片流端到端内容完整性守护（拆卡定格 + 失败注入零丢失）"
```

---

### Task 8: 文档同步 + 全量验证

**Files:**
- Modify: `AGENTS.md`（飞书出站要点段）
- Modify: `docs/usage/` 中卡片行为相关页（先 `grep -rn "输出中" docs/usage/` 定位）
- Modify: `docs/superpowers/specs/2026-09-08-feishu-card-stream-robustness-design.md`（状态行改「已实施」）

**Interfaces:** 无（纯文档 + 验证）。

- [ ] **Step 1: AGENTS.md 更新**

在「dsh 插件开发要点」的飞书相关段落中把「飞书入站支持 text/post/image…」之后的出站描述更新为：

> 飞书出站为确认式状态机：planSync 返回逐 op commit，op 成功才提交状态；失败按错误码治理（300301 视同成功 / 200850·200510 重激活重放 / 200860 废弃拆卡续写 / 未知错误 seq+2 重放）；拆卡定格旧卡状态行「📦 内容较长，已接续到下一张卡片」；`cardMaxBytes`（默认 26000）语义为单卡真实 DSL 字节上限（平台硬上限 30KB），`cardPrintStep`（默认 5）控制打字机速度；reply 句柄在 in-flight 准入通过后才替换，`/new` 等旧卡 finalize 后再摘会话映射。

- [ ] **Step 2: usage 手册与 spec 状态**

`grep -rn "输出中\|生成中\|cardMaxBytes" docs/usage/` 找到卡片行为说明处同步；spec 文件状态行从「草案，待需求方确认」改为「已实施（2026-09-08）」。

- [ ] **Step 3: 全量验证**

Run（仓库根，按序）:
1. `pnpm --filter dsh-agent-toolkit test` → 全绿（含新增守护）
2. `pnpm --filter dsh-agent-toolkit typecheck` → 零错误
3. `pnpm --filter dsh-agent-toolkit bundle` → 产出 lib/index.js + lib/client.js 成功
4. `pnpm --filter @dsh-agent-toolkit/token-usage test` → 全绿（确认零跨包影响）

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/usage docs/superpowers/specs/2026-09-08-feishu-card-stream-robustness-design.md
git commit -m "docs(toolkit): 飞书确认式出站与拆卡定格的文档同步"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec 第 1 节→Task 1；第 2 节→Task 3+4；第 3 节→Task 2（+Task 6 默认值）；第 4 节→Task 5；第 5 节→Task 4（notice）+Task 6（print_step）；第 6 节测试 1-6→各任务测试步 + Task 7；文档同步→Task 8。spec 第 7 节「不做」无对应任务（符合预期）。
- **类型一致性**：`PlannedOp`/`feishuErrorCode`/`STATUS_CONTINUED`/`buildCardJson(printStep)`/`planSync` 五参 在 Task 2/3/4/6/7 间签名一致；Task 6 改 `buildCardJson` 签名后 Task 1-3 的测试调用全部在 Task 6 Step 4 适配。
- **已知风险**：Task 3 的 noop commit 方案（vs endState 备选）已在任务内注明取舍；Task 2 测试的转义字节数值以实现实测为准微调。
