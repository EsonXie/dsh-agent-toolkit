# 飞书输出完整性修复与生产调试日志 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飞书流式卡片关流后全量重放根治末段视觉截断（情形一）、对账升级 replace-or-append 修真实丢失洞（情形二），并落地默认开启、按日滚动、保留 7 天的生产调试文件日志。

**Architecture:** 设计 spec：`docs/superpowers/specs/2026-09-15-飞书输出完整性与生产调试日志-design.md`（以下简称 spec，§1-§5）。纯函数规划层 `cards.ts` 出 `replace` op；确认式执行层 `reply.ts` 对 replace 特判（失败非致命）；`outbound.ts` 对账升级；日志 sink 类型定义在渠道无关核心 `channel.ts`，JSONL 文件实现在 `channels/feishu/debug-log.ts`。

**Tech Stack:** TypeScript ESM（允许 `.ts` 后缀导入）、vitest（fake timers）、pnpm workspace（`packages/toolkit`）。

## Global Constraints

- 测试：`pnpm --filter dsh-agent-toolkit test`；单文件：`pnpm --filter dsh-agent-toolkit exec vitest run <相对 packages/toolkit 的路径>`；类型检查：`pnpm --filter dsh-agent-toolkit typecheck`；全部完成后 `pnpm --filter dsh-agent-toolkit bundle`。
- 本计划不改 `packages/usage`，无需先 bundle usage（AGENTS.md 的 usage-lib 约束不触发）。
- 仓库约定：可调参数进 Config schema（不硬编码）；`cards.ts` 保持纯函数（无 IO、无日志）；日志写失败必须静默吞掉，绝不影响出站链路。
- 隐私：日志中内容一律 `preview()`（长度 + 首 20 + 尾 20 code point），不落全文。
- **git commit 需用户确认**：每个 Task 末尾的 commit 步骤执行前向用户汇报并等确认（用户事先批量授权除外）。
- spec 既定事实不得偏离：replace 失败不进失败分类治理；对账 append 只在防护未命中且权威文本非空时触发。

---

### Task 1: DebugSink 类型 + JSONL 文件日志器

**Files:**
- Modify: `packages/toolkit/src/channels/channel.ts`（L65-74 ChannelTunables 块）
- Create: `packages/toolkit/src/channels/feishu/debug-log.ts`
- Test: `packages/toolkit/src/channels/feishu/feishu-debug-log.test.ts`

**Interfaces:**
- Produces（后续 Task 依赖的确切签名）:
  - `channel.ts` 导出 `type DebugSink = (event: { event: string; [key: string]: unknown }) => void`；`ChannelTunables` 新增可选字段 `debugLog?: DebugSink`
  - `debug-log.ts` 导出 `DEFAULT_DEBUG_LOG_DIR(): string`、`preview(text: string, head?: number, tail?: number): { len: number; head: string; tail: string }`、`createFeishuDebugLogger(dir: string, retentionDays: number, now?: () => Date): DebugSink`

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createFeishuDebugLogger, preview } from './debug-log.ts'

let dir = ''
afterEach(() => { if (dir !== '') rmSync(dir, { recursive: true, force: true }) })

describe('preview', () => {
  test('短文本原样、长文本首尾各 20 code point、不劈代理对', () => {
    expect(preview('你好')).toEqual({ len: 2, head: '你好', tail: '' })
    const long = 'a'.repeat(30) + '😀'.repeat(20)   // 50 code points
    const p = preview(long)
    expect(p.len).toBe(50)
    expect(p.head).toBe('a'.repeat(20))
    expect(p.tail).toBe('😀'.repeat(20))
    expect([...p.tail].length).toBe(20)
  })
})

