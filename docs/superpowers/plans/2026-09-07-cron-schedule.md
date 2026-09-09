# 定时任务（cron）能力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 dsh-agent-toolkit 增加通用 cron 调度基础设施：定时让主 Agent 或注册表角色在独立新会话中执行提示词任务，UI 面板 + 模型工具双入口管理，保留运行历史。

**Architecture:** 新模块 `packages/toolkit/src/schedule/`（store/timing/executor/scheduler/service/tools/api/index 八文件分层），存储域 `dsh_agent_toolkit_schedule`；执行路径复用 channels 的 `setupAgentScope`/joiner（Task 3/4 先把 Router 角色装配与 AgentsPort 适配器抽成共享模块）；`cron_*` 模型工具经 `agent/created` + 存量 roots 注册进主 Agent scope（own 层，过滤 subagent 与插件自有会话）；浏览器半 `src/client/schedule/` 照 bots 面板骨架（createSidebarEntry + Modal + useLoadState）。

**Tech Stack:** TypeScript / cordis 插件 / zod / croner@^10（零依赖纯 ESM，新增运行时依赖）/ vitest / React 18 + 宿主 ui-primitives。

**Spec:** `docs/superpowers/specs/2026-09-07-cron-schedule-design.md`（已确认，本文所有行为以它为准）

## Global Constraints

- 与宿主 `@deepseek-ai/dsh-schedule` **互斥**：不加载它；`agent/created` 钩子里 `tools.get('schedule_create', scope)` 探测在场则 `ctx.logger.warn` 响亮告警（不物理移除他人工具）。
- 存储域 `dsh_agent_toolkit_schedule`，表 `tasks`/`runs`/`meta`，schema 单一来源 `src/schedule/store.ts`；domain/表名受 UNIT_NAME_RE 约束（`^[a-z][a-z0-9_]*$`，无连字符）。
- 调度规则三选一：`cron`（**仅 5 字段**，秒级/年字段不开放，可选 IANA timeZone，省略 = 进程时区）/ `at`（RFC 3339，一次性）/ `every`（seconds ≥ 60，创建时间为锚）。
- 每任务环形保留最近 `runHistoryLimit` 次运行（默认 20）；删除任务连带清运行历史。
- tick 间隔固定 30s（`ctx.interval`，**不进 Config**——YAGNI）；`runTimeoutMinutes` 默认 60。
- 重叠保护：内存 `Set<runningTaskId>`；同任务上次未结束 → 记 `skipped-overlap` run，不并发执行。
- `inject` 列表**不加新服务**；可选服务（webServer/workspaceRegistry/agentPresets）一律 `ctx.get(name, false)` 惰性读取。
- 工具 `execute` 返回规范 JSON 值、args 只读且已校验；create/update 即校验（cron expr/时区/cwd/roleId），非法直接拒绝不入库。
- toolkit 的 src 可对 `@deepseek-ai/dsh-tools`（defineTool）、`@deepseek-ai/dsh-storage-domain` 等宿主包做**值导入但不进 dependencies**（宿主隐式提供，delegate/tool.ts 先例）；`croner` 是真实新依赖，**必须进 dependencies** 且 Node 半 neverBundle（发版 parity 教训）。
- 浏览器半纯净度门禁：禁 Node 内建模块、禁跨插件值导入（croner 非 `@deepseek-ai/*` 前缀，可被打进 client bundle——cron 预览用）。
- 测试约定：Node 半用 Map 假表 fake KvTable（bots/api.test.ts 套路）；client spec 用 `// @vitest-environment jsdom` + stubFetch（bot-form.client.spec.tsx 套路）。
- 提交粒度：每个 Task 末尾一次 commit；message 用 `feat:` / `refactor:` / `docs:` 前缀（照仓库历史风格）。

---

### Task 1: 存储层 `src/schedule/store.ts`

**Files:**
- Create: `packages/toolkit/src/schedule/store.ts`
- Test: `packages/toolkit/src/schedule/store.test.ts`

**Interfaces:**
- Produces（后续全部任务依赖这些名字与类型）:
  - `CronScheduleSchema` / `CronSchedule`（discriminatedUnion kind: cron/at/every）
  - `CronTargetSchema` / `CronTarget`（kind: main / role+roleId）
  - `CronTaskSchema` / `CronTask`（含 `nextRunAt: string | null`、`createdAt/updatedAt: string` ISO）
  - `CronRunSchema` / `CronRun`（status: `'running' | 'ok' | 'error' | 'skipped-overlap'`）
  - `scheduleDomain`（name `dsh_agent_toolkit_schedule`，version 1，表 tasks/runs/meta）
  - `listRuns(runs: KvTable<string, CronRun>, taskId: string): CronRun[]`（新→旧）
  - `trimRuns(runs, taskId, limit): Promise<void>`（环形裁剪）
  - `deleteRunsOf(runs, taskId): Promise<void>`（连带清历史）

- [ ] **Step 1: 写失败测试** `packages/toolkit/src/schedule/store.test.ts`

照 `src/agents/store.test.ts` 模式（纯 schema/domain 断言 + Map 假表）：

```ts
import { describe, expect, test } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  CronRunSchema, CronScheduleSchema, CronTaskSchema, deleteRunsOf, listRuns, scheduleDomain, trimRuns,
  type CronRun,
} from './store.ts'

const VALID_TASK = {
  id: 't1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' },
  target: { kind: 'main' },
  catchup: true, enabled: true, nextRunAt: '2026-09-08T01:00:00.000Z',
  createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
}

/** Map 假表（bots/api.test.ts 既有套路）。 */
function fakeTable<V>(): KvTable<string, V> & { data: Map<string, V> } {
  const data = new Map<string, V>()
  return {
    data,
    get: (k: string) => data.get(k),
    put: async (k: string, v: V) => { data.set(k, v) },
    delete: async (k: string) => data.delete(k),
    entries: () => data.entries(),
  } as unknown as KvTable<string, V> & { data: Map<string, V> }
}

describe('scheduleDomain', () => {
  test('域名、版本与表布局', () => {
    expect(scheduleDomain.name).toBe('dsh_agent_toolkit_schedule')
    expect(scheduleDomain.version).toBe(1)
    expect(Object.keys(scheduleDomain.tables)).toEqual(['tasks', 'runs', 'meta'])
  })
})

describe('CronScheduleSchema', () => {
  test('三选一判别联合：cron/at/every', () => {
    expect(CronScheduleSchema.safeParse({ kind: 'cron', expr: '0 9 * * *' }).success).toBe(true)
    expect(CronScheduleSchema.safeParse({ kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' }).success).toBe(true)
    expect(CronScheduleSchema.safeParse({ kind: 'at', at: '2026-09-08T01:00:00Z' }).success).toBe(true)
    expect(CronScheduleSchema.safeParse({ kind: 'every', seconds: 3600 }).success).toBe(true)
  })
  test('拒绝：未知 kind / 空 expr / every < 60s / 非整数 seconds', () => {
    expect(CronScheduleSchema.safeParse({ kind: 'weekly' }).success).toBe(false)
    expect(CronScheduleSchema.safeParse({ kind: 'cron', expr: '' }).success).toBe(false)
    expect(CronScheduleSchema.safeParse({ kind: 'every', seconds: 59 }).success).toBe(false)
    expect(CronScheduleSchema.safeParse({ kind: 'every', seconds: 60 }).success).toBe(true)
    expect(CronScheduleSchema.safeParse({ kind: 'every', seconds: 90.5 }).success).toBe(false)
  })
})

describe('CronTaskSchema', () => {
  test('接受完整合法记录（三种 schedule × 两种 target）', () => {
    expect(CronTaskSchema.safeParse(VALID_TASK).success).toBe(true)
    expect(CronTaskSchema.safeParse({ ...VALID_TASK, schedule: { kind: 'at', at: '2026-09-08T01:00:00Z' } }).success).toBe(true)
    expect(CronTaskSchema.safeParse({ ...VALID_TASK, target: { kind: 'role', roleId: 'explorer' } }).success).toBe(true)
  })
  test('nextRunAt 可空；拒绝空 name/prompt/cwd', () => {
    expect(CronTaskSchema.safeParse({ ...VALID_TASK, nextRunAt: null }).success).toBe(true)
    expect(CronTaskSchema.safeParse({ ...VALID_TASK, name: '' }).success).toBe(false)
    expect(CronTaskSchema.safeParse({ ...VALID_TASK, prompt: '' }).success).toBe(false)
    expect(CronTaskSchema.safeParse({ ...VALID_TASK, cwd: '' }).success).toBe(false)
  })
})

describe('CronRunSchema', () => {
  test('status 四值枚举；finishedAt/sessionId/error 可选', () => {
    const base = { id: 'r1', taskId: 't1', triggeredAt: '2026-09-07T01:00:00.000Z' }
    for (const status of ['running', 'ok', 'error', 'skipped-overlap']) {
      expect(CronRunSchema.safeParse({ ...base, status }).success).toBe(true)
    }
    expect(CronRunSchema.safeParse({ ...base, status: 'cancelled' }).success).toBe(false)
  })
})

describe('runs 助手', () => {
  const run = (id: string, triggeredAt: string): CronRun => ({ id, taskId: 't1', triggeredAt, status: 'ok' })

  test('listRuns 新→旧排序且只含本任务', async () => {
    const runs = fakeTable<CronRun>()
    await runs.put('r1', run('r1', '2026-09-07T01:00:00.000Z'))
    await runs.put('r2', run('r2', '2026-09-07T02:00:00.000Z'))
    await runs.put('r3', { ...run('r3', '2026-09-07T03:00:00.000Z'), taskId: 'other' })
    expect(listRuns(runs, 't1').map((r) => r.id)).toEqual(['r2', 'r1'])
  })

  test('trimRuns 环形保留最近 N 条，删最旧', async () => {
    const runs = fakeTable<CronRun>()
    for (let i = 1; i <= 5; i++) await runs.put(`r${i}`, run(`r${i}`, `2026-09-07T0${i}:00:00.000Z`))
    await trimRuns(runs, 't1', 2)
    expect([...runs.data.keys()].sort()).toEqual(['r4', 'r5'])
  })

  test('deleteRunsOf 只清本任务历史', async () => {
    const runs = fakeTable<CronRun>()
    await runs.put('r1', run('r1', '2026-09-07T01:00:00.000Z'))
    await runs.put('r2', { ...run('r2', '2026-09-07T02:00:00.000Z'), taskId: 'other' })
    await deleteRunsOf(runs, 't1')
    expect([...runs.data.keys()]).toEqual(['r2'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/store.test.ts`
Expected: FAIL（`./store.ts` 不存在）

- [ ] **Step 3: 实现** `packages/toolkit/src/schedule/store.ts`

```ts
/** schedule 模块存储域声明：CronTask/CronRun 记录 schema + domain 布局的单一来源。 */
import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'

/** 调度规则三选一：cron（5 字段，可选 IANA 时区，省略 = 进程时区）/ at（RFC 3339 一次性）/ every（≥60s，创建时间为锚）。 */
export const CronScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), expr: z.string().min(1), timeZone: z.string().min(1).optional() }),
  z.object({ kind: z.literal('at'), at: z.string().min(1) }),
  z.object({ kind: z.literal('every'), seconds: z.number().int().min(60) }),
])
export type CronSchedule = z.infer<typeof CronScheduleSchema>

/** 执行目标：主 Agent（宿主默认模型，无 persona/restrict）或注册表角色（persona/model/工具白名单随角色）。 */
export const CronTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main') }),
  z.object({ kind: z.literal('role'), roleId: z.string().min(1) }),
])
export type CronTarget = z.infer<typeof CronTargetSchema>

export const CronTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  prompt: z.string().min(1).max(8000),
  cwd: z.string().min(1),
  schedule: CronScheduleSchema,
  target: CronTargetSchema,
  catchup: z.boolean(),
  enabled: z.boolean(),
  /** 调度器维护的持久缓存（重启 rearm 依据），UTC ISO 串。 */
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type CronTask = z.infer<typeof CronTaskSchema>

export const CronRunSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  triggeredAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(['running', 'ok', 'error', 'skipped-overlap']),
  /** 本次执行新建的会话 id（skipped-overlap 无会话）。 */
  sessionId: z.string().optional(),
  /** 错误摘要（截断）。 */
  error: z.string().optional(),
})
export type CronRun = z.infer<typeof CronRunSchema>

/** domain 名/表名受 UNIT_NAME_RE 约束（^[a-z][a-z0-9_]*$），不允许连字符。 */
export const scheduleDomain = defineDomain({
  name: 'dsh_agent_toolkit_schedule',
  version: 1,
  tables: {
    tasks: domainTable<string, CronTask>(CronTaskSchema),
    runs: domainTable<string, CronRun>(CronRunSchema),
    // 一次性标记位（沿用 agents store 的 meta 模式；当前无标记消费者，保留表位）。
    meta: domainTable<string, { value: string }>(z.object({ value: z.string() })),
  },
})

/** 某任务的 run 列表（新 → 旧；同刻按 id 倒序稳定化）。 */
export function listRuns(runs: KvTable<string, CronRun>, taskId: string): CronRun[] {
  return [...runs.entries()]
    .map(([, run]) => run)
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt) || b.id.localeCompare(a.id))
}

/** 环形保留某任务最近 limit 条 run，超出删最旧。 */
export async function trimRuns(runs: KvTable<string, CronRun>, taskId: string, limit: number): Promise<void> {
  const mine = listRuns(runs, taskId)
  for (const run of mine.slice(limit)) await runs.delete(run.id)
}

/** 删除任务连带清运行历史。 */
export async function deleteRunsOf(runs: KvTable<string, CronRun>, taskId: string): Promise<void> {
  for (const run of listRuns(runs, taskId)) await runs.delete(run.id)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/store.test.ts`
Expected: PASS（全部测试绿）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/schedule/store.ts packages/toolkit/src/schedule/store.test.ts
git commit -m "feat: cron schedule store domain (tasks/runs/meta + ring trim)"
```

---

### Task 2: 时间运算 `src/schedule/timing.ts` + croner 依赖

**Files:**
- Create: `packages/toolkit/src/schedule/timing.ts`
- Modify: `packages/toolkit/package.json`（dependencies 加 croner）
- Modify: `packages/toolkit/tsdown.config.ts:24`（neverBundle 加 'croner'）
- Test: `packages/toolkit/src/schedule/timing.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CronSchedule` / `CronTask`
- Produces:
  - `validateSchedule(schedule: CronSchedule, nowMs: number): string | undefined`（非法返回中文错误消息）
  - `nextOccurrence(schedule: CronSchedule, createdAtMs: number, nowMs: number): number | null`
  - `previewOccurrences(schedule: CronSchedule, count: number, createdAtMs: number, nowMs: number): number[]`
  - `rearmTask(task: CronTask, nowMs: number): CronTask`（启动 rearm；无变化返回原引用）
  - `recomputeTask(task: CronTask, nowMs: number): CronTask`（创建/更新 fresh 重算）
  - `advanceAfterTrigger(task: CronTask, nowMs: number): CronTask`（触发/跳过后推进；at 作废）

- [ ] **Step 1: 加依赖**

`packages/toolkit/package.json` dependencies 加一行（字典序，放在 `clsx` 后）：

```json
    "croner": "^10.0.1",
