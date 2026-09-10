# 子 Agent 模型/Provider 可见性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 委派卡与子会话头部显示子 Agent 的 LLM provider/model（委派时解析的值，全程一致）。

**Architecture:** team_delegate 执行时解析路由（`role.model ?? parent.options.{provider,model}`），写三个出口：进程内在途表（运行中卡片轮询）、`presentationMeta`（结束后/回放）、持久存储域 `dsh_agent_toolkit_routes`（子会话头部 chip 经插件 HTTP 端点读取）。浏览器半新增两个 chip 渲染点。

**Tech Stack:** TypeScript / vitest（Node 半 node 环境，浏览器半 jsdom + @testing-library/react）/ cordis 插件 / dsh 存储域 / CSS Modules（--dsw-* token）。

设计依据：`docs/superpowers/specs/2026-09-01-subagent-model-visibility-design.md`

## Global Constraints

- 工作目录 `packages/toolkit`；测试与源码同目录（`src/**/*.test.ts(x)`），jsdom 测试文件首行 `// @vitest-environment jsdom`
- 单测 `pnpm --filter dsh-agent-toolkit test`；类型检查 `pnpm --filter dsh-agent-toolkit typecheck`；构建 `pnpm --filter dsh-agent-toolkit bundle`
- 代码注释与产品文案风格跟随现有文件（toolkit 注释中文；zh 文案为真源，en 键集严格一致）
- CSS 只用 `--dsw-*` token，禁字面颜色
- 不修改 `deepseek-harness/` 宿主源码；不动模型可见输出（工具 result 文本不变）
- `agentToolkitDomain`（v1）布局不变；新数据进新域 `dsh_agent_toolkit_routes`（v1）
- **git commit 前必须先经用户确认**（仓库规则）；各 Task 的 Commit 步骤一律先问再执行
- 语义红线：provider 或 model 任一缺失则全链路省略（不渲染 chip、不写 meta、不写存储），不猜部署默认

---

### Task 1: 在途委派路由表（Node 半）

**Files:**
- Create: `packages/toolkit/src/delegate/active.ts`
- Test: `packages/toolkit/src/delegate/active.test.ts`

**Interfaces:**
- Produces: `DelegateRoute`（`{ readonly provider: string; readonly model: string }`）、`ActiveRoutes`（`set(parentSessionId, roleId, route)` / `get(parentSessionId, roleId): DelegateRoute | undefined` / `delete(parentSessionId, roleId)`）、`createActiveRoutes(): ActiveRoutes`——Task 3/4 消费。

- [ ] **Step 1: 写失败测试**

```ts
// packages/toolkit/src/delegate/active.test.ts
import { expect, test } from 'vitest'
import { createActiveRoutes } from './active.ts'

test('set 后 get 命中；delete 后 get 落空', () => {
  const active = createActiveRoutes()
  active.set('s1', 'reviewer', { provider: 'deepseek', model: 'deepseek-reasoner' })
  expect(active.get('s1', 'reviewer')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  active.delete('s1', 'reviewer')
  expect(active.get('s1', 'reviewer')).toBeUndefined()
})

test('同 key 后写覆盖；不同 session/role 互不影响', () => {
  const active = createActiveRoutes()
  active.set('s1', 'r', { provider: 'a', model: 'm1' })
  active.set('s1', 'r', { provider: 'a', model: 'm2' })
  active.set('s2', 'r', { provider: 'b', model: 'm3' })
  expect(active.get('s1', 'r')).toEqual({ provider: 'a', model: 'm2' })
  expect(active.get('s2', 'r')).toEqual({ provider: 'b', model: 'm3' })
  active.delete('s1', 'r')
  expect(active.get('s2', 'r')).toEqual({ provider: 'b', model: 'm3' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/active.test.ts`
Expected: FAIL（`./active.ts` 不存在）

- [ ] **Step 3: 实现**

```ts
// packages/toolkit/src/delegate/active.ts
/** 在途委派路由表：运行中委派卡模型 chip 的数据源（进程内，HMR/重启即清空，settle 后由 presentationMeta 兜底）。 */

/** 一条已解析的委派路由（委派时确定，全程一致）。 */
export interface DelegateRoute {
  readonly provider: string
  readonly model: string
}

export interface ActiveRoutes {
  /** startRun 前写入；同 key 并发委派后写覆盖（纯展示，可接受）。 */
  set(parentSessionId: string, roleId: string, route: DelegateRoute): void
  /** 端点读取；无条目返回 undefined。 */
  get(parentSessionId: string, roleId: string): DelegateRoute | undefined
  /** try/finally 删除（startRun 抛错、settle 成功/出错都删）。 */
  delete(parentSessionId: string, roleId: string): void
}

export function createActiveRoutes(): ActiveRoutes {
  const map = new Map<string, DelegateRoute>()
  const key = (sessionId: string, roleId: string): string => `${sessionId}:${roleId}`
  return {
    set: (sessionId, roleId, route) => { map.set(key(sessionId, roleId), route) },
    get: (sessionId, roleId) => map.get(key(sessionId, roleId)),
    delete: (sessionId, roleId) => { map.delete(key(sessionId, roleId)) },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/active.test.ts`
Expected: PASS（2 个测试）