describe('createFeishuDebugLogger', () => {
  test('写入当日 JSONL 文件，每行一个事件且带 ts', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-dbg-'))
    const sink = createFeishuDebugLogger(dir, 7, () => new Date(2026, 8, 15, 10, 0, 0))
    sink({ event: 'op', chatId: 'oc_1', op: 'update' })
    const lines = readFileSync(join(dir, 'feishu-2026-09-15.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const row = JSON.parse(lines[0]!) as { ts: string; event: string; op: string }
    expect(row.event).toBe('op')
    expect(row.op).toBe('update')
    expect(typeof row.ts).toBe('string')
  })

  test('跨日切换文件名，并在切换时清理超期文件（按文件名日期）', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-dbg-'))
    // 预置 8 天前与 6 天前的旧文件
    writeFileSync(join(dir, 'feishu-2026-09-07.jsonl'), '{}\n')
    writeFileSync(join(dir, 'feishu-2026-09-09.jsonl'), '{}\n')
    let day = 15
    const sink = createFeishuDebugLogger(dir, 7, () => new Date(2026, 8, day, 10, 0, 0))
    sink({ event: 'a' })   // 创建时清理：09-07（8 天前）删除，09-09（6 天前）保留
    expect(readdirSync(dir).sort()).toEqual(['feishu-2026-09-09.jsonl', 'feishu-2026-09-15.jsonl'])
    day = 16
    sink({ event: 'b' })   // 跨日切换
    expect(readdirSync(dir).sort()).toContain('feishu-2026-09-16.jsonl')
  })

  test('写失败静默（目录被删后不抛错）', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-dbg-'))
    const sink = createFeishuDebugLogger(dir, 7)
    rmSync(dir, { recursive: true, force: true })
    expect(() => sink({ event: 'op' })).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-debug-log.test.ts`
Expected: FAIL（`./debug-log.ts` 不存在）

- [ ] **Step 3: 实现 channel.ts 类型 + debug-log.ts**

`channel.ts`：在 `ChannelTunables` 上方加类型、接口内加字段：

```ts
/** 生产调试事件 sink（JSONL 文件日志等；undefined = 不记录）。 */
export type DebugSink = (event: { event: string; [key: string]: unknown }) => void
```

```ts
  /** 飞书打字机每次打印字符数。 */
  cardPrintStep: number
  processingReactionEmoji: string
  /** 生产调试日志 sink（feishu/debug-log.ts 装配；缺省不记录）。 */
  debugLog?: DebugSink
```

`debug-log.ts` 全文：

```ts
/** 生产调试文件日志：JSONL、按日滚动、按文件名日期保留 N 天；一切 fs 错误静默（绝不影响出站链路）。 */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DebugSink } from '../channel.ts'

/** 默认日志目录（Config feishu.debugLogDir 为空时）。 */
export function DEFAULT_DEBUG_LOG_DIR(): string {
  return join(homedir(), '.dsh', 'logs', 'feishu-debug')
}

/** 内容摘要：长度 + 首 head + 尾 tail 个 code point（不劈代理对；不落全文）。 */
export function preview(text: string, head = 20, tail = 20): { len: number; head: string; tail: string } {
  const chars = [...text]
  if (chars.length <= head + tail) return { len: chars.length, head: text, tail: '' }
  return { len: chars.length, head: chars.slice(0, head).join(''), tail: chars.slice(-tail).join('') }
}

const FILE_NAME = /^feishu-(\d{4})-(\d{2})-(\d{2})\.jsonl$/

export function createFeishuDebugLogger(dir: string, retentionDays: number, now: () => Date = () => new Date()): DebugSink {
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const fileNameOf = (d: Date): string => `feishu-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.jsonl`
  /** 按文件名日期删除超过 retentionDays 天的文件（文件名为准，不看 mtime）。 */
  const cleanup = (today: Date): void => {
    try {
      const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - retentionDays)
      for (const name of readdirSync(dir)) {
        const m = FILE_NAME.exec(name)
        if (m === null) continue
        const fileDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
        if (fileDate < cutoff) {
          try { unlinkSync(join(dir, name)) } catch { /* 单文件失败不阻断 */ }
        }
      }
    } catch { /* 目录不可读等：静默 */ }
  }
  try { mkdirSync(dir, { recursive: true }) } catch { /* 静默 */ }
  cleanup(now())
  let currentFile = ''
  return (event) => {
    try {
      const file = fileNameOf(now())
      if (file !== currentFile) {
        currentFile = file
        cleanup(now())
      }
      appendFileSync(join(dir, file), `${JSON.stringify({ ts: now().toISOString(), ...event })}\n`, 'utf8')
    } catch { /* 日志失败静默 */ }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-debug-log.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/channels/channel.ts packages/toolkit/src/channels/feishu/debug-log.ts packages/toolkit/src/channels/feishu/feishu-debug-log.test.ts
git commit -m "feat(feishu): 生产调试 JSONL 文件日志器（按日滚动 + N 天保留）"
```

---

### Task 2: cards.ts 关流后全量重放（replace op）+ reply.ts 最小执行通路

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/cards.ts`
- Modify: `packages/toolkit/src/channels/feishu/reply.ts`（planFinalize 调用点 L74、execOne L136-186、abandon L245-269）
- Test: `packages/toolkit/src/channels/feishu/feishu-cards.test.ts`、`packages/toolkit/src/channels/feishu/feishu-reply.test.ts`（适配既有断言）

**Interfaces:**
- Consumes: 无（本任务是机制本体）
- Produces:
  - `cards.ts` 导出 `interface CardSeg { segIndex: number; elementId: string; kind: 'text' | 'process'; base: number }`、`buildClosedCardJson(cardSegs: readonly CardSeg[], segments: readonly TurnSegment[], tail: StreamState['tail'], statusLine: string, processMaxBytes: number): string`
  - `StreamState` 新增 `cardSegs: readonly CardSeg[]`；`CardOp` 新增 `{ type: 'replace'; cardId: string; cardJson: string; sequence: number; elements: number }`
  - `planFinalize(state: StreamState, status: TurnStatus, segments: readonly TurnSegment[], processMaxBytes: number): { ops: CardOp[] }`（签名变更加两参）

- [ ] **Step 1: 写失败测试（追加进 feishu-cards.test.ts）**

```ts
import { buildClosedCardJson, initialStreamState, PENDING_CARD_ID, planFinalize, planSync, STATUS_CONTINUED, type StreamState } from './cards.ts'

const MAX = 26_000
const PROC = 8000
const STEP = 5

/** 纯函数侧模拟确认式执行：依次应用 commit；create 的真实 cardId 手动叠入。 */
function execAll(ops: readonly { commit: (s: StreamState) => StreamState }[], cardId = 'card_1'): StreamState {
  let state = initialStreamState()
  for (const p of ops) state = p.commit(state)
  return state.cardId === PENDING_CARD_ID ? { ...state, cardId } : state
}

describe('关流后全量重放（replace op）', () => {
  test('定格：planFinalize 在 update/settings 后追加 replace，重建内容与本卡已提交内容一致', () => {
    const segments = [
      { kind: 'text' as const, content: '正文一' },
      { kind: 'process' as const, content: '想一想' },
      { kind: 'text' as const, content: '最终答案' },
    ]
    const state = execAll(planSync(initialStreamState(), segments, MAX, PROC, STEP).ops)
    const fin = planFinalize(state, 'done', segments, PROC)
    expect(fin.ops.map((o) => o.type)).toEqual(['update', 'settings', 'replace'])
    const replace = fin.ops[2]!
    if (replace.type !== 'replace') throw new Error('unreachable')
    expect(replace.cardId).toBe('card_1')
    expect(replace.sequence).toBe(state.seq + 3)
    expect(replace.elements).toBe(4)   // 3 段 + 状态行
    const card = JSON.parse(replace.cardJson) as {
      config: { streaming_mode: boolean; summary: { content: string } }
      body: { elements: { tag: string; content?: string; element_id?: string; elements?: { content: string }[] }[] }
    }
    expect(card.config.streaming_mode).toBe(false)
    expect(card.config.summary.content).toBe('✅ 输出完成')
    expect(card.body.elements).toHaveLength(4)
    expect(card.body.elements[0]).toMatchObject({ tag: 'markdown', content: '正文一' })
    expect(card.body.elements[1]!.tag).toBe('collapsible_panel')
    expect(card.body.elements[1]!.elements![0]!.content).toBe('想一想')
    expect(card.body.elements[2]).toMatchObject({ tag: 'markdown', content: '最终答案' })
    expect(card.body.elements[3]).toMatchObject({ tag: 'markdown', content: '✅ 输出完成', element_id: 'status' })
  })

  test('无卡（cardId null）仍返回空 ops', () => {
    expect(planFinalize(initialStreamState(), 'done', [], PROC).ops).toEqual([])
  })

  test('拆卡：closeCard 追加 replace；旧卡重建精确对齐已提交的部分 piece', () => {
    // 极小 maxBytes（400）逼出拆卡：单卡内容预算 ≈ 400 - 基础卡(≈286B) - 元素开销(≈52B) ≈ 62 转义字节，
    // 100 字符 → 首卡 62 + 续卡 38，恰好 2 卡 1 次拆（若预算微变导致 3 卡，按实际 inserts/replaces 计数适配断言）。
    const segments = [{ kind: 'text' as const, content: 'A'.repeat(100) }]
    const { ops } = planSync(initialStreamState(), segments, 400, PROC, STEP)
    const inserts = ops.filter((o) => o.op.type === 'insert')
    const replaces = ops.filter((o) => o.op.type === 'replace')
    expect(inserts.length).toBe(2)          // 首卡部分 piece + 续卡剩余
    expect(replaces.length).toBe(1)         // 只有首卡关流重放（续卡在 planSync 内不关流）
    expect((replaces[0]!.op as { cardId: string }).cardId).toBe(PENDING_CARD_ID)   // 同次规划内建卡即拆卡 → 占位，执行侧解析
    const firstInsert = JSON.parse((inserts[0]!.op as { elementJson: string }).elementJson) as { content: string }
    const replace = replaces[0]!.op as { cardJson: string }
    const card = JSON.parse(replace.cardJson) as { body: { elements: { content?: string; element_id?: string }[] } }
    const textEl = card.body.elements.find((e) => e.element_id === 'seg_1')!
    expect(textEl.content).toBe(firstInsert.content)                 // 逐字节等于已提交 piece
    expect(textEl.content!.length).toBeLessThan(100)
    expect(card.body.elements.at(-1)!.content).toBe(STATUS_CONTINUED)
  })

  test('cardSegs 快照不可变：规划推进不污染先前 commit', () => {
    const segments = [{ kind: 'text' as const, content: '一' }, { kind: 'text' as const, content: '二' }]
    const { ops } = planSync(initialStreamState(), segments, MAX, PROC, STEP)
    const insert1 = ops.find((o) => o.op.type === 'insert')!
    const s1 = insert1.commit(initialStreamState())
    expect(s1.cardSegs).toHaveLength(1)
    const sN = ops[ops.length - 1]!.commit(initialStreamState())
    expect(sN.cardSegs).toHaveLength(2)
    expect(s1.cardSegs).toHaveLength(1)   // 先前快照不被后续规划污染
  })

  test('buildClosedCardJson：carry 续写段按 base 切片', () => {
    const json = buildClosedCardJson(
      [{ segIndex: 0, elementId: 'seg_9', kind: 'text', base: 3 }],
      [{ kind: 'text', content: '---续写内容' }],
      undefined,
      '✅ 输出完成',
      PROC,
    )
    const card = JSON.parse(json) as { body: { elements: { content?: string }[] } }
    expect(card.body.elements[0]!.content).toBe('续写内容')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-cards.test.ts`
Expected: FAIL（`buildClosedCardJson` 未导出 / `planFinalize` 参数不符 / `cardSegs` 不存在）

- [ ] **Step 3: 实现 cards.ts 改动**

a) `StreamState` 加字段 + `CardSeg` 导出（放在 `StreamState` 定义前）：

```ts
/** 当前卡上一个段元素的登记项（重建整卡用；base = 元素内容在该段 content 中的 char 起始偏移）。 */
export interface CardSeg { segIndex: number; elementId: string; kind: 'text' | 'process'; base: number }
```

`StreamState` 内加：

```ts
  /** 当前卡上的段元素清单（insert 追加、closeCard 清空；不可变更新保 commit 快照语义）。 */
  cardSegs: readonly CardSeg[]
```

`initialStreamState` 改为：

```ts
export const initialStreamState = (): StreamState => ({
  cardId: null, seq: 0, cardBytes: 0, cardElements: 0, segCounter: 0,
  closedSegCount: 0, tail: undefined, carry: undefined, cardSegs: [],
})
```

b) `CardOp` 加变体：

```ts
  | { type: 'replace'; cardId: string; cardJson: string; sequence: number; elements: number }
```

c) 新增 `buildClosedCardJson`（放在 `buildSegmentJson` 之后）：

