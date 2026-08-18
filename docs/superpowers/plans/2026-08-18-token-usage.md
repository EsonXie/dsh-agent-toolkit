# token-usage 插件实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 dsh 插件 token-usage：按日聚合 token 用量持久化，Web UI 会话头按钮/斜杠命令弹出模态框展示 24 小时柱状图 + 当日总量（K/M/B）+ 三维细分。

**Architecture:** 双半侧单包（`packages/token-usage/`）。Node 半：`session/event` 监听 → 纯函数聚合 → `storageDomain` KV 按日累加，`commands` 注册 `/token-usage`，`webServer` 注册 JSON 端点。浏览器半：lazy-CJS client bundle，注册 `conversation.session.header.actions` 按钮 + 观察 CommandNode 自动弹 Modal。Spec：`docs/superpowers/specs/2026-08-18-token-usage-design.md`。

**Tech Stack:** TypeScript ESM、pnpm workspace、vitest、zod ^4.4.3、schemastery（Config）、React 18、tsdown + lightningcss（client bundle）。

## Global Constraints

- domain 名 `token_usage`（`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`，**不允许连字符**）；表名 `daily`；version 1
- 计费口径：`inputTokens + (cacheReadTokens??0) + (cacheWriteTokens??0) + outputTokens`；`reasoningTokens` 不重复加
- Bucket 计费总量 = `input + output + cacheRead + cacheWrite + estimated`（估算量单列字段、计入总量）
- 只消费 `assistant/message`（天然去重）与 `compaction/summary`（并入 totals/hours + 单列 compaction 桶，不进三维细分；usage 缺失时**跳过不估算**）
- 估算回退仅用于 `assistant/message` usage 缺失时：`ctx.tokenMeter.estimateMessage(message)`，估算量全部进 `estimated` 字段
- 插件命名导出 `name`/`inject`/`Config`/`apply`，**无 default export**；Config 用 schemastery，记录 schema 用 zod
- 存储记录**不可就地修改**：合并函数返回新对象，经 `put` 整体替换
- 日期/小时按 `Config.timezone`（默认系统本地时区）从 `event.time`（UTC 毫秒）换算
- 浏览器半禁跨插件值导入（`@deepseek-ai/*` 仅 external 白名单 + INLINE_SAFE 可过 purity gate）；同包相对导入不受限
- 样式：CSS Modules + `--dsw-alias-*` 语义 token，禁止字面色值；组件文案中文
- 不修改 `deepseek-harness/` 内任何文件
- 环境：Windows 11 + PowerShell；Node ≥22.19；pnpm

---

### Task 1: dsh 宿主环境就绪

`deepseek-harness/` 是干净 checkout（无 node_modules、无 lib 产物）。开发回路和类型依赖都需要先装依赖并构建一次。

**Files:**
- 不创建/修改任何文件（只读使用 deepseek-harness）

- [ ] **Step 1: 安装依赖**

Run: `pnpm install`（workdir: `deepseek-harness`）
Expected: 成功结束（首次较慢）。若 postinstall（lefthook）失败可忽略重试，不影响产物。

- [ ] **Step 2: 全量构建（lib host + client + web 前端）**

Run: `pnpm run build`（workdir: `deepseek-harness`）
Expected: 成功。官方 client 插件的 `lib/client.js` 与 web 前端 dist 都是 `dsh web` 页面工作的前提（client-modules 对缺失 bundle 会响亮 404）。

- [ ] **Step 3: 冒烟启动**

Run: `pnpm dsh web`（workdir: `deepseek-harness`），浏览器打开输出 URL
Expected: Web UI 正常加载（无 404 的 plugin bundle）。验证后 Ctrl+C 停止。

- [ ] **Step 4: Commit（无变更则不提交）**

本任务不改本仓库文件，无需 commit。

---

### Task 2: 工作区骨架与 token-usage 包壳

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `packages/token-usage/package.json`
- Create: `packages/token-usage/tsconfig.json`
- Create: `packages/token-usage/src/css-modules.d.ts`
- Create: `packages/token-usage/src/index.ts`（桩）
- Create: `packages/token-usage/tests/smoke.test.ts`

**Interfaces:**
- Produces: 包名 `token-usage`；根包依赖它（client-modules 扫描锚定 cordis.yml 所在目录的包依赖）；后续任务在此包内添加文件。

- [ ] **Step 1: 写根 `package.json`**

```json
{
  "name": "dsh-eson-toolkit",
  "private": true,
  "type": "module",
  "dependencies": {
    "token-usage": "workspace:*"
  },
  "scripts": {
    "test": "pnpm -r run test",
    "typecheck": "pnpm -r run typecheck",
    "bundle": "pnpm --filter token-usage run bundle"
  }
}
```

- [ ] **Step 2: 写 `pnpm-workspace.yaml`**

```yaml
packages:
  - 'packages/*'
```

- [ ] **Step 3: 写 `packages/token-usage/package.json`**

`exports["."]` 直指 `./src/index.ts`——本插件只在 dsh 的 tsx 宿主里运行，Node 半开发期零构建；`./client` 指向构建产物。devDependencies 用 `link:` 指向 deepseek-harness 源码（其 `lib/types` 由 Task 1 构建产出）。

```json
{
  "name": "token-usage",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-conversation"]
    }
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "bundle": "tsdown",
    "watch": "tsdown --watch"
  },
  "dependencies": {
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "link:../../deepseek-harness/vendor/cordis",
    "@deepseek-ai/schemastery": "link:../../deepseek-harness/vendor/schemastery",
    "@deepseek-ai/dsh-session": "link:../../deepseek-harness/packages/core/session",
    "@deepseek-ai/dsh-llm": "link:../../deepseek-harness/packages/llm/llm",
    "@deepseek-ai/dsh-token-meter": "link:../../deepseek-harness/packages/llm/token-meter",
    "@deepseek-ai/dsh-storage-domain": "link:../../deepseek-harness/packages/storage/storage-domain",
    "@deepseek-ai/dsh-commands": "link:../../deepseek-harness/packages/interaction/commands",
    "@deepseek-ai/dsh-host-webserver": "link:../../deepseek-harness/packages/host/webserver",
    "@deepseek-ai/dsh-client-runtime": "link:../../deepseek-harness/packages/client/runtime",
    "@deepseek-ai/dsh-client-ui-slots": "link:../../deepseek-harness/packages/client/ui-slots",
    "@deepseek-ai/dsh-client-ui-primitives": "link:../../deepseek-harness/packages/client/ui-primitives",
    "react": "^18.2.0",
    "@types/react": "~18.3.1",
    "typescript": "^5.5.0",
    "vitest": "^3.0.0",
    "tsdown": "^0.15.0",
    "lightningcss": "^1.30.0"
  }
}
```