- [ ] **Step 5: 经用户确认后提交**

`git add packages/toolkit/src/delegate/active.ts packages/toolkit/src/delegate/active.test.ts`；message：`feat(toolkit): add in-flight delegation route table`

---

### Task 2: 持久委派路由存储域（Node 半）

**Files:**
- Create: `packages/toolkit/src/delegate/routes.ts`
- Test: `packages/toolkit/src/delegate/routes.test.ts`

**Interfaces:**
- Produces: `DelegationRouteRecord`（`{ provider: string; model: string; at: number }`）、`DelegationRouteRecordSchema`（zod）、`delegationRoutesDomain`（DomainSpec，name `dsh_agent_toolkit_routes`，v1，表 `routes`，key = childSessionId）——Task 3（recordRoute 写入）与 Task 4（端点读取、`src/index.ts` 打开域）消费。

- [ ] **Step 1: 写失败测试**

```ts
// packages/toolkit/src/delegate/routes.test.ts
import { expect, test } from 'vitest'
import { delegationRoutesDomain, DelegationRouteRecordSchema } from './routes.ts'

test('域声明：name/version/表布局', () => {
  expect(delegationRoutesDomain.name).toBe('dsh_agent_toolkit_routes')
  expect(delegationRoutesDomain.version).toBe(1)
  expect(Object.keys(delegationRoutesDomain.tables)).toEqual(['routes'])
})

test('记录 schema：合法通过，缺字段/错类型拒绝', () => {
  expect(DelegationRouteRecordSchema.safeParse({ provider: 'deepseek', model: 'deepseek-chat', at: 1 }).success).toBe(true)
  expect(DelegationRouteRecordSchema.safeParse({ provider: 'deepseek', model: 'deepseek-chat' }).success).toBe(false)
  expect(DelegationRouteRecordSchema.safeParse({ provider: 1, model: 'm', at: 1 }).success).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/routes.test.ts`
Expected: FAIL（`./routes.ts` 不存在）

- [ ] **Step 3: 实现**

```ts
// packages/toolkit/src/delegate/routes.ts
/** 委派路由持久存储域：子会话头部 chip 的数据源（schema 与 domain 布局的单一来源在本文件）。 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 一条持久化的委派路由记录。at = 写入时间戳（预留清理依据，暂无自动清理）。 */
export interface DelegationRouteRecord {
  provider: string
  model: string
  at: number
}

export const DelegationRouteRecordSchema = z.object({
  provider: z.string(),
  model: z.string(),
  at: z.number(),
})

// 独立于 agentToolkitDomain（v1 布局不变）：domain version 是格式版本，
// 改既有域表结构会 version-mismatch 拒绝存量介质且无迁移。
export const delegationRoutesDomain = defineDomain({
  name: 'dsh_agent_toolkit_routes',
  version: 1,
  tables: {
    // key = childSessionId（本地 run 的 run.id 契约上即子 session id）
    routes: domainTable<string, DelegationRouteRecord>(DelegationRouteRecordSchema),
  },
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/routes.test.ts`
Expected: PASS

- [ ] **Step 5: 经用户确认后提交**

`git add packages/toolkit/src/delegate/routes.ts packages/toolkit/src/delegate/routes.test.ts`；message：`feat(toolkit): add persistent delegation-route domain`

---

### Task 3: team_delegate 路由解析与三个出口（Node 半核心）

**Files:**
- Modify: `packages/toolkit/src/delegate/tool.ts`
- Test: `packages/toolkit/src/delegate/tool.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ActiveRoutes`/`DelegateRoute`
- Produces: `DelegateToolDeps` 新增两个必填字段——`active: ActiveRoutes`、`recordRoute: (childSessionId: string, route: DelegateRoute) => Promise<void>`（Task 4 装配实现）；工具返回值新增可选 `provider`/`model`（进 output schema 与 `presentationMeta`）。

- [ ] **Step 1: 改造既有测试基建并补失败测试**

`tool.test.ts` 的 parent mock 补 `session.id`，`depsWith` 补新 deps：

```ts
// 既有行替换：
const parent = { options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as Agent
// 改为：
const parent = {
  options: { provider: 'deepseek', model: 'deepseek-chat' },
  session: { id: 'parent-session-1' },
} as unknown as Agent
```

```ts
// depsWith 改为（新增 import：createActiveRoutes/ActiveRoutes/DelegateRoute from './active.ts'）：
function depsWith(
  run: SubagentRun,
  captured: Captured[],
  buildPersona: (role: AgentRecord) => string = fakePersona,
  extras: { active?: ActiveRoutes; recordRoute?: (id: string, route: DelegateRoute) => Promise<void> } = {},
): DelegateToolDeps {
  return {
    roster: () => ROSTER,
    provider: 'spawn',
    buildPersona,
    startRun: async (provider, request) => { captured.push({ provider, request }); return run },
    active: extras.active ?? createActiveRoutes(),
    recordRoute: extras.recordRoute ?? (async () => {}),
  }
}
```

新增测试（追加到文件末尾）：

