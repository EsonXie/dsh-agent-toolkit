# token-usage 启动回填实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件（计量主）启动时一次性回填 token_usage 域中整日缺失的历史统计（策略 A：只补 daily 表无记录的日期），数据源为 `ctx.sessionPersistence` 服务的后端无关会话日志读取。

**Architecture:** 新模块 `packages/usage/src/usage/backfill.ts` 导出 `backfillMissingDays(deps)`：`list()` 全部会话 header → 逐会话 `readFrom(id, 0)` → 逐事件复用 `sampleFromEvent`/`addSample` 聚合 → 缺失日期经共享 `tail` 串行链写入 → 落地 `backfill_done` 一次性标记。`usage/index.ts` 在计量主分支接线；`sessionPersistence` 为可选服务，按仓库规则走 `ctx.get`，不进 inject。

**Tech Stack:** TypeScript ESM、vitest、`@deepseek-ai/dsh-session-persistence`（仅 type-only 声明合并）。

**Spec:** `docs/superpowers/specs/2026-09-01-usage-backfill-design.md`

## Global Constraints

- 不执行任何 git mutation（add/commit/push 等）——用户未授权，本计划不含 commit 步骤。
- `sessionPersistence` 是可选服务：只能 `ctx.get('sessionPersistence')`，绝不进 `inject`，绝不进 dependencies/peerDependencies（宿主隐式提供，同 `@deepseek-ai/dsh-storage-domain` 先例）；类型经 devDependencies link 引入，`import type {}` 在运行时擦除。
- 合并策略 A：只写 daily 表完全无记录的日期；已有记录的日期是权威，绝不被回填覆盖。
- 回填尽力而为：任何异常 warn 收尾；`backfillMissingDays` 内部捕获全部异常、**永不 reject**；扫描失败不落地标记（下次启动重试），已成功写入的日期保留（策略 A 幂等）。
- 所有 daily/meta 写必须排进 `setupUsage` 的 `tail` 串行链（KvTable 不串行化并发读改写，沿用既有不变式）。
- 只有计量主（`meteringReady === true`）触发回填；already-open 停用方/他包占用方不回填。
- 不改 `aggregate.ts` / `store.ts` / 浏览器半 / Config schema / `inject`（`src/index.test.ts` 的 `inject` 断言必须保持绿）。
- 任何 src 改动后按仓库约定跑验证链：usage test+typecheck+bundle → toolkit test+typecheck+bundle。

---

### Task 1: backfill 模块（`backfill.ts` + 单元测试）

**Files:**
- Create: `packages/usage/src/usage/backfill.ts`
- Test: `packages/usage/src/usage/backfill.test.ts`

**Interfaces:**
- Consumes: `sampleFromEvent`/`addSample`/`emptyDaily`（`./aggregate.ts`，已存在）；`DailyRecord`（`./store.ts`，已存在）；`KvTable`（`@deepseek-ai/dsh-storage-domain` type-only）；`Session`/`SessionEvent`/`SessionHeader`/`SessionId`（`@deepseek-ai/dsh-session` type-only）；`Message`（`@deepseek-ai/dsh-llm/types` type-only）。
- Produces（Task 2 接线依赖的确切签名）:

```ts
export const BACKFILL_DONE_KEY: 'backfill_done'
export interface BackfillPersistence {
  list(signal?: AbortSignal): Promise<SessionHeader[]>
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }>
}
export interface BackfillDeps {
  persistence: BackfillPersistence
  timezone: string
  daily: KvTable<string, DailyRecord>
  meta: KvTable<string, { value: string }>
  estimate: (message: Message) => number
  /** 把读改写排进与实时采集共享的串行链；返回该次写入的完成 promise。 */
  enqueue: (job: () => Promise<unknown>) => Promise<unknown>
  warn: (msg: string) => void
}
export function backfillMissingDays(deps: BackfillDeps): Promise<void> // 内部全捕获，永不 reject
```

- [ ] **Step 1: 写失败测试（全部 6 个单元用例一次写完）**