```ts
/**
 * 关流后全量重放：用已提交内容重建整卡 JSON（非流式 update 直显，无打字机——根治关流时
 * 平台打字机存量未渲染完的情形一）。内容口径与本卡已提交内容逐字节一致：
 * process 段走截尾窗口；text 封闭段按 base 切片；当前尾段用 tail.shownText（拆卡时尾段
 * 只提交了部分 piece，不得用全文）。
 */
export function buildClosedCardJson(
  cardSegs: readonly CardSeg[],
  segments: readonly TurnSegment[],
  tail: StreamState['tail'],
  statusLine: string,
  processMaxBytes: number,
): string {
  const elements: unknown[] = []
  for (const entry of cardSegs) {
    const seg = segments[entry.segIndex]
    if (seg === undefined) continue
    const content = entry.kind === 'process'
      ? sliceTailByBytes(seg.content, processMaxBytes)
      : tail !== undefined && tail.segIndex === entry.segIndex
        ? tail.shownText
        : seg.content.slice(entry.base)
    elements.push(JSON.parse(buildSegmentJson(entry.kind, entry.elementId, content)) as unknown)
  }
  elements.push({ tag: 'markdown', content: statusLine, element_id: STATUS_ELEMENT_ID })
  return JSON.stringify({
    schema: '2.0',
    config: { streaming_mode: false, summary: { content: statusLine } },
    body: { elements },
  })
}
```

d) `planSync`：解构加 `cardSegs`；`push` 的 snap 加 `cardSegs`；`closeCard` 改为：

```ts
  const closeCard = (): void => {
    // cardId 可能是 PENDING 占位（同一次 planSync 内建卡即拆卡）：replace op 照带，
    // 执行侧 resolve 为 settings 关流时的真实 cardId（见 reply.ts execOne 的 replace 分支）。
    const closingCardId = cardId
    // replace 负载须取清空前的已提交内容（tail.shownText / cardSegs）
    const replaceJson = closingCardId !== null && cardSegs.length > 0
      ? buildClosedCardJson(cardSegs, segments, tail, STATUS_CONTINUED, processMaxBytes)
      : undefined
    const replaceElements = cardSegs.length + 1
    // 先定格状态行（流式还开着，组件 content API 需要流式模式），再关流 + summary。
    seq += 1
    push({ type: 'update', elementId: STATUS_ELEMENT_ID, content: STATUS_CONTINUED, sequence: seq })
    seq += 1
    cardId = null
    tail = undefined
    cardSegs = []
    push({ type: 'settings', streaming: false, sequence: seq, summary: STATUS_CONTINUED })
    if (replaceJson !== undefined) push({ type: 'replace', cardId: closingCardId, cardJson: replaceJson, sequence: seq + 1, elements: replaceElements })
  }
```