```ts
/** 读工具的 presentationMeta（output 面测试 casts，与既有 description 测试同法）。 */
function metaOf(tool: unknown, value: Record<string, unknown>): Record<string, unknown> {
  return (tool as unknown as {
    output: { presentationMeta: (args: unknown, v: Record<string, unknown>) => Record<string, unknown> }
  }).output.presentationMeta({}, value)
}

test('角色有 model：路由=角色覆盖；在途条目 startRun 前可见、settle 后删除；recordRoute 收到子会话坐标；meta 透出', async () => {
  const active = createActiveRoutes()
  const recorded: { id: string; route: DelegateRoute }[] = []
  const captured: Captured[] = []
  const run = okRun([{ type: 'text', text: '结论' } as ContentBlock])
  const deps = depsWith(run, captured, fakePersona, {
    active,
    recordRoute: async (id, route) => { recorded.push({ id, route }) },
  })
  // startRun 时在途条目已写入（运行中卡片的读取窗口）。spread 拷贝绕开 readonly。
  const checkingDeps: DelegateToolDeps = {
    ...deps,
    startRun: async (p, req) => {
      expect(active.get('parent-session-1', 'reviewer')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
      return deps.startRun(p, req)
    },
  }
  const tool = createDelegateTool('team_delegate', checkingDeps)
  const result = await callTool(tool, { role: 'reviewer', description: '审查', prompt: '任务' }) as Record<string, unknown>
  expect(result.provider).toBe('deepseek')
  expect(result.model).toBe('deepseek-reasoner')
  expect(recorded).toEqual([{ id: 'child-session-1', route: { provider: 'deepseek', model: 'deepseek-reasoner' } }])
  expect(active.get('parent-session-1', 'reviewer')).toBeUndefined() // settle 后删除
  expect(metaOf(tool, result)).toMatchObject({
    role: 'reviewer', childSessionId: 'child-session-1',
    provider: 'deepseek', model: 'deepseek-reasoner',
  })
})

test('角色无 model：路由继承父 options', async () => {
  const recorded: { id: string; route: DelegateRoute }[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [], fakePersona, {
    recordRoute: async (id, route) => { recorded.push({ id, route }) },
  }))
  const result = await callTool(tool, { role: 'worker', description: '执行', prompt: '任务' }) as Record<string, unknown>
  expect(result.provider).toBe('deepseek')
  expect(result.model).toBe('deepseek-chat')
  expect(recorded).toEqual([{ id: 'child-session-1', route: { provider: 'deepseek', model: 'deepseek-chat' } }])
})

test('父 options 不完整且角色无覆盖：全链路省略（无 meta/无在途/无持久写）', async () => {
  const active = createActiveRoutes()
  let recordCalls = 0
  const bareParent = { options: {}, session: { id: 'p2' } } as unknown as Agent
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [], fakePersona, {
    active,
    recordRoute: async () => { recordCalls += 1 },
  }))
  const result = await callTool(tool, { role: 'worker', description: 'x', prompt: 'y' },
    { agent: bareParent, signal: new AbortController().signal }) as Record<string, unknown>
  expect(result.provider).toBeUndefined()
  expect(result.model).toBeUndefined()
  expect(metaOf(tool, result).provider).toBeUndefined()
  expect(active.get('p2', 'worker')).toBeUndefined()
  expect(recordCalls).toBe(0)
})

test('settle 抛错路径：在途条目仍被 finally 删除；持久行已写（子会话确曾以该路由运行）', async () => {
  const active = createActiveRoutes()
  const recorded: string[] = []
  const run: SubagentRun = {
    id: 'child-err' as unknown as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve<SubagentResult>({ stopReason: 'error', output: [] } as SubagentResult),
    dispose: () => Promise.resolve(),
  } as unknown as SubagentRun
  const tool = createDelegateTool('team_delegate', depsWith(run, [], fakePersona, {
    active,
    recordRoute: async (id) => { recorded.push(id) },
  }))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' })).rejects.toThrow()
  expect(active.get('parent-session-1', 'reviewer')).toBeUndefined()
  expect(recorded).toEqual(['child-err'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/tool.test.ts`
Expected: FAIL（`active`/`recordRoute` 不在 DelegateToolDeps；返回值/meta 无 provider/model）

- [ ] **Step 3: 实现 tool.ts 改造**

四处改动（其余不动）：