创建 `packages/usage/src/usage/backfill.test.ts`：

```ts
import { expect, test, vi } from 'vitest'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { emptyDaily } from './aggregate.ts'
import type { DailyRecord } from './store.ts'
import { BACKFILL_DONE_KEY, backfillMissingDays, type BackfillPersistence } from './backfill.ts'

/** Map 假 KvTable（meter-owner.test.ts 同款）。 */
function fakeTable() {
  const records = new Map<string, unknown>()
  return {
    records,
    get: (k: string) => records.get(k),
    put: vi.fn(async (k: string, v: unknown) => { records.set(k, v) }),
    delete: async (k: string) => records.delete(k),
  }
}

const HEADER: SessionHeader = { version: 0, id: 'sess-1' as SessionId, createdAt: 0, cwd: 'D:\\proj' }

/** 2026-08-27 12:00 Asia/Shanghai；usage 可省略（省略即走估算路径）。 */
function usageEvent(time: number, usage?: { inputTokens: number; outputTokens: number }): SessionEvent {
  return {
    type: 'assistant/message', seq: 1, time,
    data: {
      turn: 0, step: 0,
      message: { source: { provider: 'p', model: 'm' } },
      ...(usage === undefined ? {} : { usage }),
    },
  } as unknown as SessionEvent
}

const T1 = Date.parse('2026-08-27T12:00:00+08:00')
const T2 = Date.parse('2026-08-28T13:00:00+08:00')

function makeDeps(events: SessionEvent[], opts: {
  persistence?: Partial<BackfillPersistence>
  estimate?: (m: unknown) => number
} = {}) {
  const daily = fakeTable()
  const meta = fakeTable()
  const warn = vi.fn()
  const persistence: BackfillPersistence = {
    list: vi.fn(async () => [HEADER]),
    readFrom: vi.fn(async () => ({ meta: HEADER, events })),
    ...opts.persistence,
  }
  const enqueue = (job: () => Promise<unknown>) => job()
  return {
    daily, meta, warn, persistence,
    deps: {
      persistence, timezone: 'Asia/Shanghai',
      daily: daily as never, meta: meta as never,
      estimate: (opts.estimate ?? (() => 0)) as never,
      enqueue, warn,
    },
  }
}

test('缺失日期被补齐：按日聚合进 daily，含 byModel/hours', async () => {
  const { daily, deps } = makeDeps([usageEvent(T1, { inputTokens: 100, outputTokens: 10 })])
  await backfillMissingDays(deps)
  const rec = daily.records.get('2026-08-27') as DailyRecord
  expect(rec.totals.input).toBe(100)
  expect(rec.totals.calls).toBe(1)
  expect(rec.hours[12].input).toBe(100)
  expect(rec.byModel['p/m'].output).toBe(10)
  expect(rec.bySession['sess-1'].cwd).toBe('D:\\proj')
})

test('已有记录的日期跳过，不被覆盖', async () => {
  const { daily, deps } = makeDeps([usageEvent(T1, { inputTokens: 100, outputTokens: 10 })])
  const existing = emptyDaily('2026-08-27')
  daily.records.set('2026-08-27', existing)
  await backfillMissingDays(deps)
  expect(daily.records.get('2026-08-27')).toBe(existing) // 原对象未被替换
})

test('全部完成后落地 backfill_done 标记', async () => {
  const { meta, deps } = makeDeps([usageEvent(T1)])
  await backfillMissingDays(deps)
  expect(meta.records.get(BACKFILL_DONE_KEY)).toEqual({ value: expect.any(String) })
})

test('标记已存在：不调用 sessionPersistence，直接返回', async () => {
  const { meta, persistence, deps } = makeDeps([])
  meta.records.set(BACKFILL_DONE_KEY, { value: '2026-09-01T00:00:00.000Z' })
  await backfillMissingDays(deps)
  expect(persistence.list).not.toHaveBeenCalled()
})

test('无 usage 的 assistant/message 走估算路径', async () => {
  const { daily, deps } = makeDeps([usageEvent(T1)], { estimate: () => 42 })
  await backfillMissingDays(deps)
  const rec = daily.records.get('2026-08-27') as DailyRecord
  expect(rec.totals.estimated).toBe(42)
  expect(rec.totals.estimatedCalls).toBe(1)
})

test('单会话 readFrom 失败：warn 跳过，其余会话仍补齐，标记仍落地', async () => {
  const other: SessionHeader = { ...HEADER, id: 'sess-2' as SessionId }
  const { daily, meta, warn, deps } = makeDeps([], {
    persistence: {
      list: vi.fn(async () => [HEADER, other]),
      readFrom: vi.fn(async (id: SessionId) => {
        if (id === HEADER.id) throw new Error('corrupt')
        return { meta: other, events: [usageEvent(T2, { inputTokens: 7, outputTokens: 3 })] }
      }),
    },
  })
  await backfillMissingDays(deps)
  expect(warn).toHaveBeenCalled()
  expect(daily.records.has('2026-08-28')).toBe(true)
  expect(meta.records.has(BACKFILL_DONE_KEY)).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认全红**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run src/usage/backfill.test.ts`