- [ ] **Step 4: 写 `packages/token-usage/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "noImplicitAny": true,
    "jsx": "react-jsx",
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src", "tests", "tsdown.config.ts"]
}
```

- [ ] **Step 5: 写 `packages/token-usage/src/css-modules.d.ts`**

```ts
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
```

- [ ] **Step 6: 写桩 `packages/token-usage/src/index.ts`**

```ts
/** token-usage 插件 Node 半：占位桩，Task 7 装配完整逻辑。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  timezone: string
}

export const Config: z<Config> = z.object({
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'),
})

export const name = 'token-usage'

export const inject = ['storageDomain', 'tokenMeter', 'commands']

export function apply(_ctx: Context, _config: Config): void {}
```

- [ ] **Step 7: 写 `packages/token-usage/tests/smoke.test.ts`**

```ts
import { expect, test } from 'vitest'
import { name } from '../src/index.ts'

test('插件导出名', () => {
  expect(name).toBe('token-usage')
})
```

- [ ] **Step 8: 安装并验证**

Run: `pnpm install`（workdir: 仓库根），然后 `pnpm --filter token-usage test` 与 `pnpm --filter token-usage typecheck`
Expected: install 成功；test PASS；typecheck 通过。若 tsdown/lightningcss 版本号不存在，`pnpm --filter token-usage add -D tsdown lightningcss` 取最新并同步 package.json。

- [ ] **Step 9: Commit**

```bash
git add package.json pnpm-workspace.yaml packages/token-usage
git commit -m "feat(token-usage): 工作区与包骨架"
```

---

### Task 3: aggregate.ts — 日期与格式化纯函数（TDD）

**Files:**
- Create: `packages/token-usage/src/aggregate.ts`
- Test: `packages/token-usage/tests/aggregate.test.ts`

**Interfaces:**
- Produces（后续任务依赖的确切签名）:
  - `dayParts(time: number, timeZone: string): { date: string; hour: number }` — date 为 `YYYY-MM-DD`，hour 为 0-23
  - `shiftDate(date: string, days: number): string` — 日期串加减天数（翻页用）
  - `formatTokens(n: number): string` — `<1000` 原样；否则按 10³/10⁶/10⁹ 换 K/M/B，`toFixed(1)`

- [ ] **Step 1: 写失败测试 `tests/aggregate.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { dayParts, formatTokens, shiftDate } from '../src/aggregate.ts'

describe('dayParts', () => {
  test('UTC 深夜在东八区归入次日早晨', () => {
    // 2026-08-18T23:30:00Z = 北京时间 2026-08-19 07:30
    const p = dayParts(Date.UTC(2026, 7, 18, 23, 30), 'Asia/Shanghai')
    expect(p).toEqual({ date: '2026-08-19', hour: 7 })
  })

  test('UTC 时区原样', () => {
    const p = dayParts(Date.UTC(2026, 7, 18, 23, 30), 'UTC')
    expect(p).toEqual({ date: '2026-08-18', hour: 23 })
  })

  test('午夜小时归 0（ICU 可能给 24）', () => {
    const p = dayParts(Date.UTC(2026, 7, 18, 0, 0), 'UTC')
    expect(p).toEqual({ date: '2026-08-18', hour: 0 })
  })
})

describe('shiftDate', () => {
  test('跨月', () => {
    expect(shiftDate('2026-08-01', -1)).toBe('2026-07-31')
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('formatTokens', () => {
  test('边界', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1.0K')
    expect(formatTokens(999950)).toBe('1000.0K')
    expect(formatTokens(1_000_000)).toBe('1.0M')
    expect(formatTokens(1_000_000_000)).toBe('1.0B')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter token-usage test`
Expected: FAIL（`../src/aggregate.ts` 不存在）

- [ ] **Step 3: 实现 `src/aggregate.ts`（本任务部分）**

```ts
/** token-usage 纯函数：日期换算、K/M/B 格式化、聚合。无运行时依赖，浏览器半可内联。 */

/** 把 UTC 毫秒换算成指定时区的日期串与小时序号。 */
export function dayParts(time: number, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(time)
  const get = (type: string): string => parts.find((p) => p.type === type)!.value
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24, // 部分 ICU 版本午夜给 24
  }
}

/** 日期串加减天数（锚 UTC 正午，避开 DST）。 */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** 计费 token 数自动换算 K/M/B（10 进制，1 位小数）。 */
export function formatTokens(n: number): string {
  const units = ['', 'K', 'M', 'B'] as const
  let value = n
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return unit === 0 ? String(n) : `${value.toFixed(1)}${units[unit]}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter token-usage test`
Expected: PASS（7 个断言）

- [ ] **Step 5: Commit**

```bash
git add packages/token-usage/src/aggregate.ts packages/token-usage/tests/aggregate.test.ts
git commit -m "feat(token-usage): 日期换算与 K/M/B 格式化纯函数"
```

---

### Task 4: aggregate.ts — 采样与聚合（TDD）

**Files:**
- Modify: `packages/token-usage/src/aggregate.ts`（追加）
- Test: `packages/token-usage/tests/aggregate.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: Task 3 的 `dayParts`
- Produces:
  - `interface UsageSample { date: string; hour: number; input: number; output: number; cacheRead: number; cacheWrite: number; estimated: number; estimatedCall: boolean; model?: string; sessionId?: string; cwd?: string; compaction: boolean }`（每个样本隐含 calls=1）
  - `billedOf(b: Bucket): number` — `input+output+cacheRead+cacheWrite+estimated`
  - `emptyBucket(): Bucket`、`emptyDaily(date: string): DailyRecord`
  - `addSample(rec: DailyRecord, s: UsageSample): DailyRecord` — **返回新对象**，不改入参
  - `sampleFromEvent(session: Session, event: SessionEvent, timeZone: string, estimate: (m: Message) => number): UsageSample | undefined`
- `Bucket`/`DailyRecord` 类型来自 Task 5 的 `store.ts`；本任务先用本地接口占位，Task 5 完成后改为 `import type { Bucket, DailyRecord } from './store.ts'`。为免返工，**本任务直接从 './store.ts' 做 type-only import，先建 Task 5 的 store.ts 再写本任务实现**（步骤已排序：先 Step 3 建 store.ts，再写实现）。

- [ ] **Step 1: 先写 `src/store.ts`（Task 5 的 schema 提前到这里建，类型才能编译）**