```ts
// 1) import 区追加：
import type { ActiveRoutes, DelegateRoute } from './active.ts'

// 2) DelegateToolDeps 追加两个字段：
  /** 在途表：运行中委派卡 chip 的数据源。 */
  readonly active: ActiveRoutes
  /** 持久路由写入（子会话头部 chip 数据源）；实现方保证不抛错语义由调用处 catch 兜底。 */
  readonly recordRoute: (childSessionId: string, route: DelegateRoute) => Promise<void>

// 3) settleForegroundRun 签名加可选 route，成功返回值尾部追加：
async function settleForegroundRun(run: SubagentRun, roleId: string, route?: DelegateRoute) {
  // ……run.result.then 内 return 改为：
      return {
        kind: 'foreground' as const,
        role: roleId,
        runId: String(run.id),
        childSessionId,
        output: result.output as unknown as JsonValue[],
        ...route !== undefined ? { provider: route.provider, model: route.model } : {},
      }

// 4) output.schema properties 追加（可选，不写 required）：
        provider: { type: 'string' },
        model: { type: 'string' },

// 5) presentationMeta 透传：
      presentationMeta: (_args, value) => ({
        role: value.role as string,
        runId: value.runId as string,
        childSessionId: value.childSessionId as string,
        ...typeof value.provider === 'string' && typeof value.model === 'string'
          ? { provider: value.provider, model: value.model }
          : {},
      }),

// 6) execute 内（role 查找之后、startRun 之前起）改为：
      // 路由解析与 spawn driver resolveChildAgentOptions 同源：角色覆盖 ?? 父 options。
      // 任一缺失整体省略（不猜部署默认——显示错值比不显示更糟）。
      const route: DelegateRoute | undefined = role.model
        ?? (typeof parent.options.provider === 'string' && parent.options.provider !== ''
            && typeof parent.options.model === 'string' && parent.options.model !== ''
          ? { provider: parent.options.provider, model: parent.options.model }
          : undefined)
      const parentSessionId = String(parent.session.id)
      if (route !== undefined) deps.active.set(parentSessionId, role.id, route)
      try {
        const run = await deps.startRun(deps.provider, request)
        if (route !== undefined) {
          // 展示向写入失败不阻断委派（域关闭等异常吞掉）。
          await deps.recordRoute(String(run.id), route).catch(() => undefined)
        }
        return await settleForegroundRun(run, role.id, route)
      } finally {
        if (route !== undefined) deps.active.delete(parentSessionId, role.id)
      }
```

注意 `parent.session.id` 类型是 branded `SessionId`，map key 用 `String(...)` 归一。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/tool.test.ts`
Expected: PASS（含既有全部测试）

- [ ] **Step 5: 经用户确认后提交**

`git add packages/toolkit/src/delegate/tool.ts packages/toolkit/src/delegate/tool.test.ts`；message：`feat(toolkit): resolve delegation route and expose it via meta/active/persistent exits`

---

### Task 4: delegate HTTP 端点与装配（Node 半）

**Files:**
- Create: `packages/toolkit/src/delegate/api.ts`
- Test: `packages/toolkit/src/delegate/api.test.ts`
- Modify: `packages/toolkit/src/delegate/index.ts`（setupDelegate 加第 4 参）
- Modify: `packages/toolkit/src/index.ts:95-108`（打开路由域、接线）

**Interfaces:**
- Consumes: Task 1 `ActiveRoutes`；Task 2 `delegationRoutesDomain`/`DelegationRouteRecord`；Task 3 `DelegateToolDeps.active`/`recordRoute`
- Produces: `createDelegateApiHandler(deps)`、`setupDelegateApi(ctx, deps)`（deps = `{ active: ActiveRoutes; routes: { get(childSessionId: string): DelegationRouteRecord | undefined } }`）；端点 `GET /dsh-agent-toolkit/api/delegate/active?session=&role=` 与 `GET /dsh-agent-toolkit/api/delegate/route?session=`（200 `{provider, model}` | 404）——Task 5/6 浏览器半消费。

- [ ] **Step 1: 写失败测试**（req/res mock 模式照 `src/agents/api.test.ts:9-32`）

```ts
// packages/toolkit/src/delegate/api.test.ts
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { expect, test } from 'vitest'
import { createActiveRoutes } from './active.ts'
import { createDelegateApiHandler, type DelegateApiDeps } from './api.ts'
import type { DelegationRouteRecord } from './routes.ts'

function mockReq(method: string, url: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage
  req.method = method
  req.url = url
  req.headers = {}
  return req
}

type MockRes = ServerResponse & { status: number; body: string }

function mockRes(): MockRes {
  const res = { status: 0, body: '' } as MockRes
  res.writeHead = ((code: number) => { res.status = code; return res }) as unknown as MockRes['writeHead']
  res.end = ((chunk?: unknown) => { if (typeof chunk === 'string') res.body = chunk; return res }) as unknown as MockRes['end']
  return res
}

function harness(overrides: Partial<DelegateApiDeps> = {}) {
  const routes = new Map<string, DelegationRouteRecord>()
  const deps: DelegateApiDeps = {
    active: createActiveRoutes(),
    routes: { get: (id) => routes.get(id) },
    ...overrides,
  }
  return { handler: createDelegateApiHandler(deps), deps, routes }
}

test('GET /delegate/active：命中 200，未命中/缺参 404', async () => {
  const { handler, deps } = harness()
  deps.active.set('s1', 'reviewer', { provider: 'deepseek', model: 'deepseek-reasoner' })
  const hit = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/delegate/active?session=s1&role=reviewer'), hit)
  expect(hit.status).toBe(200)
  expect(JSON.parse(hit.body)).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  const miss = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/delegate/active?session=s1&role=worker'), miss)
  expect(miss.status).toBe(404)
  const noParam = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/delegate/active'), noParam)
  expect(noParam.status).toBe(404)
})

test('GET /delegate/route：命中返回 provider/model（不带 at），未命中 404', async () => {
  const { handler, routes } = harness()
  routes.set('child-1', { provider: 'deepseek', model: 'deepseek-chat', at: 123 })
  const hit = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/delegate/route?session=child-1'), hit)
  expect(hit.status).toBe(200)
  expect(JSON.parse(hit.body)).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  const miss = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/delegate/route?session=nobody'), miss)
  expect(miss.status).toBe(404)
})