两处 insert 分支在 `push({ type: 'insert', ... })` 之前各加一行登记（process 分支 `base: 0`，text 分支 `base` 用局部变量 base）：

```ts
      cardSegs = [...cardSegs, { segIndex: i, elementId, kind: 'process', base: 0 }]
```
```ts
      cardSegs = [...cardSegs, { segIndex: i, elementId, kind: 'text', base }]
```

末尾 noop 的 snap 加 `cardSegs`（与其他 snap 同步改）。

e) `planFinalize` 改签名并追加 replace：

```ts
/** 定格：先 update 状态行（流式还开着），再关闭 + summary，最后全量重放整卡（直显无打字机）。 */
export function planFinalize(
  state: StreamState,
  status: TurnStatus,
  segments: readonly TurnSegment[],
  processMaxBytes: number,
): { ops: CardOp[] } {
  if (state.cardId === null) return { ops: [] }
  const statusLine = STATUS_FINAL[status]
  const ops: CardOp[] = [
    { type: 'update', elementId: STATUS_ELEMENT_ID, content: statusLine, sequence: state.seq + 1 },
    { type: 'settings', streaming: false, sequence: state.seq + 2, summary: statusLine },
  ]
  if (state.cardSegs.length > 0) {
    ops.push({
      type: 'replace', cardId: state.cardId, sequence: state.seq + 3, elements: state.cardSegs.length + 1,
      cardJson: buildClosedCardJson(state.cardSegs, segments, state.tail, statusLine, processMaxBytes),
    })
  }
  return { ops }
}
```

f) `reply.ts` 最小执行通路（本任务范围内只做这四点，debug 事件属 Task 3）：

- finalize 中 `planFinalize(this.state, status)` 改为 `planFinalize(this.state, status, this.segments, this.tunables.processMaxBytes)`；
- 类加私有字段 `private closedCardId: string | null = null`；`invokeThenCommit` 的 settings 分支在 `streaming === false` 时、commit 前捕获 `this.closedCardId = this.state.cardId`（此刻 state 仍是关流前值，真实 id 在手）；
- `execOne` 在 `noop` 分支之后插入 replace 特判：

```ts
    if (op.type === 'replace') {
      // 纯显示修复：失败不进失败分类治理（内容早已正确在卡），重试一次后记日志、照常 commit。
      // cardId 为 PENDING 占位时（同一次 planSync 内建卡即拆卡）解析为紧邻前一个关流 settings 的真实 id。
      const cardId = op.cardId === PENDING_CARD_ID ? this.closedCardId : op.cardId
      if (cardId === null || cardId === PENDING_CARD_ID) {
        this.log('[project-bot] 关流后全量重放跳过：取不到真实 cardId')
        this.commit(planned)
        return 'ok'
      }
      try {
        await withRetry(() => this.api.replaceCard(cardId, op.cardJson, op.sequence), 2)
      } catch (error) {
        this.log(`[project-bot] 关流后全量重放失败（不影响内容）：${error instanceof Error ? error.message : String(error)}`)
      }
      this.commit(planned)
      return 'ok'
    }
```

- `abandon()` 两个分支的状态重置都补 `cardSegs: []`。

- [ ] **Step 4: 适配既有测试**

- `feishu-cards.test.ts`：`planFinalize(state, status)` 旧调用全部补两参（`, segments, PROC`，无现成 segments 变量时传 `[]`）；断言关流 op 序列的用例在 `settings` 之后补 `replace`（有内容段时）。逐条跑到绿。
- `feishu-reply.test.ts`：`finalize：冲刷尾部 → 关流式 → 状态行定格`（约 L90-100）中的 `expect(ops).not.toContain('replaceCard')` 反转为断言 replaceCard 在序列末尾，并补：

```ts
    const replace = calls[calls.length - 1]!
    const card = JSON.parse(String(replace.args[1])) as { config: { streaming_mode: boolean }; body: { elements: { content?: string }[] } }
    expect(card.config.streaming_mode).toBe(false)
    expect(card.body.elements[0]!.content).toBe('结论')
    expect(card.body.elements.at(-1)!.content).toBe('✅ 输出完成')
```

其余断言拆卡/定格 op 序列的用例同样在 `setCardStreaming(false)` 后补 `replaceCard`；`tail2 = calls.slice(-2)` 一类取末尾若干条的断言改为按 op 类型过滤后断言。逐条跑到绿。

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit test; pnpm --filter dsh-agent-toolkit typecheck`
Expected: 全绿（若 feishu-stream-integrity 因 replace 断言失败，属预期——Task 6 统一处理；若其余失败，先修）

- [ ] **Step 6: Commit（需用户确认）**

```bash
git add packages/toolkit/src/channels/feishu/cards.ts packages/toolkit/src/channels/feishu/reply.ts packages/toolkit/src/channels/feishu/feishu-cards.test.ts packages/toolkit/src/channels/feishu/feishu-reply.test.ts
git commit -m "feat(feishu): 关流后全量重放整卡（根治关流时打字机存量未渲染完）"
```

---

### Task 3: reply.ts debug 事件 + 渠道装配透传

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/reply.ts`（构造函数、execOne、invokeThenCommit、abandon）
- Modify: `packages/toolkit/src/channels/feishu/index.ts`（L29 reply 构造点）
- Test: `packages/toolkit/src/channels/feishu/feishu-reply.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DebugSink`（channel.ts）、`preview`（debug-log.ts）
- Produces: `FeishuReplyHandle` 构造函数第 5 参 `debugLog?: DebugSink`；事件名/字段照 spec §1 表（`op`/`close`/`replace`/`abandon`）

- [ ] **Step 1: 写失败测试（追加进 feishu-reply.test.ts）**