```ts
/** token-usage 存储域声明：身份、版本、记录 zod schema 的单一来源。 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const BucketSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  /** 估算样本的计费 token 量（usage 缺失时经 tokenMeter 启发式得出）。 */
  estimated: z.number().int().nonnegative(),
})
export type Bucket = z.infer<typeof BucketSchema>

export const DailyRecordSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totals: BucketSchema.extend({ estimatedCalls: z.number().int().nonnegative() }),
  /** 24 小时桶，空小时为全零桶。 */
  hours: z.array(BucketSchema).length(24),
  /** key = 'provider/model'。 */
  byModel: z.record(z.string(), BucketSchema),
  /** key = sessionId。 */
  bySession: z.record(z.string(), BucketSchema.extend({ cwd: z.string() })),
  /** key = cwd（原样存储）。 */
  byProject: z.record(z.string(), BucketSchema),
  /** 压缩摘要调用单列；数值同时已并入 totals/hours。 */
  compaction: BucketSchema,
})
export type DailyRecord = z.infer<typeof DailyRecordSchema>

/** domain 名受 UNIT_NAME_RE 约束（^[a-z][a-z0-9_]*$），不允许连字符。 */
export const tokenUsageDomain = defineDomain({
  name: 'token_usage',
  version: 1,
  tables: { daily: domainTable<string, DailyRecord>(DailyRecordSchema) },
})
```

- [ ] **Step 2: 追加失败测试到 `tests/aggregate.test.ts`**

```ts
import { addSample, billedOf, emptyDaily, sampleFromEvent } from '../src/aggregate.ts'
import type { UsageSample } from '../src/aggregate.ts'

const sample: UsageSample = {
  date: '2026-08-18', hour: 7,
  input: 100, output: 50, cacheRead: 20, cacheWrite: 10, estimated: 0,
  estimatedCall: false, model: 'deepseek/deepseek-chat', sessionId: 's1', cwd: 'D:/proj',
  compaction: false,
}

describe('billedOf', () => {
  test('计费总量含 estimated', () => {
    expect(billedOf({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, calls: 5, estimated: 6 })).toBe(16)
  })
})

describe('addSample', () => {
  test('累加 totals/hours/三维细分，且不改入参', () => {
    const day = emptyDaily('2026-08-18')
    const next = addSample(day, sample)
    expect(day.totals.calls).toBe(0) // 入参未被修改
    expect(billedOf(next.totals)).toBe(180)
    expect(next.totals.calls).toBe(1)
    expect(billedOf(next.hours[7])).toBe(180)
    expect(billedOf(next.hours[8])).toBe(0) // 空小时保持全零
    expect(billedOf(next.byModel['deepseek/deepseek-chat'])).toBe(180)
    expect(next.bySession['s1'].cwd).toBe('D:/proj')
    expect(billedOf(next.byProject['D:/proj'])).toBe(180)
    expect(next.compaction.calls).toBe(0)
  })

  test('compaction 样本并入 totals/hours 与单列桶，不进三维细分', () => {
    const c: UsageSample = { ...sample, model: undefined, sessionId: undefined, cwd: undefined, compaction: true }
    const next = addSample(emptyDaily('2026-08-18'), c)
    expect(billedOf(next.totals)).toBe(180)
    expect(billedOf(next.compaction)).toBe(180)
    expect(Object.keys(next.byModel)).toHaveLength(0)
    expect(Object.keys(next.bySession)).toHaveLength(0)
    expect(Object.keys(next.byProject)).toHaveLength(0)
  })

  test('估算样本计入 estimated 并累计 estimatedCalls', () => {
    const e: UsageSample = { ...sample, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 42, estimatedCall: true }
    const next = addSample(emptyDaily('2026-08-18'), e)
    expect(next.totals.estimated).toBe(42)
    expect(next.totals.estimatedCalls).toBe(1)
    expect(billedOf(next.totals)).toBe(42)
  })
})

describe('sampleFromEvent', () => {
  const session = { header: { id: 's1', cwd: 'D:/proj' } } as never
  const message = {
    id: 'm1', role: 'assistant', content: [],
    source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
  } as never

  test('assistant/message 带 usage：按互斥字段计费', () => {
    const event = {
      type: 'assistant/message', seq: 1, time: Date.UTC(2026, 7, 18, 12, 0),
      data: { turn: 1, step: 1, message, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 5 } },
    } as never
    const s = sampleFromEvent(session, event, 'UTC', () => 999)
    expect(s).toMatchObject({ date: '2026-08-18', hour: 12, input: 100, output: 50, cacheRead: 20, cacheWrite: 10, estimated: 0, estimatedCall: false, model: 'deepseek/deepseek-chat', compaction: false })
  })

  test('assistant/message 缺 usage：估算整体进 estimated', () => {
    const event = { type: 'assistant/message', seq: 1, time: Date.UTC(2026, 7, 18), data: { turn: 1, step: 1, message } } as never
    const s = sampleFromEvent(session, event, 'UTC', () => 1234)
    expect(s).toMatchObject({ input: 0, output: 0, estimated: 1234, estimatedCall: true })
  })

  test('compaction/summary 带 usage：compaction 样本；缺 usage：跳过', () => {
    const withUsage = { type: 'compaction/summary', seq: 2, time: Date.UTC(2026, 7, 18, 3), data: { provider: 'deepseek', model: 'deepseek-chat', usage: { inputTokens: 500, outputTokens: 100 } } } as never
    expect(sampleFromEvent(session, withUsage, 'UTC', () => 0)).toMatchObject({ hour: 3, input: 500, output: 100, compaction: true, model: undefined })
    const noUsage = { type: 'compaction/summary', seq: 3, time: Date.UTC(2026, 7, 18), data: { provider: 'deepseek', model: 'deepseek-chat' } } as never
    expect(sampleFromEvent(session, noUsage, 'UTC', () => 0)).toBeUndefined()
  })

  test('无关事件返回 undefined', () => {
    const event = { type: 'step/start', seq: 4, time: Date.UTC(2026, 7, 18), data: { turn: 1, step: 1 } } as never
    expect(sampleFromEvent(session, event, 'UTC', () => 0)).toBeUndefined()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter token-usage test`
Expected: FAIL（`addSample` 等未定义）

- [ ] **Step 4: 追加实现到 `src/aggregate.ts`**