test('非 GET 405；未知路径 404', async () => {
  const { handler } = harness()
  const wrong = mockRes()
  await handler(mockReq('POST', '/dsh-agent-toolkit/api/delegate/active?session=s&role=r'), wrong)
  expect(wrong.status).toBe(405)
  const unknown = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/delegate/nope'), unknown)
  expect(unknown.status).toBe(404)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/api.test.ts`
Expected: FAIL（`./api.ts` 不存在）

- [ ] **Step 3: 实现 api.ts**

```ts
// packages/toolkit/src/delegate/api.ts
/** delegate RPC 端点：在途委派路由（运行中委派卡）+ 持久委派路由（子会话头部 chip）。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { json } from '../shared/http.ts'
import { registerOptionalRoutes } from '../shared/webserver.ts'
import type { ActiveRoutes } from './active.ts'
import type { DelegationRouteRecord } from './routes.ts'

export interface DelegateApiDeps {
  readonly active: ActiveRoutes
  /** 持久路由表读面（KvTable.get 同步读）。 */
  readonly routes: { get(childSessionId: string): DelegationRouteRecord | undefined }
}

export function createDelegateApiHandler(deps: DelegateApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sub = url.pathname.replace(/^\/dsh-agent-toolkit\/api/, '') || '/'
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (sub === '/delegate/active') {
      const route = deps.active.get(url.searchParams.get('session') ?? '', url.searchParams.get('role') ?? '')
      if (route === undefined) {
        json(res, 404, { error: 'not found' })
        return
      }
      json(res, 200, route)
      return
    }
    if (sub === '/delegate/route') {
      const record = deps.routes.get(url.searchParams.get('session') ?? '')
      if (record === undefined) {
        json(res, 404, { error: 'not found' })
        return
      }
      json(res, 200, { provider: record.provider, model: record.model })
      return
    }
    json(res, 404, { error: 'not found' })
  }
}

/**
 * 注册 delegate 路由（恒启用，与 agents 同策略）。webServer 为可选服务：
 * 缺席时经 registerOptionalRoutes 惰性不注册。prefix 先于 /api 兜底前缀命中。
 */