Expected: 6 个用例全部失败，原因是 `./backfill.ts` 模块不存在（模块解析错误），不是断言笔误。

- [ ] **Step 3: 写最小实现**

创建 `packages/usage/src/usage/backfill.ts`：

```ts
/** token-usage 一次性历史回填：用 sessionPersistence 的持久化日志补齐整日缺失的统计（策略 A）。 */
import type { Message } from '@deepseek-ai/dsh-llm/types'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { addSample, emptyDaily, sampleFromEvent } from './aggregate.ts'
import type { DailyRecord } from './store.ts'

export const BACKFILL_DONE_KEY = 'backfill_done'

/** ctx.sessionPersistence 的最小消费面（结构子类型，详见 dsh-session-persistence 的 Service Definition）。 */
export interface BackfillPersistence {
  list(signal?: AbortSignal): Promise<SessionHeader[]>
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }>
}

export interface BackfillDeps {
  persistence: BackfillPersistence
  timezone: string
  daily: KvTable<string, DailyRecord>
  meta: KvTable<string, { value: string }>
  estimate: (message: Message) => number
  /** 把读改写排进与实时采集共享的串行链；返回该次写入的完成 promise。 */
  enqueue: (job: () => Promise<unknown>) => Promise<unknown>
  warn: (msg: string) => void
}

/**
 * 一次性补齐 daily 表完全缺失的日期：已有记录的日期视为权威（策略 A），跳过即幂等。
 * 尽力而为：整体与单会话异常都只 warn；扫描未完整走完不落地 backfill_done，下次启动重试。
 * 本函数永不 reject（setupUsage 的不次生 unhandled rejection 不变式）。
 */
export async function backfillMissingDays(deps: BackfillDeps): Promise<void> {
  const { persistence, timezone, daily, meta, estimate, enqueue, warn } = deps
  if (meta.get(BACKFILL_DONE_KEY) !== undefined) return
  try {
    const headers = await persistence.list()
    const byDate = new Map<string, DailyRecord>()
    for (const header of headers) {
      let events: readonly SessionEvent[]
      try {
        events = (await persistence.readFrom(header.id, 0)).events
      } catch (error) {
        warn(`回填跳过会话 ${String(header.id)}：读取失败 ${String(error)}`)
        continue
      }
      // sampleFromEvent 只读 session.header 的 id/cwd：给最小会话形态。
      const stub = { header } as unknown as Session
      for (const event of events) {
        const sample = sampleFromEvent(stub, event, timezone, estimate)
        if (sample === undefined) continue
        byDate.set(sample.date, addSample(byDate.get(sample.date) ?? emptyDaily(sample.date), sample))
      }
    }
    // 写入前再查一次：扫描期间被实时采集创建的日期（如今日）跳过，天然防双计。
    for (const [date, record] of byDate) {
      await enqueue(async () => {
        if (daily.get(date) === undefined) await daily.put(date, record)
      })
    }
    await enqueue(() => meta.put(BACKFILL_DONE_KEY, { value: new Date().toISOString() }))
  } catch (error) {
    warn(`历史用量回填未完成（下次启动重试）：${String(error)}`)
  }
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run src/usage/backfill.test.ts`
Expected: 6/6 PASS。