```ts
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm/types'
import type { Bucket, DailyRecord } from './store.ts'

/** 一条待聚合样本；每个样本隐含 calls=1。 */
export interface UsageSample {
  date: string
  hour: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 估算样本的计费 token 量；真实样本为 0。 */
  estimated: number
  estimatedCall: boolean
  /** 'provider/model'；compaction 样本无。 */
  model?: string
  sessionId?: string
  cwd?: string
  compaction: boolean
}

/** 桶的计费总量（含估算）。 */
export function billedOf(b: Bucket): number {
  return b.input + b.output + b.cacheRead + b.cacheWrite + b.estimated
}

export function emptyBucket(): Bucket {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, estimated: 0 }
}

export function emptyDaily(date: string): DailyRecord {
  return {
    date,
    totals: { ...emptyBucket(), estimatedCalls: 0 },
    hours: Array.from({ length: 24 }, emptyBucket),
    byModel: {},
    bySession: {},
    byProject: {},
    compaction: emptyBucket(),
  }
}

function addToBucket(b: Bucket, s: UsageSample): Bucket {
  return {
    input: b.input + s.input, output: b.output + s.output,
    cacheRead: b.cacheRead + s.cacheRead, cacheWrite: b.cacheWrite + s.cacheWrite,
    calls: b.calls + 1, estimated: b.estimated + s.estimated,
  }
}

/** 把一条样本并入日记录，返回新对象（存储记录禁止就地修改）。 */
export function addSample(rec: DailyRecord, s: UsageSample): DailyRecord {
  const totals = { ...addToBucket(rec.totals, s), estimatedCalls: rec.totals.estimatedCalls + (s.estimatedCall ? 1 : 0) }
  const hours = rec.hours.slice()
  hours[s.hour] = addToBucket(hours[s.hour], s)
  const byModel = { ...rec.byModel }
  if (s.model !== undefined) byModel[s.model] = addToBucket(byModel[s.model] ?? emptyBucket(), s)
  const bySession = { ...rec.bySession }
  if (s.sessionId !== undefined && s.cwd !== undefined) {
    bySession[s.sessionId] = { ...addToBucket(bySession[s.sessionId] ?? { ...emptyBucket(), cwd: s.cwd }, s), cwd: s.cwd }
  }
  const byProject = { ...rec.byProject }
  if (s.cwd !== undefined && !s.compaction) byProject[s.cwd] = addToBucket(byProject[s.cwd] ?? emptyBucket(), s)
  const compaction = s.compaction ? addToBucket(rec.compaction, s) : rec.compaction
  return { ...rec, totals, hours, byModel, bySession, byProject, compaction }
}

/** 从 session 事件提取样本；不相关事件与无 usage 的 compaction 返回 undefined。 */
export function sampleFromEvent(
  session: Session,
  event: SessionEvent,
  timeZone: string,
  estimate: (message: Message) => number,
): UsageSample | undefined {
  const { date, hour } = dayParts(event.time, timeZone)
  if (event.type === 'assistant/message') {
    const { message, usage } = event.data
    const base = { date, hour, model: `${message.source.provider}/${message.source.model}`, sessionId: String(session.header.id), cwd: session.header.cwd, compaction: false }
    if (usage === undefined) {
      return { ...base, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: estimate(message), estimatedCall: true }
    }
    return {
      ...base, estimated: 0, estimatedCall: false,
      input: usage.inputTokens, output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0,
    }
  }
  if (event.type === 'compaction/summary') {
    const { usage } = event.data
    if (usage === undefined) return undefined // 摘要块不是 Message，不做启发式估算
    return {
      date, hour, estimated: 0, estimatedCall: false, compaction: true,
      input: usage.inputTokens, output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0,
    }
  }
  return undefined
}
```

注意 `addSample` 中 byProject 的 `!s.compaction` 守卫：compaction 样本本就无 cwd（`cwd === undefined`），双保险。byModel 对 compaction 同样因 `model === undefined` 跳过。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter token-usage test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/token-usage/src/aggregate.ts packages/token-usage/src/store.ts packages/token-usage/tests/aggregate.test.ts
git commit -m "feat(token-usage): 采样聚合纯函数与存储域 schema"
```

---

### Task 5: store.ts schema 校验测试（TDD）

`store.ts` 已在 Task 4 Step 1 创建；本任务补其行为测试。

**Files:**
- Test: `packages/token-usage/tests/store.test.ts`

**Interfaces:**
- Consumes: `tokenUsageDomain`、`DailyRecordSchema`、`emptyDaily`

- [ ] **Step 1: 写失败测试 `tests/store.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { DailyRecordSchema, tokenUsageDomain } from '../src/store.ts'
import { emptyDaily } from '../src/aggregate.ts'

describe('tokenUsageDomain', () => {
  test('域名与版本', () => {
    expect(tokenUsageDomain.name).toBe('token_usage')
    expect(tokenUsageDomain.version).toBe(1)
    expect(Object.keys(tokenUsageDomain.tables)).toEqual(['daily'])
  })
})