export function setupDelegateApi(ctx: Context, deps: DelegateApiDeps): void {
  const handler = createDelegateApiHandler(deps)
  registerOptionalRoutes(ctx, (webCtx) => {
    const unregister = webCtx.webServer.register({ kind: 'prefix', path: '/dsh-agent-toolkit/api/delegate', handler })
    return () => unregister()
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/api.test.ts`
Expected: PASS

- [ ] **Step 5: 装配接线**

`src/delegate/index.ts`：`setupDelegate` 加第 4 参并传入工具 deps——

```ts
// 追加 import：
import type { ActiveRoutes, DelegateRoute } from './active.ts'

/** setupDelegate 的存储/在途通道（Task 3 DelegateToolDeps 的两个新字段）。 */
export interface DelegateChannels {
  readonly active: ActiveRoutes
  readonly recordRoute: (childSessionId: string, route: DelegateRoute) => Promise<void>
}

// 签名改为：
export function setupDelegate(ctx: Context, config: DelegateConfig, registry: AgentRegistry, channels: DelegateChannels): void {
// mountTool 内 createDelegateTool 的 deps 追加：
//         active: channels.active,
//         recordRoute: channels.recordRoute,
```

`src/index.ts` apply 内（`setupDelegate` 调用之前插入；追加 import `delegationRoutesDomain`/`DelegationRouteRecord`、`createActiveRoutes`、`setupDelegateApi`）：

```ts
  const routesDomain = await openDomainSafely(ctx, delegationRoutesDomain, warn)
  const routesTable = routesDomain.table('routes') as KvTable<string, DelegationRouteRecord>
  const activeRoutes = createActiveRoutes()
  setupDelegate(ctx, {
    provider: config.provider,
    toolName: config.toolName,
    rules: config.rules,
  }, registry, {
    active: activeRoutes,
    recordRoute: async (childSessionId, route) => {
      await routesTable.put(childSessionId, { provider: route.provider, model: route.model, at: Date.now() })
    },
  })
  setupDelegateApi(ctx, { active: activeRoutes, routes: routesTable })
```

- [ ] **Step 6: 全量回归 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit test; pnpm --filter dsh-agent-toolkit typecheck`
Expected: 全绿（`src/index.test.ts` 若有 setupDelegate 调用签名的相关断言需同步——先跑看结果再修）

- [ ] **Step 7: 经用户确认后提交**

`git add packages/toolkit/src/delegate/api.ts packages/toolkit/src/delegate/api.test.ts packages/toolkit/src/delegate/index.ts packages/toolkit/src/index.ts`；message：`feat(toolkit): expose delegation routes via /api/delegate endpoints`

---

### Task 5: 委派卡模型 chip（浏览器半）

**Files:**
- Create: `packages/toolkit/src/client/delegate/api.ts`
- Modify: `packages/toolkit/src/client/delegate/delegate-card.tsx`
- Modify: `packages/toolkit/src/client/delegate/locales.ts`
- Test: `packages/toolkit/src/client/delegate/delegate-card.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 4 端点
- Produces: `fetchActiveRoute(sessionId: string, role: string): Promise<DelegateRoute | null>`、`fetchChildRoute(sessionId: string): Promise<DelegateRoute | null>`（Task 6 复用后者）；locales 新键 `card.modelAria`/`header.modelAria`。

- [ ] **Step 1: 写 fetch 封装 + locales 新键**

```ts
// packages/toolkit/src/client/delegate/api.ts
/** 委派路由查询封装（fetch → Node 半 /api/delegate 路由）。 */
export interface DelegateRoute {
  provider: string
  model: string
}

/** GET /delegate/active：运行中委派的已解析路由；404/失败 → null（不渲染 chip）。 */
export async function fetchActiveRoute(sessionId: string, role: string): Promise<DelegateRoute | null> {
  const res = await fetch(`/dsh-agent-toolkit/api/delegate/active?session=${encodeURIComponent(sessionId)}&role=${encodeURIComponent(role)}`)
  if (!res.ok) return null
  return res.json() as Promise<DelegateRoute>
}

/** GET /delegate/route：子会话的持久委派路由；404/失败 → null。 */
export async function fetchChildRoute(sessionId: string): Promise<DelegateRoute | null> {
  const res = await fetch(`/dsh-agent-toolkit/api/delegate/route?session=${encodeURIComponent(sessionId)}`)
  if (!res.ok) return null
  return res.json() as Promise<DelegateRoute>
}
```

`locales.ts` zh 追加 `'card.modelAria': '子 Agent 使用模型 {route}'`、`'header.modelAria': '子会话模型 {route}'`；en 对应 `'Subagent runs on {route}'`、`'Subagent session model {route}'`（键集一致由 `Record<AgentTeamKey, string>` 强制）。

- [ ] **Step 2: 写卡片失败测试**

```tsx
// packages/toolkit/src/client/delegate/delegate-card.test.tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { DelegateCard } from './delegate-card.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const ZH = {
  'card.viewChild': '查看子对话',
  'card.running': '成员执行中',
  'card.failed': '委派失败',
  'card.modelAria': '子 Agent 使用模型 {route}',
  'header.modelAria': '子会话模型 {route}',
} as const

type Key = keyof typeof ZH

function t(key: Key, params?: Record<string, unknown>): string {
  let text: string = ZH[key]
  for (const [k, v] of Object.entries(params ?? {})) text = text.replace(`{${k}}`, String(v))
  return text
}

const openChild = vi.fn()

function callBlock(args: Record<string, unknown>) {
  return { kind: 'tool-call', callId: 'c1', name: 'team_delegate', argsRaw: JSON.stringify(args), resultView: null, subCalls: [] }
}

function resultBlock(args: Record<string, unknown>, meta?: Record<string, unknown>) {
  return {
    kind: 'tool-result', callId: 'c1', name: 'team_delegate', argsRaw: JSON.stringify(args),
    content: [{ type: 'text', text: '结论' }], isError: false,
    call: { argsRaw: JSON.stringify(args) }, meta,
    resultView: null, subCalls: [],
  }
}

const ARGS = { role: 'reviewer', description: '审查登录模块', prompt: '请审查' }

function propsFor(block: unknown) {
  return { block, sessionId: 'parent-s1', openChild, t } as unknown as Parameters<typeof DelegateCard>[0]
}

test('运行中：轮询命中在途端点 → 渲染模型 chip', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ provider: 'deepseek', model: 'deepseek-reasoner' }),
  })))
  render(<DelegateCard {...propsFor(callBlock(ARGS))} />)
  expect(await screen.findByText('deepseek / deepseek-reasoner')).toBeTruthy()
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/dsh-agent-toolkit/api/delegate/active?session=parent-s1&role=reviewer'))
})

test('运行中：404 → 不渲染 chip', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
  render(<DelegateCard {...propsFor(callBlock(ARGS))} />)
  await waitFor(() => { expect(fetch).toHaveBeenCalled() })
  expect(screen.queryByText(/deepseek/)).toBeNull()
})

test('settled：读 meta 渲染 chip，不请求在途端点', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  render(<DelegateCard {...propsFor(resultBlock(ARGS, {
    role: 'reviewer', runId: 'r1', childSessionId: 'child-1', provider: 'deepseek', model: 'deepseek-chat',
  }))} />)
  expect(screen.getByText('deepseek / deepseek-chat')).toBeTruthy()
  expect(fetchMock).not.toHaveBeenCalled()
})