```ts
test('debug 事件：op/close/replace 落 sink；replace 失败非致命且有事件', async () => {
  const { api, calls } = fakeApi()
  const events: { event: string; [k: string]: unknown }[] = []
  const reply = new FeishuReplyHandle(api, 'oc_1', TUNABLES, () => undefined, (e) => { events.push(e) })
  await reply.update([{ kind: 'text', content: '你好' }])
  await vi.advanceTimersByTimeAsync(500)
  await reply.finalize('done')
  const kinds = events.map((e) => e.event)
  expect(kinds).toContain('op')
  expect(kinds).toContain('close')
  expect(kinds).toContain('replace')
  const close = events.find((e) => e.event === 'close')!
  expect(close.chatId).toBe('oc_1')
  expect(close.tailShownLen).toBe(2)
  expect(close.tailSegLen).toBe(2)
  const replace = events.find((e) => e.event === 'replace')!
  expect(replace.ok).toBe(true)
  expect(replace.elements).toBe(2)   // 1 段 + 状态行
  // 状态行 update op 事件带内容摘要而非全文（finalize 批的 update 是状态行定格）
  const statusOp = events.find((e) => e.event === 'op' && e.op === 'update' && e.elementId === 'status')!
  expect(statusOp.content).toEqual({ len: 5, head: '✅ 输出完成', tail: '' })
  void calls
})

test('debug 事件：replaceCard 失败记 replace failed + 日志，不触发废弃通知', async () => {
  const { api, calls } = fakeApi()
  const failing = { ...api, replaceCard: async () => { throw bizError(999999) } }
  const events: { event: string; [k: string]: unknown }[] = []
  const logs: string[] = []
  const reply = new FeishuReplyHandle(failing, 'oc_1', TUNABLES, (m) => { logs.push(m) }, (e) => { events.push(e) })
  await reply.update([{ kind: 'text', content: '结论' }])
  const fin = reply.finalize('done')
  await vi.advanceTimersByTimeAsync(1000)   // withRetry 的 300ms 退避
  await fin
  expect(events).toContainEqual(expect.objectContaining({ event: 'replace', ok: false, code: 999999 }))
  expect(logs.some((m) => m.includes('全量重放失败'))).toBe(true)
  expect(calls.map((c) => c.op)).not.toContain('sendText')   // 无 ABANDON_NOTICE
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-reply.test.ts`
Expected: FAIL（构造函数第 5 参不存在 / 无事件）

- [ ] **Step 3: 实现**

a) `reply.ts` 顶部 import 加：

```ts
import { preview, type DebugSink } from './debug-log.ts'
```

注意：`DebugSink` 实际定义在 `../channel.ts`，`debug-log.ts` 不 re-export——此处写：

```ts
import type { DebugSink } from '../channel.ts'
import { preview } from './debug-log.ts'
```

b) 构造函数加第 5 参：

```ts
  constructor(
    private readonly api: FeishuApi,
    private readonly chatId: string,
    private readonly tunables: ChannelTunables,
    private readonly log: (message: string) => void,
    private readonly debugLog?: DebugSink,
  ) {}
```

c) `execOne` 的 replace 分支（Task 2 已落最小版）改为带事件 + PENDING 解析的完整版：

```ts
    if (op.type === 'replace') {
      // 纯显示修复：失败不进失败分类治理（内容早已正确在卡），重试一次后记日志、照常 commit。
      // cardId 为 PENDING 占位时（同一次 planSync 内建卡即拆卡）解析为紧邻前一个关流 settings 的真实 id。
      const cardId = op.cardId === PENDING_CARD_ID ? this.closedCardId : op.cardId
      const started = Date.now()
      if (cardId === null || cardId === PENDING_CARD_ID) {
        this.debugLog?.({ event: 'replace', chatId: this.chatId, ok: false, reason: 'no-card-id' })
        this.log('[project-bot] 关流后全量重放跳过：取不到真实 cardId')
        this.commit(planned)
        return 'ok'
      }
      try {
        await withRetry(() => this.api.replaceCard(cardId, op.cardJson, op.sequence), 2)
        this.debugLog?.({ event: 'replace', chatId: this.chatId, cardId, ok: true, elements: op.elements, dslBytes: Buffer.byteLength(op.cardJson, 'utf8'), durationMs: Date.now() - started })
      } catch (error) {
        this.debugLog?.({ event: 'replace', chatId: this.chatId, cardId, ok: false, code: feishuErrorCode(error), durationMs: Date.now() - started })
        this.log(`[project-bot] 关流后全量重放失败（不影响内容）：${error instanceof Error ? error.message : String(error)}`)
      }
      this.commit(planned)
      return 'ok'
    }
```

（`closedCardId` 字段与捕获行已在 Task 2 落地，本步不重复添加。）

d) op 事件：在 `invokeThenCommit` 成功路径末尾（`this.commit(planned, effectiveSeq)` 之前）发 `op` 事件（outcome 简化：成功即 `ok`；重放/重激活路径在 execOne 各分支内补发 outcome——为控制复杂度，重放成功的分支在 `invokeThenCommit` 后由 execOne 再发一条 outcome=`replayed`/`reactivated` 的 op 事件）。实现助手（加为私有方法）：

```ts
  /** op 执行结果事件（insert/update 带内容摘要；settings 带 streaming 标记）。 */
  private emitOp(op: CardOp, outcome: string, started: number, code?: number): void {
    if (this.debugLog === undefined) return
    const base = {
      event: 'op' as const, chatId: this.chatId, op: op.type, cardId: this.state.cardId,
      outcome, durationMs: Date.now() - started, ...(code !== undefined ? { code } : {}),
    }
    if (op.type === 'update') this.debugLog({ ...base, elementId: op.elementId, seq: op.sequence, content: preview(op.content) })
    else if (op.type === 'insert') this.debugLog({ ...base, seq: op.sequence, content: preview(op.elementJson) })
    else if (op.type === 'settings') this.debugLog({ ...base, seq: op.sequence, streaming: op.streaming })
    else this.debugLog(base)
  }
```

接线：`invokeThenCommit` 入口记 `const started = Date.now()`，成功路径 commit 前 `this.emitOp(op, 'ok', started)`；`execOne` 的 200850/200510 重放成功后 `this.emitOp(op, 'reactivated', started)`、未知错误重放成功后 `this.emitOp(op, 'replayed', started)`（两处 started 在 execOne catch 内重新取 `Date.now()` 近似值即可，字段语义是「该次尝试耗时」）。注意重放路径会经 invokeThenCommit 再发一条 `ok`——接受重复（两条事件 outcome 不同），不为此加抑制逻辑。

e) `close` 事件：`invokeThenCommit` 的 settings 分支内、`streaming === false` 时（commit 前，state 仍是关流前值；`closedCardId` 捕获行 Task 2 已在同一位置，本步只在其后补 debugLog 调用）：