describe('DailyRecordSchema', () => {
  test('接受 emptyDaily 产物', () => {
    expect(DailyRecordSchema.safeParse(emptyDaily('2026-08-18')).success).toBe(true)
  })

  test('拒绝非法日期与缺桶', () => {
    expect(DailyRecordSchema.safeParse(emptyDaily('2026-8-18')).success).toBe(false)
    const bad = emptyDaily('2026-08-18')
    ;(bad.hours as unknown[]).length = 23
    expect(DailyRecordSchema.safeParse(bad).success).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认通过（实现已在 Task 4 完成，此步验证其正确性）**

Run: `pnpm --filter token-usage test`
Expected: PASS。若失败，修正 `store.ts` schema 或 `emptyDaily` 使其一致。

- [ ] **Step 3: Commit**

```bash
git add packages/token-usage/tests/store.test.ts
git commit -m "test(token-usage): 存储域 schema 校验"
```

---

### Task 6: render.ts — 命令文本视图（TDD）

**Files:**
- Create: `packages/token-usage/src/render.ts`
- Test: `packages/token-usage/tests/render.test.ts`

**Interfaces:**
- Consumes: `DailyRecord`、`billedOf`、`formatTokens`、`shiftDate`
- Produces:
  - `renderDay(rec: DailyRecord): string` — 当日详情文本
  - `renderWeek(today: string, days: readonly DailyRecord[]): string` — 今日详情 + 近 7 日每日一行（`days[0]` 须为今日）

- [ ] **Step 1: 写失败测试 `tests/render.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { addSample, emptyDaily, type UsageSample } from '../src/aggregate.ts'
import { renderDay, renderWeek } from '../src/render.ts'

const s: UsageSample = {
  date: '2026-08-18', hour: 7, input: 900, output: 200, cacheRead: 0, cacheWrite: 0,
  estimated: 0, estimatedCall: false, model: 'deepseek/deepseek-chat', sessionId: 's1', cwd: 'D:/proj',
  compaction: false,
}

describe('renderDay', () => {
  test('含总量、调用数与模型细分', () => {
    const text = renderDay(addSample(emptyDaily('2026-08-18'), s))
    expect(text).toContain('2026-08-18')
    expect(text).toContain('1.1K')
    expect(text).toContain('deepseek/deepseek-chat')
    expect(text).toContain('D:/proj')
  })

  test('估算标注', () => {
    const e: UsageSample = { ...s, input: 0, output: 0, estimated: 500, estimatedCall: true }
    expect(renderDay(addSample(emptyDaily('2026-08-18'), e))).toContain('估算')
  })
})

describe('renderWeek', () => {
  test('今日详情 + 近 7 日逐日行', () => {
    const days = Array.from({ length: 7 }, (_, i) => emptyDaily(`2026-08-${18 - i}`))
    days[0] = addSample(days[0], s)
    const text = renderWeek('2026-08-18', days)
    expect(text).toContain('2026-08-17')
    expect(text).toContain('2026-08-12')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter token-usage test`
Expected: FAIL（`../src/render.ts` 不存在）

- [ ] **Step 3: 实现 `src/render.ts`**

```ts
/** /token-usage 命令的文本视图（纯函数）。 */
import { billedOf, formatTokens } from './aggregate.ts'
import type { DailyRecord } from './store.ts'

function line(name: string, b: { calls: number } & Record<string, number>): string {
  return `  ${name}  ${formatTokens(billedOf(b as never))}  ${b.calls} 次调用`
}

/** 当日详情：总量（含估算标注）+ 三维细分 + compaction 单列。 */
export function renderDay(rec: DailyRecord): string {
  const est = rec.totals.estimated > 0 ? `（含估算 ${formatTokens(rec.totals.estimated)}）` : ''
  const rows: string[] = [
    `${rec.date} 用量：${formatTokens(billedOf(rec.totals))} ${rec.totals.calls} 次调用${est}`,
  ]
  const models = Object.entries(rec.byModel).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))
  if (models.length > 0) rows.push('按模型：', ...models.map(([k, v]) => line(k, v)))
  const projects = Object.entries(rec.byProject).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))
  if (projects.length > 0) rows.push('按项目：', ...projects.map(([k, v]) => line(k, v)))
  const sessions = Object.entries(rec.bySession).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))
  if (sessions.length > 0) rows.push('按会话：', ...sessions.map(([k, v]) => line(`${k} (${v.cwd})`, v)))
  if (rec.compaction.calls > 0) rows.push(`上下文压缩：${formatTokens(billedOf(rec.compaction))} ${rec.compaction.calls} 次调用`)
  return rows.join('\n')
}

/** 今日详情 + 近 7 日逐日摘要行（days[0] 为今日）。 */
export function renderWeek(today: string, days: readonly DailyRecord[]): string {
  const lines = days.map((d) => `${d.date}  ${formatTokens(billedOf(d.totals))}  ${d.totals.calls} 次调用`)
  return `${renderDay(days[0])}\n\n近 7 日：\n${lines.join('\n')}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter token-usage test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/token-usage/src/render.ts packages/token-usage/tests/render.test.ts
git commit -m "feat(token-usage): 命令文本视图"
```

---

### Task 7: Node 半装配 + cordis.yml 开发回路

**Files:**
- Modify: `packages/token-usage/src/index.ts`（替换桩实现）
- Create: `cordis.yml`（仓库根）

**Interfaces:**
- Consumes: 全部前序产物
- Produces: 运行中的插件；`GET /token-usage/api/daily?date=YYYY-MM-DD` 返回 `200 { today: string, record: DailyRecord }`（无记录时 record 为全零空记录；date 缺省=按 Config.timezone 的"今天"）；非法 date 返回 `400 { error: string }`；非 GET 返回 405。

- [ ] **Step 1: 写完整 `src/index.ts`**

```ts
/** token-usage 插件 Node 半：采集、按日聚合持久化、/token-usage 命令、JSON 查询端点。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { addSample, dayParts, emptyDaily, sampleFromEvent } from './aggregate.ts'
import { renderDay, renderWeek } from './render.ts'
import { tokenUsageDomain, type DailyRecord } from './store.ts'

export interface Config {
  /** 按日聚合的时区（IANA 名）。 */
  timezone: string
}

export const Config: z<Config> = z.object({
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'),
})

export const name = 'token-usage'

export const inject = ['storageDomain', 'tokenMeter', 'commands']

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function apply(ctx: Context, config: Config): void {
  let daily: KvTable<string, DailyRecord> | undefined
  // 写串行化：session/event 监听可并发触发，所有聚合写排进同一条 Promise 链，
  // 之后 get+put 才不会互相覆盖（KvTable 不串行化并发写）。
  let tail: Promise<unknown> = Promise.resolve()
  const domainReady = ctx.storageDomain.open(tokenUsageDomain).then((domain) => {
    daily = domain.table('daily')
    return domain
  })

  ctx.on('session/event', (session, event) => {
    const sample = sampleFromEvent(session, event, config.timezone, (m) => ctx.tokenMeter.estimateMessage(m))
    if (sample === undefined) return
    tail = domainReady.then(() => {
      const table = daily!
      return table.put(sample.date, addSample(table.get(sample.date) ?? emptyDaily(sample.date), sample))
    })
  })

  ctx.commands.register({
    name: 'token-usage',
    description: '查看 token 用量（今日+近7日，或指定日期）',
    input: { hint: 'YYYY-MM-DD，可空' },
    handler: async ({ rawInput }) => {
      const table = await domainReady.then(() => daily!)
      const arg = rawInput.trim()
      const today = dayParts(Date.now(), config.timezone).date
      if (arg !== '' && !DATE_RE.test(arg)) {
        return { kind: 'error' as const, text: '用法：/token-usage [YYYY-MM-DD]' }
      }
      if (arg !== '') {
        return { kind: 'success' as const, text: renderDay(table.get(arg) ?? emptyDaily(arg)) }
      }
      const days = Array.from({ length: 7 }, (_, i) => {
        const date = dayParts(Date.now() - i * 86_400_000, config.timezone).date
        return table.get(date) ?? emptyDaily(date)
      })
      void today
      return { kind: 'success' as const, text: renderWeek(days[0].date, days) }
    },
  })

  // webServer 是可选能力（headless/CLI 无此服务），用 ctx.get 而非 inject。
  const webServer = ctx.get('webServer') as WebServer | undefined
  webServer?.register({
    kind: 'exact',
    path: '/token-usage/api/daily',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      const date = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('date')
      if (date !== null && !DATE_RE.test(date)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad date, want YYYY-MM-DD' }))
        return
      }
      const table = await domainReady.then(() => daily!)
      const today = dayParts(Date.now(), config.timezone).date
      const key = date ?? today
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ today, record: table.get(key) ?? emptyDaily(key) }))
    },
  })

  ctx.effect(() => async () => {
    await tail.catch(() => undefined) // 排空的写链落到后端后再关 domain
    await domainReady.then((domain) => domain.close())
  })
}
```

- [ ] **Step 2: typecheck + 单测全绿**

Run: `pnpm --filter token-usage typecheck; pnpm --filter token-usage test`
Expected: 均通过。若 `WebServer`/`KvTable` 导出路径不对，打开对应包的 `src/index.ts` 确认导出名后修正 import。

- [ ] **Step 3: 写开发 patch `cordis.yml`（仓库根）**

```yaml
# 开发用 patch：dsh web --patch 叠加到 web profile。
# 插件 name 必须是绝对路径（相对路径不会从 profile 目录解析）。
plugins:
  - name: D:/work/github/dsh/dsh-eson-toolkit/packages/token-usage
    config:
      timezone: Asia/Shanghai