test('settled 旧事件（meta 无新字段）：不渲染 chip', () => {
  render(<DelegateCard {...propsFor(resultBlock(ARGS, { role: 'reviewer', runId: 'r1', childSessionId: 'child-1' }))} />)
  expect(screen.queryByText(/deepseek/)).toBeNull()
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/delegate/delegate-card.test.tsx`
Expected: FAIL（chip 不存在）

- [ ] **Step 4: 实现卡片改造**

`delegate-card.tsx` 改动：

```tsx
// import 区追加：
import { useEffect, useState } from 'react'  // 替换既有 useState import
import { fetchActiveRoute, type DelegateRoute } from './api.ts'

// DelegateMeta 接口改为：
interface DelegateMeta {
  readonly childSessionId?: SessionId
  readonly provider?: string
  readonly model?: string
}

// 模块级常量：
/** 运行中轮询间隔（命中/settled/卸载即停）。 */
const ACTIVE_POLL_MS = 1500

// DelegateCard 内（既有 useState(expanded) 之后）追加：
  const role = args.role
  const [activeRoute, setActiveRoute] = useState<DelegateRoute | null>(null)
  useEffect(() => {
    if (settled || role === undefined) return
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined
    const pull = (): void => {
      void fetchActiveRoute(String(sessionId), role).then((route) => {
        if (cancelled || route === null) return
        setActiveRoute(route)
        if (timer !== undefined) clearInterval(timer)
      }).catch(() => undefined)
    }
    pull()
    timer = setInterval(pull, ACTIVE_POLL_MS)
    return () => { cancelled = true; if (timer !== undefined) clearInterval(timer) }
  }, [settled, sessionId, role])

// settled 时取 meta，运行中取在途结果；error 无 meta → null：
  const route: DelegateRoute | null = settled
    ? (typeof meta?.provider === 'string' && typeof meta?.model === 'string'
      ? { provider: meta.provider, model: meta.model }
      : null)
    : activeRoute

// 渲染行内 role chip 之后追加：
        {route !== null && (
          <span className={css.chip} aria-label={t('card.modelAria', { route: `${route.provider} / ${route.model}` })}>
            {route.provider} / {route.model}
          </span>
        )}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/delegate/`
Expected: PASS

- [ ] **Step 6: 经用户确认后提交**

`git add packages/toolkit/src/client/delegate/`；message：`feat(toolkit): show resolved model chip on delegation card`

---

### Task 6: 子会话头部 chip（浏览器半）

**Files:**
- Create: `packages/toolkit/src/client/subagent-model/index.ts`
- Create: `packages/toolkit/src/client/subagent-model/SubagentModelChip.tsx`
- Create: `packages/toolkit/src/client/subagent-model/subagent-model.module.css`
- Test: `packages/toolkit/src/client/subagent-model/SubagentModelChip.test.tsx`
- Modify: `packages/toolkit/src/client/index.ts`（接线）
- Modify: `packages/toolkit/package.json`（devDep + dsh.client.inject）

**Interfaces:**
- Consumes: Task 5 的 `fetchChildRoute`、locales 键 `header.modelAria`（NS `agent-team` 已由 setupDelegateClient 注册词典）
- Produces: `setupSubagentModelClient(ctx: Context): void`；槽位注册 `{ name: 'conversation.session.header.utilities', id: 'subagent-model', order: 10, locale: NS }`

- [ ] **Step 1: package.json 依赖**

`devDependencies` 按字母序插入（`dsh-client-locale` 之后）：

```json
    "@deepseek-ai/dsh-client-ui-conversation": "link:../../deepseek-harness/packages/client/ui-conversation",
```

`dsh.client.inject` 数组加 `"@deepseek-ai/dsh-client-ui-conversation"`（信息性 boot-graph 边，照现有四行风格）。然后 `pnpm install` 使 link 生效。

- [ ] **Step 2: 写组件失败测试**

```tsx
// packages/toolkit/src/client/subagent-model/SubagentModelChip.test.tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { SubagentModelChip } from './SubagentModelChip.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const t = (key: string, params?: Record<string, unknown>): string => {
  const dict: Record<string, string> = { 'header.modelAria': '子会话模型 {route}' }
  let text = dict[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) text = text.replace(`{${k}}`, String(v))
  return text
}

function propsWith(subagent: unknown) {
  return {
    sessionId: 'child-1',
    useSession: (selector: (s: { subagent: unknown }) => unknown) => selector({ subagent }),
    t,
  } as unknown as Parameters<typeof SubagentModelChip>[0]
}

const ADDRESS = { parentSessionId: 'p1', childSessionId: 'child-1', mode: 'one-shot' }

test('非子会话：渲染 null，不发起 fetch', () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const { container } = render(<SubagentModelChip {...propsWith(null)} />)
  expect(container.firstChild).toBeNull()
  expect(fetchMock).not.toHaveBeenCalled()
})

test('子会话且路由命中：渲染 provider / model chip', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  })))
  render(<SubagentModelChip {...propsWith(ADDRESS)} />)
  expect(await screen.findByText('deepseek / deepseek-chat')).toBeTruthy()
  expect(fetch).toHaveBeenCalledWith('/dsh-agent-toolkit/api/delegate/route?session=child-1')
})

test('子会话但无路由记录（404）：渲染 null', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })))
  const { container } = render(<SubagentModelChip {...propsWith(ADDRESS)} />)
  await vi.waitFor(() => { expect(fetch).toHaveBeenCalled() })
  expect(container.firstChild).toBeNull()
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/subagent-model/`
Expected: FAIL（组件不存在）

- [ ] **Step 4: 实现组件 + CSS + 注册**

```tsx
// packages/toolkit/src/client/subagent-model/SubagentModelChip.tsx
/** 子会话头部模型 chip：仅子会话渲染；数据来自插件持久委派路由（委派时解析的值，全程一致）。 */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 触发 dsh-client-ui-conversation 对 SlotMap 的声明合并（header.utilities 槽位类型）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { fetchChildRoute, type DelegateRoute } from '../delegate/api.ts'
import type { NS } from '../delegate/locales.ts'
import css from './subagent-model.module.css'