```ts
    } else if (op.type === 'settings') {
      await this.api.setCardStreaming(this.state.cardId!, op.streaming, op.sequence, op.summary)
      if (!op.streaming) {
        this.closedCardId = this.state.cardId   // replace op 的 PENDING 解析来源（commit 后 state.cardId 即 null）
        const t = this.state.tail
        this.debugLog?.({
          event: 'close', chatId: this.chatId, cardId: this.state.cardId, seq: op.sequence, summary: op.summary,
          tailShownLen: t?.shownText.length,
          tailSegLen: t !== undefined ? this.segments[t.segIndex]?.content.length : undefined,
          cardBytes: this.state.cardBytes,
        })
      }
    }
```

f) `abandon` 事件：`abandon()` 内 `this.log(...)` 之后加：

```ts
    this.debugLog?.({ event: 'abandon', chatId: this.chatId, cardId, reason, carrySegIndex: this.state.carry?.segIndex, carryBase: this.state.carry?.base })
```

g) `channels/feishu/index.ts` L29 改：

```ts
        const reply = new FeishuReplyHandle(api, parsed.chatId, tunables, log, tunables.debugLog)
```

- [ ] **Step 4: 全量测试 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit test; pnpm --filter dsh-agent-toolkit typecheck`
Expected: 全绿

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/channels/feishu/reply.ts packages/toolkit/src/channels/feishu/index.ts packages/toolkit/src/channels/feishu/feishu-reply.test.ts
git commit -m "feat(feishu): 出站卡片 op/close/replace/abandon 调试事件"
```

---

### Task 4: outbound.ts 对账升级（replace-or-append）+ 帧统计 + debug 事件

**Files:**
- Modify: `packages/toolkit/src/channels/ports.ts`（L91 turn 类型）
- Modify: `packages/toolkit/src/channels/outbound.ts`（构造函数、turn/start、assistant/message、turn/end、handleAssistantFrame）
- Modify: `packages/toolkit/src/channels/runtime.ts`（RuntimeDeps L13-38、Outbound 构造 L62）
- Test: `packages/toolkit/src/channels/outbound.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DebugSink`
- Produces:
  - `Outbound` 构造函数第 5 参 `debugLog?: DebugSink`（位置参数，在 `onTurnIdle` 之后）
  - `SessionRuntime['turn']` 新增可选 `stats: { starts: number; textDeltas: number; reasoningDeltas: number; droppedNoBaseline: number }`
  - 事件名：`reconcile`（result: `replaced`/`appended`/`skipped-noop`/`skipped-empty`）、`frame-stats`
  - `RuntimeDeps` 新增可选 `debugLog?: DebugSink`（Task 5 装配）

- [ ] **Step 1: 写失败测试（追加进 outbound.test.ts）**

```ts
describe('对账 replace-or-append', () => {
  test('本 step 一帧未到（start 帧丢）：append 新 text 段补回权威全文', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const events: { event: string; [k: string]: unknown }[] = []
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined, 500, undefined, (e) => { events.push(e) })
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    // start 帧丢失、chunk 全丢：直接来持久结算事件
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '完整答复' }] } } })
    await drain(rt)
    expect(calls).toEqual([{ op: 'beginTurn' }, { op: 'update', arg: 'text:完整答复' }])
    expect(events).toContainEqual(expect.objectContaining({ event: 'reconcile', result: 'appended', authoritativeLen: 4 }))
  })

  test('防护未命中且权威文本为空：跳过（skipped-empty），不产生 update', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'tool_call', id: 'c', name: 'n' }] } } })
    await drain(rt)
    expect(calls).toEqual([])
  })

  test('多 text 块消息：权威文本为全部 text 块拼接（textOf），不丢前块', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: 'A' }))   // B 的帧丢了
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'A' }, { type: 'tool_call', id: 'c', name: 'n' }, { type: 'text', text: 'B' }] } } })
    await drain(rt)
    // 对账把尾 text 段从 'A' 替换为拼接全文 'AB'
    expect(calls[calls.length - 1]).toEqual({ op: 'update', arg: 'text:AB' })
  })

  test('frame-stats：turn/end 输出帧统计（含基线缺失丢弃计数）', async () => {
    const { reply } = recorder()
    const rt = fakeRuntime(reply)
    const events: { event: string; [k: string]: unknown }[] = []
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined, 500, undefined, (e) => { events.push(e) })
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: '你好' }))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'reasoning-delta', index: 1, text: '想' }))
    // 无基线丢弃：把 attemptStep 清掉模拟 start 帧丢失后的 chunk（直接改 turn 状态模拟第二步丢 start）
    rt.turn!.attemptStep = undefined
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: '丢' }))
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drain(rt)
    expect(events).toContainEqual(expect.objectContaining({
      event: 'frame-stats', turn: 1, starts: 1, textDeltas: 1, reasoningDeltas: 1, droppedNoBaseline: 1, lastTextStep: 1,
    }))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/outbound.test.ts`
Expected: FAIL（第 5 参 / append 行为 / stats 均不存在）

- [ ] **Step 3: 实现**

a) `ports.ts` L91 turn 类型改为：

```ts
  /** 当前 turn 归集状态；无进行中 turn 为 undefined。 */
  turn: {
    n: number; segments: TurnSegment[]; began: boolean; lastTextStep?: number; attemptStep?: number
    /** 帧统计（frame-stats debug 事件；turn/end 输出后随 turn 销毁）。 */
    stats?: { starts: number; textDeltas: number; reasoningDeltas: number; droppedNoBaseline: number }
  } | undefined
```

b) `outbound.ts`：import 加 `import type { DebugSink } from './channel.ts'`；构造函数加第 5 参：

```ts
    /** 槽位释放后同步触发（核心侧排水排队消息）；实现须同步完成占槽转移，先于删表情返回。 */
    private readonly onTurnIdle?: (rt: SessionRuntime) => void,
    /** 生产调试事件 sink（reconcile/frame-stats；缺省不记录）。 */
    private readonly debugLog?: DebugSink,
```

c) turn/start 分支：`rt.turn = { n: ..., segments: [], began: false, stats: { starts: 0, textDeltas: 0, reasoningDeltas: 0, droppedNoBaseline: 0 } }`。

d) assistant/message 分支整体替换为（注释保留防护语义）：