```

- [ ] **Step 4: 手动验证开发回路**

先选 home 姿态（`resolveDshHome`：显式配置 ?? `$DSH_HOME` ?? `~/.dsh`）：
- **共享真实 home（默认）**：直接跑下述命令，模型配置/凭据与已装 CLI 共用；发消息是真实调用、消耗真实额度，且测试消耗会被本插件统计进真实数据。不要与已装 dsh 同时运行。
- **隔离 home**：先 `$env:DSH_HOME='D:\work\github\dsh\dsh-eson-toolkit\.dev-home'`（该目录加进 .gitignore）再跑；全新空环境，无模型配置，只能验证空态/400/弹窗，真实用量验证跳过。

Run: `pnpm dsh web --patch D:\work\github\dsh\dsh-eson-toolkit\cordis.yml`（workdir: `deepseek-harness`）
Expected:
1. 启动无 token-usage 相关报错
2. 浏览器发一条消息产生真实用量（需 `DEEPSEEK_API_KEY`；无 key 则跳过，验证空态）
3. 会话输入 `/token-usage` → 返回今日+近 7 日文本
4. `curl "http://127.0.0.1:<port>/token-usage/api/daily"` → 200 JSON 含 today/record；`?date=bad` → 400
5. 改 cordis.yml 的 timezone → HMR 热替换不重启
验证后 Ctrl+C。

- [ ] **Step 5: Commit**

```bash
git add packages/token-usage/src/index.ts cordis.yml
git commit -m "feat(token-usage): Node 半装配与开发 patch"
```

---

### Task 8: tsdown 客户端 bundle 构建

**Files:**
- Create: `packages/token-usage/tsdown.config.ts`
- Create: `packages/token-usage/src/client/index.ts`（最小桩，验证 bundle 能被宿主加载）

**Interfaces:**
- Produces: `pnpm --filter token-usage bundle` 产出 `lib/client.js`，首行含 `window.__ModuleLoader__.load({ id: "token-usage", factory: (require) => {`，末行含 `return module.exports; } });`

- [ ] **Step 1: 写 `tsdown.config.ts`（复刻 dsh clientBundle 预设的浏览器半；Node 半不需要构建——exports["."] 直指 src）**

```ts
/** token-usage 客户端 bundle 配置：复刻 dsh tsdown.client.ts 的 lazy-CJS factory 形态。 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

const ID = 'token-usage'

/** 平台模块由 loader 模块表提供，保持 external（对照 dsh web/src/platform.ts + runtime 豁免）。 */
const CLIENT_EXTERNALS = [
  'react', 'react-dom', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form', '@deepseek-ai/dsh-client-runtime/client',
] as const
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

export default {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  noExternal: (id: string) => ((CLIENT_EXTERNALS as readonly string[]).includes(id) ? undefined : true),
  plugins: [{
    // 纯净度门禁：跨插件值导入即构建错误；协作走 cordis 服务/slot。
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if ((CLIENT_EXTERNALS as readonly string[]).includes(source)) return null
      if (VENDORED_LIBRARY.test(source)) return null
      if (INLINE_SAFE.test(source)) return null
      throw new Error(`client bundle purity: "${source}" 不是平台模块或 inline-safe 线层——禁止跨插件值导入`)
    },
  }, {
    // CSS Modules 内联：x.module.css → 哈希类名映射 + <style data-plugin> 自动注入。
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(id: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId, code: source, cssModules: { pattern: '[hash]_[local]' }, minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} satisfies UserConfig
```

- [ ] **Step 2: 写最小桩 `src/client/index.ts`**

```ts
/** token-usage 浏览器半：占位桩，Task 9 起注册 UI。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const inject = ['slots']

export function apply(_ctx: ClientContext): void {}
```

- [ ] **Step 3: 构建并断言产物格式**

Run: `pnpm --filter token-usage bundle`
Expected: 成功产出 `packages/token-usage/lib/client.js`。
Run: `Select-String -Path packages\token-usage\lib\client.js -Pattern '__ModuleLoader__.load' -SimpleMatch`（可只读首行）
Expected: 命中 banner；文件末尾为 footer。

- [ ] **Step 4: Commit**

```bash
git add packages/token-usage/tsdown.config.ts packages/token-usage/src/client/index.ts
git commit -m "feat(token-usage): 客户端 bundle 构建配置"
```

`.gitignore` 已含 `node_modules/` 与 `dist/`；追加一行 `packages/*/lib/`：

```bash
git add .gitignore  # 先编辑再加
```

---

### Task 9: UsageButton — 会话头按钮 + 空模态框

**Files:**
- Create: `packages/token-usage/src/client/UsageButton.tsx`
- Create: `packages/token-usage/src/client/UsageModal.tsx`（壳）
- Create: `packages/token-usage/src/client/UsageModal.module.css`
- Modify: `packages/token-usage/src/client/index.ts`（注册 slot）

**Interfaces:**
- Consumes: slot `conversation.session.header.actions`（session scope；组件 props 含 `useSession`/`sessionId`/`useProjection`）；`Modal` from `@deepseek-ai/dsh-client-ui-primitives`（props: `open`/`onClose`/`title`/`closeLabel?`/`children`）
- Produces: 会话头出现柱状图按钮，点击打开标题为"Token 用量"的空模态框

- [ ] **Step 1: 写 `src/client/index.ts`**

```tsx
/** token-usage 浏览器半：注册会话头按钮。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { UsageButton } from './UsageButton.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  // inject() 等 slot 被 ui-conversation 声明后再注册，声明消失自动回滚。
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.actions', id: 'token-usage', order: 30 },
      UsageButton,
    ))
}
```

- [ ] **Step 2: 写 `UsageButton.tsx`（本任务先开空 Modal；CommandNode 观察在 Task 11 加）**

```tsx
/** 会话头"Token 用量"按钮：点击打开用量模态框。 */
import { useState } from 'react'
import { UsageModal } from './UsageModal.tsx'

export function UsageButton(): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" title="Token 用量" onClick={() => setOpen(true)}>📊</button>
      <UsageModal open={open} onClose={() => setOpen(false)} initialDate={null} />
    </>
  )
}
```

（`import type { ReactNode } from 'react'` 一并加上。emoji 占位图标，Task 10 定稿时可换 ui-primitives 图标。）

- [ ] **Step 3: 写 `UsageModal.tsx` 壳与 `UsageModal.module.css`**

```tsx
/** Token 用量模态框：翻页头 + 24 小时柱状图 + 总量 + 三维细分（Task 10 填充）。 */
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

export interface UsageModalProps {
  open: boolean
  onClose: () => void
  /** 初始日期 YYYY-MM-DD；null = 今天（以端点返回的 today 为准）。 */
  initialDate: string | null
}