export type SubagentModelChipProps =
  PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS>

export function SubagentModelChip({ sessionId, useSession, t }: SubagentModelChipProps) {
  const subagent = useSession(s => s.subagent)
  const [route, setRoute] = useState<DelegateRoute | null>(null)
  const isSubagent = subagent !== null
  useEffect(() => {
    if (!isSubagent) return
    let cancelled = false
    void fetchChildRoute(String(sessionId))
      .then((r) => { if (!cancelled) setRoute(r) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [sessionId, isSubagent])
  if (!isSubagent || route === null) return null
  const text = `${route.provider} / ${route.model}`
  return <span className={css.chip} aria-label={t('header.modelAria', { route: text })}>{text}</span>
}
```

```css
/* packages/toolkit/src/client/subagent-model/subagent-model.module.css */
/* 子会话头部模型 chip：几何照委派卡 chip（单行、token 着色）。 */
.chip {
  flex: none; padding: 0 6px; border-radius: 6px;
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-label-tertiary);
  border: 1px solid var(--dsw-alias-border-l2);
  white-space: nowrap;
}
```

```ts
// packages/toolkit/src/client/subagent-model/index.ts
/** 子会话头部 chip 注册：conversation.session.header.utilities 槽位（list/session scope）。 */
import type { Context } from '@deepseek-ai/cordis'
// 触发 dsh-client-ui-conversation 的 SlotMap 声明合并（本文件调用 slots.register 需要槽位类型可见）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from '../delegate/locales.ts'
import { SubagentModelChip } from './SubagentModelChip.tsx'

export function setupSubagentModelClient(ctx: Context): void {
  // 词典由 setupDelegateClient 统一注册（同 NS 'agent-team'），此处不重复注册。
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.utilities', id: 'subagent-model', order: 10, locale: NS },
      SubagentModelChip,
    ))
}
```

`client/index.ts`：`apply` 内 `setupDelegateClient(ctx)` 之后加 `setupSubagentModelClient(ctx)`（含 import）。

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/subagent-model/; pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS + 无类型错误（若 `PropsRuntime<'conversation.session.header.utilities'>` 报未声明，检查 Step 1 的 link 是否已 `pnpm install`）

- [ ] **Step 6: 经用户确认后提交**

`git add packages/toolkit/src/client/subagent-model/ packages/toolkit/src/client/index.ts packages/toolkit/package.json`；message：`feat(toolkit): show model chip in subagent session header`

---

### Task 7: 全量验证与文档

**Files:**
- Modify: `AGENTS.md`（"dsh 插件开发要点"节：委派卡条目补模型 chip 行为 + 新存储域 `dsh_agent_toolkit_routes` 一句）
- Modify: `docs/usage/delegation.md`（委派卡说明补一行：卡片与子会话头部显示 `provider / model`）

- [ ] **Step 1: 全量验证**

Run: `pnpm --filter dsh-agent-toolkit test; pnpm --filter dsh-agent-toolkit typecheck; pnpm --filter dsh-agent-toolkit bundle`
Expected: 329+新增测试全绿；typecheck 无错；bundle 产出 lib/index.js + lib/client.js

- [ ] **Step 2: 更新 AGENTS.md**

在"Agent 注册表"条目所在段落后补/改：

- 委派卡条目改为：委派走 `team_delegate`（一次性），浏览器半渲染委派卡（含 `provider / model` chip：运行中读在途端点、结束后读 presentationMeta）
- 存储域说明补：路由持久域 `dsh_agent_toolkit_routes`（表 `routes`，key=childSessionId），schema 单一来源在 `src/delegate/routes.ts`；子会话头部 chip 经 `GET /dsh-agent-toolkit/api/delegate/route` 读取

- [ ] **Step 3: 更新 docs/usage/delegation.md**

在委派卡说明处补一行：委派卡与子会话头部会显示子 Agent 使用的 `provider / model`（角色模型覆盖 ?? 继承主 Agent 路由）。

- [ ] **Step 4: 开发回路实机验证（人工）**

`pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml` 后真实委派一次：确认运行中卡片 chip、结束后 chip、子会话头部 chip、刷新回放 chip 四处表现。

- [ ] **Step 5: 经用户确认后提交**

`git add AGENTS.md docs/usage/delegation.md`；message：`docs: document subagent model visibility`

---

## Self-Review 记录

- **Spec 覆盖**：解析语义→Task 3；在途表→Task 1；持久域→Task 2；端点→Task 4；委派卡 chip→Task 5；子会话 chip→Task 6；测试矩阵→各 Task；文档→Task 7。无遗漏。
- **类型一致性**：`DelegateRoute`（Task 1 定义）在 Task 3/4/5 复用；`DelegateApiDeps.routes.get` 与 `KvTable.get` 签名兼容（KvTable 直接作为 routes 传入）；`fetchChildRoute` 在 Task 5 定义、Task 6 复用；locales 键 `card.modelAria`（Task 5）/`header.modelAria`（Task 5 定义、Task 6 消费）一致。
- **占位符**：无 TBD/TODO。