```ts
    if (event.type === 'assistant/message') {
      const turn = rt.turn
      if (turn === undefined || turn.n !== (event.data.turn as number)) return
      const step = event.data.step as number
      const content = (event.data.message as { content?: readonly unknown[] }).content ?? []
      // 权威文本 = 全部 text 块拼接（与流式合并语义对齐；多 text 块消息不丢前块）。
      const authoritative = textOf(content)
      let tailLen: number | undefined
      for (let i = turn.segments.length - 1; i >= 0; i--) {
        if (turn.segments[i]!.kind === 'text') { tailLen = turn.segments[i]!.content.length; break }
      }
      let result: 'replaced' | 'appended' | 'skipped-noop' | 'skipped-empty'
      if (turn.lastTextStep === step) {
        // 防护（必需）：尾 text 段归属本结算 step 才替换，否则篡改上一步已提交正文（宁缺勿错）。
        result = reconcileTrailingText(turn.segments, authoritative) ? 'replaced' : 'skipped-noop'
      } else if (authoritative !== '') {
        // 本 step 正文一帧没应用（start 帧丢/帧全丢）：append 新段补回，不篡改已显示内容。
        appendToSegments(turn.segments, 'text', authoritative)
        result = 'appended'
      } else {
        result = 'skipped-empty'
      }
      this.debugLog?.({ event: 'reconcile', sessionId, chatId: rt.chatId, turn: turn.n, step, result, tailLen, authoritativeLen: authoritative.length })
      if (result === 'skipped-noop' || result === 'skipped-empty') return
      const snapshot = turn.segments.map((s) => ({ ...s }))
      this.enqueue(rt, async () => {
        if (rt.reply === undefined) return
        if (!turn.began) {
          await rt.reply.beginTurn()
          turn.began = true
        }
        await rt.reply.update(snapshot)
      })
      return
    }
```

注意 `handleSessionEvent` 的签名是 `(sessionId: string, event: ...)`——事件中无 sessionId 字段，直接用形参 `sessionId`。

e) turn/end 分支在 `rt.turn = undefined` 之前加：

```ts
      if (turn.stats !== undefined) {
        this.debugLog?.({ event: 'frame-stats', sessionId, chatId: rt.chatId, turn: turn.n, ...turn.stats, lastTextStep: turn.lastTextStep })
      }
```

f) `handleAssistantFrame`：start 分支加 `if (turn.stats !== undefined) turn.stats.starts += 1`；基线缺失分支改为：

```ts
    const step = turn.attemptStep
    if (step === undefined) {
      if (turn.stats !== undefined && (frame.chunk.type === 'text-delta' || frame.chunk.type === 'reasoning-delta')) turn.stats.droppedNoBaseline += 1
      return
    }
    if (!applyStreamChunk(turn.segments, frame.chunk)) return
    if (turn.stats !== undefined) {
      if (frame.chunk.type === 'text-delta') turn.stats.textDeltas += 1
      else if (frame.chunk.type === 'reasoning-delta') turn.stats.reasoningDeltas += 1
    }
```

g) `runtime.ts`：RuntimeDeps 加 `debugLog?: DebugSink`（import type 自 channel.ts，已有 ChannelTunables 同文件可复用导入）；L62 改：

```ts
    this.outbound = new Outbound(this.sessions, (m) => deps.log.warn(m), deps.maxErrorDetailChars, (rt) => this.inbound.drain(rt.botId, rt.chatId), deps.debugLog)
```

- [ ] **Step 4: 全量测试 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit test; pnpm --filter dsh-agent-toolkit typecheck`
Expected: 全绿（既有对账用例 `assistant/message 对账补齐缺帧正文` 等单 text 块场景 textOf 与 lastTextOf 同值，不受影响；若有 fakeRuntime 构造缺 stats 不报类型错——stats 可选）

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/channels/ports.ts packages/toolkit/src/channels/outbound.ts packages/toolkit/src/channels/runtime.ts packages/toolkit/src/channels/outbound.test.ts
git commit -m "feat(feishu): 对账升级 replace-or-append（textOf 拼接 + 帧全丢 append 补回）+ 帧统计事件"
```

---

### Task 5: Config 三键 + bots 装配接线

**Files:**
- Modify: `packages/toolkit/src/index.ts`（feishu schema L84-107）
- Modify: `packages/toolkit/src/bots/index.ts`（BotsModuleConfig L37-58、setupBots tunables L72-78、BotRuntime deps L170-190）

**Interfaces:**
- Consumes: Task 1 `createFeishuDebugLogger`/`DEFAULT_DEBUG_LOG_DIR`；Task 4 `RuntimeDeps.debugLog`
- Produces: Config `feishu.debugLog: boolean`（默认 true）、`feishu.debugLogDir: string`（默认 ''）、`feishu.debugLogRetentionDays: number`（默认 7）

- [ ] **Step 1: 写失败测试**

`packages/toolkit/src/index.ts` 的 Config 若已有 schema 测试文件（先 `glob packages/toolkit/src/**/index*.test.ts` 与 `rg -l "Config" packages/toolkit/src --glob '*.test.ts'` 确认），在其中追加；若无 Config 测试，新建 `packages/toolkit/src/config.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { Config } from './index.ts'

describe('Config feishu 调试日志三键', () => {
  test('默认开启、默认目录为空（解析到 ~/.dsh/logs/feishu-debug）、默认保留 7 天', () => {
    const parsed = Config({}) as { feishu: { debugLog: boolean; debugLogDir: string; debugLogRetentionDays: number } }
    expect(parsed.feishu.debugLog).toBe(true)
    expect(parsed.feishu.debugLogDir).toBe('')
    expect(parsed.feishu.debugLogRetentionDays).toBe(7)
  })
})
```

注意：`Config` 是 schemastery schema，调用形态以 index.ts 现有导出为准（`z.object` 风格即 `Config({})`；若测试框架下调用形态不同，参照既有 Config 测试的调用方式适配）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/config.test.ts`（或既有 Config 测试文件）
Expected: FAIL（三键不存在 → undefined）

- [ ] **Step 3: 实现**

a) `index.ts` feishu schema 对象内加三行（`docMaxBytes` 行之后）：

```ts
    /** /doc 发送文件的大小上限（字节）。 */
    docMaxBytes: z.number().default(30 * 1024 * 1024),
    /** 生产调试文件日志开关（JSONL，按日滚动）。 */
    debugLog: z.boolean().default(true),
    /** 日志目录（空 = <os.homedir()>/.dsh/logs/feishu-debug/）。 */
    debugLogDir: z.string().default(''),
    /** 日志保留天数（按文件名日期清理）。 */
    debugLogRetentionDays: z.number().default(7),