export function UsageModal({ open, onClose }: UsageModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Token 用量" closeLabel="关闭">
      <p>加载中…</p>
    </Modal>
  )
}
```

```css
/* UsageModal.module.css：Task 10 填充；先放空占位保持构建管线通畅。 */
.root { min-width: 560px; }
```

语义 token 选择：写样式前打开 `deepseek-harness/packages/client/ui-theme/src/styles/` 挑存在的 `--dsw-alias-*`（如文本/边框/强调色），禁止字面色值。

- [ ] **Step 4: 构建 + typecheck**

Run: `pnpm --filter token-usage typecheck; pnpm --filter token-usage bundle`
Expected: 通过。若 `ctx.slots` 类型不在 ClientContext 上（service 声明合并问题），检查 `dsh-client-runtime/client` 的类型导出并在本包 `src/client/` 加 `import type {} from '@deepseek-ai/dsh-client-ui-slots'` 触发合并。

- [ ] **Step 5: 手动验证**

Run: `pnpm dsh web --patch D:\work\github\dsh\dsh-eson-toolkit\cordis.yml`（workdir: `deepseek-harness`）
Expected: 打开/新建会话 → 会话头出现 📊 按钮 → 点击弹出标题"Token 用量"的模态框，Escape/遮罩关闭。bundle 改动后重跑 `pnpm --filter token-usage bundle`（或常驻 `pnpm --filter token-usage watch`），页面刷新生效。

- [ ] **Step 6: Commit**

```bash
git add packages/token-usage/src/client
git commit -m "feat(token-usage): 会话头按钮与模态框壳"
```

---

### Task 10: UsageModal 完整内容

**Files:**
- Modify: `packages/token-usage/src/client/UsageModal.tsx`
- Modify: `packages/token-usage/src/client/UsageModal.module.css`

**Interfaces:**
- Consumes: Task 7 的端点 `GET /token-usage/api/daily?date=` → `{ today, record }`；`../aggregate.ts` 的 `billedOf`/`formatTokens`/`shiftDate`（同包导入，bundle 内联合法）
- Produces: 完整模态框——翻页头、24 根柱状图（空小时零高度占位）、当日总量（K/M/B + 估算标注）、按模型/项目/会话细分表、compaction 行、空态/错误态

- [ ] **Step 1: 实现完整 `UsageModal.tsx`**

```tsx
/** Token 用量模态框：翻页头 + 24 小时柱状图 + 总量 + 三维细分。 */
import { useEffect, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { billedOf, formatTokens, shiftDate } from '../aggregate.ts'
import type { DailyRecord } from '../store.ts'
import css from './UsageModal.module.css'

export interface UsageModalProps {
  open: boolean
  onClose: () => void
  /** 初始日期 YYYY-MM-DD；null = 今天（以端点 today 为准）。 */
  initialDate: string | null
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; today: string; record: DailyRecord }

async function fetchDay(date: string | null): Promise<LoadState> {
  try {
    const res = await fetch(date === null ? '/token-usage/api/daily' : `/token-usage/api/daily?date=${date}`)
    if (!res.ok) return { status: 'error' }
    const body = await res.json() as { today: string; record: DailyRecord }
    return { status: 'ok', today: body.today, record: body.record }
  } catch {
    return { status: 'error' }
  }
}

function Breakdown({ title, rows }: { title: string; rows: [string, { calls: number } & Record<string, number>][] }) {
  if (rows.length === 0) return null
  return (
    <section>
      <h3 className={css.sectionTitle}>{title}</h3>
      {rows.map(([name, b]) => (
        <div key={name} className={css.row}>
          <span className={css.rowName}>{name}</span>
          <span>{formatTokens(billedOf(b as never))}</span>
          <span className={css.rowCalls}>{b.calls} 次</span>
        </div>
      ))}
    </section>
  )
}

export function UsageModal({ open, onClose, initialDate }: UsageModalProps) {
  const [date, setDate] = useState<string | null>(initialDate)
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => { if (open) setDate(initialDate) }, [open, initialDate])
  useEffect(() => {
    if (!open) return
    let stale = false
    setState({ status: 'loading' })
    void fetchDay(date).then((s) => { if (!stale) setState(s) })
    return () => { stale = true }
  }, [open, date])

  const record = state.status === 'ok' ? state.record : undefined
  const today = state.status === 'ok' ? state.today : undefined
  const current = record?.date ?? initialDate ?? ''
  const peak = record === undefined ? 1 : Math.max(1, ...record.hours.map(billedOf))

  return (
    <Modal open={open} onClose={onClose} title="Token 用量" closeLabel="关闭" contentClassName={css.root}>
      <div className={css.pager}>
        <button type="button" onClick={() => setDate(shiftDate(current, -1))}>←</button>
        <span className={css.dateLabel}>{current}</span>
        <button type="button" disabled={today === undefined || shiftDate(current, 1) > today}
          onClick={() => setDate(shiftDate(current, 1))}>→</button>
      </div>
      {state.status === 'loading' && <p>加载中…</p>}
      {state.status === 'error' && <p>加载失败，请翻页重试</p>}
      {record !== undefined && (
        <>
          <div className={css.chart}>
            {record.hours.map((b, h) => (
              <div key={h} className={css.barSlot} title={`${h}:00  ${formatTokens(billedOf(b))}  ${b.calls} 次`}>
                <div className={css.bar} style={{ height: `${(billedOf(b) / peak) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className={css.hourLabels}>
            {[0, 6, 12, 18].map((h) => <span key={h}>{h}:00</span>)}
          </div>
          <p className={css.total}>
            当日总量 {formatTokens(billedOf(record.totals))} · {record.totals.calls} 次调用
            {record.totals.estimated > 0 && `（含估算 ${formatTokens(record.totals.estimated)}）`}
            {record.totals.calls === 0 && ' · 当日无用量'}
          </p>
          <Breakdown title="按模型" rows={Object.entries(record.byModel).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
          <Breakdown title="按项目" rows={Object.entries(record.byProject).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
          <Breakdown title="按会话" rows={Object.entries(record.bySession).map(([k, v]) => [`${k} (${v.cwd})`, v] as [string, typeof v]).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
          {record.compaction.calls > 0 && (
            <p className={css.compaction}>上下文压缩 {formatTokens(billedOf(record.compaction))} · {record.compaction.calls} 次</p>
          )}
        </>
      )}
    </Modal>
  )
}
```

- [ ] **Step 2: 写完整 `UsageModal.module.css`**

柱状图照 ContextMeter 先例（固定高度容器 + div 百分比高度）。token 名以 `deepseek-harness/packages/client/ui-theme/src/styles/` 实际存在的 `--dsw-alias-*` 为准：

```css
.root { min-width: 560px; max-width: 720px; }
.pager { display: flex; align-items: center; gap: 8px; justify-content: center; }
.dateLabel { font-variant-numeric: tabular-nums; }
.chart { display: flex; align-items: flex-end; gap: 2px; height: 120px; margin-top: 12px; }
.barSlot { flex: 1; height: 100%; display: flex; align-items: flex-end; }
.bar { width: 100%; min-height: 1px; background: var(--dsw-alias-accent, currentColor); border-radius: 1px; }
.hourLabels { display: flex; justify-content: space-between; opacity: 0.6; font-size: 11px; }
.total { margin-top: 12px; font-weight: 600; }
.sectionTitle { margin: 12px 0 4px; font-size: 12px; opacity: 0.7; }
.row { display: flex; gap: 12px; justify-content: space-between; font-size: 12px; }
.rowName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rowCalls { opacity: 0.6; }
.compaction { margin-top: 8px; font-size: 12px; opacity: 0.7; }
```

（`--dsw-alias-accent` 若不存在，从 ui-theme styles 里挑真实强调色 token 替换。）

- [ ] **Step 3: typecheck + bundle + 单测全绿**

Run: `pnpm --filter token-usage typecheck; pnpm --filter token-usage bundle; pnpm --filter token-usage test`
Expected: 全通过

- [ ] **Step 4: 手动验证**

Run: `pnpm dsh web --patch D:\work\github\dsh\dsh-eson-toolkit\cordis.yml`
Expected: 按钮 → 模态框显示今日：24 根柱（无用量小时为零高度占位）、总量 K/M/B、细分表；翻页到昨天/明天（明天禁用）；无数据日期显示"当日无用量"；断网/关服务时翻页显示错误态。

- [ ] **Step 5: Commit**

```bash
git add packages/token-usage/src/client
git commit -m "feat(token-usage): 用量模态框完整内容（柱状图/总量/细分/翻页）"
```

---

### Task 11: 命令触发自动弹窗

**Files:**
- Modify: `packages/token-usage/src/client/UsageButton.tsx`

**Interfaces:**
- Consumes: props 的 `useSession`（`SnapshotSelectorHook<ConversationSnapshot>`）；`ConversationSnapshot.nodes: readonly ConversationNode[]`；`CommandNode { kind: 'command', seq, name: string | null, args: string | null, outcome: {...} | null }`

机制：观察会话快照里最新一个 `name === 'token-usage'` 且 `outcome` 非空的 CommandNode；其 seq 超过已处理水位即弹窗，日期取 `args.trim()`（合法日期串才采用，否则今天）。

- [ ] **Step 1: 改写 `UsageButton.tsx`**

```tsx
/** 会话头"Token 用量"按钮：点击弹窗；执行 /token-usage 命令后自动弹窗。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { UseConversationSession } from '@deepseek-ai/dsh-client-runtime/client'
import { UsageModal } from './UsageModal.tsx'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface UsageButtonProps {
  useSession: UseConversationSession
}

export function UsageButton({ useSession }: UsageButtonProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState<string | null>(null)
  const handledSeq = useRef(0)

  const lastCommand = useSession((s) => {
    for (let i = s.nodes.length - 1; i >= 0; i -= 1) {
      const n = s.nodes[i]
      if (n.kind === 'command' && n.name === 'token-usage') return n
    }
    return null
  })

  useEffect(() => {
    if (lastCommand === null || lastCommand.outcome === null) return
    if (lastCommand.seq <= handledSeq.current) return
    handledSeq.current = lastCommand.seq
    const arg = lastCommand.args?.trim() ?? ''
    setDate(DATE_RE.test(arg) ? arg : null)
    setOpen(true)
  }, [lastCommand])

  return (
    <>
      <button type="button" title="Token 用量" onClick={() => { setDate(null); setOpen(true) }}>📊</button>
      <UsageModal open={open} onClose={() => setOpen(false)} initialDate={date} />
    </>
  )
}
```

注意：`useSession` 的选择器每次返回同一个 CommandNode 对象引用（snapshot 不可变、未变子结构保引用），effect 不会因无关渲染重复弹窗；seq 水位双保险。

- [ ] **Step 2: typecheck + bundle**

Run: `pnpm --filter token-usage typecheck; pnpm --filter token-usage bundle`
Expected: 通过。若 `UseConversationSession` 未导出，从 `@deepseek-ai/dsh-client-runtime/client` 的导出表找 `SnapshotSelectorHook<ConversationSnapshot>` 的别名并修正。

- [ ] **Step 3: 手动验证**

Run: `pnpm dsh web --patch ...`
Expected: 输入 `/token-usage` → 文本摘要出现在会话流的同时模态框自动弹出（今日）；`/token-usage 2026-08-01` → 弹窗显示该日期；点按钮仍是今日。

- [ ] **Step 4: Commit**

```bash
git add packages/token-usage/src/client/UsageButton.tsx
git commit -m "feat(token-usage): /token-usage 命令自动弹出用量模态框"
```

---

### Task 12: 收尾

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新 AGENTS.md**

"仓库性质"节：删除"当前没有任何代码"，改为记录 packages/token-usage 存在。新增"开发命令"节：

```markdown
## 开发命令

- 单测：`pnpm --filter token-usage test`；类型检查：`pnpm --filter token-usage typecheck`
- 客户端 bundle：`pnpm --filter token-usage bundle`（开发期 `pnpm --filter token-usage watch`）
- 开发回路：`cd deepseek-harness && pnpm dsh web --patch D:\work\github\dsh\dsh-eson-toolkit\cordis.yml`（deepseek-harness 首次需 `pnpm install && pnpm run build`）
```

- [ ] **Step 2: 全量验证**

Run: `pnpm install; pnpm run typecheck; pnpm run test`（仓库根）+ Task 9/10/11 的手动项过一次
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md 记录 token-usage 开发命令"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec §2 八项决策 → Task 4/7/9/10/11 全覆盖；§4 数据模型 → Task 4/5；§5 采集 → Task 4/7；§6.1/6.2/6.3 交互 → Task 9/11/10；§6.4 端点 → Task 7；§7 配置 → Task 2/7；§8 构建 → Task 2/8；§9 错误处理 → Task 7（400/405/error result）+ Task 10（错误态/空态）；§10 测试 → 各 TDD 任务 + Task 12。
- **与 spec 的偏差**（实现期合理简化，已在任务内注明）：①悬停数值用原生 `title` 属性而非 ui-primitives Tooltip（后者 API 未核实，打磨项）；②端点响应加 `today` 字段让浏览器半不猜时区；③`store.ts` 提前到 Task 4 创建（类型依赖顺序）。
- **占位符扫描**：无 TBD/TODO；唯一环境变量是 dsh 侧构建/端口的验证命令，均为可执行命令。
- **类型一致性**：`UsageSample`/`Bucket`/`DailyRecord`/`billedOf`/`formatTokens`/`shiftDate`/`dayParts`/`renderDay`/`renderWeek` 在任务间签名一致；`token_usage` 域名与 spec 修正后一致。