- [ ] **Step 5: 跑 usage 全量测试确认无回归**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test`
Expected: 59+6 全过。

---

### Task 2: setupUsage 接线 + 组合级测试

**Files:**
- Modify: `packages/usage/package.json`（devDependencies 加一行）
- Modify: `packages/usage/src/usage/index.ts:91-101` 之后新增回填接线块
- Test: `packages/usage/src/usage/backfill.test.ts`（追加 3 个 setupUsage 级用例）

**Interfaces:**
- Consumes: Task 1 的 `backfillMissingDays` / `BackfillDeps` / `BACKFILL_DONE_KEY`。
- Produces: 无新导出；`setupUsage` 行为变化 = 计量主启动后自动回填一次。

- [ ] **Step 1: 加 type-only 依赖并安装**

`packages/usage/package.json` devDependencies 增加一行（保持字母序，跟在 `@deepseek-ai/dsh-llm` 后）：

```json
    "@deepseek-ai/dsh-session-persistence": "link:../../deepseek-harness/packages/session/session-persistence",
```

Run: `pnpm install`（workspace 根，刷新 link）
Expected: 无报错。

- [ ] **Step 2: 写失败测试（3 个 setupUsage 级组合用例，追加到 backfill.test.ts）**

```ts
// ===== setupUsage 组合级（接线）用例 =====
import type { Context } from '@deepseek-ai/cordis'
import { setupUsage } from './index.ts'

/** meter-owner.test.ts 同款假上下文，额外支持 ctx.get('sessionPersistence')。 */
function makeSetupCtx(persistence: unknown, opts: { alreadyOpen?: boolean } = {}) {
  const tables = new Map<string, Map<string, unknown>>()
  const domain = {
    table: (name: string) => {
      let records = tables.get(name)
      if (records === undefined) { records = new Map(); tables.set(name, records) }
      return {
        get: (k: string) => records!.get(k),
        put: async (k: string, v: unknown) => { records!.set(k, v) },
        delete: async (k: string) => records!.delete(k),
      }
    },
    close: async () => {},
  }
  const warn = vi.fn()
  const open = opts.alreadyOpen === true
    ? () => Promise.reject(Object.assign(new Error('already open'), { code: 'already-open' }))
    : () => Promise.resolve(domain)
  const ctx = {
    logger: { warn },
    tokenMeter: { estimateMessage: () => 0 },
    storageDomain: { open },
    effect: (fn: () => unknown) => { void fn() },
    on: vi.fn(),
    commands: { register: vi.fn() },
    inject: vi.fn(),
    get: (name: string) => (name === 'sessionPersistence' ? persistence : undefined),
  }
  return { ctx: ctx as unknown as Context, tables, warn }
}

/** 等 domainReady/metering/backfill 微任务链落地（多轮 flush 覆盖链式 enqueue）。 */
async function flushAll() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

test('接线：计量主启动后自动回填缺失日期并落地标记', async () => {
  const persistence = {
    list: vi.fn(async () => [HEADER]),
    readFrom: vi.fn(async () => ({ meta: HEADER, events: [usageEvent(T1, { inputTokens: 5, outputTokens: 1 })] })),
  }
  const { ctx, tables } = makeSetupCtx(persistence)
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flushAll()
  expect(persistence.list).toHaveBeenCalled()
  const rec = tables.get('daily')?.get('2026-08-27') as DailyRecord
  expect(rec.totals.input).toBe(5)
  expect(tables.get('meta')?.has(BACKFILL_DONE_KEY)).toBe(true)
})