```

`.default({...})` 对象字面量同步补三键：`debugLog: true, debugLogDir: '', debugLogRetentionDays: 7`。

b) `bots/index.ts`：BotsModuleConfig 加三键（同 schema 注释）；顶部 import 加：

```ts
import { createFeishuDebugLogger, DEFAULT_DEBUG_LOG_DIR } from '../channels/feishu/debug-log.ts'
```

`setupBots` 内 tunables 构造改为：

```ts
  const debugLog = config.debugLog
    ? createFeishuDebugLogger(config.debugLogDir === '' ? DEFAULT_DEBUG_LOG_DIR() : config.debugLogDir, config.debugLogRetentionDays)
    : undefined
  const tunables: ChannelTunables = {
    cardUpdateThrottleMs: config.cardUpdateThrottleMs,
    cardMaxBytes: config.cardMaxBytes,
    processMaxBytes: config.processMaxBytes,
    cardPrintStep: config.cardPrintStep,
    processingReactionEmoji: config.processingReactionEmoji,
    ...(debugLog !== undefined ? { debugLog } : {}),
  }
```

BotRuntime deps 构造（L170-190）加一行：

```ts
      ...(debugLog !== undefined ? { debugLog } : {}),
```

- [ ] **Step 4: 全量测试 + 类型检查 + bundle**

Run: `pnpm --filter dsh-agent-toolkit test; pnpm --filter dsh-agent-toolkit typecheck; pnpm --filter dsh-agent-toolkit bundle`
Expected: 全绿；bundle 产物含 lib/index.js 与 lib/client.js（debug-log.ts 只在 Node 半被引用，浏览器半 tree-shake 不内联 node:fs——若 bundle 报错 node:fs 进浏览器半，检查 import 链：debug-log.ts 只允许被 bots/index.ts（Node 半）与 reply.ts（值导入 preview 为纯函数，type 导入 DebugSink 擦除）引用，reply.ts 本身不进浏览器半）

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/index.ts packages/toolkit/src/bots/index.ts packages/toolkit/src/config.test.ts
git commit -m "feat(feishu): debugLog/debugLogDir/debugLogRetentionDays 配置接线（默认开启）"
```

---

### Task 6: 端到端守护断言 + 文档同步

**Files:**
- Test: `packages/toolkit/src/channels/feishu/feishu-stream-integrity.test.ts`
- Modify: `docs/domains/feishu.md`
- Modify: `docs/usage/config-reference.md`
- Modify: `docs/usage/feishu-bots.md`（仅当其中描述了出站卡片行为/配置时）

**Interfaces:**
- Consumes: Task 2/3 的 replace 机制与事件（只加断言，不改实现）

- [ ] **Step 1: stream-integrity 补断言**

在既有「40 轮事件流 + 拆卡 + 失败注入」守护测试末尾追加：

```ts
  // 每张关流的卡都有一次全量重放（replaceCard 次数 === setCardStreaming(false) 次数）
  const closes = calls.filter((c) => c.op === 'setCardStreaming' && c.args[1] === false)
  const replaces = calls.filter((c) => c.op === 'replaceCard')
  expect(replaces.length).toBe(closes.length)
  // 末卡重放内容含最终文本（全文断言的一部分，与既有「渲染拼接 == 模型全量输出」互补）
  const lastReplace = replaces[replaces.length - 1]!
  const card = JSON.parse(String(lastReplace.args[1])) as { config: { streaming_mode: boolean } }
  expect(card.config.streaming_mode).toBe(false)
```

（`calls` 形状以该文件现有 fake 为准适配；若现有断言已覆盖 closes 计数，则只补 replace 对齐断言。）

- [ ] **Step 2: 全量测试确认绿**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: 全绿（75 文件 + 新增用例）

- [ ] **Step 3: 文档同步**

`docs/domains/feishu.md` 出站段（第 7 行长段）更新三处现行事实：

1. 拆卡/定格描述补：「关流后全量重放整卡（非流式 update 直显，根治关流时打字机存量未渲染完；replace 失败非致命只记日志）」；
2. 对账描述补：「assistant/message 对账目标为全部 text 块拼接（textOf）；lastTextStep 防护未命中但权威非空时 append 新 text 段补回」；
3. 段尾补调试日志一句：「生产调试日志：`feishu.debugLog`（默认 true）+ `debugLogDir`（默认 `~/.dsh/logs/feishu-debug/`）+ `debugLogRetentionDays`（默认 7），JSONL 按日滚动，事件含 op/close/replace/abandon/reconcile/frame-stats，内容只记长度+首尾 20 字」。

`docs/usage/config-reference.md`：feishu 配置表补 `debugLog`/`debugLogDir`/`debugLogRetentionDays` 三行（表格格式照该文件既有行）。

`docs/usage/feishu-bots.md`：若出站卡片行为小节描述了定格/拆卡，补一句关流重放；无相关小节则不动。

- [ ] **Step 4: Commit（需用户确认）**

```bash
git add packages/toolkit/src/channels/feishu/feishu-stream-integrity.test.ts docs/domains/feishu.md docs/usage/config-reference.md docs/usage/feishu-bots.md
git commit -m "test+docs(feishu): 关流重放端到端断言与文档同步"
```

---

## Self-Review 记录

- **Spec 覆盖**：§1 日志 → Task 1+3+4+5；§2 关流重放 → Task 2+3；§3 对账升级 → Task 4；§4 测试/文档 → 各 Task 内 + Task 6；§5 不做项 → 未引入。cordis.yml 的 cardPrintStep=50 已先行落地（不在本计划）。
- **类型一致性**：`DebugSink`（Task 1 channel.ts）→ Task 3 reply.ts、Task 4 outbound.ts/runtime.ts 同一类型；`CardSeg`/`buildClosedCardJson`/`planFinalize` 新签名（Task 2）→ Task 2 内 reply.ts 调用点同步改；`RuntimeDeps.debugLog`（Task 4）→ Task 5 装配。
- **中间态可编译**：Task 2 自带 reply.ts 调用点适配；Task 3 改构造函数为可选第 5 参，旧调用不破坏；Task 4 构造函数可选第 5 参同理。
- **已修正的审查发现**：①同一次 planSync 内「建卡即拆卡」时 replace op 的 cardId 是 PENDING 占位——closeCard 不排除 PENDING、执行侧经 `closedCardId` 解析（spec §2 已同步修订）；②拆卡测试参数 200→100 字符（原参数在 400 字节预算下会产生 3 次拆卡而非断言的 1 次）；③Task 3 首个用例的 update op 断言对象修正为状态行（正文 '你好' 走 insert，finalize 批的 update 是状态行定格）。