```

`packages/toolkit/tsdown.config.ts` nodeConfig 的 neverBundle 改为：

```ts
    neverBundle: [/^@deepseek-ai\//, '@dsh-agent-toolkit/token-usage', '@larksuiteoapi/node-sdk', 'clsx', 'zod', 'croner'],
```

Run: `pnpm install`（workspace 根）

- [ ] **Step 2: 写失败测试** `packages/toolkit/src/schedule/timing.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import {
  advanceAfterTrigger, nextOccurrence, previewOccurrences, rearmTask, recomputeTask, validateSchedule,
} from './timing.ts'
import type { CronTask } from './store.ts'

// 固定时钟：2026-09-07T00:00:00.000Z（周一）
const NOW = Date.parse('2026-09-07T00:00:00.000Z')
const CREATED = Date.parse('2026-09-07T00:00:00.000Z')

const task = (over: Partial<CronTask>): CronTask => ({
  id: 't1', name: 'n', prompt: 'p', cwd: 'D:\\work',
  schedule: { kind: 'every', seconds: 3600 },
  target: { kind: 'main' }, catchup: false, enabled: true,
  nextRunAt: null, createdAt: new Date(CREATED).toISOString(), updatedAt: new Date(CREATED).toISOString(),
  ...over,
})

describe('validateSchedule', () => {
  test('合法 cron（5 字段）/ at（未来 RFC 3339）/ every 返回 undefined', () => {
    expect(validateSchedule({ kind: 'cron', expr: '0 9 * * *' }, NOW)).toBeUndefined()
    expect(validateSchedule({ kind: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' }, NOW)).toBeUndefined()
    expect(validateSchedule({ kind: 'at', at: '2026-09-08T00:00:00Z' }, NOW)).toBeUndefined()
    expect(validateSchedule({ kind: 'every', seconds: 60 }, NOW)).toBeUndefined()
  })
  test('拒绝 6/7 字段（秒级/年字段首期不开放）', () => {
    expect(validateSchedule({ kind: 'cron', expr: '0 0 9 * * *' }, NOW)).toMatch(/5 字段/)
    expect(validateSchedule({ kind: 'cron', expr: '0 0 9 * * * 2026' }, NOW)).toMatch(/5 字段/)
  })
  test('拒绝非法 cron 表达式 / 未知时区 / 非法 at / 过去的 at', () => {
    expect(validateSchedule({ kind: 'cron', expr: '99 9 * * *' }, NOW)).toMatch(/非法 cron 表达式/)
    expect(validateSchedule({ kind: 'cron', expr: '0 9 * * *', timeZone: 'Mars/Olympus' }, NOW)).toMatch(/未知时区/)
    expect(validateSchedule({ kind: 'at', at: 'not-a-date' }, NOW)).toMatch(/非法 at 时间/)
    expect(validateSchedule({ kind: 'at', at: '2026-09-06T00:00:00Z' }, NOW)).toMatch(/未来/)
  })
})

describe('nextOccurrence', () => {
  test('cron：now 之后下一 occurrence（显式 UTC）', () => {
    const next = nextOccurrence({ kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' }, CREATED, NOW)
    expect(next).toBe(Date.parse('2026-09-07T09:00:00.000Z'))
  })
  test('cron 带时区：Asia/Shanghai 09:00 = UTC 01:00', () => {
    const next = nextOccurrence({ kind: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' }, CREATED, NOW)
    expect(next).toBe(Date.parse('2026-09-07T01:00:00.000Z'))
  })
  test('at：未来返回触发点，过期返回 null', () => {
    expect(nextOccurrence({ kind: 'at', at: '2026-09-08T00:00:00Z' }, CREATED, NOW)).toBe(Date.parse('2026-09-08T00:00:00.000Z'))
    expect(nextOccurrence({ kind: 'at', at: '2026-09-06T00:00:00Z' }, CREATED, NOW)).toBeNull()
  })
  test('every：创建锚点对齐推进，跳过中间错过的（不枚举积压）', () => {
    // 锚 00:00，间隔 1h；now = 10:30 → 下一触发 11:00
    const later = Date.parse('2026-09-07T10:30:00.000Z')
    expect(nextOccurrence({ kind: 'every', seconds: 3600 }, CREATED, later)).toBe(Date.parse('2026-09-07T11:00:00.000Z'))
  })
})

describe('previewOccurrences', () => {
  test('cron 预览未来 3 次；at 只给 1 次（未来时）', () => {
    const prevs = previewOccurrences({ kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' }, 3, CREATED, NOW)
    expect(prevs).toEqual([
      Date.parse('2026-09-07T09:00:00.000Z'),
      Date.parse('2026-09-08T09:00:00.000Z'),
      Date.parse('2026-09-09T09:00:00.000Z'),
    ])
    expect(previewOccurrences({ kind: 'at', at: '2026-09-08T00:00:00Z' }, 3, CREATED, NOW)).toHaveLength(1)
    expect(previewOccurrences({ kind: 'at', at: '2026-09-06T00:00:00Z' }, 3, CREATED, NOW)).toHaveLength(0)
  })
})

describe('rearmTask（启动 rearm）', () => {
  test('nextRunAt 仍在未来 → 原样保持（返回原引用）', () => {
    const t = task({ nextRunAt: '2026-09-08T00:00:00.000Z' })
    expect(rearmTask(t, NOW)).toBe(t)
  })
  test('已过期且 catchup=true → 设为立即', () => {
    const t = task({ catchup: true, nextRunAt: '2026-09-06T00:00:00.000Z' })
    const rearmed = rearmTask(t, NOW)
    expect(rearmed.nextRunAt).toBe(new Date(NOW).toISOString())
    expect(rearmed.enabled).toBe(true)
  })
  test('已过期且 catchup=false → 下一未来触发点；at 无未来触发点 → 作废', () => {
    const cronT = task({ schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' }, nextRunAt: '2026-09-06T09:00:00.000Z' })
    expect(rearmTask(cronT, NOW).nextRunAt).toBe('2026-09-07T09:00:00.000Z')
    const atT = task({ schedule: { kind: 'at', at: '2026-09-06T00:00:00Z' }, nextRunAt: '2026-09-06T00:00:00.000Z' })
    const rearmed = rearmTask(atT, NOW)
    expect(rearmed.enabled).toBe(false)
    expect(rearmed.nextRunAt).toBeNull()
  })
  test('disabled → nextRunAt 归 null（已 null 返回原引用）', () => {
    const t = task({ enabled: false, nextRunAt: '2026-09-08T00:00:00.000Z' })
    expect(rearmTask(t, NOW).nextRunAt).toBeNull()
    const already = task({ enabled: false, nextRunAt: null })
    expect(rearmTask(already, NOW)).toBe(already)
  })
})

describe('recomputeTask / advanceAfterTrigger', () => {
  test('recomputeTask：enabled 重算 nextRunAt；disabled 归 null', () => {
    const t = task({ schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' } })
    expect(recomputeTask(t, NOW).nextRunAt).toBe('2026-09-07T09:00:00.000Z')
    expect(recomputeTask(task({ enabled: false }), NOW).nextRunAt).toBeNull()
  })
  test('advanceAfterTrigger：cron/every 推进到下一触发点；at 一次性作废', () => {
    const cronT = task({ schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' }, nextRunAt: '2026-09-07T09:00:00.000Z' })
    expect(advanceAfterTrigger(cronT, Date.parse('2026-09-07T09:00:05.000Z')).nextRunAt).toBe('2026-09-08T09:00:00.000Z')
    const atT = task({ schedule: { kind: 'at', at: '2026-09-08T00:00:00Z' }, nextRunAt: '2026-09-08T00:00:00.000Z' })
    const advanced = advanceAfterTrigger(atT, Date.parse('2026-09-08T00:00:01.000Z'))
    expect(advanced.enabled).toBe(false)
    expect(advanced.nextRunAt).toBeNull()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/timing.test.ts`
Expected: FAIL（`./timing.ts` 不存在）

- [ ] **Step 4: 实现** `packages/toolkit/src/schedule/timing.ts`

```ts
/** cron/at/every 纯时间运算：校验、下一触发点、预览、启动 rearm。全部注入 now，无隐藏时钟。 */
import { Cron } from 'croner'
import type { CronSchedule, CronTask } from './store.ts'

/** croner 选项：paused 仅做解析与预测，不注册真实定时器（计时由调度器 tick 驱动）。 */
function cronerOptions(schedule: Extract<CronSchedule, { kind: 'cron' }>): { paused: true; timezone?: string } {
  return { paused: true, ...(schedule.timeZone !== undefined ? { timezone: schedule.timeZone } : {}) }
}

/** 创建/更新即校验；合法返回 undefined，非法返回错误消息（不入库由调用方保证）。 */
export function validateSchedule(schedule: CronSchedule, nowMs: number): string | undefined {
  switch (schedule.kind) {
    case 'cron': {
      const fields = schedule.expr.trim().split(/\s+/)
      if (fields.length !== 5) return `cron 表达式须为 5 字段（分 时 日 月 周），收到 ${fields.length} 字段；秒级/年字段暂不开放`
      if (schedule.timeZone !== undefined) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone })
        } catch {
          return `未知时区：${schedule.timeZone}`
        }
      }
      try {
        new Cron(schedule.expr, cronerOptions(schedule))
      } catch (error) {
        return `非法 cron 表达式 "${schedule.expr}"：${error instanceof Error ? error.message : String(error)}`
      }
      return undefined
    }
    case 'at': {
      const t = Date.parse(schedule.at)
      if (Number.isNaN(t)) return `非法 at 时间（须 RFC 3339）：${schedule.at}`
      if (t <= nowMs) return `at 时间须在未来：${schedule.at}`
      return undefined
    }
    case 'every':
      return undefined // seconds ≥ 60 整数由 schema 保证
  }
}

/** 下一触发点（epoch ms）；无未来触发点（at 过期等）返回 null。 */
export function nextOccurrence(schedule: CronSchedule, createdAtMs: number, nowMs: number): number | null {
  switch (schedule.kind) {
    case 'cron': {
      const next = new Cron(schedule.expr, cronerOptions(schedule)).nextRun(new Date(nowMs))
      return next === null ? null : next.getTime()
    }
    case 'at': {
      const t = Date.parse(schedule.at)
      return t > nowMs ? t : null
    }
    case 'every': {
      const intervalMs = schedule.seconds * 1000
      if (nowMs < createdAtMs) return createdAtMs
      // 创建锚点对齐的下一间隔：跳过中间错过的，不枚举积压。
      const k = Math.floor((nowMs - createdAtMs) / intervalMs) + 1
      return createdAtMs + k * intervalMs
    }
  }
}

/** 「未来 count 次触发」预览（epoch ms 数组，长度 ≤ count；供 UI 表单与调试）。 */
export function previewOccurrences(schedule: CronSchedule, count: number, createdAtMs: number, nowMs: number): number[] {
  const out: number[] = []
  let cursor = nowMs
  for (let i = 0; i < count; i++) {
    const next = nextOccurrence(schedule, createdAtMs, cursor)
    if (next === null) break
    out.push(next)
    cursor = next + 1
  }
  return out
}

/**
 * 启动 rearm：对一条持久化任务重算 enabled/nextRunAt（无变化返回原引用，调用方按引用决定是否写回）。
 * - nextRunAt 仍在未来 → 保持；
 * - 已过期且 catchup → 设为「立即」（首个 tick 补跑一次）；
 * - 已过期且不 catchup → 下一未来触发点；没有（at 一次性）→ enabled=false、nextRunAt=null（过期即作废）。
 */
export function rearmTask(task: CronTask, nowMs: number): CronTask {
  if (!task.enabled) return task.nextRunAt === null ? task : { ...task, nextRunAt: null }
  const persisted = task.nextRunAt === null ? null : Date.parse(task.nextRunAt)
  if (persisted !== null && persisted > nowMs) return task
  if (persisted !== null && task.catchup) return { ...task, nextRunAt: new Date(nowMs).toISOString() }
  const next = nextOccurrence(task.schedule, Date.parse(task.createdAt), nowMs)
  return next === null
    ? { ...task, enabled: false, nextRunAt: null }
    : { ...task, nextRunAt: new Date(next).toISOString() }
}

/** 创建/更新后的 fresh 重算（catchup 是停机补跑语义，不适用于编辑路径）。 */
export function recomputeTask(task: CronTask, nowMs: number): CronTask {
  if (!task.enabled) return { ...task, nextRunAt: null }
  const next = nextOccurrence(task.schedule, Date.parse(task.createdAt), nowMs)
  return next === null
    ? { ...task, enabled: false, nextRunAt: null }
    : { ...task, nextRunAt: new Date(next).toISOString() }
}

/** 触发/跳过后推进：cron/every 取 now 之后下一触发点；at 一次性作废。 */
export function advanceAfterTrigger(task: CronTask, nowMs: number): CronTask {
  if (task.schedule.kind === 'at') return { ...task, enabled: false, nextRunAt: null }
  const next = nextOccurrence(task.schedule, Date.parse(task.createdAt), nowMs)
  return next === null
    ? { ...task, enabled: false, nextRunAt: null }
    : { ...task, nextRunAt: new Date(next).toISOString() }
}
```

- [ ] **Step 5: 跑测试确认通过 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/timing.test.ts`
Expected: PASS
Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/schedule/timing.ts packages/toolkit/src/schedule/timing.test.ts packages/toolkit/package.json packages/toolkit/tsdown.config.ts pnpm-lock.yaml
git commit -m "feat: cron timing math (validate/next/preview/rearm) with croner"
```

---


### Task 3: 抽取角色装配共享模块 `src/channels/role-assembly.ts`（重构）

**Files:**
- Create: `packages/toolkit/src/channels/role-assembly.ts`
- Create: `packages/toolkit/src/channels/role-assembly.test.ts`
- Modify: `packages/toolkit/src/channels/router.ts:84-93`（resolveSession 角色分支改用共享函数）

**Interfaces:**
- Consumes: `AgentRecord`（agents/store.ts）、`AgentHooks` / `DefaultModelAccessor`（channels/ports.ts）
- Produces（Task 5 executor 与 Router 共同消费）:
  - `ROLE_PERSONA_SECTION = 'dsh-agent-toolkit:agent:persona'`
  - `roleHooks(role: AgentRecord): AgentHooks`（persona 单 section order 0，空 persona 省略；tools 白名单有则带上）
  - `roleAgentOptions(role: AgentRecord, defaultModel: DefaultModelAccessor): { provider?: string; model?: string }`

**注意：** 纯重构，`roleHooks` 产出必须与 router.ts 现有角色分支逐字段一致（sections name/order/text 与 tools），否则 router.test.ts 会红。

- [ ] **Step 1: 写失败测试** `packages/toolkit/src/channels/role-assembly.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import { ROLE_PERSONA_SECTION, roleAgentOptions, roleHooks } from './role-assembly.ts'
import type { AgentRecord } from '../agents/store.ts'

const role = (over: Partial<AgentRecord>): AgentRecord => ({ id: 'explorer', name: 'Explorer', ...over })

describe('roleHooks', () => {
  test('persona 单 section（order 0，固定段名）+ tools 白名单', () => {
    expect(roleHooks(role({ persona: '你是探索员。', tools: { allow: ['read'] } }))).toEqual({
      sections: [{ name: ROLE_PERSONA_SECTION, order: 0, text: '你是探索员。' }],
      tools: ['read'],
    })
    expect(ROLE_PERSONA_SECTION).toBe('dsh-agent-toolkit:agent:persona')
  })
  test('空/纯空白 persona 省略 sections；无 tools 省略 tools', () => {
    expect(roleHooks(role({}))).toEqual({})
    expect(roleHooks(role({ persona: '   ' }))).toEqual({})
  })
})

describe('roleAgentOptions', () => {
  test('角色自配模型优先；缺省回退宿主默认模型', () => {
    const fallback = () => ({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(roleAgentOptions(role({ model: { provider: 'anthropic', model: 'claude-sonnet-4' } }), fallback))
      .toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(roleAgentOptions(role({}), fallback)).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/role-assembly.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/toolkit/src/channels/role-assembly.ts`

```ts
/** 角色形态会话装配（Router bot 会话与 schedule 执行器共用）：persona 单 section + tools 白名单 + 模型解析。 */
import type { AgentRecord } from '../agents/store.ts'
import type { AgentHooks, DefaultModelAccessor } from './ports.ts'

/** 角色 persona 的 scoped 段名（与 Router 既有产出一致，逐字段不可改）。 */
export const ROLE_PERSONA_SECTION = 'dsh-agent-toolkit:agent:persona'

/** 角色形态创作期注入：persona 非空 → 单 section（order 0）；tools 白名单存在 → 带上（由 setupAgentScope restrict）。 */
export function roleHooks(role: AgentRecord): AgentHooks {
  const sections = role.persona === undefined || role.persona.trim().length === 0
    ? []
    : [{ name: ROLE_PERSONA_SECTION, order: 0, text: role.persona }]
  return {
    ...(sections.length > 0 ? { sections } : {}),
    ...(role.tools !== undefined ? { tools: role.tools.allow } : {}),
  }
}

/** 角色模型：自配优先，缺省回退宿主默认模型（与 Router 语义一致）。 */
export function roleAgentOptions(
  role: AgentRecord,
  defaultModel: DefaultModelAccessor,
): { provider?: string; model?: string } {
  return role.model ?? defaultModel()
}
```

- [ ] **Step 4: router.ts 改用共享函数**

`packages/toolkit/src/channels/router.ts`：
- 顶部 import 加：`import { roleAgentOptions, roleHooks } from './role-assembly.ts'`
- `resolveSession` 的角色分支（现 84-93 行，`const sections = ...` 拼装块 + return）替换为：

```ts
    return {
      agentOptions: roleAgentOptions(role, this.defaultModel),
      hooks: this.withSenderSection(roleHooks(role), bot, userId),
    }
```

（main 分支与 sender 逻辑不动。）

- [ ] **Step 5: 跑 channels 全部测试确认零回归**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/`
Expected: PASS（router.test.ts 等既有测试全绿 + 新测试绿）

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/channels/role-assembly.ts packages/toolkit/src/channels/role-assembly.test.ts packages/toolkit/src/channels/router.ts
git commit -m "refactor: extract role session assembly shared by router and schedule executor"
```

---

### Task 4: 抽取 AgentsPort 共享工厂 `src/channels/agents-port.ts`（重构）

**Files:**
- Create: `packages/toolkit/src/channels/agents-port.ts`
- Modify: `packages/toolkit/src/bots/index.ts`（79-107 行 agentsPort/adaptAgent 块改用工厂；`BotsDeps` 加 `ownedSessions?`）
- Modify: `packages/toolkit/src/index.ts`（apply 建 `ownedSessions` 并传给 setupBots——setupSchedule 在 Task 10 才接入）

**Interfaces:**
- Consumes: `ScopeJoiner`（channels/scope-joiner.ts）、`setupAgentScope`（channels/agent-setup.ts）、`AgentsPort`/`AgentPort`（channels/ports.ts）
- Produces:
  - `createAgentsPort(ctx: Context, joiner: ScopeJoiner, ownedSessions?: Set<string>): AgentsPort`——`create`/`resume` 时把 sessionId 记入 `ownedSessions`（cron 工具注册门控排除插件自有会话用）
  - `BotsDeps.ownedSessions?: Set<string>`（新增可选字段）

**注意：** 纯重构。适配逻辑（SessionId 包装、meta.cwd、agentOptions 条件展开、cancel({kind:'user'})）必须与 bots/index.ts 现 79-107 行逐行等价。

- [ ] **Step 1: 实现工厂** `packages/toolkit/src/channels/agents-port.ts`

```ts
/** AgentsPort 真实适配器工厂（bots Router 与 schedule 执行器共用）：create/resume 经 setupAgentScope 装配，
 *  sessionId 记入 ownedSessions（插件自有会话集合，cron_* 工具注册门控据此排除 bot/schedule 会话）。 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { setupAgentScope } from './agent-setup.ts'
import type { AgentPort, AgentsPort } from './ports.ts'
import type { ScopeJoiner } from './scope-joiner.ts'

export function createAgentsPort(ctx: Context, joiner: ScopeJoiner, ownedSessions?: Set<string>): AgentsPort {
  function adaptAgent(handle: AgentHandle): AgentPort {
    const { agent } = handle
    return {
      sessionId: String(agent.id),
      followup: (message) => agent.followup(message as Parameters<typeof agent.followup>[0]),
      cancel: () => agent.cancel({ kind: 'user' }),
      whenIdle: () => agent.whenIdle(),
    }
  }
  return {
    async create(input) {
      ownedSessions?.add(input.sessionId)
      const handle: AgentHandle = await ctx.agents.create({
        sessionId: SessionId(input.sessionId),
        meta: { cwd: input.cwd },
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        setup: (agentCtx) => setupAgentScope(agentCtx, input.hooks, joiner),
      })
      return adaptAgent(handle)
    },
    async resume(input) {
      ownedSessions?.add(input.sessionId)
      const handle: AgentHandle = await ctx.agents.resume({
        resumeSessionId: SessionId(input.sessionId),
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        setup: (agentCtx) => setupAgentScope(agentCtx, input.hooks, joiner),
      })
      return adaptAgent(handle)
    },
  }
}
```

- [ ] **Step 2: bots/index.ts 改用工厂**

`packages/toolkit/src/bots/index.ts`：
- `BotsDeps` 接口加字段：

```ts
export interface BotsDeps {
  registry: AgentRegistry
  /** bot 会话挂载的 preset id（agentTeamPreset 开启时下达；undefined = 直接 toolsScope）。 */
  botPresetId?: string
  /** 插件自有会话 id 集（cron_* 工具门控排除用；缺省不记录）。 */
  ownedSessions?: Set<string>
}
```

- 删除现 79-107 行的 `agentsPort` 与 `adaptAgent` 定义，替换为：

```ts
  const agentsPort = createAgentsPort(ctx, scopeJoiner, deps.ownedSessions)
```

- 顶部 import 调整：加 `import { createAgentsPort } from '../channels/agents-port.ts'`；移除不再直接使用的 `SessionId`、`AgentHandle`、`setupAgentScope`、`AgentPort` 导入（以 typecheck 为准，未使用的逐个删）。

- [ ] **Step 3: 根 index.ts 建 ownedSessions 并传给 setupBots**

`packages/toolkit/src/index.ts` apply 末尾区域：
- `if (config.modules.feishu) setupBots(...)` 一行前加：

```ts
  const ownedSessions = new Set<string>()
```

- setupBots 调用改为：

```ts
  if (config.modules.feishu) setupBots(ctx, config.feishu, { registry, botPresetId: config.agentTeamPreset.enabled ? config.agentTeamPreset.botsId : undefined, ownedSessions })
```

- [ ] **Step 4: 类型检查 + bots/channels 全部测试零回归**

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 无错误
Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/bots/ src/channels/`
Expected: PASS（既有测试全绿）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/agents-port.ts packages/toolkit/src/bots/index.ts packages/toolkit/src/index.ts
git commit -m "refactor: extract shared AgentsPort factory with owned-session tracking"
```

---

### Task 5: 执行器 `src/schedule/executor.ts`

**Files:**
- Create: `packages/toolkit/src/schedule/executor.ts`
- Test: `packages/toolkit/src/schedule/executor.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `roleHooks`/`roleAgentOptions`；`AgentsPort`/`WorkspacePort`/`DefaultModelAccessor`/`AgentHooks`/`AgentSection`（channels/ports.ts）；Task 1 的 `CronTask`/`CronRun`/`trimRuns`；`AgentRegistry`（agents/registry.ts）
- Produces:
  - `TASK_SECTION_NAME = 'dsh-agent-toolkit:schedule:task'`（order 20 来源段）
  - `taskSectionText(task: CronTask, triggeredAt: string): string`
  - `ExecutorDeps` / `Executor` / `createExecutor(deps: ExecutorDeps): Executor`——`trigger(task): Promise<CronRun>` 永不抛错，结果体现在 run 记录

- [ ] **Step 1: 写失败测试** `packages/toolkit/src/schedule/executor.test.ts`

fake AgentsPort（照 channels 测试套路：结构化端口 fake 注入）：

```ts
import { describe, expect, test, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { createExecutor, TASK_SECTION_NAME, taskSectionText, type ExecutorDeps } from './executor.ts'
import type { AgentHooks, AgentPort, AgentsPort } from '../channels/ports.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import type { CronRun, CronTask } from './store.ts'

const NOW = Date.parse('2026-09-07T00:00:00.000Z')

const task = (over: Partial<CronTask>): CronTask => ({
  id: 't1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *' },
  target: { kind: 'main' }, catchup: false, enabled: true,
  nextRunAt: null, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
  ...over,
})

interface CreateCall { sessionId: string; cwd: string; agentOptions?: { provider?: string; model?: string }; hooks: AgentHooks }

function fakeTable<V>(): KvTable<string, V> & { data: Map<string, V> } {
  const data = new Map<string, V>()
  return {
    data,
    get: (k: string) => data.get(k),
    put: async (k: string, v: V) => { data.set(k, v) },
    delete: async (k: string) => data.delete(k),
    entries: () => data.entries(),
  } as unknown as KvTable<string, V> & { data: Map<string, V> }
}

const EMPTY_REGISTRY: AgentRegistry = {
  list: () => [], get: () => undefined,
  upsert: async () => undefined, remove: async () => undefined, subscribe: () => () => undefined,
}

function makeDeps(over: {
  agent?: Partial<AgentPort>
  createImpl?: AgentsPort['create']
  registry?: AgentRegistry
  attachError?: Error
  delay?: (ms: number) => Promise<void>
} = {}) {
  const calls: CreateCall[] = []
  const runs = fakeTable<CronRun>()
  const agent: AgentPort = {
    sessionId: 'sess-1',
    followup: vi.fn(),
    cancel: vi.fn(),
    whenIdle: () => Promise.resolve(),
    ...over.agent,
  }
  const deps: ExecutorDeps = {
    agents: {
      create: over.createImpl ?? (async (input) => { calls.push(input); return agent }),
      resume: async () => { throw new Error('not used') },
    },
    registry: over.registry ?? EMPTY_REGISTRY,
    defaultModel: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    workspace: { attach: async () => { if (over.attachError !== undefined) throw over.attachError } },
    runs,
    runHistoryLimit: 20,
    runTimeoutMs: 60_000,
    warn: vi.fn(),
    now: () => NOW,
    newSessionId: () => 'sess-1',
    newRunId: () => 'run-1',
    delay: over.delay ?? (() => new Promise(() => undefined)), // 默认超时永不触发
  }
  return { deps, calls, runs, agent }
}

describe('taskSectionText', () => {
  test('来源段文本（任务名 + id + 触发时间）', () => {
    expect(taskSectionText(task({}), '2026-09-07T01:00:00.000Z'))
      .toBe('本会话由定时任务「日报」（id: t1）于 2026-09-07T01:00:00.000Z 触发。')
    expect(TASK_SECTION_NAME).toBe('dsh-agent-toolkit:schedule:task')
  })
})

describe('executor.trigger', () => {
  test('main 形态：宿主默认模型 + 仅来源段；followup(prompt) → whenIdle → ok', async () => {
    const { deps, calls, runs, agent } = makeDeps()
    const run = await createExecutor(deps).trigger(task({}))
    expect(calls).toHaveLength(1)
    expect(calls[0].agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(calls[0].hooks).toEqual({
      sections: [{ name: TASK_SECTION_NAME, order: 20, text: taskSectionText(task({}), new Date(NOW).toISOString()) }],
    })
    expect(agent.followup).toHaveBeenCalledWith('写日报')
    expect(run.status).toBe('ok')
    expect(run.sessionId).toBe('sess-1')
    expect(run.finishedAt).toBeDefined()
    expect(runs.data.get('run-1')?.status).toBe('ok')
  })

  test('role 形态：role.model + persona section（order 0）+ tools 白名单 + 来源段追加在尾', async () => {
    const registry: AgentRegistry = {
      ...EMPTY_REGISTRY,
      get: (id) => id === 'explorer'
        ? { id: 'explorer', name: 'Explorer', persona: '你是探索员。', model: { provider: 'anthropic', model: 'claude-sonnet-4' }, tools: { allow: ['read'] } }
        : undefined,
    }
    const { deps, calls } = makeDeps({ registry })
    await createExecutor(deps).trigger(task({ target: { kind: 'role', roleId: 'explorer' } }))
    expect(calls[0].agentOptions).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' })
    expect(calls[0].hooks.tools).toEqual(['read'])
    expect(calls[0].hooks.sections?.map((s) => s.name)).toEqual(['dsh-agent-toolkit:agent:persona', TASK_SECTION_NAME])
  })

  test('role 缺失：降级 main 形态并 warn（同 Router 语义）', async () => {
    const { deps, calls } = makeDeps()
    await createExecutor(deps).trigger(task({ target: { kind: 'role', roleId: 'ghost' } }))
    expect(calls[0].agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(calls[0].hooks.sections).toHaveLength(1)
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('ghost'))
  })

  test('agents.create 抛错 → run 记 error（不建会话不驱动）', async () => {
    const { deps, runs, agent } = makeDeps({ createImpl: async () => { throw new Error('boom') } })
    const run = await createExecutor(deps).trigger(task({}))
    expect(run.status).toBe('error')
    expect(run.error).toBe('boom')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(runs.data.get('run-1')?.status).toBe('error')
  })

  test('whenIdle 拒绝 → run 记 error（摘要截断 500 字符）', async () => {
    const long = 'x'.repeat(600)
    const { deps } = makeDeps({ agent: { whenIdle: () => Promise.reject(new Error(long)) } })
    const run = await createExecutor(deps).trigger(task({}))
    expect(run.status).toBe('error')
    expect(run.error).toHaveLength(500)
  })

  test('超时 → cancel + run 记 error(timeout)', async () => {
    const { deps, agent } = makeDeps({
      agent: { whenIdle: () => new Promise(() => undefined) }, // 永不空闲
      delay: () => Promise.resolve(), // 立即超时
    })
    const run = await createExecutor(deps).trigger(task({}))
    expect(agent.cancel).toHaveBeenCalled()
    expect(run.status).toBe('error')
    expect(run.error).toMatch(/timeout/)
  })

  test('workspace.attach 失败仅 warn（会话降级未分组），执行照常 ok', async () => {
    const { deps } = makeDeps({ attachError: new Error('no workspace') })
    const run = await createExecutor(deps).trigger(task({}))
    expect(run.status).toBe('ok')
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('workspace'))
  })

  test('环形裁剪：runHistoryLimit=2 时只留最近 2 条', async () => {
    const { deps, runs } = makeDeps()
    let n = 0
    deps.newRunId = () => `run-${++n}`
    const executor = createExecutor({ ...deps, runHistoryLimit: 2 })
    await executor.trigger(task({}))
    await executor.trigger(task({}))
    await executor.trigger(task({}))
    expect([...runs.data.keys()].sort()).toEqual(['run-2', 'run-3'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/executor.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/toolkit/src/schedule/executor.ts`

```ts
/** 定时任务执行器：输入一条 task，输出一条 run 记录（建会话 → followup → whenIdle/超时 → 落库）。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentRegistry } from '../agents/registry.ts'
import { roleAgentOptions, roleHooks } from '../channels/role-assembly.ts'
import type { AgentHooks, AgentSection, AgentsPort, DefaultModelAccessor, WorkspacePort } from '../channels/ports.ts'
import { trimRuns, type CronRun, type CronTask } from './store.ts'

/** 来源段名：声明本会话由定时任务触发（order 20，与渠道 sender 段同位）。 */
export const TASK_SECTION_NAME = 'dsh-agent-toolkit:schedule:task'

export function taskSectionText(task: CronTask, triggeredAt: string): string {
  return `本会话由定时任务「${task.name}」（id: ${task.id}）于 ${triggeredAt} 触发。`
}

/** 错误摘要最大字符数（对齐 feishu.errorDetailMaxChars 默认 500）。 */
const ERROR_MAX_CHARS = 500

export interface ExecutorDeps {
  agents: AgentsPort
  registry: AgentRegistry
  /** 宿主默认模型（main 形态与未自配模型的角色的模型来源）。 */
  defaultModel: DefaultModelAccessor
  workspace: WorkspacePort
  runs: KvTable<string, CronRun>
  runHistoryLimit: number
  /** 单次运行 followup→whenIdle 超时（Config schedule.runTimeoutMinutes × 60_000）。 */
  runTimeoutMs: number
  warn: (msg: string) => void
  now(): number
  newSessionId(): string
  newRunId(): string
  /** 超时计时（测试注入可控 Promise；生产为 setTimeout 包装）。 */
  delay(ms: number): Promise<void>
}

export interface Executor {
  /** 执行一次任务：永不抛错，结果体现在返回的 run 记录。 */
  trigger(task: CronTask): Promise<CronRun>
}

class RunTimeoutError extends Error {
  constructor() { super('timeout') }
}

export function createExecutor(deps: ExecutorDeps): Executor {
  async function persist(run: CronRun): Promise<void> {
    await deps.runs.put(run.id, run)
    await trimRuns(deps.runs, run.taskId, deps.runHistoryLimit)
  }

  return {
    async trigger(task) {
      const triggeredAt = new Date(deps.now()).toISOString()
      const sessionId = deps.newSessionId()
      const run: CronRun = { id: deps.newRunId(), taskId: task.id, triggeredAt, status: 'running', sessionId }
      await persist(run)
      const finish = async (status: CronRun['status'], error?: string): Promise<CronRun> => {
        const done: CronRun = {
          ...run,
          status,
          finishedAt: new Date(deps.now()).toISOString(),
          ...(error !== undefined ? { error: error.slice(0, ERROR_MAX_CHARS) } : {}),
        }
        await persist(done)
        return done
      }

      // 解析装配（main/role 共用序列，仅装配不同；roleId 缺失降级 main 并 warn，同 Router 语义）。
      const source: AgentSection = { name: TASK_SECTION_NAME, order: 20, text: taskSectionText(task, triggeredAt) }
      let agentOptions: { provider?: string; model?: string }
      let hooks: AgentHooks
      const roleId = task.target.kind === 'role' ? task.target.roleId : 'main'
      const role = roleId === 'main' ? undefined : deps.registry.get(roleId)
      if (roleId === 'main' || role === undefined) {
        if (roleId !== 'main' && role === undefined) {
          deps.warn(`[schedule] 定时任务 "${task.id}" 的角色 "${roleId}" 不存在，降级主 Agent 形态`)
        }
        agentOptions = deps.defaultModel()
        hooks = { sections: [source] }
      } else {
        const base = roleHooks(role)
        agentOptions = roleAgentOptions(role, deps.defaultModel)
        hooks = { ...base, sections: [...(base.sections ?? []), source] }
      }

      let agent
      try {
        agent = await deps.agents.create({ sessionId, cwd: task.cwd, agentOptions, hooks })
      } catch (error) {
        return finish('error', error instanceof Error ? error.message : String(error))
      }
      try {
        await deps.workspace.attach(task.cwd, sessionId)
      } catch (error) {
        // attach 失败仅告警（会话降级为未分组），不阻塞执行——同 Router.attach。
        deps.warn(`[schedule] 会话 ${sessionId} 挂载 workspace 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      agent.followup(task.prompt)
      // race 落败方的迟到 rejection 不变 unhandled（先各挂 noop catch；race 自身引用不受影响）。
      const idle = agent.whenIdle()
      idle.catch(() => undefined)
      const timeout = deps.delay(deps.runTimeoutMs).then(() => { throw new RunTimeoutError() })
      timeout.catch(() => undefined)
      try {
        await Promise.race([idle, timeout])
        return await finish('ok')
      } catch (error) {
        if (error instanceof RunTimeoutError) {
          agent.cancel()
          return await finish('error', `timeout（超过 ${Math.round(deps.runTimeoutMs / 60_000)} 分钟未空闲，已取消）`)
        }
        return await finish('error', error instanceof Error ? error.message : String(error))
      }
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/executor.test.ts`
Expected: PASS（全部测试绿）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/schedule/executor.ts packages/toolkit/src/schedule/executor.test.ts
git commit -m "feat: cron executor (session assembly, followup, timeout, run records)"
```

---


### Task 6: 调度器 `src/schedule/scheduler.ts`

**Files:**
- Create: `packages/toolkit/src/schedule/scheduler.ts`
- Test: `packages/toolkit/src/schedule/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `rearmTask`/`recomputeTask`/`advanceAfterTrigger`；Task 1 的 `trimRuns`/`CronRun`/`CronTask`
- Produces:
  - `SchedulerDeps` / `Scheduler` / `createScheduler(deps: SchedulerDeps): Scheduler`
  - `Scheduler` 方法：`rearmAll(): Promise<void>`、`tick(): Promise<void>`、`recompute(task: CronTask): CronTask`、`triggerManual(taskId: string): Promise<CronRun>`（不存在/运行中抛 Error）、`isRunning(taskId: string): boolean`

**语义要点（spec §3）：**
- tick 扫 `enabled && nextRunAt <= now`；到期且未在跑 → launch（异步执行，tick 不等执行完成）；到期且在跑 → 记 `skipped-overlap` run 并把 nextRunAt 推进到未来（避免每个 tick 重复记跳过）。
- 执行 settle 后推进 nextRunAt（`advanceAfterTrigger`）；任务已被删/停用则不写回。
- 手动触发走同一 running 锁与执行器，但**不推进 nextRunAt**、不受 enabled 影响。

- [ ] **Step 1: 写失败测试** `packages/toolkit/src/schedule/scheduler.test.ts`

fake 时钟驱动 tick（手动调 `tick()`，注入 `now`）：

```ts
import { describe, expect, test, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { createScheduler, type SchedulerDeps } from './scheduler.ts'
import type { CronRun, CronTask } from './store.ts'

const T0 = Date.parse('2026-09-07T00:00:00.000Z')

const task = (over: Partial<CronTask>): CronTask => ({
  id: 't1', name: 'n', prompt: 'p', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' },
  target: { kind: 'main' }, catchup: false, enabled: true,
  nextRunAt: null, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
  ...over,
})

function fakeTable<V>(init: [string, V][] = []): KvTable<string, V> & { data: Map<string, V> } {
  const data = new Map<string, V>(init)
  return {
    data,
    get: (k: string) => data.get(k),
    put: async (k: string, v: V) => { data.set(k, v) },
    delete: async (k: string) => data.delete(k),
    entries: () => data.entries(),
  } as unknown as KvTable<string, V> & { data: Map<string, V> }
}

function makeDeps(over: {
  tasks?: KvTable<string, CronTask> & { data: Map<string, CronTask> }
  execute?: (task: CronTask) => Promise<unknown>
  now?: () => number
} = {}) {
  const tasks = over.tasks ?? fakeTable<CronTask>()
  const runs = fakeTable<CronRun>()
  let runN = 0
  const deps: SchedulerDeps = {
    tasks, runs,
    runHistoryLimit: 20,
    execute: over.execute ?? (async () => undefined),
    now: over.now ?? (() => T0),
    newRunId: () => `run-${++runN}`,
    warn: vi.fn(),
  }
  return { deps, tasks, runs }
}

describe('rearmAll', () => {
  test('未来保持 / 过期 catchup 立即 / 过期不 catchup 重算 / 过期 at 作废 / disabled 归 null', async () => {
    const tasks = fakeTable<CronTask>([
      ['future', task({ id: 'future', nextRunAt: '2026-09-08T00:00:00.000Z' })],
      ['catchup', task({ id: 'catchup', catchup: true, nextRunAt: '2026-09-06T09:00:00.000Z' })],
      ['skip', task({ id: 'skip', nextRunAt: '2026-09-06T09:00:00.000Z' })],
      ['at', task({ id: 'at', schedule: { kind: 'at', at: '2026-09-06T00:00:00Z' }, nextRunAt: '2026-09-06T00:00:00.000Z' })],
      ['off', task({ id: 'off', enabled: false, nextRunAt: '2026-09-06T09:00:00.000Z' })],
    ])
    const { deps } = makeDeps({ tasks })
    await createScheduler(deps).rearmAll()
    expect(tasks.data.get('future')?.nextRunAt).toBe('2026-09-08T00:00:00.000Z')
    expect(tasks.data.get('catchup')?.nextRunAt).toBe(new Date(T0).toISOString())
    expect(tasks.data.get('skip')?.nextRunAt).toBe('2026-09-07T09:00:00.000Z')
    expect(tasks.data.get('at')).toMatchObject({ enabled: false, nextRunAt: null })
    expect(tasks.data.get('off')).toMatchObject({ enabled: false, nextRunAt: null })
  })
})

describe('tick', () => {
  test('到期任务触发执行；settle 后推进 nextRunAt 到下一 occurrence', async () => {
    const fired: string[] = []
    const tasks = fakeTable<CronTask>([['t1', task({ nextRunAt: new Date(T0).toISOString() })]])
    const { deps } = makeDeps({ tasks, execute: async (t) => { fired.push(t.id) } })
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    expect(fired).toEqual(['t1'])
    await vi.waitFor(() => {
      expect(tasks.data.get('t1')?.nextRunAt).toBe('2026-09-07T09:00:00.000Z')
    })
  })

  test('未到期 / disabled / nextRunAt=null 不触发', async () => {
    const execute = vi.fn(async () => undefined)
    const tasks = fakeTable<CronTask>([
      ['future', task({ id: 'future', nextRunAt: '2026-09-08T00:00:00.000Z' })],
      ['off', task({ id: 'off', enabled: false, nextRunAt: new Date(T0).toISOString() })],
      ['null', task({ id: 'null', nextRunAt: null })],
    ])
    const { deps } = makeDeps({ tasks, execute })
    await createScheduler(deps).tick()
    expect(execute).not.toHaveBeenCalled()
  })

  test('重叠保护：上次未结束 → 记 skipped-overlap 并推进 nextRunAt，不并发执行', async () => {
    let resolveRun: (() => void) | undefined
    const execute = vi.fn(() => new Promise<void>((resolve) => { resolveRun = () => resolve() }))
    const tasks = fakeTable<CronTask>([['t1', task({ nextRunAt: new Date(T0).toISOString() })]])
    const { deps, runs } = makeDeps({ tasks, execute })
    const scheduler = createScheduler(deps)
    await scheduler.tick()               // 启动首次执行（不结束）
    expect(execute).toHaveBeenCalledTimes(1)
    await scheduler.tick()               // 仍在跑 → 跳过
    expect(execute).toHaveBeenCalledTimes(1)
    const skipped = [...runs.data.values()].filter((r) => r.status === 'skipped-overlap')
    expect(skipped).toHaveLength(1)
    expect(tasks.data.get('t1')?.nextRunAt).toBe('2026-09-07T09:00:00.000Z')
    resolveRun!()
  })

  test('at 一次性：触发 settle 后作废（enabled=false, nextRunAt=null）', async () => {
    const at = '2026-09-07T00:00:00.000Z'
    const tasks = fakeTable<CronTask>([['t1', task({ schedule: { kind: 'at', at }, nextRunAt: at })]])
    const { deps } = makeDeps({ tasks })
    await createScheduler(deps).tick()
    await vi.waitFor(() => {
      expect(tasks.data.get('t1')).toMatchObject({ enabled: false, nextRunAt: null })
    })
  })

  test('执行中被删除：settle 后不回写（不复活）', async () => {
    let resolveRun: (() => void) | undefined
    const execute = vi.fn(() => new Promise<void>((resolve) => { resolveRun = () => resolve() }))
    const tasks = fakeTable<CronTask>([['t1', task({ nextRunAt: new Date(T0).toISOString() })]])
    const { deps } = makeDeps({ tasks, execute })
    const scheduler = createScheduler(deps)
    await scheduler.tick()
    await tasks.delete('t1')
    resolveRun!()
    await vi.waitFor(() => { expect(scheduler.isRunning('t1')).toBe(false) })
    expect(tasks.data.has('t1')).toBe(false)
  })
})

describe('triggerManual', () => {
  test('立即执行（disabled 也可），不推进 nextRunAt', async () => {
    const run: CronRun = { id: 'run-x', taskId: 't1', triggeredAt: new Date(T0).toISOString(), status: 'ok' }
    const tasks = fakeTable<CronTask>([['t1', task({ enabled: false, nextRunAt: '2026-09-08T00:00:00.000Z' })]])
    const { deps } = makeDeps({ tasks, execute: async () => run })
    const result = await createScheduler(deps).triggerManual('t1')
    expect(result).toBe(run)
    expect(tasks.data.get('t1')?.nextRunAt).toBe('2026-09-08T00:00:00.000Z')
  })

  test('不存在 / 运行中 → 抛错', async () => {
    let resolveRun: (() => void) | undefined
    const execute = vi.fn(() => new Promise<void>((resolve) => { resolveRun = () => resolve() }))
    const tasks = fakeTable<CronTask>([['t1', task({ nextRunAt: new Date(T0).toISOString() })]])
    const { deps } = makeDeps({ tasks, execute })
    const scheduler = createScheduler(deps)
    await expect(scheduler.triggerManual('ghost')).rejects.toThrow(/不存在/)
    const p = scheduler.triggerManual('t1')
    await expect(scheduler.triggerManual('t1')).rejects.toThrow(/正在运行/)
    expect(scheduler.isRunning('t1')).toBe(true)
    resolveRun!()
    await p
    expect(scheduler.isRunning('t1')).toBe(false)
  })
})

describe('recompute', () => {
  test('创建/更新后 fresh 重算（不经 catchup）', () => {
    const { deps } = makeDeps()
    const scheduler = createScheduler(deps)
    expect(scheduler.recompute(task({})).nextRunAt).toBe('2026-09-07T09:00:00.000Z')
    expect(scheduler.recompute(task({ enabled: false })).nextRunAt).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/scheduler.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/toolkit/src/schedule/scheduler.ts`

```ts
/** 调度引擎：启动 rearm + 周期 tick + 重叠保护 + 触发后推进。计时由接线层（ctx.interval 30s）驱动。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { advanceAfterTrigger, rearmTask, recomputeTask } from './timing.ts'
import { trimRuns, type CronRun, type CronTask } from './store.ts'

export interface SchedulerDeps {
  tasks: KvTable<string, CronTask>
  runs: KvTable<string, CronRun>
  runHistoryLimit: number
  /** executor.trigger：契约上永不抛错（异常已落 run 记录）；仍 catch 兜底。 */
  execute(task: CronTask): Promise<unknown>
  now(): number
  newRunId(): string
  warn(msg: string): void
}

export interface Scheduler {
  /** 启动 rearm：全部任务按 catchup 语义重算（写回有变化的行）。 */
  rearmAll(): Promise<void>
  /** 一次 tick：触发全部到期任务（执行异步进行，不阻塞 tick 返回）。 */
  tick(): Promise<void>
  /** 创建/更新后 fresh 重算 nextRunAt（不执行、不落库——调用方负责 put）。 */
  recompute(task: CronTask): CronTask
  /** 手动触发一次（不受 enabled 影响；不存在/运行中抛错）。不改变 nextRunAt。 */
  triggerManual(taskId: string): Promise<CronRun>
  isRunning(taskId: string): boolean
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  /** 内存重叠锁：同任务上次未结束则本次记 skipped-overlap，不并发执行。 */
  const running = new Set<string>()

  async function recordSkipped(task: CronTask): Promise<void> {
    const nowIso = new Date(deps.now()).toISOString()
    const run: CronRun = {
      id: deps.newRunId(), taskId: task.id,
      triggeredAt: nowIso, finishedAt: nowIso,
      status: 'skipped-overlap',
    }
    await deps.runs.put(run.id, run)
    await trimRuns(deps.runs, task.id, deps.runHistoryLimit)
  }

  function launch(task: CronTask): void {
    running.add(task.id)
    void deps.execute(task)
      .catch((error) => deps.warn(`[schedule] 任务 "${task.id}" 执行器异常：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        running.delete(task.id)
        // 触发后推进：任务可能已被删除/停用 → 只在仍存在且启用时写回。
        const current = deps.tasks.get(task.id)
        if (current === undefined || !current.enabled) return
        void deps.tasks.put(task.id, advanceAfterTrigger(current, deps.now()))
      })
  }

  return {
    async rearmAll() {
      for (const [id, task] of deps.tasks.entries()) {
        const rearmed = rearmTask(task, deps.now())
        if (rearmed !== task) await deps.tasks.put(id, rearmed)
      }
    },
    async tick() {
      for (const [, task] of deps.tasks.entries()) {
        if (!task.enabled || task.nextRunAt === null) continue
        if (Date.parse(task.nextRunAt) > deps.now()) continue
        if (running.has(task.id)) {
          // 重叠保护：记 skipped-overlap 并把 nextRunAt 推到未来（避免每个 tick 重复记跳过）。
          await recordSkipped(task)
          await deps.tasks.put(task.id, advanceAfterTrigger(task, deps.now()))
          continue
        }
        launch(task)
      }
    },
    recompute: (task) => recomputeTask(task, deps.now()),
    async triggerManual(taskId) {
      const task = deps.tasks.get(taskId)
      if (task === undefined) throw new Error(`定时任务 "${taskId}" 不存在`)
      if (running.has(taskId)) throw new Error(`定时任务 "${task.name}" 正在运行中，本次手动触发已跳过`)
      running.add(taskId)
      try {
        return await deps.execute(task) as CronRun
      } finally {
        running.delete(taskId)
      }
    },
    isRunning: (taskId) => running.has(taskId),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/scheduler.test.ts`
Expected: PASS（全部测试绿）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/schedule/scheduler.ts packages/toolkit/src/schedule/scheduler.test.ts
git commit -m "feat: cron scheduler (rearm, tick, overlap guard, manual trigger)"
```

---

### Task 7: CRUD 服务 `src/schedule/service.ts`（tools 与 API 共用）

**Files:**
- Create: `packages/toolkit/src/schedule/service.ts`
- Test: `packages/toolkit/src/schedule/service.test.ts`

**Interfaces:**
- Consumes: Task 1 store、Task 2 `validateSchedule`、Task 6 `Scheduler`、`AgentRegistry`
- Produces:
  - `CronTaskInput`（name/prompt/cwd/schedule/target/catchup/enabled 全必填）/ `CronTaskPatch = Partial<CronTaskInput>`
  - `CronTaskView = CronTask & { lastRun?: Pick<CronRun, 'status' | 'triggeredAt'> }`
  - `CronResult<T> = { ok: true; value: T } | { ok: false; error: string }`
  - `CronServiceDeps` / `CronService`（`list`/`get`/`create`/`update`/`remove`/`trigger`/`runsOf`）/ `createCronService(deps)`

- [ ] **Step 1: 写失败测试** `packages/toolkit/src/schedule/service.test.ts`

```ts
import { describe, expect, test, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { createCronService, type CronServiceDeps, type CronTaskInput } from './service.ts'
import { createScheduler } from './scheduler.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import type { CronRun, CronTask } from './store.ts'

const T0 = Date.parse('2026-09-07T00:00:00.000Z')

function fakeTable<V>(): KvTable<string, V> & { data: Map<string, V> } {
  const data = new Map<string, V>()
  return {
    data,
    get: (k: string) => data.get(k),
    put: async (k: string, v: V) => { data.set(k, v) },
    delete: async (k: string) => data.delete(k),
    entries: () => data.entries(),
  } as unknown as KvTable<string, V> & { data: Map<string, V> }
}

const EMPTY_REGISTRY: AgentRegistry = {
  list: () => [], get: () => undefined,
  upsert: async () => undefined, remove: async () => undefined, subscribe: () => () => undefined,
}

const INPUT: CronTaskInput = {
  name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'UTC' },
  target: { kind: 'main' }, catchup: true, enabled: true,
}

function makeDeps(over: Partial<{
  registry: AgentRegistry
  validateProject: (path: string) => boolean
}> = {}) {
  const tasks = fakeTable<CronTask>()
  const runs = fakeTable<CronRun>()
  const execute = vi.fn(async () => undefined)
  const scheduler = createScheduler({
    tasks, runs, runHistoryLimit: 20, execute, now: () => T0, newRunId: () => 'run-1', warn: vi.fn(),
  })
  let idN = 0
  const deps: CronServiceDeps = {
    tasks, runs, scheduler,
    registry: over.registry ?? EMPTY_REGISTRY,
    validateProject: over.validateProject ?? (() => true),
    now: () => T0,
    newTaskId: () => `task-${++idN}`,
  }
  return { deps, tasks, runs, execute }
}

describe('create', () => {
  test('合法输入：落库并算好 nextRunAt', async () => {
    const { deps, tasks } = makeDeps()
    const result = await createCronService(deps).create(INPUT)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.id).toBe('task-1')
      expect(result.value.nextRunAt).toBe('2026-09-07T09:00:00.000Z')
      expect(result.value.createdAt).toBe(new Date(T0).toISOString())
    }
    expect(tasks.data.size).toBe(1)
  })

  test('校验失败拒绝入库：非法 cron / 未知时区 / cwd 不可用 / roleId 不存在 / at 过去', async () => {
    const { deps, tasks } = makeDeps({ validateProject: (p) => p === 'D:\\work' })
    const service = createCronService(deps)
    const cases: CronTaskInput[] = [
      { ...INPUT, schedule: { kind: 'cron', expr: '99 9 * * *' } },
      { ...INPUT, schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'Mars/Olympus' } },
      { ...INPUT, cwd: 'D:\\nope' },
      { ...INPUT, target: { kind: 'role', roleId: 'ghost' } },
      { ...INPUT, schedule: { kind: 'at', at: '2026-09-06T00:00:00Z' } },
    ]
    for (const input of cases) {
      const result = await service.create(input)
      expect(result.ok).toBe(false)
    }
    expect(tasks.data.size).toBe(0)
  })

  test('disabled 创建：nextRunAt=null', async () => {
    const { deps } = makeDeps()
    const result = await createCronService(deps).create({ ...INPUT, enabled: false })
    expect(result.ok && result.value.nextRunAt).toBeNull()
  })
})

describe('update', () => {
  test('改任意字段并重算 nextRunAt；不存在 → ok:false', async () => {
    const { deps, tasks } = makeDeps()
    const service = createCronService(deps)
    await service.create(INPUT)
    const result = await service.update('task-1', { name: '晚报', schedule: { kind: 'every', seconds: 3600 } })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.name).toBe('晚报')
      expect(result.value.prompt).toBe('写日报') // 未改字段保留
      expect(result.value.nextRunAt).toBe('2026-09-07T01:00:00.000Z') // every 锚 = createdAt
    }
    expect((await service.update('ghost', { name: 'x' })).ok).toBe(false)
    expect(tasks.data.get('task-1')?.updatedAt).toBe(new Date(T0).toISOString())
  })

  test('更新携带非法字段 → ok:false 且不改库', async () => {
    const { deps, tasks } = makeDeps()
    const service = createCronService(deps)
    await service.create(INPUT)
    const before = tasks.data.get('task-1')
    const result = await service.update('task-1', { schedule: { kind: 'cron', expr: 'bad expr here now' } })
    expect(result.ok).toBe(false)
    expect(tasks.data.get('task-1')).toBe(before)
  })
})

describe('remove / list / runsOf / trigger', () => {
  test('remove 连带清运行历史；不存在 → ok:false', async () => {
    const { deps, tasks, runs } = makeDeps()
    const service = createCronService(deps)
    await service.create(INPUT)
    await runs.put('r1', { id: 'r1', taskId: 'task-1', triggeredAt: new Date(T0).toISOString(), status: 'ok' })
    const result = await service.remove('task-1')
    expect(result.ok).toBe(true)
    expect(tasks.data.size).toBe(0)
    expect(runs.data.size).toBe(0)
    expect((await service.remove('task-1')).ok).toBe(false)
  })

  test('list 携带 lastRun 摘要（最近一次运行状态）', async () => {
    const { deps, runs } = makeDeps()
    const service = createCronService(deps)
    await service.create(INPUT)
    expect(service.list()[0].lastRun).toBeUndefined()
    await runs.put('r1', { id: 'r1', taskId: 'task-1', triggeredAt: '2026-09-07T01:00:00.000Z', status: 'ok' })
    await runs.put('r2', { id: 'r2', taskId: 'task-1', triggeredAt: '2026-09-07T02:00:00.000Z', status: 'error' })
    expect(service.list()[0].lastRun).toEqual({ status: 'error', triggeredAt: '2026-09-07T02:00:00.000Z' })
    expect(service.runsOf('task-1', 20)).toHaveLength(2)
  })

  test('trigger 手动触发：经 scheduler（不存在/运行中错误透传为 ok:false）', async () => {
    const { deps, execute } = makeDeps()
    const service = createCronService(deps)
    await service.create(INPUT)
    const result = await service.trigger('task-1')
    expect(result.ok).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await service.trigger('ghost')).ok).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/service.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/toolkit/src/schedule/service.ts`

```ts
/** cron 任务 CRUD 服务：模型工具与 HTTP API 双入口共用（校验、落库、重算、连带清理）。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentRegistry } from '../agents/registry.ts'
import type { Scheduler } from './scheduler.ts'
import { CronTaskSchema, deleteRunsOf, listRuns, type CronRun, type CronSchedule, type CronTarget, type CronTask } from './store.ts'
import { validateSchedule } from './timing.ts'

/** 创建输入（全字段必填；更新用 Partial）。 */
export interface CronTaskInput {
  name: string
  prompt: string
  cwd: string
  schedule: CronSchedule
  target: CronTarget
  catchup: boolean
  enabled: boolean
}
export type CronTaskPatch = Partial<CronTaskInput>

/** 列表视图：任务 + 最近一次运行摘要。 */
export type CronTaskView = CronTask & { lastRun?: Pick<CronRun, 'status' | 'triggeredAt'> }

export type CronResult<T> = { ok: true; value: T } | { ok: false; error: string }

export interface CronServiceDeps {
  tasks: KvTable<string, CronTask>
  runs: KvTable<string, CronRun>
  scheduler: Scheduler
  registry: AgentRegistry
  validateProject(path: string): boolean
  now(): number
  newTaskId(): string
}

export interface CronService {
  list(): CronTaskView[]
  get(id: string): CronTask | undefined
  create(input: CronTaskInput): Promise<CronResult<CronTask>>
  update(id: string, patch: CronTaskPatch): Promise<CronResult<CronTask>>
  /** 删除任务并连带清运行历史。 */
  remove(id: string): Promise<CronResult<null>>
  /** 立即手动触发一次（不受 enabled 影响；不存在/运行中 ok:false）。 */
  trigger(id: string): Promise<CronResult<CronRun>>
  /** 运行历史（新 → 旧，最多 limit 条）。 */
  runsOf(id: string, limit: number): CronRun[]
}

export function createCronService(deps: CronServiceDeps): CronService {
  /** 创建/更新共用校验：schedule 语法与时值 → cwd → roleId 存在性。 */
  const validateIO = (input: Pick<CronTaskInput, 'cwd' | 'schedule' | 'target'>): string | undefined => {
    const scheduleError = validateSchedule(input.schedule, deps.now())
    if (scheduleError !== undefined) return scheduleError
    if (!deps.validateProject(input.cwd)) return `项目路径不可用：${input.cwd}`
    if (input.target.kind === 'role' && deps.registry.get(input.target.roleId) === undefined) {
      return `角色 "${input.target.roleId}" 不存在`
    }
    return undefined
  }

  return {
    list() {
      return [...deps.tasks.entries()].map(([, task]) => {
        const last = listRuns(deps.runs, task.id)[0]
        const view: CronTaskView = last === undefined
          ? task
          : { ...task, lastRun: { status: last.status, triggeredAt: last.triggeredAt } }
        return view
      })
    },
    get: (id) => deps.tasks.get(id),
    async create(input) {
      const invalid = validateIO(input)
      if (invalid !== undefined) return { ok: false, error: invalid }
      const nowIso = new Date(deps.now()).toISOString()
      const parsed = CronTaskSchema.safeParse({
        id: deps.newTaskId(), ...input,
        nextRunAt: null, createdAt: nowIso, updatedAt: nowIso,
      })
      if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid task' }
      const task = deps.scheduler.recompute(parsed.data)
      await deps.tasks.put(task.id, task)
      return { ok: true, value: task }
    },
    async update(id, patch) {
      const existing = deps.tasks.get(id)
      if (existing === undefined) return { ok: false, error: `定时任务 "${id}" 不存在` }
      const merged = {
        ...existing,
        ...(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))),
        id: existing.id,
        updatedAt: new Date(deps.now()).toISOString(),
      }
      const invalid = validateIO(merged)
      if (invalid !== undefined) return { ok: false, error: invalid }
      const parsed = CronTaskSchema.safeParse(merged)
      if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid task' }
      const task = deps.scheduler.recompute(parsed.data)
      await deps.tasks.put(id, task)
      return { ok: true, value: task }
    },
    async remove(id) {
      if (deps.tasks.get(id) === undefined) return { ok: false, error: `定时任务 "${id}" 不存在` }
      await deps.tasks.delete(id)
      await deleteRunsOf(deps.runs, id)
      return { ok: true, value: null }
    },
    async trigger(id) {
      try {
        return { ok: true, value: await deps.scheduler.triggerManual(id) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    runsOf: (id, limit) => listRuns(deps.runs, id).slice(0, limit),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/service.test.ts`
Expected: PASS（全部测试绿）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/schedule/service.ts packages/toolkit/src/schedule/service.test.ts
git commit -m "feat: cron task CRUD service shared by tools and HTTP API"
```

---


### Task 8: 模型工具 `src/schedule/tools.ts`（cron_* + 互斥探测）

**Files:**
- Create: `packages/toolkit/src/schedule/tools.ts`
- Test: `packages/toolkit/src/schedule/tools.test.ts`

**Interfaces:**
- Consumes: Task 7 `CronService`/`CronTaskInput`/`CronTaskPatch`；宿主 `defineTool`/`ToolDefinition`（`@deepseek-ai/dsh-tools`，值导入宿主隐式提供，delegate/tool.ts 先例）；`scopeOf`（`@deepseek-ai/dsh-scope`）
- Produces:
  - `createCronTools(service: CronService): ToolDefinition[]`——5 个工具：`cron_task_create` / `cron_task_list` / `cron_task_update` / `cron_task_delete` / `cron_task_trigger`
  - `setupCronTools(ctx: Context, tools: ToolDefinition[], ownedSessions: ReadonlySet<string>): void`——主 Agent scope 注册 + `schedule_create` 互斥探测
  - 工具参数扁平化（模型友好）：`scheduleKind: 'cron'|'at'|'every'` + `cronExpr?`/`timeZone?`/`atTime?`/`everySeconds?`；`targetKind: 'main'|'role'` + `roleId?`

**门控语义（spec §5「注册在主 Agent scope（不进 subagent/bot 会话）」）：**
- 排除 `agent.session.header.origin === 'subagent'`；
- 排除 `ownedSessions`（Task 4 工厂记录的 bot/schedule 自有会话）；
- 对已在场的 roots 立即注册 + `agent/created` 注册未来 agent（dsh-schedule `src/index.ts:45-49` 同款模式，多一个存量 roots 循环改善 HMR 体验）。

- [ ] **Step 1: 写失败测试** `packages/toolkit/src/schedule/tools.test.ts`

工具 execute 直接调用（不经宿主工具运行时）+ 门控单测用 fake ctx：

```ts
import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createCronTools, setupCronTools } from './tools.ts'
import type { CronResult, CronService, CronTaskView } from './service.ts'
import type { CronRun, CronTask } from './store.ts'

const T0 = Date.parse('2026-09-07T00:00:00.000Z')

const VIEW: CronTaskView = {
  id: 'task-1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *' }, target: { kind: 'main' },
  catchup: true, enabled: true, nextRunAt: '2026-09-07T09:00:00.000Z',
  createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
}

function fakeService(over: Partial<CronService> = {}): CronService & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = []
  const record = <A extends unknown[], R>(method: string, impl: (...args: A) => R) =>
    (...args: A): R => { calls.push({ method, args }); return impl(...args) }
  return {
    calls,
    list: record('list', () => [VIEW]),
    get: record('get', (id: string) => (id === 'task-1' ? VIEW : undefined)),
    create: record('create', async (): Promise<CronResult<CronTask>> => ({ ok: true, value: VIEW })),
    update: record('update', async (): Promise<CronResult<CronTask>> => ({ ok: true, value: VIEW })),
    remove: record('remove', async (): Promise<CronResult<null>> => ({ ok: true, value: null })),
    trigger: record('trigger', async (): Promise<CronResult<CronRun>> => ({
      ok: true, value: { id: 'run-1', taskId: 'task-1', triggeredAt: new Date(T0).toISOString(), status: 'ok' },
    })),
    runsOf: record('runsOf', () => []),
    ...over,
  }
}

type Exec = (args: Record<string, unknown>) => Promise<unknown>

function execOf(tools: ReturnType<typeof createCronTools>, name: string): Exec {
  const tool = tools.find((t) => t.name === name)
  if (tool === undefined) throw new Error(`tool ${name} not registered`)
  return tool.execute as unknown as Exec
}

describe('createCronTools', () => {
  test('注册 5 个 cron_ 前缀工具', () => {
    expect(createCronTools(fakeService()).map((t) => t.name)).toEqual([
      'cron_task_create', 'cron_task_list', 'cron_task_update', 'cron_task_delete', 'cron_task_trigger',
    ])
  })

  test('create：扁平参数装配 schedule/target 三选一；服务 ok:false → 抛错', async () => {
    const service = fakeService()
    const exec = execOf(createCronTools(service), 'cron_task_create')
    await exec({
      name: '日报', prompt: '写日报', cwd: 'D:\\work',
      scheduleKind: 'cron', cronExpr: '0 9 * * *', timeZone: 'Asia/Shanghai',
      targetKind: 'role', roleId: 'explorer', catchup: true, enabled: true,
    })
    expect(service.calls[0].args[0]).toEqual({
      name: '日报', prompt: '写日报', cwd: 'D:\\work',
      schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' },
      target: { kind: 'role', roleId: 'explorer' },
      catchup: true, enabled: true,
    })
    // at / every 装配
    await exec({ name: 'a', prompt: 'p', cwd: 'c', scheduleKind: 'at', atTime: '2026-09-08T00:00:00Z', targetKind: 'main', catchup: false, enabled: true })
    expect(service.calls[1].args[0]).toMatchObject({ schedule: { kind: 'at', at: '2026-09-08T00:00:00Z' }, target: { kind: 'main' } })
    await exec({ name: 'a', prompt: 'p', cwd: 'c', scheduleKind: 'every', everySeconds: 3600, targetKind: 'main', catchup: false, enabled: true })
    expect(service.calls[2].args[0]).toMatchObject({ schedule: { kind: 'every', seconds: 3600 } })
    // 缺 kind 对应字段 → 抛错
    await expect(exec({ name: 'a', prompt: 'p', cwd: 'c', scheduleKind: 'cron', targetKind: 'main', catchup: false, enabled: true }))
      .rejects.toThrow(/cronExpr/)
    // 服务校验失败 → 结构化错误
    const failing = fakeService({ create: async () => ({ ok: false, error: '非法 cron 表达式' }) })
    await expect(execOf(createCronTools(failing), 'cron_task_create')({
      name: 'a', prompt: 'p', cwd: 'c', scheduleKind: 'cron', cronExpr: 'bad', targetKind: 'main', catchup: false, enabled: true,
    })).rejects.toThrow('非法 cron 表达式')
  })

  test('list 返回任务视图（enabled/nextRunAt/lastRun）；update/delete/trigger 转发', async () => {
    const service = fakeService()
    const tools = createCronTools(service)
    const list = await execOf(tools, 'cron_task_list')({}) as CronTaskView[]
    expect(list[0]).toMatchObject({ id: 'task-1', enabled: true, nextRunAt: '2026-09-07T09:00:00.000Z' })
    await execOf(tools, 'cron_task_update')({ id: 'task-1', name: '晚报' })
    expect(service.calls.find((c) => c.method === 'update')?.args).toEqual(['task-1', { name: '晚报' }])
    await execOf(tools, 'cron_task_delete')({ id: 'task-1' })
    expect(service.calls.find((c) => c.method === 'remove')?.args).toEqual(['task-1'])
    await execOf(tools, 'cron_task_trigger')({ id: 'task-1' })
    expect(service.calls.find((c) => c.method === 'trigger')?.args).toEqual(['task-1'])
  })

  test('update：只透传出现的字段（undefined 键不进 patch）', async () => {
    const service = fakeService()
    await execOf(createCronTools(service), 'cron_task_update')({ id: 'task-1', enabled: false })
    const patch = service.calls.find((c) => c.method === 'update')?.args[1] as Record<string, unknown>
    expect(patch).toEqual({ enabled: false })
  })
})

describe('setupCronTools 门控与互斥探测', () => {
  interface FakeAgent {
    session: { id: string; header: { origin?: string } }
    ctx: { effect(fn: () => () => void): void; tools: unknown }
    effects: Array<() => void>
  }

  /** fake ctx + fake agent（agent.ctx.tools 与 ctx.tools 共用注册表，便于断言）。 */
  function fakeWorld(over: { hasScheduleCreate?: boolean } = {}) {
    const listeners: ((payload: { agent: FakeAgent }) => void)[] = []
    const registered: string[] = []
    const warns: string[] = []
    const toolsRegistry = {
      get: (name: string) => (name === 'schedule_create' && over.hasScheduleCreate === true ? { name } : undefined),
      register: (tool: { name: string }) => { registered.push(tool.name); return () => undefined },
    }
    let roots: FakeAgent[] = []
    const ctx = {
      agents: { roots: () => roots },
      on: (event: string, listener: (payload: { agent: FakeAgent }) => void) => {
        if (event === 'agent/created') listeners.push(listener)
      },
      tools: toolsRegistry,
      logger: { warn: (m: string) => warns.push(m) },
    } as unknown as Context
    const makeAgent = (origin: string | undefined, sessionId: string): FakeAgent => {
      const effects: Array<() => void> = []
      return {
        session: { id: sessionId, header: { origin } },
        ctx: { effect: (fn: () => () => void) => { effects.push(fn()) }, tools: toolsRegistry },
        effects,
      }
    }
    return {
      ctx, listeners, registered, warns, makeAgent,
      setRoots: (agents: FakeAgent[]) => { roots = agents },
    }
  }

  test('主 Agent（origin undefined）注册 5 工具；schedule_create 在场 → warn', () => {
    const world = fakeWorld({ hasScheduleCreate: true })
    const agent = world.makeAgent(undefined, 'sess-main')
    world.setRoots([agent])
    setupCronTools(world.ctx, createCronTools(fakeService()), new Set())
    expect(world.registered).toEqual(['cron_task_create', 'cron_task_list', 'cron_task_update', 'cron_task_delete', 'cron_task_trigger'])
    expect(world.warns.some((m) => m.includes('schedule_create'))).toBe(true)
  })

  test('subagent 与插件自有会话不注册', () => {
    const world = fakeWorld()
    world.setRoots([world.makeAgent('subagent', 'sess-sub'), world.makeAgent(undefined, 'sess-owned')])
    setupCronTools(world.ctx, createCronTools(fakeService()), new Set(['sess-owned']))
    expect(world.registered).toEqual([])
  })

  test('agent/created 对未来主 Agent 注册', () => {
    const world = fakeWorld()
    setupCronTools(world.ctx, createCronTools(fakeService()), new Set())
    const agent = world.makeAgent(undefined, 'sess-new')
    for (const listener of world.listeners) listener({ agent })
    expect(world.registered).toContain('cron_task_create')
  })
})
```

> **实现提示**：fake 里 `scopeOf(agent.ctx)` 返回 undefined（无 scope key），门控代码对 `scopeOf` 结果做 undefined 守卫后，互斥探测退化为 `ctx.tools.get('schedule_create')`（无 scope 参数）——生产路径 agent.ctx 必有 scope，走 scoped get。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/tools.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/toolkit/src/schedule/tools.ts`

```ts
/** cron_* 模型工具：注册在主 Agent scope（不进 subagent/插件自有会话）+ 宿主 schedule 互斥探测。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { CronService, CronTaskInput, CronTaskPatch } from './service.ts'
import type { CronSchedule, CronTarget } from './store.ts'

/** 互斥探测目标：宿主 @deepseek-ai/dsh-schedule 的会话内提醒工具。 */
const HOST_SCHEDULE_TOOL = 'schedule_create'

/** 扁平参数 → CronSchedule（缺 kind 对应字段抛错——模型可读的自描述消息）。 */
function scheduleOf(args: Record<string, unknown>): CronSchedule {
  const kind = args.scheduleKind
  if (kind === 'cron') {
    if (typeof args.cronExpr !== 'string' || args.cronExpr.trim() === '') throw new Error('scheduleKind=cron 需要 cronExpr（5 字段 cron 表达式）')
    return {
      kind: 'cron', expr: args.cronExpr,
      ...(typeof args.timeZone === 'string' && args.timeZone !== '' ? { timeZone: args.timeZone } : {}),
    }
  }
  if (kind === 'at') {
    if (typeof args.atTime !== 'string' || args.atTime === '') throw new Error('scheduleKind=at 需要 atTime（RFC 3339 时间）')
    return { kind: 'at', at: args.atTime }
  }
  if (kind === 'every') {
    if (typeof args.everySeconds !== 'number') throw new Error('scheduleKind=every 需要 everySeconds（≥60 的秒数）')
    return { kind: 'every', seconds: args.everySeconds }
  }
  throw new Error(`未知 scheduleKind：${String(kind)}（可选 cron / at / every）`)
}

function targetOf(args: Record<string, unknown>): CronTarget {
  if (args.targetKind === 'role') {
    if (typeof args.roleId !== 'string' || args.roleId === '') throw new Error('targetKind=role 需要 roleId')
    return { kind: 'role', roleId: args.roleId }
  }
  return { kind: 'main' }
}

/** 服务结果展开：ok:false → 抛错（defineTool 约定：抛错即工具错误结果）。 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

const JSON_OUTPUT = {
  schema: { type: 'json' },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
} as const

const SCHEDULE_PARAMS_REQUIRED = {
  scheduleKind: { type: 'string', required: true, description: 'One of: cron / at / every' },
} as const

const SCHEDULE_PARAMS_OPTIONAL = {
  scheduleKind: { type: 'string', description: 'Replace schedule kind: cron / at / every (provide the matching fields too)' },
} as const

const SCHEDULE_FIELD_PARAMS = {
  cronExpr: { type: 'string', description: 'Required when scheduleKind=cron: 5-field cron expression "minute hour day-of-month month day-of-week" (seconds/years not supported)' },
  timeZone: { type: 'string', description: 'Optional IANA time zone for cron (e.g. "Asia/Shanghai"); default: server process time zone' },
  atTime: { type: 'string', description: 'Required when scheduleKind=at: one-shot RFC 3339 time (e.g. "2026-09-08T09:00:00+08:00")' },
  everySeconds: { type: 'number', description: 'Required when scheduleKind=every: interval seconds (>= 60), anchored at creation time' },
} as const

const TARGET_PARAMS_REQUIRED = {
  targetKind: { type: 'string', required: true, description: 'One of: main (main agent, default model) / role (registry role with its persona/model/tool allowlist)' },
} as const

const TARGET_PARAMS_OPTIONAL = {
  targetKind: { type: 'string', description: 'Replace target: main / role' },
} as const

const ROLE_ID_PARAM = { roleId: { type: 'string', description: 'Required when targetKind=role: registry role id' } } as const

export function createCronTools(service: CronService): ToolDefinition[] {
  return [
    defineTool({
      name: 'cron_task_create',
      description:
        'Create a scheduled task that runs a prompt in a NEW standalone session (main agent or a registry role) '
        + 'on a cron/at/every schedule. The task survives restarts; a run missed while stopped is caught up once '
        + 'when catchup=true. Use cron_task_list to see existing tasks.',
      parameters: {
        name: { type: 'string', required: true, description: 'Task name (display)' },
        prompt: { type: 'string', required: true, description: 'The prompt sent as the user message when the task fires. Self-contained: the session has no other context.' },
        cwd: { type: 'string', required: true, description: 'Working directory of the new session (must be a valid project path)' },
        ...SCHEDULE_PARAMS_REQUIRED,
        ...SCHEDULE_FIELD_PARAMS,
        ...TARGET_PARAMS_REQUIRED,
        ...ROLE_ID_PARAM,
        catchup: { type: 'boolean', required: true, description: 'true: run once immediately after restart if a run was missed while stopped; false: skip to the next future occurrence' },
        enabled: { type: 'boolean', required: true, description: 'false: create paused (nextRunAt stays null until enabled via cron_task_update)' },
      },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(rawArgs) {
        const args = rawArgs as Record<string, unknown>
        const input: CronTaskInput = {
          name: args.name as string,
          prompt: args.prompt as string,
          cwd: args.cwd as string,
          schedule: scheduleOf(args),
          target: targetOf(args),
          catchup: args.catchup as boolean,
          enabled: args.enabled as boolean,
        }
        return unwrap(await service.create(input))
      },
    }),
    defineTool({
      name: 'cron_task_list',
      description: 'List all scheduled tasks with enabled flag, next run time and last run status.',
      parameters: {},
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      async execute() {
        return service.list()
      },
    }),
    defineTool({
      name: 'cron_task_update',
      description: 'Update any fields of a scheduled task by id. nextRunAt is recomputed.',
      parameters: {
        id: { type: 'string', required: true, description: 'Task id' },
        name: { type: 'string', description: 'New name' },
        prompt: { type: 'string', description: 'New prompt' },
        cwd: { type: 'string', description: 'New working directory' },
        ...SCHEDULE_PARAMS_OPTIONAL,
        ...SCHEDULE_FIELD_PARAMS,
        ...TARGET_PARAMS_OPTIONAL,
        ...ROLE_ID_PARAM,
        catchup: { type: 'boolean', description: 'New catchup flag' },
        enabled: { type: 'boolean', description: 'Enable/disable the task' },
      },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(rawArgs) {
        const args = rawArgs as Record<string, unknown>
        const patch: CronTaskPatch = {}
        if (args.name !== undefined) patch.name = args.name as string
        if (args.prompt !== undefined) patch.prompt = args.prompt as string
        if (args.cwd !== undefined) patch.cwd = args.cwd as string
        if (args.scheduleKind !== undefined) patch.schedule = scheduleOf(args)
        if (args.targetKind !== undefined) patch.target = targetOf(args)
        if (args.catchup !== undefined) patch.catchup = args.catchup as boolean
        if (args.enabled !== undefined) patch.enabled = args.enabled as boolean
        return unwrap(await service.update(args.id as string, patch))
      },
    }),
    defineTool({
      name: 'cron_task_delete',
      description: 'Delete a scheduled task by id, including its run history.',
      parameters: { id: { type: 'string', required: true, description: 'Task id' } },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(rawArgs) {
        return unwrap(await service.remove((rawArgs as Record<string, unknown>).id as string))
      },
    }),
    defineTool({
      name: 'cron_task_trigger',
      description: 'Trigger a scheduled task once right now (works even when disabled; fails with an error if the task is already running).',
      parameters: { id: { type: 'string', required: true, description: 'Task id' } },
      output: JSON_OUTPUT,
      isConcurrencySafe: () => true,
      async execute(rawArgs) {
        return unwrap(await service.trigger((rawArgs as Record<string, unknown>).id as string))
      },
    }),
  ]
}

/**
 * 注册 cron_* 工具到主 Agent scope 并探测宿主 schedule 互斥（spec §1/§5）。
 * 门控：跳过 subagent（session.header.origin === 'subagent'）与插件自有会话（ownedSessions：
 * bot/schedule 会话）——dsh-schedule src/index.ts:45-49 同款 agent/created 模式，
 * 外加存量 roots 立即注册（HMR 重挂后当前主会话不丢工具）。
 */
export function setupCronTools(ctx: Context, tools: ToolDefinition[], ownedSessions: ReadonlySet<string>): void {
  const attach = (agent: Agent): void => {
    if (agent.session.header.origin === 'subagent') return
    if (ownedSessions.has(String(agent.session.id))) return
    agent.ctx.effect(() => {
      const scope = scopeOf(agent.ctx)
      const hostPresent = scope !== undefined
        ? ctx.tools.get(HOST_SCHEDULE_TOOL, scope) !== undefined
        : ctx.tools.get(HOST_SCHEDULE_TOOL) !== undefined
      if (hostPresent) {
        ctx.logger.warn(
          'dsh-agent-toolkit: 检测到宿主 @deepseek-ai/dsh-schedule 的 schedule_create 与 cron_* 并存——'
          + '两套调度工具并存会显著提高模型误选率，且会话内提醒在会话冷时静默失败；'
          + '请从组合中移除 @deepseek-ai/dsh-schedule（二选一）',
        )
      }
      const disposers = tools.map((tool) => agent.ctx.tools.register(tool))
      return () => { for (const dispose of disposers) dispose() }
    })
  }
  for (const agent of ctx.agents.roots()) attach(agent)
  ctx.on('agent/created', ({ agent }) => { attach(agent) })
}
```

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/tools.test.ts`
Expected: PASS（全部测试绿）
Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 无错误（若 defineTool 的 parameters/output 字面量类型不匹配，照 delegate/tool.ts 的写法微调——不改行为）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/schedule/tools.ts packages/toolkit/src/schedule/tools.test.ts
git commit -m "feat: cron_* model tools with main-scope gating and host schedule probe"
```

---

### Task 9: HTTP API `src/schedule/api.ts`

**Files:**
- Create: `packages/toolkit/src/schedule/api.ts`
- Test: `packages/toolkit/src/schedule/api.test.ts`

**Interfaces:**
- Consumes: Task 7 `CronService`/`CronTaskInput`；`json`/`readJsonBody`（shared/http.ts）
- Produces:
  - `CronApiDeps = { service: CronService; listProjects(): string[]; runHistoryLimit: number }`
  - `createCronApiHandler(deps: CronApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void>`
- 路由（prefix `/dsh-agent-toolkit/api/cron` 内部分发；路径参数照 spec §6 用 `:id` 段，不用 query）：
  - `GET /tasks` / `POST /tasks` / `PUT /tasks/:id` / `DELETE /tasks/:id` / `POST /tasks/:id/trigger` / `GET /tasks/:id/runs` / `GET /projects`
- 状态码约定：body schema 失败或服务校验失败 → 400；`:id` 不存在（先 `service.get` 预检）→ 404；trigger 运行中 → 409；已知路径错方法 → 405；其余 → 404。

- [ ] **Step 1: 写失败测试** `packages/toolkit/src/schedule/api.test.ts`

```ts
import { describe, expect, test } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { createCronApiHandler } from './api.ts'
import type { CronResult, CronService, CronTaskView } from './service.ts'
import type { CronRun, CronTask } from './store.ts'

const T0 = Date.parse('2026-09-07T00:00:00.000Z')
const TASK: CronTask = {
  id: 'task-1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *' }, target: { kind: 'main' },
  catchup: true, enabled: true, nextRunAt: '2026-09-07T09:00:00.000Z',
  createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
}

/** fake service：内存 Map 实现（不走真 scheduler——api 层只测转发与状态码）。 */
function fakeService(): CronService & { tasks: Map<string, CronTask>; runLog: CronRun[] } {
  const tasks = new Map<string, CronTask>([['task-1', TASK]])
  const runLog: CronRun[] = []
  let n = 1
  const ok = <T>(value: T): CronResult<T> => ({ ok: true, value })
  const fail = (error: string): CronResult<never> => ({ ok: false, error })
  return {
    tasks, runLog,
    list: () => [...tasks.values()],
    get: (id) => tasks.get(id),
    create: async (input) => {
      const task: CronTask = { ...input, id: `task-${++n}`, nextRunAt: null, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() }
      tasks.set(task.id, task)
      return ok(task)
    },
    update: async (id, patch) => {
      const existing = tasks.get(id)
      if (existing === undefined) return fail(`定时任务 "${id}" 不存在`)
      const next = { ...existing, ...patch, updatedAt: new Date(T0).toISOString() }
      tasks.set(id, next)
      return ok(next)
    },
    remove: async (id) => {
      if (!tasks.delete(id)) return fail(`定时任务 "${id}" 不存在`)
      return ok(null)
    },
    trigger: async (id) => {
      if (!tasks.has(id)) return fail(`定时任务 "${id}" 不存在`)
      const run: CronRun = { id: 'run-1', taskId: id, triggeredAt: new Date(T0).toISOString(), status: 'running' }
      runLog.push(run)
      return ok(run)
    },
    runsOf: (id, limit) => runLog.filter((r) => r.taskId === id).slice(0, limit),
  }
}

type FakeService = ReturnType<typeof fakeService>

function req(method: string, path: string, body?: unknown): IncomingMessage {
  const r = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage
  r.method = method
  r.url = path
  return r
}

interface Captured { code: number; body: unknown }
function res(): ServerResponse & { captured: Captured } {
  const captured: Captured = { code: 0, body: undefined }
  return {
    captured,
    writeHead(code: number) { captured.code = code; return this },
    end(body?: string) { captured.body = body === undefined ? undefined : JSON.parse(body) },
  } as unknown as ServerResponse & { captured: Captured }
}

const BASE = '/dsh-agent-toolkit/api/cron'

function makeHandler() {
  const service = fakeService()
  const handler = createCronApiHandler({ service, listProjects: () => ['D:\\work', 'D:\\ops'], runHistoryLimit: 20 })
  return { service, handler }
}

describe('cron api', () => {
  test('GET /tasks 列表', async () => {
    const { handler } = makeHandler()
    const r = res()
    await handler(req('GET', `${BASE}/tasks`), r)
    expect(r.captured.code).toBe(200)
    expect((r.captured.body as { tasks: CronTaskView[] }).tasks[0].id).toBe('task-1')
  })

  test('POST /tasks 创建 round-trip；body 校验失败 400', async () => {
    const { handler, service } = makeHandler()
    const create = {
      name: '晚报', prompt: '写晚报', cwd: 'D:\\ops',
      schedule: { kind: 'every', seconds: 3600 }, target: { kind: 'main' },
      catchup: false, enabled: true,
    }
    const r = res()
    await handler(req('POST', `${BASE}/tasks`, create), r)
    expect(r.captured.code).toBe(200)
    expect(service.tasks.size).toBe(2)
    const bad = res()
    await handler(req('POST', `${BASE}/tasks`, { name: '' }), bad)
    expect(bad.captured.code).toBe(400)
  })

  test('PUT /tasks/:id 更新；不存在 404', async () => {
    const { handler, service } = makeHandler()
    const r = res()
    await handler(req('PUT', `${BASE}/tasks/task-1`, { name: '改名' }), r)
    expect(r.captured.code).toBe(200)
    expect(service.tasks.get('task-1')?.name).toBe('改名')
    const missing = res()
    await handler(req('PUT', `${BASE}/tasks/ghost`, { name: 'x' }), missing)
    expect(missing.captured.code).toBe(404)
  })

  test('DELETE /tasks/:id；不存在 404', async () => {
    const { handler, service } = makeHandler()
    const r = res()
    await handler(req('DELETE', `${BASE}/tasks/task-1`), r)
    expect(r.captured.code).toBe(200)
    expect(service.tasks.size).toBe(0)
    const missing = res()
    await handler(req('DELETE', `${BASE}/tasks/task-1`), missing)
    expect(missing.captured.code).toBe(404)
  })

  test('POST /tasks/:id/trigger；运行中 409；不存在 404', async () => {
    const { handler, service } = makeHandler()
    const r = res()
    await handler(req('POST', `${BASE}/tasks/task-1/trigger`), r)
    expect(r.captured.code).toBe(200)
    expect((r.captured.body as { run: CronRun }).run.status).toBe('running')
    service.trigger = async () => ({ ok: false, error: '定时任务 "日报" 正在运行中，本次手动触发已跳过' })
    const conflict = res()
    await handler(req('POST', `${BASE}/tasks/task-1/trigger`), conflict)
    expect(conflict.captured.code).toBe(409)
    const missing = res()
    await handler(req('POST', `${BASE}/tasks/ghost/trigger`), missing)
    expect(missing.captured.code).toBe(404)
  })

  test('GET /tasks/:id/runs 运行历史；不存在 404', async () => {
    const { handler, service } = makeHandler()
    service.runLog.push({ id: 'r1', taskId: 'task-1', triggeredAt: new Date(T0).toISOString(), status: 'ok' })
    const r = res()
    await handler(req('GET', `${BASE}/tasks/task-1/runs`), r)
    expect(r.captured.code).toBe(200)
    expect((r.captured.body as { runs: CronRun[] }).runs).toHaveLength(1)
    const missing = res()
    await handler(req('GET', `${BASE}/tasks/ghost/runs`), missing)
    expect(missing.captured.code).toBe(404)
  })

  test('GET /projects 候选 cwd 列表；405/404 兜底', async () => {
    const { handler } = makeHandler()
    const r = res()
    await handler(req('GET', `${BASE}/projects`), r)
    expect((r.captured.body as { projects: string[] }).projects).toEqual(['D:\\work', 'D:\\ops'])
    const wrong = res()
    await handler(req('DELETE', `${BASE}/tasks`), wrong)
    expect(wrong.captured.code).toBe(405)
    const nope = res()
    await handler(req('GET', `${BASE}/nope`), nope)
    expect(nope.captured.code).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/api.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/toolkit/src/schedule/api.ts`

```ts
/** 定时任务浏览器半 RPC：单前缀路由 /dsh-agent-toolkit/api/cron + 内部路径分发（bots/api.ts 同款骨架）。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { json, readJsonBody } from '../shared/http.ts'
import type { CronService, CronTaskInput } from './service.ts'
import { CronScheduleSchema, CronTargetSchema } from './store.ts'

export interface CronApiDeps {
  service: CronService
  /** 候选 cwd 列表（workspaceRegistry.list() 的 path 集；服务缺席时调用方给空数组）。 */
  listProjects(): string[]
  runHistoryLimit: number
}

const CreateBodySchema: z.ZodType<CronTaskInput> = z.object({
  name: z.string().min(1).max(64),
  prompt: z.string().min(1).max(8000),
  cwd: z.string().min(1),
  schedule: CronScheduleSchema,
  target: CronTargetSchema,
  catchup: z.boolean(),
  enabled: z.boolean(),
})
const UpdateBodySchema = CreateBodySchema.partial()

export function createCronApiHandler(deps: CronApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sub = url.pathname.replace(/^\/dsh-agent-toolkit\/api\/cron/, '') || '/'
    const method = req.method ?? 'GET'
    const taskMatch = /^\/tasks\/([^/]+)$/.exec(sub)
    const triggerMatch = /^\/tasks\/([^/]+)\/trigger$/.exec(sub)
    const runsMatch = /^\/tasks\/([^/]+)\/runs$/.exec(sub)

    if (sub === '/tasks' && method === 'GET') {
      json(res, 200, { tasks: deps.service.list() })
      return
    }

    if (sub === '/tasks' && method === 'POST') {
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const parsed = CreateBodySchema.safeParse(body)
      if (!parsed.success) {
        json(res, 400, { error: parsed.error.issues[0]?.message ?? 'invalid body' })
        return
      }
      const result = await deps.service.create(parsed.data)
      if (!result.ok) {
        json(res, 400, { error: result.error })
        return
      }
      json(res, 200, { task: result.value })
      return
    }

    if (taskMatch !== null && method === 'PUT') {
      const id = decodeURIComponent(taskMatch[1])
      if (deps.service.get(id) === undefined) {
        json(res, 404, { error: `定时任务 "${id}" 不存在` })
        return
      }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const parsed = UpdateBodySchema.safeParse(body)
      if (!parsed.success) {
        json(res, 400, { error: parsed.error.issues[0]?.message ?? 'invalid body' })
        return
      }
      const result = await deps.service.update(id, parsed.data)
      if (!result.ok) {
        json(res, 400, { error: result.error })
        return
      }
      json(res, 200, { task: result.value })
      return
    }

    if (taskMatch !== null && method === 'DELETE') {
      const id = decodeURIComponent(taskMatch[1])
      if (deps.service.get(id) === undefined) {
        json(res, 404, { error: `定时任务 "${id}" 不存在` })
        return
      }
      const result = await deps.service.remove(id)
      if (!result.ok) {
        json(res, 400, { error: result.error })
        return
      }
      json(res, 200, { ok: true })
      return
    }

    if (triggerMatch !== null && method === 'POST') {
      const id = decodeURIComponent(triggerMatch[1])
      if (deps.service.get(id) === undefined) {
        json(res, 404, { error: `定时任务 "${id}" 不存在` })
        return
      }
      const result = await deps.service.trigger(id)
      if (!result.ok) {
        // 运行中冲突 409；其余（理论上只有不存在，已被预检拦截）400。
        json(res, /正在运行/.test(result.error) ? 409 : 400, { error: result.error })
        return
      }
      json(res, 200, { run: result.value })
      return
    }

    if (runsMatch !== null && method === 'GET') {
      const id = decodeURIComponent(runsMatch[1])
      if (deps.service.get(id) === undefined) {
        json(res, 404, { error: `定时任务 "${id}" 不存在` })
        return
      }
      json(res, 200, { runs: deps.service.runsOf(id, deps.runHistoryLimit) })
      return
    }

    if (sub === '/projects' && method === 'GET') {
      json(res, 200, { projects: deps.listProjects() })
      return
    }

    if (sub === '/tasks' || taskMatch !== null || triggerMatch !== null || runsMatch !== null || sub === '/projects') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    json(res, 404, { error: 'not found' })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/api.test.ts`
Expected: PASS（全部测试绿）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/schedule/api.ts packages/toolkit/src/schedule/api.test.ts
git commit -m "feat: cron HTTP API (7 routes under /dsh-agent-toolkit/api/cron)"
```

---


### Task 10: 模块接线 `src/schedule/index.ts` + 根 Config + 组合守护

**Files:**
- Create: `packages/toolkit/src/schedule/index.ts`
- Create: `packages/toolkit/src/schedule/composition.test.ts`
- Modify: `packages/toolkit/src/index.ts`（Config 加 `schedule` 段 + apply 调 setupSchedule）
- Modify: `packages/toolkit/src/index.test.ts`（默认值断言 + 存储域/路由断言更新）
- Modify: `packages/toolkit/package.json`（devDependencies 加 `@deepseek-ai/cordis-plugin-timer` link）

**Interfaces:**
- Consumes: Task 4 `createAgentsPort`、Task 5 `createExecutor`、Task 6 `createScheduler`、Task 7 `createCronService`、Task 8 `createCronTools`/`setupCronTools`、Task 9 `createCronApiHandler`；`openDomainSafely`（shared/storage.ts）、`registerOptionalRoutes`（shared/webserver.ts）、`createToolsScope`/`createScopeJoiner`（channels）
- Produces:
  - `ScheduleModuleConfig = { runTimeoutMinutes: number; runHistoryLimit: number }`
  - `ScheduleDeps = { registry: AgentRegistry; botPresetId?: string; ownedSessions: Set<string> }`
  - `setupSchedule(ctx: Context, config: ScheduleModuleConfig, deps: ScheduleDeps): void`
  - 根 `Config.schedule`（`runTimeoutMinutes` 默认 60、`runHistoryLimit` 默认 20）

**运行时事实（接线依据，已核实）：**
- `ctx.interval(cb, ms)` 由 `@deepseek-ai/cordis-plugin-timer` mixin 提供，宿主 profile-boot 保证在场（`apps/cli/src/profile-boot.ts:280-281` 缺则补装）；cordis effect 自动清理。类型需 `import type {} from '@deepseek-ai/cordis-plugin-timer'` + devDependency `link:../../deepseek-harness/vendor/timer`。
- `ctx.agentDefaultModel.currentSelection()` 返回 `{ provider, model }`（bots/index.ts 现有用法照抄）。
- `workspaceRegistry` 可选服务：`create(path)` → `{ attachSession(SessionId) }`；`list()` → `{ path }[]`。

- [ ] **Step 1: package.json 加 timer 类型依赖 + pnpm install**

`packages/toolkit/package.json` devDependencies 加（字典序，cordis-plugin-loader 后）：

```json
    "@deepseek-ai/cordis-plugin-timer": "link:../../deepseek-harness/vendor/timer",
```

Run: `pnpm install`

- [ ] **Step 2: 写组合守护测试** `packages/toolkit/src/schedule/composition.test.ts`

镜像 `src/channels/scope-joiner.composition.test.ts`（真实 AgentPresets 服务 + Loader + fixture 插件），守护「schedule 模块 joiner 栈（与 setupSchedule 内部构造同源）产生的父链真实可被执行中的 composeFrom 认到」：

```ts
/** 真实组合守护：schedule 任务会话的 joiner 栈（preset 优先 + toolsScope 回退）与 bots 同源，
 *  composeFrom 认父继承 preset 工具（spec §9 组合守护；0.2.3/0.2.4 fake 单测事故对策同族）。
 *  镜像 channels/scope-joiner.composition.test.ts 的最小集。 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { createScopeJoiner } from '../channels/scope-joiner.ts'
import { createToolsScope } from '../channels/tool-scope.ts'

const FIXTURE_PLUGIN = `
export const name = 'contribute'
export const inject = ['tools', 'systemPrompt']
export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register({
    name: config.tool,
    description: 'fixture tool ' + config.tool,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: () => Promise.resolve(config.tool),
  }))
}
`

const COMPOSITION = `- id: fixture
  name: ../../plugins/contribute.mjs
  config:
    tool: cron-fixture
`

let ctx: Context
let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dsh-toolkit-cron-composition-'))
  await mkdir(join(tempDir, 'plugins'))
  await writeFile(join(tempDir, 'plugins', 'contribute.mjs'), FIXTURE_PLUGIN, 'utf8')
  await mkdir(join(tempDir, 'presets', 'agent-bot'), { recursive: true })
  await writeFile(join(tempDir, 'presets', 'agent-bot', 'agent.cordis.yml'), COMPOSITION, 'utf8')

  ctx = new Context()
  ctx.baseUrl = pathToFileURL(tempDir).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentPresets, { default: 'agent-bot', roots: [{ path: join(tempDir, 'presets'), trust: 'user' }], includeUserRoot: false })
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('schedule 任务会话组合守护', () => {
  test('setupSchedule 同款 joiner 栈：mount 路径 composeFrom 认父，子 scope 继承 preset 工具', async () => {
    // 与 schedule/index.ts 内部构造逐行同源：createToolsScope → createScopeJoiner(botPresetId)。
    const toolsScope = createToolsScope(ctx, async () => ((() => undefined) as never))
    const joiner = createScopeJoiner(ctx, 'agent-bot', toolsScope, vi.fn())
    const parentScope = createScope(ctx, { fake: 'cron-parent' })
    await joiner.join(parentScope.ctx)
    expect(ctx.agentPresets.composedPreset(parentScope.ctx)).toBe('agent-bot')
    const childScope = createScope(ctx, { fake: 'cron-child' })
    expect(ctx.agentPresets.composeFrom(childScope.ctx, parentScope.ctx)).toBe('agent-bot')
    expect(ctx.tools.get('cron-fixture', scopeOf(childScope.ctx)!)).toBeDefined()
    await toolsScope.dispose()
  })
})
```

- [ ] **Step 3: 跑组合守护测试 + 根 index.test.ts 更新为红**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/schedule/composition.test.ts`
Expected: PASS（joiner 栈是 Task 4 前就位的既有能力，此测试是守护不是驱动）

`packages/toolkit/src/index.test.ts` 三处修改（先改测试看红）：

1. **fake ctx 补两个服务面**（`makeCtx()` 的字面量里）：schedule 接线在 apply 同步段调 `ctx.interval(...)`、在域打开后调 `ctx.agents.roots()`——fake 缺了会 TypeError。
   - 加 `interval: vi.fn(() => () => {}),`（顶层，与 `effect`/`on` 并列）；
   - `agents` 改为 `{ create: vi.fn(), resume: vi.fn(), roots: () => [] },`。
2. 「Config({}) 产出全量默认值」补：

   ```ts
   expect(config.schedule).toEqual({ runTimeoutMinutes: 60, runHistoryLimit: 20 })
   ```

3. 「默认配置：注册 /token-usage 命令、四个存储域、委派工具挂载路径」改五个存储域：

   ```ts
   expect(h.openedDomains.sort()).toEqual(['dsh_agent_toolkit', 'dsh_agent_toolkit_routes', 'dsh_agent_toolkit_schedule', 'project_bot', 'token_usage'])
   ```

4. 新增一条路由断言测试（schedule 路由注册在域打开之后，须先 `await flush()`）：

   ```ts
   test('默认配置：/dsh-agent-toolkit/api/cron 前缀路由注册（schedule 恒启用，不随 modules 门控）', async () => {
     const h = makeCtx()
     await apply(h.ctx, Config({ modules: { feishu: false } }))
     await flush()
     expect(h.registered.map((r) => r.path)).toContain('/dsh-agent-toolkit/api/cron')
   })
   ```

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/index.test.ts`
Expected: FAIL（`config.schedule` undefined / 存储域缺 schedule / cron 路由未注册）

- [ ] **Step 4: 实现** `packages/toolkit/src/schedule/index.ts`

```ts
/** schedule 模块接线：存储域 → executor/scheduler/service → cron_* 工具 + HTTP API + 30s tick。 */
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
// ctx.interval 声明合并（宿主 profile-boot 保证 timer 在场：apps/cli/src/profile-boot.ts:280-281）。
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { AgentRegistry } from '../agents/registry.ts'
import { createAgentsPort } from '../channels/agents-port.ts'
import type { WorkspacePort } from '../channels/ports.ts'
import { createScopeJoiner, type ScopeJoiner } from '../channels/scope-joiner.ts'
import { createToolsScope } from '../channels/tool-scope.ts'
import { openDomainSafely } from '../shared/storage.ts'
import { registerOptionalRoutes } from '../shared/webserver.ts'
import { createCronApiHandler } from './api.ts'
import { createExecutor } from './executor.ts'
import { createScheduler, type Scheduler } from './scheduler.ts'
import { createCronService } from './service.ts'
import { scheduleDomain, type CronRun, type CronTask } from './store.ts'
import { createCronTools, setupCronTools } from './tools.ts'

export interface ScheduleModuleConfig {
  /** 单次运行 followup→whenIdle 超时（分钟），超时 cancel + run 记 error('timeout')。 */
  runTimeoutMinutes: number
  /** 每任务环形保留的最近运行数。 */
  runHistoryLimit: number
}

export interface ScheduleDeps {
  registry: AgentRegistry
  /** 任务会话挂载的 preset id（agentTeamPreset 开启时下达；undefined = 直接 toolsScope）。 */
  botPresetId?: string
  /** 插件自有会话 id 集（与 bots 共享；cron_* 工具注册门控排除用）。 */
  ownedSessions: Set<string>
}

/** tick 间隔固定 30s（spec §8：不进 Config——YAGNI）。 */
const TICK_MS = 30_000

export function setupSchedule(ctx: Context, config: ScheduleModuleConfig, deps: ScheduleDeps): void {
  const warn = (m: string): void => ctx.logger.warn(m)
  // 与 setupBots 同款 joiner 栈：preset 优先（委派子会话 composeFrom 认父）+ toolsScope 回退。
  const toolsScope = createToolsScope(ctx)
  const joiner: ScopeJoiner = deps.botPresetId !== undefined
    ? createScopeJoiner(ctx, deps.botPresetId, toolsScope, warn)
    : toolsScope
  const agentsPort = createAgentsPort(ctx, joiner, deps.ownedSessions)

  // workspaceRegistry 可选服务，惰性解析（attachments 教训：apply 期一次性捕获会吃到未注册的 undefined）。
  interface WorkspaceRegistryLike {
    create(path: string): Promise<{ attachSession(sessionId: SessionId): Promise<void> }>
    list(): { path: string }[]
  }
  const workspaceRegistryOf = (): WorkspaceRegistryLike | undefined =>
    ctx.get('workspaceRegistry', false) as WorkspaceRegistryLike | undefined
  const workspacePort: WorkspacePort = {
    async attach(cwd, sessionId) {
      const registry = workspaceRegistryOf()
      if (registry === undefined) throw new Error('workspaceRegistry 服务不可用')
      const workspace = await registry.create(cwd)
      await workspace.attachSession(SessionId(sessionId))
    },
  }

  let scheduler: Scheduler | undefined
  const started = openDomainSafely(ctx, scheduleDomain, warn).then(async (domain) => {
    const tasks = domain.table('tasks') as KvTable<string, CronTask>
    const runs = domain.table('runs') as KvTable<string, CronRun>
    const executor = createExecutor({
      agents: agentsPort,
      registry: deps.registry,
      defaultModel: () => {
        const selection = ctx.agentDefaultModel.currentSelection()
        return { provider: selection.provider, model: selection.model }
      },
      workspace: workspacePort,
      runs,
      runHistoryLimit: config.runHistoryLimit,
      runTimeoutMs: config.runTimeoutMinutes * 60_000,
      warn,
      now: () => Date.now(),
      newSessionId: () => randomUUID(),
      newRunId: () => randomUUID(),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
    scheduler = createScheduler({
      tasks, runs,
      runHistoryLimit: config.runHistoryLimit,
      execute: (task) => executor.trigger(task),
      now: () => Date.now(),
      newRunId: () => randomUUID(),
      warn,
    })
    const service = createCronService({
      tasks, runs,
      scheduler,
      registry: deps.registry,
      validateProject: (path) => existsSync(path),
      now: () => Date.now(),
      newTaskId: () => randomUUID(),
    })
    setupCronTools(ctx, createCronTools(service), deps.ownedSessions)
    // webServer 可选（headless 惰性不抛错）；handler 请求时才构造（启动链落定前不捕获 service）。
    registerOptionalRoutes(ctx, (webCtx) => {
      const dispose = webCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-agent-toolkit/api/cron',
        handler: async (req, res) => {
          try {
            await started
            await createCronApiHandler({
              service,
              listProjects: () => workspaceRegistryOf()?.list().map((w) => w.path) ?? [],
              runHistoryLimit: config.runHistoryLimit,
            })(req, res)
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' })
              .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
          }
        },
      })
      return () => dispose()
    })
    await scheduler.rearmAll()
  })
  started.catch((error) => {
    warn(`[schedule] 启动失败：${error instanceof Error ? error.message : String(error)}`)
  })

  // 周期 tick：启动链落定后扫描到期任务（Cordis 卸载自动清理 interval）。
  ctx.interval(() => { void started.then(() => scheduler?.tick()) }, TICK_MS)

  ctx.effect(() => async () => { await toolsScope.dispose() })
}
```

- [ ] **Step 5: 根 index.ts 接 Config + apply**

`packages/toolkit/src/index.ts`：
- import 加：`import { setupSchedule, type ScheduleModuleConfig } from './schedule/index.ts'`
- `Config` 接口加字段：

```ts
  feishu: BotsModuleConfig
  agentTeamPreset: AgentTeamPresetConfig
  schedule: ScheduleModuleConfig
```

- schemastery schema 在 `agentTeamPreset` 块后加：

```ts
  // 定时任务（cron）：单次运行超时（分钟）与每任务运行历史环形上限（spec: docs/superpowers/specs/2026-09-07-cron-schedule-design.md §8）。
  schedule: z.object({
    runTimeoutMinutes: z.number().min(1).default(60),
    runHistoryLimit: z.number().int().min(1).default(20),
  }).default({ runTimeoutMinutes: 60, runHistoryLimit: 20 }),
```

- apply 末尾（`ownedSessions` 在 Task 4 已建；setupSchedule 恒启用，不随 modules 门控）：

```ts
  setupSchedule(ctx, config.schedule, {
    registry,
    botPresetId: config.agentTeamPreset.enabled ? config.agentTeamPreset.botsId : undefined,
    ownedSessions,
  })
```

- [ ] **Step 6: 全量测试 + 类型检查 + bundle**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（含更新后的 index.test.ts 与组合守护）
Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 无错误
Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 成功产出 lib/index.js + lib/client.js

- [ ] **Step 7: Commit**

```bash
git add packages/toolkit/src/schedule/index.ts packages/toolkit/src/schedule/composition.test.ts packages/toolkit/src/index.ts packages/toolkit/src/index.test.ts packages/toolkit/package.json
git commit -m "feat: wire schedule module (config, tick loop, cron routes, composition guard)"
```

---

### Task 11: 浏览器半——入口 + 任务列表模态框 + 运行历史

**Files:**
- Create: `packages/toolkit/src/client/schedule/api.ts`
- Create: `packages/toolkit/src/client/schedule/locales.ts`
- Create: `packages/toolkit/src/client/schedule/entry.tsx`
- Create: `packages/toolkit/src/client/schedule/ScheduleModal.tsx`
- Create: `packages/toolkit/src/client/schedule/schedule.module.css`
- Create: `packages/toolkit/src/client/schedule/index.ts`
- Test: `packages/toolkit/src/client/schedule/schedule-modal.client.spec.tsx`

**Interfaces:**
- Consumes: `createSidebarEntry`（client/shared/entry.tsx）、`useLoadState`（client/shared/load-state.ts）、宿主 `Modal`/`Button`/`Pill`（ui-primitives）、`ISessions`（dsh-client-runtime/client）；Task 1 类型（import type，不进 bundle）
- Produces:
  - `setupScheduleClient(ctx: Context): void`（Task 12 挂进 client/index.ts）
  - client api 封装：`fetchTasks`/`createTask`/`updateTask`/`deleteTask`/`triggerTask`/`fetchRuns`/`fetchProjects` + `CronTaskInput`/`CronTaskView` 类型
  - locales NS `'agent-schedule'`（zh 真源，en 键集严格一致）
  - `ScheduleModal` props：`{ open, onClose, openSession: (sessionId: string) => void, t: TranslateNS<'agent-schedule'>, onEdit?, onCreate? }`（onEdit/onCreate 测试注入点，缺省走内部视图状态机——Task 12 接 TaskForm）

- [ ] **Step 1: client api 封装** `packages/toolkit/src/client/schedule/api.ts`

```ts
/** 浏览器半 RPC 封装（fetch → Node 半 webServer 路由）。类型全部 import type，不进 bundle。 */
import type { CronRun, CronTask } from '../../schedule/store.ts'
import type { CronTaskInput, CronTaskView } from '../../schedule/service.ts'

export type { CronTaskInput, CronTaskView }
export type { CronRun, CronTask }

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = init === undefined
    ? await fetch(input)
    : await fetch(input, { ...init, headers: { 'content-type': 'application/json' } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

const BASE = '/dsh-agent-toolkit/api/cron'

export const fetchTasks = () => request<{ tasks: CronTaskView[] }>(`${BASE}/tasks`).then((r) => r.tasks)

export const createTask = (input: CronTaskInput) =>
  request<{ task: CronTask }>(`${BASE}/tasks`, { method: 'POST', body: JSON.stringify(input) })

export const updateTask = (id: string, patch: Partial<CronTaskInput>) =>
  request<{ task: CronTask }>(`${BASE}/tasks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) })

export const deleteTask = (id: string) =>
  request(`${BASE}/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const triggerTask = (id: string) =>
  request<{ run: CronRun }>(`${BASE}/tasks/${encodeURIComponent(id)}/trigger`, { method: 'POST', body: '{}' })

export const fetchRuns = (id: string) =>
  request<{ runs: CronRun[] }>(`${BASE}/tasks/${encodeURIComponent(id)}/runs`).then((r) => r.runs)

export const fetchProjects = () =>
  request<{ projects: string[] }>(`${BASE}/projects`).then((r) => r.projects)

/** Agent 下拉选项（复用 agents 端点；取子集）。 */
export interface AgentOption { id: string; name: string; description?: string }
export const fetchAgents = () => request<AgentOption[]>('/dsh-agent-toolkit/api/agents')
```

- [ ] **Step 2: locales** `packages/toolkit/src/client/schedule/locales.ts`

```ts
/** schedule 浏览器半文案：zh 为真源，en 键集严格一致。 */
export const NS = 'agent-schedule'

export const zh = {
  'modal.title': '定时任务',
  'modal.close': '关闭',
  'list.loading': '加载中…',
  'list.error': '加载失败，请重试',
  'list.empty': '还没有定时任务，点击「新建任务」开始。',
  'list.create': '新建任务',
  'list.edit': '编辑',
  'list.delete': '删除',
  'list.confirmDelete': '确认删除？',
  'list.deleteFailed': '删除失败：{message}',
  'list.trigger': '立即触发',
  'list.triggerFailed': '触发失败：{message}',
  'list.targetMain': '主 Agent',
  'list.targetRole': '角色 {roleId}',
  'list.nextRun': '下次触发 {time}',
  'list.noNextRun': '已停用',
  'list.history': '运行历史',
  'list.historyEmpty': '暂无运行记录',
  'run.ok': '成功',
  'run.error': '失败',
  'run.running': '运行中',
  'run.skipped-overlap': '跳过（上次未结束）',
  'run.openSession': '查看会话',
  'form.name': '名称',
  'form.prompt': '提示词',
  'form.project': '项目',
  'form.target': '目标',
  'form.targetMain': '主 Agent',
  'form.targetRole': '角色',
  'form.schedule': '调度',
  'form.scheduleCron': 'cron 表达式',
  'form.scheduleAt': '一次性时间',
  'form.scheduleEvery': '固定间隔',
  'form.cronExpr': '表达式（分 时 日 月 周）',
  'form.timeZone': '时区（可选，IANA）',
  'form.atTime': '触发时间',
  'form.everySeconds': '间隔秒数（≥60）',
  'form.preview': '未来 3 次触发',
  'form.catchup': '停机补跑（重启后补跑一次漏掉的触发）',
  'form.enabled': '启用',
  'form.save': '保存',
  'form.cancel': '取消',
  'form.saveFailed': '保存失败：{message}',
} as const

export type ScheduleKey = keyof typeof zh

export const en: Record<ScheduleKey, string> = {
  'modal.title': 'Scheduled tasks',
  'modal.close': 'Close',
  'list.loading': 'Loading…',
  'list.error': 'Failed to load, please retry',
  'list.empty': 'No scheduled tasks yet. Click "New task" to start.',
  'list.create': 'New task',
  'list.edit': 'Edit',
  'list.delete': 'Delete',
  'list.confirmDelete': 'Confirm delete?',
  'list.deleteFailed': 'Delete failed: {message}',
  'list.trigger': 'Run now',
  'list.triggerFailed': 'Trigger failed: {message}',
  'list.targetMain': 'Main agent',
  'list.targetRole': 'Role {roleId}',
  'list.nextRun': 'Next run {time}',
  'list.noNextRun': 'Disabled',
  'list.history': 'Run history',
  'list.historyEmpty': 'No runs yet',
  'run.ok': 'OK',
  'run.error': 'Error',
  'run.running': 'Running',
  'run.skipped-overlap': 'Skipped (overlap)',
  'run.openSession': 'Open session',
  'form.name': 'Name',
  'form.prompt': 'Prompt',
  'form.project': 'Project',
  'form.target': 'Target',
  'form.targetMain': 'Main agent',
  'form.targetRole': 'Role',
  'form.schedule': 'Schedule',
  'form.scheduleCron': 'Cron expression',
  'form.scheduleAt': 'One-shot time',
  'form.scheduleEvery': 'Fixed interval',
  'form.cronExpr': 'Expression (minute hour day month weekday)',
  'form.timeZone': 'Time zone (optional, IANA)',
  'form.atTime': 'Run at',
  'form.everySeconds': 'Interval seconds (>= 60)',
  'form.preview': 'Next 3 runs',
  'form.catchup': 'Catch up missed runs after restart',
  'form.enabled': 'Enabled',
  'form.save': 'Save',
  'form.cancel': 'Cancel',
  'form.saveFailed': 'Save failed: {message}',
}
```

- [ ] **Step 3: 样式** `packages/toolkit/src/client/schedule/schedule.module.css`

照 `client/bots/bots.module.css` 既有类名风格（读该文件对齐变量与间距），最小集：

```css
.dialog { width: 640px; }
.row { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.main { flex: 1; display: flex; flex-direction: column; gap: 2px; text-align: left; background: none; border: none; cursor: pointer; color: inherit; font: inherit; padding: 0; }
.name { font-weight: 600; }
.meta { font-size: 12px; opacity: 0.7; }
.runs { margin: 4px 0 8px 16px; font-size: 12px; }
.runRow { display: flex; gap: 8px; align-items: center; padding: 2px 0; }
.error { color: var(--dsh-color-error, #d33); }
.createButton { margin-top: 12px; }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
```

- [ ] **Step 4: 写失败测试** `packages/toolkit/src/client/schedule/schedule-modal.client.spec.tsx`

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ScheduleModal } from './ScheduleModal.tsx'
import { zh, type ScheduleKey } from './locales.ts'

/** t 桩：zh 真源 + {param} 插值（delegate-card.test.tsx 同款）。 */
function t(key: ScheduleKey, params?: Record<string, unknown>): string {
  let text: string = zh[key]
  for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v))
  return text
}

const TASK = {
  id: 'task-1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' },
  target: { kind: 'main' }, catchup: true, enabled: true,
  nextRunAt: '2026-09-08T01:00:00.000Z',
  createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
  lastRun: { status: 'ok', triggeredAt: '2026-09-07T01:00:00.000Z' },
}

function stubFetch(routes: Record<string, (body?: unknown) => unknown>) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body !== undefined && init.body !== '{}' ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method ?? 'GET', body })
    const handler = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1]
    if (handler === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(handler(body)), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function renderModal() {
  const openSession = vi.fn()
  render(<ScheduleModal open onClose={() => undefined} openSession={openSession} t={t} />)
  return { openSession }
}

test('列表渲染：名称/调度摘要/目标/下次触发/上次运行徽标', async () => {
  stubFetch({ '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [TASK] }) })
  renderModal()
  await screen.findByText('日报')
  expect(screen.getByText(/cron: 0 9 \* \* \* \(Asia\/Shanghai\)/)).toBeDefined()
  expect(screen.getByText('主 Agent')).toBeDefined()
  expect(screen.getByText(/下次触发/)).toBeDefined()
  expect(screen.getByText('成功')).toBeDefined()
})

test('enabled 行内开关：PUT enabled=false', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/cron/tasks/task-1': () => ({ task: TASK }),
    '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [TASK] }),
  })
  renderModal()
  const toggle = await screen.findByRole('checkbox', { name: /日报/ })
  fireEvent.click(toggle)
  await vi.waitFor(() => {
    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('task-1'))
    expect(put?.body).toEqual({ enabled: false })
  })
})

test('删除两段确认：第一次点击变确认，第二次发 DELETE', async () => {
  const calls = stubFetch({ '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [TASK] }) })
  renderModal()
  const del = await screen.findByRole('button', { name: '删除' })
  fireEvent.click(del)
  expect(screen.getByRole('button', { name: '确认删除？' })).toBeDefined()
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '确认删除？' }))
  await vi.waitFor(() => { expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('task-1'))).toBe(true) })
})

test('立即触发：POST trigger 并重拉', async () => {
  const calls = stubFetch({ '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [TASK] }) })
  renderModal()
  fireEvent.click(await screen.findByRole('button', { name: '立即触发' }))
  await vi.waitFor(() => { expect(calls.some((c) => c.method === 'POST' && c.url.includes('/trigger'))).toBe(true) })
})

test('运行历史：展开拉取 runs，sessionId 链接点击打开会话', async () => {
  stubFetch({
    '/dsh-agent-toolkit/api/cron/tasks/task-1/runs': () => ({
      runs: [{ id: 'r1', taskId: 'task-1', triggeredAt: '2026-09-07T01:00:00.000Z', finishedAt: '2026-09-07T01:02:00.000Z', status: 'ok', sessionId: 'sess-1' }],
    }),
    '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [TASK] }),
  })
  const { openSession } = renderModal()
  fireEvent.click(await screen.findByRole('button', { name: '运行历史' }))
  fireEvent.click(await screen.findByRole('button', { name: '查看会话' }))
  expect(openSession).toHaveBeenCalledWith('sess-1')
})
```

- [ ] **Step 5: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/schedule/`
Expected: FAIL（模块不存在）

- [ ] **Step 6: 实现 ScheduleModal + entry + index**

`packages/toolkit/src/client/schedule/ScheduleModal.tsx`：

```tsx
/** 定时任务管理模态框：任务列表（行内开关/编辑/删除两段确认/立即触发）+ 运行历史展开。 */
import { useState, type ReactNode } from 'react'
import { Button, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useLoadState } from '../shared/load-state.ts'
import { deleteTask, fetchRuns, fetchTasks, triggerTask, updateTask, type CronRun, type CronTaskView } from './api.ts'
import type { NS } from './locales.ts'
import type { ScheduleTaskDraft } from './TaskForm.tsx'
import css from './schedule.module.css'

type T = PropsLocale<typeof NS>['t']

export interface ScheduleModalProps {
  open: boolean
  onClose: () => void
  /** 打开运行历史对应会话（sessions.open 包装）。 */
  openSession: (sessionId: string) => void
  t: T
  /** 测试注入点；缺省走内部视图状态机（Task 12 接 TaskForm）。 */
  onEdit?: (task: CronTaskView) => void
  onCreate?: () => void
  /** Task 12 注入：渲染创建/编辑表单（draft 缺省 = 新建）。 */
  renderForm?: (draft: ScheduleTaskDraft | undefined, onSaved: () => void, onCancel: () => void) => ReactNode
}

type View = 'list' | { mode: 'create' } | { mode: 'edit'; task: CronTaskView }

/** 调度规则摘要（列表行内一行）。 */
export function scheduleSummary(task: CronTaskView): string {
  switch (task.schedule.kind) {
    case 'cron':
      return `cron: ${task.schedule.expr}${task.schedule.timeZone !== undefined ? ` (${task.schedule.timeZone})` : ''}`
    case 'at':
      return `at: ${new Date(task.schedule.at).toLocaleString()}`
    case 'every':
      return `every ${task.schedule.seconds}s`
  }
}

const RUN_STATUS_KEY: Record<CronRun['status'], 'run.ok' | 'run.error' | 'run.running' | 'run.skipped-overlap'> = {
  ok: 'run.ok',
  error: 'run.error',
  running: 'run.running',
  'skipped-overlap': 'run.skipped-overlap',
}

export function ScheduleModal(props: ScheduleModalProps): ReactNode {
  return (
    <Modal open={props.open} onClose={props.onClose} title={props.t('modal.title')} closeLabel={props.t('modal.close')} className={css.dialog}>
      {props.open && <ScheduleModalBody {...props} />}
    </Modal>
  )
}

function ScheduleModalBody({ onClose: _onClose, ...props }: ScheduleModalProps): ReactNode {
  const { t, openSession } = props
  const [view, setView] = useState<View>('list')
  const { state, reload } = useLoadState<CronTaskView[]>(() => fetchTasks(), [])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  async function remove(task: CronTaskView): Promise<void> {
    if (confirmDeleteId !== task.id) {
      setConfirmDeleteId(task.id)
      setError(null)
      return
    }
    try {
      await deleteTask(task.id)
      setConfirmDeleteId(null)
      reload()
    } catch (e) {
      setError(t('list.deleteFailed', { message: e instanceof Error ? e.message : String(e) }))
    }
  }

  async function toggleEnabled(task: CronTaskView): Promise<void> {
    try {
      await updateTask(task.id, { enabled: !task.enabled })
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function trigger(task: CronTaskView): Promise<void> {
    try {
      await triggerTask(task.id)
      reload()
    } catch (e) {
      setError(t('list.triggerFailed', { message: e instanceof Error ? e.message : String(e) }))
    }
  }

  if (view !== 'list' && props.renderForm !== undefined) {
    return <>{props.renderForm(
      view === 'list' ? undefined : view.mode === 'edit' ? view.task : undefined,
      () => { reload(); setView('list') },
      () => { setView('list') },
    )}</>
  }

  return (
    <>
      {state.kind === 'loading' && <p>{t('list.loading')}</p>}
      {state.kind === 'error' && <p>{t('list.error')}</p>}
      {state.kind === 'ok' && state.data.length === 0 && <p>{t('list.empty')}</p>}
      {state.kind === 'ok' && state.data.map((task) => (
        <div key={task.id}>
          <div className={css.row}>
            <input
              type="checkbox"
              aria-label={task.name}
              checked={task.enabled}
              onChange={() => { void toggleEnabled(task) }}
            />
            <button type="button" className={css.main}
              onClick={() => { setConfirmDeleteId(null); props.onEdit !== undefined ? props.onEdit(task) : setView({ mode: 'edit', task }) }}>
              <span className={css.name}>{task.name}</span>
              <span className={css.meta}>
                {scheduleSummary(task)}
                {' · '}
                {task.target.kind === 'main' ? t('list.targetMain') : t('list.targetRole', { roleId: task.target.roleId })}
                {' · '}
                {task.enabled && task.nextRunAt !== null
                  ? t('list.nextRun', { time: new Date(task.nextRunAt).toLocaleString() })
                  : t('list.noNextRun')}
              </span>
            </button>
            {task.lastRun !== undefined && <Pill>{t(RUN_STATUS_KEY[task.lastRun.status])}</Pill>}
            <button type="button" onClick={() => { setExpandedId(expandedId === task.id ? null : task.id) }}>
              {t('list.history')}
            </button>
            <button type="button" onClick={() => { void trigger(task) }}>{t('list.trigger')}</button>
            <button type="button" onClick={() => { void remove(task) }}>
              {confirmDeleteId === task.id ? t('list.confirmDelete') : t('list.delete')}
            </button>
          </div>
          {expandedId === task.id && <RunHistory taskId={task.id} openSession={openSession} t={t} />}
        </div>
      ))}
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
      <Button variant="primary" className={css.createButton}
        onClick={() => { setConfirmDeleteId(null); props.onCreate !== undefined ? props.onCreate() : setView({ mode: 'create' }) }}>
        {t('list.create')}
      </Button>
    </>
  )
}

function RunHistory({ taskId, openSession, t }: { taskId: string; openSession: (id: string) => void; t: T }): ReactNode {
  const { state } = useLoadState<CronRun[]>(() => fetchRuns(taskId), [taskId])
  if (state.kind !== 'ok') return <p className={css.runs}>{t('list.loading')}</p>
  if (state.data.length === 0) return <p className={css.runs}>{t('list.historyEmpty')}</p>
  return (
    <div className={css.runs}>
      {state.data.map((run) => (
        <div key={run.id} className={css.runRow}>
          <span>{new Date(run.triggeredAt).toLocaleString()}</span>
          <Pill>{t(RUN_STATUS_KEY[run.status])}</Pill>
          {run.finishedAt !== undefined && (
            <span>{Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.triggeredAt)) / 1000))}s</span>
          )}
          {run.error !== undefined && <span className={css.error}>{run.error}</span>}
          {run.sessionId !== undefined && (
            <button type="button" onClick={() => { openSession(run.sessionId as string) }}>
              {t('run.openSession')}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
```

`packages/toolkit/src/client/schedule/entry.tsx`：

```tsx
/** 定时任务侧边栏底栏入口：createSidebarEntry 工厂产物（order 紧随 bots=1），点击打开任务管理模态框。 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 触发 ui-sidebar 对 SlotMap 的声明合并（sidebar.footer.action 键与 owner props）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { createSidebarEntry } from '../shared/entry.tsx'
import { ScheduleModal } from './ScheduleModal.tsx'
import type { NS } from './locales.ts'
import type { ScheduleTaskDraft } from './TaskForm.tsx'

/** 时钟图标（ui-primitives 无现成时钟图标，内联 16px outline SVG）。 */
const IconClock = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" />
    <path d="M8 4.5V8L10.5 9.5" stroke="currentColor" strokeLinecap="round" />
  </svg>
)

/** 入口需透传给模态框的运行时注入：openSession（宿主 sessions 服务包装）+ t（slot locale 声明注入）+ renderForm（Task 12）。 */
type ScheduleExtra = {
  openSession: (sessionId: string) => void
  renderForm?: ScheduleModalRenderForm
}

type ScheduleModalRenderForm = NonNullable<Parameters<typeof ScheduleModal>[0]['renderForm']>

const SidebarEntry = createSidebarEntry<ScheduleExtra & { t: PropsLocale<typeof NS>['t'] }>({
  id: 'dsh-agent-toolkit:schedule',
  order: 2,
  icon: IconClock,
  title: '定时任务',
  renderModal: (p) => <ScheduleModal {...p} />,
})

export function ScheduleEntry(props: PropsRuntime<'sidebar.footer.action'> & PropsLocale<typeof NS> & ScheduleExtra): ReactNode {
  return <SidebarEntry wide={props.wide} t={props.t} openSession={props.openSession} renderForm={props.renderForm} />
}
```

`packages/toolkit/src/client/schedule/index.ts`：

```ts
/** dsh-agent-toolkit schedule 浏览器半：注册侧边栏底栏入口 + 文案词典。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// 触发 dsh-client-locale 对 Context.locale 的声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 触发 ui-sidebar 对 SlotMap 的声明合并（sidebar.footer.action 键）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { ScheduleEntry } from './entry.tsx'
import { en, NS, zh, type ScheduleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 定时任务面板文案。 */
    'agent-schedule': ScheduleKey
  }
}

export function setupScheduleClient(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agent-toolkit: schedule dictionaries')
  // dsh-session (Node half's JsonValue type source) declares the same-named
  // Context.sessions, shadowing the client ISessions type — restore the face
  // the runtime actually serves（delegate/index.ts 同款注释与强转）。
  const sessions = ctx.sessions as unknown as ISessions
  const openSession = (sessionId: string): void => { sessions.open(sessionId as SessionId) }
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'dsh-agent-toolkit:schedule', order: 2, locale: NS },
      (props) => ScheduleEntry({ ...props, openSession }),
    ))
}
```

`packages/toolkit/src/client/schedule/TaskForm.tsx` 本任务先建**占位实现**（Task 12 替换为完整表单）：

```tsx
/** 定时任务编辑表单（Task 12 完整实现；本任务仅占位以让列表视图可编译）。 */
import type { ReactNode } from 'react'
import type { CronTaskView } from './api.ts'

/** 新建/编辑草稿：编辑 = 既有任务视图。 */
export type ScheduleTaskDraft = CronTaskView

export function TaskForm(): ReactNode {
  return null
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/schedule/`
Expected: PASS（5 个测试全绿）

- [ ] **Step 8: Commit**

```bash
git add packages/toolkit/src/client/schedule/
git commit -m "feat: cron sidebar entry and task list modal with run history"
```

---

### Task 12: 浏览器半——编辑表单 TaskForm + client/index.ts 注册

**Files:**
- Modify: `packages/toolkit/src/client/schedule/TaskForm.tsx`（完整实现替换占位）
- Modify: `packages/toolkit/src/client/schedule/index.ts`（register 组件闭包注入 renderForm）
- Modify: `packages/toolkit/src/client/index.ts`（调 setupScheduleClient）
- Test: `packages/toolkit/src/client/schedule/task-form.client.spec.tsx`
- Test: `packages/toolkit/src/client/schedule/schedule-entry.client.spec.tsx`（入口注册）

**Interfaces:**
- Consumes: Task 11 全部产物；`croner`（client bundle 内联——纯度门禁只拦 `@deepseek-ai/*` 与 Node 内建，croner 允许）
- Produces:
  - `TaskForm` props：`{ draft: ScheduleTaskDraft | undefined, t, onSaved: () => void, onCancel: () => void }`

**表单字段（spec §7）：** 名称、提示词（多行）、项目下拉（`/cron/projects`）、目标 radio（主 Agent / 角色下拉，`/dsh-agent-toolkit/api/agents`）、调度 radio 三选一（cron：表达式 + 可选时区 + 未来 3 次触发预览；at：datetime-local；every：秒数）、catchup、enabled。

- [ ] **Step 1: 写失败测试** `packages/toolkit/src/client/schedule/task-form.client.spec.tsx`

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskForm } from './TaskForm.tsx'
import { zh, type ScheduleKey } from './locales.ts'

function t(key: ScheduleKey, params?: Record<string, unknown>): string {
  let text: string = zh[key]
  for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v))
  return text
}

function stubFetch(routes: Record<string, (body?: unknown) => unknown>) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method ?? 'GET', body })
    const handler = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1]
    if (handler === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(handler(body)), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const BASE_ROUTES = {
  '/dsh-agent-toolkit/api/cron/projects': () => ({ projects: ['D:\\work', 'D:\\ops'] }),
  '/dsh-agent-toolkit/api/agents': () => [{ id: 'main', name: '主 Agent' }, { id: 'explorer', name: 'Explorer' }],
  '/dsh-agent-toolkit/api/cron/tasks': () => ({ task: {} }),
}

test('创建（cron + 角色）：payload 装配 schedule/target 判别联合；cron 预览渲染 3 次触发', async () => {
  const calls = stubFetch(BASE_ROUTES)
  const saved = vi.fn()
  render(<TaskForm draft={undefined} t={t} onSaved={saved} onCancel={() => undefined} />)

  await screen.findByRole('option', { name: 'D:\\work' })
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '日报' } })
  fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '写日报' } })
  fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'D:\\ops' } })
  fireEvent.click(screen.getByRole('radio', { name: '角色' }))
  fireEvent.change(screen.getByLabelText('角色'), { target: { value: 'explorer' } })
  fireEvent.change(screen.getByLabelText(/表达式/), { target: { value: '0 9 * * *' } })
  fireEvent.change(screen.getByLabelText(/时区/), { target: { value: 'Asia/Shanghai' } })

  // 预览：未来 3 次触发（croner 内联计算，不打网络）
  await screen.findByText('未来 3 次触发')
  const previewItems = document.querySelectorAll('[data-testid="cron-preview"] li')
  expect(previewItems.length).toBe(3)

  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const create = calls.find((c) => c.url === '/dsh-agent-toolkit/api/cron/tasks' && c.method === 'POST')
  expect(create?.body).toMatchObject({
    name: '日报', prompt: '写日报', cwd: 'D:\\ops',
    schedule: { kind: 'cron', expr: '0 9 * * *', timeZone: 'Asia/Shanghai' },
    target: { kind: 'role', roleId: 'explorer' },
    catchup: true, enabled: true,
  })
})

test('创建（every）：间隔秒数装配；<60 由服务端拒绝时展示错误', async () => {
  const calls = stubFetch({
    ...BASE_ROUTES,
    '/dsh-agent-toolkit/api/cron/tasks': () => { throw new Error('unreachable') },
  })
  // 用 400 响应模拟服务端拒绝：stubFetch 的 handler 返回值固定 200，改为直接校验 payload 装配。
  render(<TaskForm draft={undefined} t={t} onSaved={vi.fn()} onCancel={() => undefined} />)
  await screen.findByRole('option', { name: 'D:\\work' })
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '巡检' } })
  fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '巡检' } })
  fireEvent.click(screen.getByRole('radio', { name: '固定间隔' }))
  fireEvent.change(screen.getByLabelText(/间隔秒数/), { target: { value: '3600' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await vi.waitFor(() => {
    const create = calls.find((c) => c.method === 'POST')
    expect(create?.body).toMatchObject({ schedule: { kind: 'every', seconds: 3600 }, target: { kind: 'main' } })
  })
})

test('编辑：回填既有任务字段并 PUT', async () => {
  const calls = stubFetch({
    ...BASE_ROUTES,
    '/dsh-agent-toolkit/api/cron/tasks/task-1': () => ({ task: {} }),
  })
  const draft = {
    id: 'task-1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
    schedule: { kind: 'every', seconds: 7200 }, target: { kind: 'main' },
    catchup: false, enabled: false,
    nextRunAt: null, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
  } as const
  const saved = vi.fn()
  render(<TaskForm draft={draft} t={t} onSaved={saved} onCancel={() => undefined} />)
  await screen.findByRole('option', { name: 'D:\\work' })
  expect(screen.getByLabelText('名称')).toHaveProperty('value', '日报')
  expect(screen.getByLabelText(/间隔秒数/)).toHaveProperty('value', '7200')
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '晚报' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const put = calls.find((c) => c.method === 'PUT')
  expect(put?.url).toContain('task-1')
  expect(put?.body).toMatchObject({ name: '晚报', enabled: false, catchup: false })
})

test('保存失败：展示服务端错误消息', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/projects')) return new Response(JSON.stringify({ projects: ['D:\\work'] }), { status: 200 })
    if (url.includes('/agents')) return new Response(JSON.stringify([{ id: 'main', name: '主 Agent' }]), { status: 200 })
    return new Response(JSON.stringify({ error: '非法 cron 表达式' }), { status: 400 })
  }))
  render(<TaskForm draft={undefined} t={t} onSaved={vi.fn()} onCancel={() => undefined} />)
  await screen.findByRole('option', { name: 'D:\\work' })
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'x' } })
  fireEvent.change(screen.getByLabelText('提示词'), { target: { value: 'x' } })
  fireEvent.change(screen.getByLabelText(/表达式/), { target: { value: 'bad' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toContain('非法 cron 表达式')
})
```

`packages/toolkit/src/client/schedule/schedule-entry.client.spec.tsx`（照 `client/bots/bots-entry.client.spec.tsx` / `client/shared/entry.spec.tsx` 模式——先读它们对齐 fake ctx slots 断言方式）：

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ScheduleEntry } from './entry.tsx'
import { zh, type ScheduleKey } from './locales.ts'

function t(key: ScheduleKey, params?: Record<string, unknown>): string {
  let text: string = zh[key]
  for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v))
  return text
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('入口渲染图标按钮（aria-label 定时任务），点击开模态框', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ tasks: [] }), { status: 200 })))
  render(<ScheduleEntry wide t={t} openSession={vi.fn()} />)
  const trigger = screen.getByRole('button', { name: '定时任务' })
  expect(trigger).toBeDefined()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/schedule/`
Expected: FAIL（TaskForm 占位返回 null；entry props 缺 t/openSession 时类型错）

- [ ] **Step 3: 实现完整 TaskForm**（替换 `packages/toolkit/src/client/schedule/TaskForm.tsx` 占位）

```tsx
/** 定时任务创建/编辑表单：名称/提示词/项目下拉/目标 radio/调度三选一（cron 预览经内联 croner 计算）/catchup/enabled。 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Cron } from 'croner'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useLoadState } from '../shared/load-state.ts'
import { createTask, fetchAgents, fetchProjects, updateTask, type CronTaskInput } from './api.ts'
import type { CronSchedule, CronTarget } from '../../schedule/store.ts'
import type { NS } from './locales.ts'
import type { ScheduleTaskDraft } from './TaskForm.types.ts'
import css from './schedule.module.css'

type T = PropsLocale<typeof NS>['t']

export interface TaskFormProps {
  /** 编辑 = 既有任务；undefined = 新建。 */
  draft: ScheduleTaskDraft | undefined
  t: T
  onSaved: () => void
  onCancel: () => void
}

type ScheduleKind = CronSchedule['kind']

/** cron 未来 3 次触发预览（内联 croner；非法表达式返回空数组）。 */
function previewCron(expr: string, timeZone: string): number[] {
  if (expr.trim().split(/\s+/).length !== 5) return []
  try {
    return new Cron(expr, { paused: true, ...(timeZone !== '' ? { timezone: timeZone } : {}) })
      .nextRuns(3)
      .map((d) => d.getTime())
  } catch {
    return []
  }
}

export function TaskForm({ draft, t, onSaved, onCancel }: TaskFormProps): ReactNode {
  const [name, setName] = useState(draft?.name ?? '')
  const [prompt, setPrompt] = useState(draft?.prompt ?? '')
  const [cwd, setCwd] = useState(draft?.cwd ?? '')
  const [targetKind, setTargetKind] = useState<CronTarget['kind']>(draft?.target.kind ?? 'main')
  const [roleId, setRoleId] = useState(draft?.target.kind === 'role' ? draft.target.roleId : '')
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(draft?.schedule.kind ?? 'cron')
  const [cronExpr, setCronExpr] = useState(draft?.schedule.kind === 'cron' ? draft.schedule.expr : '0 9 * * *')
  const [timeZone, setTimeZone] = useState(draft?.schedule.kind === 'cron' ? (draft.schedule.timeZone ?? '') : '')
  const [atTime, setAtTime] = useState(draft?.schedule.kind === 'at' ? draft.schedule.at.slice(0, 16) : '')
  const [everySeconds, setEverySeconds] = useState(draft?.schedule.kind === 'every' ? String(draft.schedule.seconds) : '3600')
  const [catchup, setCatchup] = useState(draft?.catchup ?? true)
  const [enabled, setEnabled] = useState(draft?.enabled ?? true)
  const [error, setError] = useState<string | null>(null)

  const { state: projectsState } = useLoadState<string[]>(() => fetchProjects(), [])
  const { state: agentsState } = useLoadState(() => fetchAgents(), [])
  const projects = projectsState.kind === 'ok' ? projectsState.data : []
  const roles = (agentsState.kind === 'ok' ? agentsState.data : []).filter((a) => a.id !== 'main')

  // 项目下拉缺省选中第一项（新建时）。
  useEffect(() => {
    if (cwd === '' && projects.length > 0) setCwd(projects[0])
  }, [projects, cwd])

  const preview = useMemo(
    () => (scheduleKind === 'cron' ? previewCron(cronExpr, timeZone) : []),
    [scheduleKind, cronExpr, timeZone],
  )

  function buildInput(): CronTaskInput {
    const schedule: CronSchedule =
      scheduleKind === 'cron'
        ? { kind: 'cron', expr: cronExpr, ...(timeZone !== '' ? { timeZone } : {}) }
        : scheduleKind === 'at'
          ? { kind: 'at', at: new Date(atTime).toISOString() }
          : { kind: 'every', seconds: Number(everySeconds) }
    const target: CronTarget = targetKind === 'role' ? { kind: 'role', roleId } : { kind: 'main' }
    return { name, prompt, cwd, schedule, target, catchup, enabled }
  }

  async function save(): Promise<void> {
    setError(null)
    try {
      const input = buildInput()
      if (draft === undefined) await createTask(input)
      else await updateTask(draft.id, input)
      onSaved()
    } catch (e) {
      setError(t('form.saveFailed', { message: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save() }}>
      <label className={css.field}>
        {t('form.name')}
        <input value={name} onChange={(e) => { setName(e.target.value) }} required />
      </label>
      <label className={css.field}>
        {t('form.prompt')}
        <textarea value={prompt} onChange={(e) => { setPrompt(e.target.value) }} rows={5} required />
      </label>
      <label className={css.field}>
        {t('form.project')}
        <select value={cwd} onChange={(e) => { setCwd(e.target.value) }}>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <fieldset className={css.field}>
        <legend>{t('form.target')}</legend>
        <label>
          <input type="radio" name="target" checked={targetKind === 'main'} onChange={() => { setTargetKind('main') }} />
          {t('form.targetMain')}
        </label>
        <label>
          <input type="radio" name="target" checked={targetKind === 'role'} onChange={() => { setTargetKind('role') }} />
          {t('form.targetRole')}
        </label>
        {targetKind === 'role' && (
          <select aria-label={t('form.targetRole')} value={roleId} onChange={(e) => { setRoleId(e.target.value) }}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
      </fieldset>
      <fieldset className={css.field}>
        <legend>{t('form.schedule')}</legend>
        <label>
          <input type="radio" name="schedule" checked={scheduleKind === 'cron'} onChange={() => { setScheduleKind('cron') }} />
          {t('form.scheduleCron')}
        </label>
        <label>
          <input type="radio" name="schedule" checked={scheduleKind === 'at'} onChange={() => { setScheduleKind('at') }} />
          {t('form.scheduleAt')}
        </label>
        <label>
          <input type="radio" name="schedule" checked={scheduleKind === 'every'} onChange={() => { setScheduleKind('every') }} />
          {t('form.scheduleEvery')}
        </label>
        {scheduleKind === 'cron' && (
          <>
            <label className={css.field}>
              {t('form.cronExpr')}
              <input value={cronExpr} onChange={(e) => { setCronExpr(e.target.value) }} />
            </label>
            <label className={css.field}>
              {t('form.timeZone')}
              <input value={timeZone} onChange={(e) => { setTimeZone(e.target.value) }} placeholder="Asia/Shanghai" />
            </label>
            {preview.length > 0 && (
              <div data-testid="cron-preview">
                {t('form.preview')}
                <ul>
                  {preview.map((ms) => <li key={ms}>{new Date(ms).toLocaleString()}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
        {scheduleKind === 'at' && (
          <label className={css.field}>
            {t('form.atTime')}
            <input type="datetime-local" value={atTime} onChange={(e) => { setAtTime(e.target.value) }} />
          </label>
        )}
        {scheduleKind === 'every' && (
          <label className={css.field}>
            {t('form.everySeconds')}
            <input type="number" min={60} value={everySeconds} onChange={(e) => { setEverySeconds(e.target.value) }} />
          </label>
        )}
      </fieldset>
      <label>
        <input type="checkbox" checked={catchup} onChange={(e) => { setCatchup(e.target.checked) }} />
        {t('form.catchup')}
      </label>
      <label>
        <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked) }} />
        {t('form.enabled')}
      </label>
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
      <div className={css.actions}>
        <Button type="button" onClick={onCancel}>{t('form.cancel')}</Button>
        <Button variant="primary" type="submit">{t('form.save')}</Button>
      </div>
    </form>
  )
}
```

把 `ScheduleTaskDraft` 类型移到独立文件避免循环导入——`packages/toolkit/src/client/schedule/TaskForm.types.ts`：

```ts
/** TaskForm 草稿类型（独立文件避免 ScheduleModal ↔ TaskForm 循环导入）。 */
import type { CronTaskView } from './api.ts'

/** 新建/编辑草稿：编辑 = 既有任务视图。 */
export type ScheduleTaskDraft = CronTaskView
```

并同步修正 Task 11 产物中的 import（`ScheduleModal.tsx` 与 `entry.tsx` 的 `ScheduleTaskDraft` 改从 `./TaskForm.types.ts` 导入；TaskForm.tsx 不再导出该类型）。re-export 保持兼容：`TaskForm.tsx` 末尾加 `export type { ScheduleTaskDraft } from './TaskForm.types.ts'`。

- [ ] **Step 4: schedule/index.ts 注入 renderForm + client/index.ts 注册**

`packages/toolkit/src/client/schedule/index.ts` 的 slots.register 组件改为：

```ts
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'dsh-agent-toolkit:schedule', order: 2, locale: NS },
      (props) => ScheduleEntry({
        ...props,
        openSession,
        renderForm: (draft, onSaved, onCancel) =>
          TaskForm({ draft, t: props.t, onSaved, onCancel }),
      }),
    ))
```

（import 加 `TaskForm`；`props.t` 由 slot 的 `locale: NS` 声明注入——若类型不直通，照 delegate/index.ts 的 `PropsLocale` 组合模式调整注册组件参数类型。）

`packages/toolkit/src/client/index.ts`：
- import 加：`import { setupScheduleClient } from './schedule/index.ts'`
- apply 末尾（setupBotsClient 之后）加：`setupScheduleClient(ctx)`

- [ ] **Step 5: 全量测试 + 类型检查 + bundle**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（含 client 新 spec）
Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 无错误
Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 成功（确认 lib/client.js 构建期无纯度门禁报错——croner 应被打进 client bundle）

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/client/
git commit -m "feat: cron task form with schedule variants and client wiring"
```

---

### Task 13: 文档 + 全量门禁 + 发布前 parity 清单

**Files:**
- Modify: `AGENTS.md`（dsh 插件开发要点加 schedule 模块条目；目录结构不变）
- Modify: `docs/usage/config-reference.md`（补 `schedule.runTimeoutMinutes` / `schedule.runHistoryLimit` 两行）
- Create: `docs/usage/cron-tasks.md`（照 `docs/usage/feishu-bots.md` 结构与文风）
- Modify: `docs/usage/README.md`（索引加一行链到 cron-tasks.md）
- Modify: `docs/superpowers/specs/2026-09-07-cron-schedule-design.md`（状态行：已确认（待实施）→ 已实施）

- [ ] **Step 1: AGENTS.md 更新**

在「dsh 插件开发要点」节的 Agent 注册表条目后追加一条：

```markdown
- 定时任务（cron）：模块 `src/schedule/`（store/timing/executor/scheduler/service/tools/api/index 八文件；schema 单一来源 `src/schedule/store.ts`），存储域 `dsh_agent_toolkit_schedule`（表 tasks/runs/meta）；调度三选一（cron 仅 5 字段 / at RFC 3339 一次性 / every ≥60s 创建锚），croner 解析（dependencies 真实依赖 + Node 半 neverBundle）；30s `ctx.interval` tick + 启动 rearm（catchup 补跑/过期 at 作废）+ 内存重叠锁（skipped-overlap）；执行复用 channels 共享件（`role-assembly.ts` 角色装配、`agents-port.ts` AgentsPort 工厂——后者把插件自有会话记入 ownedSessions 供 cron_* 工具门控排除）；cron_* 工具经 agent/created + 存量 roots 注册进主 Agent scope（own 层；跳过 subagent 与 ownedSessions），同钩子探测宿主 schedule_create 并存并 warn（与 @deepseek-ai/dsh-schedule 互斥）；来源段 `dsh-agent-toolkit:schedule:task`（order 20）；Config `schedule.runTimeoutMinutes`（默认 60）/ `schedule.runHistoryLimit`（默认 20）；UI 面板 `src/client/schedule/`（侧边栏底栏 order 2「定时任务」+ locales NS agent-schedule）。
```

- [ ] **Step 2: 使用手册**

`docs/usage/config-reference.md`：照现有条目格式补 `schedule.runTimeoutMinutes`（默认 60，单次运行超时分钟数）与 `schedule.runHistoryLimit`（默认 20，每任务运行历史环形保留数）。

`docs/usage/cron-tasks.md`（照 feishu-bots.md 结构：功能简介 → 入口 → 字段说明 → 模型工具 → 注意事项）：

```markdown
# 定时任务（cron）

## 功能简介

定时让主 Agent 或注册表角色在**独立新会话**中执行提示词任务：cron 表达式 / 一次性时间 / 固定间隔三种调度，
停机漏跑可补跑，保留每任务最近 20 次运行历史（可跳转到对应会话）。

> 与宿主 `@deepseek-ai/dsh-schedule`（会话内提醒）**二选一**：两套工具并存会显著提高模型误选率，
> 且会话内提醒在会话冷时静默失败。检测到并存时插件会输出 warn 日志，请从组合中移除宿主 schedule。

## 入口

侧边栏底栏「定时任务」图标 → 任务管理模态框：列表（启用开关 / 编辑 / 删除两段确认 / 立即触发 / 运行历史）。

## 字段

- 名称、提示词（触发时作为新会话的 user message，须自包含）
- 项目（工作目录，下拉候选来自 workspace 列表）
- 目标：主 Agent（宿主默认模型）/ 角色（persona/模型/工具白名单随角色）
- 调度三选一：
  - cron：5 字段表达式（分 时 日 月 周；秒级/年字段不开放）+ 可选 IANA 时区（缺省 = 服务器进程时区），表单内实时预览未来 3 次触发
  - 一次性时间：RFC 3339，触发后即作废
  - 固定间隔：秒数（≥60），以创建时间为锚
- 停机补跑（catchup）：开 = 重启后补跑一次漏掉的触发；关 = 跳到下一未来触发点
- 启用开关

## 模型工具

主 Agent 可用 `cron_task_create / list / update / delete / trigger` 五个工具管理任务（subagent 与 bot 会话不可见）。

## 注意事项

- 同任务上次未结束时到点不并发执行，记一条「跳过（上次未结束）」运行。
- 单次运行超过 `schedule.runTimeoutMinutes`（默认 60 分钟）未空闲会被取消并记为失败。
- 消息推送（如发飞书群）不内建：在任务提示词里指引执行 Agent 自行调用飞书工具完成。
```

`docs/usage/README.md` 索引加一行链接。

- [ ] **Step 3: spec 状态翻转**

`docs/superpowers/specs/2026-09-07-cron-schedule-design.md` 第 3 行：`状态：已确认（待实施）` → `状态：已实施`。

- [ ] **Step 4: 全量门禁**

Run: `pnpm --filter dsh-agent-toolkit test` + `pnpm --filter dsh-agent-toolkit typecheck` + `pnpm --filter dsh-agent-toolkit bundle`
Expected: 全部通过
Run: `pnpm --filter @dsh-agent-toolkit/token-usage test`（确认未波及）
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/usage/ docs/superpowers/specs/2026-09-07-cron-schedule-design.md
git commit -m "docs: cron schedule usage manual and AGENTS.md entry"
```

- [ ] **Step 6: 发布前 parity（人工执行，AGENTS.md 教训——不占自动门禁）**

安装版 dsh + npm 装插件跑一遍（或开发回路 link: 安装替代）：
1. `pnpm dsh web --patch cordis.yml` 启动；
2. 面板新建 cron 任务（`every 60s` 最快验证）→ 到点自动触发 → 运行历史出现 ok 记录 → 点击「查看会话」跳转；
3. 主会话里让模型用 `cron_task_list` 看到任务（验证工具注册进主 Agent scope）；
4. 面板停用任务 → 确认不再触发；删除任务 → 运行历史连带清空；
5. 重启 dsh（制造停机漏跑）→ catchup=true 任务启动后补跑一次。