test('接线：sessionPersistence 缺失时 warn 跳过且不落地标记', async () => {
  const { ctx, tables, warn } = makeSetupCtx(undefined)
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flushAll()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('sessionPersistence'))
  expect(tables.get('meta')?.has(BACKFILL_DONE_KEY)).toBe(false)
})

test('接线：already-open 停用方不回填', async () => {
  const persistence = { list: vi.fn(), readFrom: vi.fn() }
  const { ctx } = makeSetupCtx(persistence, { alreadyOpen: true })
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-b')
  await flushAll()
  expect(persistence.list).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: 跑测试确认 3 个新用例红**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run src/usage/backfill.test.ts`
Expected: 前 6 个仍绿；新 3 个失败（回填未接线：list 未被调用 / 无 warn / 标记不存在）。

- [ ] **Step 4: 接线 `usage/index.ts`**

在 `packages/usage/src/usage/index.ts` 顶部 import 区追加：

```ts
// Type-only 激活 @deepseek-ai/dsh-session-persistence 对 cordis Context 的声明合并（可选服务，ctx.get 惰性读取）。
import type {} from '@deepseek-ai/dsh-session-persistence'
import { BACKFILL_DONE_KEY, backfillMissingDays } from './backfill.ts'
```

在既有 `void meteringReady.then((metering) => { ... })` 块（实时采集监听注册，约 89-101 行）之后追加新块：

```ts
  // 一次性历史回填（仅计量主）：sessionPersistence 是可选服务，按仓库规则走 ctx.get
  // （不进 inject，headless 无持久化后端时 warn 跳过、不落地标记，下次启动重试）。
  // 标记已落地则每次启动只读一次 meta 键，零扫描开销。
  void meteringReady.then((metering) => {
    if (!metering) return
    if (meta!.get(BACKFILL_DONE_KEY) !== undefined) return
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) {
      ctx.logger.warn('sessionPersistence 服务缺失，跳过历史用量回填（下次启动重试）')
      return
    }
    // 回填写与实时采集写共用同一条 tail 串行链（读改写不交错）。
    const enqueue = (job: () => Promise<unknown>): Promise<unknown> => {
      const write = tail.then(job)
      tail = write.then(() => undefined, () => undefined)
      return write
    }
    // backfillMissingDays 内部全捕获、永不 reject，无需再挂 rejection handler。
    void backfillMissingDays({
      persistence,
      timezone: config.timezone,
      daily: daily!,
      meta: meta!,
      estimate: (m) => ctx.tokenMeter.estimateMessage(m),
      enqueue,
      warn: (m) => ctx.logger.warn(m),
    })
  }, () => undefined)
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage exec vitest run src/usage/backfill.test.ts`
Expected: 9/9 PASS。

- [ ] **Step 6: 跑 usage 全量测试 + typecheck**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test; if ($?) { pnpm --filter @dsh-agent-toolkit/token-usage typecheck }`
Expected: 全部测试过（含 `src/index.test.ts` 的 inject 断言不变、meter-owner 7 用例不变）；tsc 无错。

---

### Task 3: 全量验证链（进开发回路前的仓库约定门禁）

**Files:** 无新改动；纯验证。

- [ ] **Step 1: usage 三产物 bundle（toolkit 测试经 node_modules 吃 usage lib，必须先刷新）**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage bundle`
Expected: node/client-module/client 三产物构建成功。

- [ ] **Step 2: toolkit 全量测试 + typecheck**

Run: `pnpm --filter dsh-agent-toolkit test; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }`
Expected: 349/349 通过，tsc 无错。

- [ ] **Step 3: toolkit bundle**

Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: Node 半 + 浏览器半构建成功。

- [ ] **Step 4: 人工验收提示（告知用户，不自动执行）**

下次重启 dsh 后：日志应出现一次回填完成（或缺服务 warn）；`/token-usage` 与侧边栏面板应显示 2026-08-26 起补齐的历史统计，且今日数据由实时采集接管不双计。8-26~8-31 期间若本来就无对话，对应日期无记录属预期（回填只补有事件的日期）。
