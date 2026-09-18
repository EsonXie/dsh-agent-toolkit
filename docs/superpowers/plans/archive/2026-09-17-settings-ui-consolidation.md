# 设置面板收编插件 UI 入口 + 配置页重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 toolkit 浏览器半的 Agents/Prompt/Bots/Schedule 四个底栏弹窗迁入宿主设置面板（单 `settings.section` + 页内 tab），Bots 配置并入 Agents（数据模型收窄 + 存量迁移），逐页重设计并修复排序/保存反馈/新手引导痛点。

**Architecture:** Node 半：`AgentRecord` 补时间戳（注册表改按创建时间排序）、`project_bot` domain 加 meta 表并做一次性合并迁移（剥离 bot 级 persona/tools，非 main 绑定剥离 agentOptions）、bots API 收窄、channels 运行时删除 bot 级注入。浏览器半：新增 `src/client/settings/`（section 注册 + tab 壳 + `agent-toolkit` 词典），四个面板由 Modal 改为内联页组件，经 `ctx.slots.inject('settings.section', …)` 注册；底栏四个入口与 `createSidebarEntry` 工厂删除。

**Tech Stack:** TypeScript / React 19 / zod v4 / vitest（node 默认 + `// @vitest-environment jsdom` docblock）/ @testing-library/react / dsh slots（`PropsRuntime`/`PropsLocale`/`InjectFace` 来自 `@deepseek-ai/dsh-client-ui-slots`）/ ui-primitives（Modal 弃用、Toast/Button/StateDot 沿用）。

**Spec:** `docs/superpowers/specs/2026-09-17-settings-ui-consolidation-design.md`（已确认）。

## Global Constraints

- 工作区根 `D:\work\github\dsh\dsh-agent-toolkit`；所有命令用 `pnpm --filter dsh-agent-toolkit <test|typecheck|bundle>`。**本次不动 `packages/usage`**，无需先构建 usage。
- zod schema 单一来源在各域 `store.ts`；存储表 `KvTable` 为同步读（`get`/`keys`）+ 异步写（`put`/`delete`）。
- 测试无共享 fixture：每个 spec 自建 FakeTable/FakeDomain 或对象字面量 fake（参照 `src/agents/registry.test.ts:11-51`、`src/bots/api.test.ts:24-71`）。
- 客户端 spec 首行必须 `// @vitest-environment jsdom`；网络用 `vi.stubGlobal('fetch', …)` 桩（参照 `src/client/agents/agents.spec.tsx` 的 stubFetch 模式）；断言用户可见行为与 HTTP payload，不断言 class/内部实现。
- bundle 纯净度门禁：浏览器半禁止跨插件值导入；对宿主 `ui-settings` 只能 `import type`。CSS module 只用 `--dsw-alias-*` token。
- 文案决策（对 spec 的收窄，已确认方向内）：**新增**的界面 chrome 文案（section 导航、tab、保存反馈、Prompt 引导）进新词典 NS `agent-toolkit`（zh 为真源 + en 镜像）；被迁移组件里**存量**硬编码中文保持原样，不在本次全量词典化。
- 状态管理决策（对 spec 第 2 节的简化）：沿用现有 `useLoadState` + 组件 local state 模式，**不引入 `createXXXStore`**——设置 section 每次打开全新挂载、无跨条目共享状态，store 无收益。
- 浏览器半入口 `inject` 保持 `['sessions', 'slots', 'locale']` 不变；双装防护 try/catch（usage）契约不变。
- 注释与提交信息用中文（本仓库现行风格）；commit 遵循 `type(scope): 主题` 格式。
- 每 Task 结束提交；提交前该 Task 涉及的测试必须全绿。

---

### Task 1: AgentRecord 时间戳字段 + 注册表按创建时间排序

**Files:**
- Modify: `packages/toolkit/src/agents/store.ts`
- Modify: `packages/toolkit/src/agents/registry.ts`
- Test: `packages/toolkit/src/agents/store.test.ts`、`packages/toolkit/src/agents/registry.test.ts`

**Interfaces:**
- Produces: `AgentRecord` 新增 `createdAt?: number; updatedAt?: number`（epoch ms，int）；`createRegistry(warn, tables, listPresetTools, now?)` 第 4 参可选 `now: () => number`（默认 `Date.now`）；meta 标记键常量 `AGENTS_TIMESTAMPS_BACKFILLED_KEY = 'agents_timestamps_backfilled'`。后续 Task 2（API 服务端管理时间戳）与 Task 8（UI 排序渲染）依赖此排序语义：**main 恒置顶，其余 `createdAt` 升序、并列按 id 字典序**。

- [ ] **Step 1: 写失败测试（schema + 排序 + 回填迁移）**

`store.test.ts` 追加：

```ts
it('AgentRecordSchema 接受可选 createdAt/updatedAt', () => {
  const r = AgentRecordSchema.parse({ id: 'a1', name: 'A', createdAt: 1, updatedAt: 2 })
  expect(r.createdAt).toBe(1)
  expect(r.updatedAt).toBe(2)
})
```

`registry.test.ts` 追加（沿用该文件 FakeTable/FakeDomain 与 `vi.stubEnv('DSH_HOME', …)` 模式；`createRegistry` 调用处补第 4 参 `() => 1000`）：

```ts
it('list：main 置顶，其余按 createdAt 升序、并列按 id 字典序', async () => {
  const { agents, meta } = makeTables()
  await agents.put('b', { id: 'b', name: 'B', createdAt: 20 })
  await agents.put('a', { id: 'a', name: 'A', createdAt: 20 })
  await agents.put('c', { id: 'c', name: 'C', createdAt: 10 })
  const registry = await createRegistry(warn, { agents, meta }, async () => [], () => 1000)
  expect(registry.list().map((r) => r.id)).toEqual(['main', 'c', 'a', 'b'])
})

it('回填迁移：缺 createdAt 的存量记录按 id 序回填 now()+index，幂等', async () => {
  const { agents, meta } = makeTables()
  await agents.put('b', { id: 'b', name: 'B' })
  await agents.put('a', { id: 'a', name: 'A' })
  const registry = await createRegistry(warn, { agents, meta }, async () => [], () => 1000)
  expect(agents.get('a')?.createdAt).toBe(1000)
  expect(agents.get('b')?.createdAt).toBe(1001)
  expect(meta.get(AGENTS_TIMESTAMPS_BACKFILLED_KEY)).toEqual({ value: '1' })
  // 幂等：二次创建不再改写
  const again = await createRegistry(warn, { agents, meta }, async () => [], () => 2000)
  expect(agents.get('a')?.createdAt).toBe(1000)
  expect(again.list()[0].id).toBe('main')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/agents`
Expected: FAIL（schema 无字段 / 排序仍是 id 字典序 / 无回填）

- [ ] **Step 3: 实现**

`store.ts`：`AgentRecord` 接口与 `AgentRecordSchema` 各加两行（放在 `visibleInTeam` 后）：

```ts
createdAt?: number
updatedAt?: number
```
```ts
createdAt: z.number().int().nonnegative().optional(),
updatedAt: z.number().int().nonnegative().optional(),
```

`registry.ts`：标记常量加在 L30 附近；`list()` 排序改为：

```ts
.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
```

`createRegistry` 加第 4 参 `now: () => number = Date.now`，在现有四种 meta 迁移之后追加回填（注意 agents 表句臂在该函数内已可用；`agents.keys()` 同步）：

```ts
if (meta.get(AGENTS_TIMESTAMPS_BACKFILLED_KEY) === undefined) {
  const missing = agents.keys()
    .filter((id) => agents.get(id)?.createdAt === undefined)
    .sort((a, b) => a.localeCompare(b))
  const base = now()
  for (const [index, id] of missing.entries()) {
    const record = agents.get(id)
    if (record === undefined) continue
    await agents.put(id, { ...record, createdAt: base + index, updatedAt: base + index })
  }
  await meta.put(AGENTS_TIMESTAMPS_BACKFILLED_KEY, { value: '1' })
}
```

同步更新 `list()` 接口注释为「main 置顶，其余按 createdAt 升序（并列按 id）」。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm --filter dsh-agent-toolkit test -- src/agents; if ($?) { pnpm --filter dsh-agent-toolkit test }`
Expected: PASS（既有断言 GET /agents 排序的测试若钉死 id 序需一并改为新语义——registry.test.ts/api.test.ts 中排序断言更新为 createdAt 语义）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/agents
git commit -m "feat(agents): AgentRecord 补 createdAt/updatedAt，注册表按创建时间升序（main 置顶），存量一次性回填"
```

---

### Task 2: project_bot domain 打开上移 + agents API 服务端时间戳与删除 409 守卫

**Files:**
- Modify: `packages/toolkit/src/index.ts`（apply 编排）
- Modify: `packages/toolkit/src/bots/index.ts`（setupBots 改收表格句柄，不再自开 domain）
- Modify: `packages/toolkit/src/agents/api.ts`
- Test: `packages/toolkit/src/agents/api.test.ts`、`packages/toolkit/src/bots/index.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `createdAt/updatedAt` 字段。
- Produces:
  - `AgentsApiDeps` 新增 `countBotsForAgent(agentId: string): number` 与 `now(): number`；
  - `setupAgentsApi(ctx, deps)` 签名不变（deps 变宽）；
  - `BotsDeps` 变为 `{ registry: AgentRegistry; presetId?: string; bots: KvTable<string, BotRecord>; bindings: KvTable<string, Binding> }`，`setupBots` 内部删除 `openDomainSafely(projectBotDomain)` 块；
  - DELETE `/agents/:id` 名下有 Bot 时 409 `{ error: string; bots: number }`；PUT 忽略客户端携带的 createdAt/updatedAt，服务端回填（`createdAt = existing?.createdAt ?? now()`，`updatedAt = now()`）。

- [ ] **Step 1: 写失败测试**

`agents/api.test.ts`（fake deps 补 `countBotsForAgent: () => 0`、`now: () => 5000`）追加：

```ts
it('PUT 新建：服务端写 createdAt/updatedAt，客户端携带值被剥离', async () => {
  await putJson('/dsh-agent-toolkit/api/agents/a1', { id: 'a1', name: 'A', createdAt: 1, builtin: true })
  const saved = registryFake.get('a1')
  expect(saved?.createdAt).toBe(5000)
  expect(saved?.updatedAt).toBe(5000)
  expect(saved?.builtin).toBeUndefined()
})

it('PUT 更新：保留原 createdAt，刷新 updatedAt', async () => {
  registryFake.seed({ id: 'a1', name: 'A', createdAt: 100 })
  await putJson('/dsh-agent-toolkit/api/agents/a1', { id: 'a1', name: 'A2' })
  expect(registryFake.get('a1')?.createdAt).toBe(100)
  expect(registryFake.get('a1')?.updatedAt).toBe(5000)
})

it('DELETE 名下有 Bot：409 且带数量', async () => {
  deps.countBotsForAgent = () => 2
  const res = await del('/dsh-agent-toolkit/api/agents/a1')
  expect(res.status).toBe(409)
  expect(res.json()).toMatchObject({ bots: 2 })
})
```

`bots/index.test.ts`：现有 fake ctx 的 `storageDomain.open` 桩删除对 project_bot 的断言，改为断言 `setupBots(ctx, config, { registry, bots: fakeBotsTable, bindings: fakeBindingsTable })` 下装配照常（answerer 门控等既有断言不变）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/agents/api.test.ts src/bots/index.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`agents/api.ts`：
- `AgentsApiDeps` 加 `countBotsForAgent(agentId: string): number` 与 `now(): number`。
- PUT 分支（L63-88）：`delete bodyRecord.builtin` 后追加 `delete bodyRecord.createdAt; delete bodyRecord.updatedAt;`；构造 candidate 时 `candidate.createdAt = existing?.createdAt ?? deps.now(); candidate.updatedAt = deps.now()`。
- DELETE 分支（L90-103）：404 检查之后、`registry.remove` 之前插入：

```ts
const botCount = deps.countBotsForAgent(id)
if (botCount > 0) {
  json(res, 409, { error: `角色 "${id}" 仍有 ${botCount} 个 Bot 绑定，请先删除这些 Bot`, bots: botCount })
  return
}
```

`src/index.ts`：在 L171 附近（agents domain 之后、setupAgentsApi 之前）插入：

```ts
const botsDomain = await openDomainSafely(ctx, projectBotDomain, warn)
const botsTable = botsDomain.table('bots')
const bindingsTable = botsDomain.table('bindings')
const countBotsForAgent = (agentId: string): number =>
  botsTable.keys().filter((id) => (botsTable.get(id)?.agentRef ?? 'main') === agentId).length
```

`setupAgentsApi` 调用处 deps 补 `countBotsForAgent, now: () => Date.now()`；`setupBots` 调用处 deps 补 `bots: botsTable, bindings: bindingsTable`（import 处从 `bots/store.ts` 加 `projectBotDomain`——现已 import 了别的 bots 符号的话合并 import 行）。

`bots/index.ts`：`BotsDeps` 加 `bots`/`bindings` 两个字段；删除 L175-187 的 `openDomainSafely` 块与 `domainReady` 变量；BotRuntime 构造改为直接用 `deps.bots`/`deps.bindings`，`started = Promise.resolve().then(() => { runtime = new BotRuntime({...}); return runtime.startAll() })`。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（含 smoke.test.ts 对 setupBots 签名面的断言若有需同步）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src
git commit -m "feat(agents): 删除角色名下有 Bot 时 409 + 服务端管理时间戳；project_bot domain 打开上移至插件入口"
```

---

### Task 3: project_bot meta 表 + Bot 合并迁移（剥离 persona/tools，非 main 剥离 agentOptions）

**Files:**
- Modify: `packages/toolkit/src/bots/store.ts`
- Create: `packages/toolkit/src/bots/merge-migration.ts`
- Modify: `packages/toolkit/src/index.ts`
- Test: `packages/toolkit/src/bots/merge-migration.test.ts`（新建）、`packages/toolkit/src/bots/store.test.ts`

**Interfaces:**
- Produces: `migrateBotsIntoAgents(deps: { bots: KvTable<string, BotRecord>; meta: KvTable<string, { value: string }> }, warn: (msg: string) => void): Promise<void>` 与常量 `BOTS_AGENT_MERGE_MIGRATED_KEY = 'bots_agent_merge_migrated'`。Task 5（运行时删除注入）假定迁移已剥离存储。
- 决策记录：`BotRecordSchema` **保留** `persona`/`tools` 可选字段并标注 `@deprecated 仅迁移输入`（与 `AgentRecordSchema.promptLayers` 同款先例），否则存量行里的旧值在 schema 剥离后无法读取、迁移无从 warn。domain version 保持 1（加表不影响既有记录；version 是按记录读写校验，新表无存量）。

- [ ] **Step 1: 写失败测试**

`store.test.ts` 追加：domain 表清单变为 `['bots', 'bindings', 'meta']`。

`merge-migration.test.ts`（自建 Map 版 FakeTable，同 registry.test.ts 模式）：

```ts
it('已迁移过：直接跳过', async () => { /* meta 预置标记，bots 表放带 persona 的记录，跑后记录不变 */ })

it('main 绑定：剥离 persona/tools 并 warn，保留 agentOptions', async () => {
  // bot: { id:'b1', name, project:'/p', persona:'x', tools:['read'], agentOptions:{provider:'p',model:'m'}, createdAt:1, updatedAt:1 }
  // 跑后：persona/tools 被删，agentOptions 保留；warn 恰好 1 次且文本含 bot id
})

it('角色绑定：剥离 persona/tools/agentOptions，不 warn（这些值运行时本就被忽略）', async () => {
  // bot agentRef:'role-x'，三字段齐全 → 全剥离，warn 0 次
})

it('幂等：第二次跑不再改写', async () => { /* 跑两次，第二次 bots.put 零调用（用 spy 包一层） */ })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/bots`
Expected: FAIL（模块不存在 / 表清单不符）

- [ ] **Step 3: 实现**

`store.ts`：`persona`/`tools` 字段注释改 `@deprecated 仅迁移输入（2026-09-17 合并迁移后删除）`；domain tables 加：

```ts
// meta 表存一次性标记（bots_agent_merge_migrated），沿用 agents 域 meta 模式。
meta: domainTable<string, { value: string }>(z.object({ value: z.string() })),
```

`merge-migration.ts`：

```ts
/** Bot 配置并入 Agent 的一次性迁移：剥离 bot 级 persona/tools（主 Agent 绑定 warn），非 main 绑定剥离 agentOptions。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { BotRecord } from './store.ts'

export const BOTS_AGENT_MERGE_MIGRATED_KEY = 'bots_agent_merge_migrated'

export interface MergeMigrationDeps {
  bots: KvTable<string, BotRecord>
  meta: KvTable<string, { value: string }>
}

export async function migrateBotsIntoAgents(
  deps: MergeMigrationDeps,
  warn: (msg: string) => void,
): Promise<void> {
  if (deps.meta.get(BOTS_AGENT_MERGE_MIGRATED_KEY) !== undefined) return
  for (const id of deps.bots.keys()) {
    const bot = deps.bots.get(id)
    if (bot === undefined) continue
    const ref = bot.agentRef ?? 'main'
    const next = { ...bot }
    let changed = false
    if (bot.persona !== undefined || bot.tools !== undefined) {
      if (ref === 'main') {
        warn(`[project-bot] bot "${id}"：主 Agent 名下的 Bot 不再支持单独 persona/工具白名单，配置已移除；如需差异化 persona 请创建角色 Agent 并绑定`)
      }
      delete next.persona
      delete next.tools
      changed = true
    }
    if (ref !== 'main' && bot.agentOptions !== undefined) {
      delete next.agentOptions
      changed = true
    }
    if (changed) await deps.bots.put(id, next)
  }
  await deps.meta.put(BOTS_AGENT_MERGE_MIGRATED_KEY, { value: '1' })
}
```

`src/index.ts`：Task 2 打开 domain 处补 `const botsMetaTable = botsDomain.table('meta')`，并在其后立即 `await migrateBotsIntoAgents({ bots: botsTable, meta: botsMetaTable }, warn)`。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/bots packages/toolkit/src/index.ts
git commit -m "feat(bots): project_bot 加 meta 表 + Bot 并入 Agent 一次性迁移（剥离 bot 级 persona/tools，非 main 剥离 agentOptions）"
```

---

### Task 4: bots API 收窄（删 persona/tools；agentOptions 仅 main）

**Files:**
- Modify: `packages/toolkit/src/bots/api.ts`
- Test: `packages/toolkit/src/bots/api.test.ts`

**Interfaces:**
- Consumes: Task 3 的 schema（persona/tools 仍在 BotRecord 上是迁移输入，但 API 不再接受）。
- Produces（Task 7 客户端对齐用）：POST/PUT body 不再含 `persona`/`tools`；`agentOptions` 仅当生效 agentRef 为 `'main'` 时合法，否则 400 `{ error: 'agentOptions 仅在绑定主 Agent 时可用' }`；PUT 把 agentRef 切到非 main 时同时丢弃存量 agentOptions。

- [ ] **Step 1: 写失败测试**

`api.test.ts` 追加/修改：

```ts
it('POST 携带 agentOptions 且 agentRef 为角色：400', async () => {
  const res = await postJson(base, { name: 'b', project: '/p', agentRef: 'role-x',
    agentOptions: { provider: 'p', model: 'm' }, feishu: { appId: VALID_APP_ID, appSecret: 's' } })
  expect(res.status).toBe(400)
})

it('PUT 切 agentRef 到角色：存量 agentOptions 被丢弃', async () => {
  // 预置 main 绑定且带 agentOptions 的 bot → PUT { agentRef: 'role-x' } → 记录 agentOptions undefined
})

it('PUT 切 agentRef 到角色且携带 agentOptions：400', async () => { /* ... */ })

it('PUT agentRef=null 回 main：允许携带/保留 agentOptions', async () => { /* ... */ })
```

同时删除/改写所有「POST/PUT 携带 persona/tools 落表」的既有断言（改为断言这两个字段被忽略、不落表）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/bots/api.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`api.ts`：
- `CreateBodySchema`/`UpdateBodySchema` 删除 `persona`、`tools` 两行。
- POST zod 校验通过后：

```ts
const ref = body.agentRef ?? 'main'
if (ref !== 'main' && body.agentOptions !== undefined) {
  json(res, 400, { error: 'agentOptions 仅在绑定主 Agent 时可用' })
  return
}
```

- PUT 字段合并段：先算生效 ref 并校验：

```ts
const effectiveRef = body.agentRef === null ? 'main' : body.agentRef ?? existing.agentRef ?? 'main'
if (effectiveRef !== 'main' && body.agentOptions != null) {
  json(res, 400, { error: 'agentOptions 仅在绑定主 Agent 时可用' })
  return
}
```

合并逻辑中删除 persona/tools 分支；agentOptions 分支后追加：

```ts
if (effectiveRef !== 'main') delete merged.agentOptions
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/bots
git commit -m "feat(bots): API 收窄——删 persona/tools 入参，agentOptions 仅主 Agent 绑定合法，切角色自动丢弃覆盖"
```

---

### Task 5: 运行时删除 bot 级 persona/tools 注入

**Files:**
- Modify: `packages/toolkit/src/channels/ports.ts`（删 `hooksOf`）
- Modify: `packages/toolkit/src/channels/router.ts`（resolveSession 主 Agent 分支）
- Test: `packages/toolkit/src/channels/router.test.ts`（及 grep 到的 hooksOf 引用测试）

**Interfaces:**
- Consumes: Task 3 迁移已剥离存储字段；Task 4 已堵 API 入口。
- Produces: 主 Agent 分支 hooks 恒为渠道段（guidance + sender），不再含 bot persona/tools；模型仍 `bot.agentOptions ?? defaultModel()`。

- [ ] **Step 1: 改失败测试**

`router.test.ts` 中主 Agent 分支断言改为：bot 记录即便（构造假数据）带 persona/tools，装配的 hooks 也不含 persona section、tools restrict 不发生；agentOptions 透传断言不变。先跑确认失败。

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/router.test.ts`

- [ ] **Step 2: 实现**

`ports.ts`：删除 `hooksOf` 函数（若 `AgentHooks` 仍被别处使用则保留类型）。`router.ts` resolveSession 主 Agent 分支：

```ts
return { agentOptions: bot.agentOptions ?? this.defaultModel(), hooks: this.withChannelSections({}, bot, userId) }
```

并删除对 `hooksOf` 的 import。grep 确认无其他 `hooksOf` 引用（`rg -n "hooksOf" packages/toolkit/src`）。

- [ ] **Step 3: 跑测试确认通过 + 全量回归**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/toolkit/src/channels
git commit -m "refactor(channels): 删除 bot 级 persona/tools 注入（hooksOf），bot 会话装配统一走 agentRef 角色/主 Agent 默认"
```

---

### Task 6: 浏览器半共享保存反馈组件（useToast + SaveBar）

**Files:**
- Create: `packages/toolkit/src/client/shared/feedback.tsx`
- Create: `packages/toolkit/src/client/shared/feedback.module.css`
- Test: `packages/toolkit/src/client/shared/feedback.spec.tsx`

**Interfaces:**
- Produces（Task 8/10/11 消费）：

```ts
export function useToast(): { toastText: string | null; showToast: (text: string) => void; toastNode: ReactNode }
export interface SaveBarLabels { save: string; cancel: string; saved: string }
export function SaveBar(props: {
  labels: SaveBarLabels
  dirty: boolean
  saving: boolean
  saved: boolean
  error?: string | null
  onSave: () => void
  onCancel: () => void
}): ReactNode
```

- [ ] **Step 1: 写失败测试**

`feedback.spec.tsx`（首行 `// @vitest-environment jsdom`）：

```tsx
it('SaveBar：dirty 时保存按钮可用，saved 时显示「已保存」', () => {
  const { rerender } = render(<SaveBar labels={{ save: '保存', cancel: '取消', saved: '已保存' }}
    dirty saving={false} saved={false} onSave={() => {}} onCancel={() => {}} />)
  expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
  rerender(<SaveBar labels={{ save: '保存', cancel: '取消', saved: '已保存' }}
    dirty={false} saving={false} saved onSave={() => {}} onCancel={() => {}} />)
  expect(screen.getByText('已保存')).toBeDefined()
})

it('SaveBar：error 内联展示', () => { /* error="boom" → getByText('boom') */ })

it('useToast：showToast 后渲染 Toast 文本，onDone 后卸载', async () => {
  // 小组件包一层 hook；showToast('已保存') → getByText('已保存')（role=alert）
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client/shared/feedback.spec.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`feedback.tsx`：

```tsx
/** 保存反馈共享件：顶部 toast（ui-primitives Toast）+ 编辑区底部保存条。 */
import { useCallback, useState, type ReactNode } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './feedback.module.css'

export function useToast(): { toastText: string | null; showToast: (text: string) => void; toastNode: ReactNode } {
  const [toastText, setToastText] = useState<string | null>(null)
  const showToast = useCallback((text: string) => { setToastText(text) }, [])
  const toastNode = toastText === null ? null : <Toast text={toastText} onDone={() => { setToastText(null) }} />
  return { toastText, showToast, toastNode }
}

export interface SaveBarLabels { save: string; cancel: string; saved: string }

export function SaveBar(props: {
  labels: SaveBarLabels
  dirty: boolean
  saving: boolean
  saved: boolean
  error?: string | null
  onSave: () => void
  onCancel: () => void
}): ReactNode {
  const { labels } = props
  return (
    <div className={css.bar}>
      {props.error != null && <span className={css.error} role="alert">{props.error}</span>}
      {props.saved && !props.dirty && <span className={css.saved}>{labels.saved}</span>}
      <span className={css.spacer} />
      <Button onClick={props.onCancel}>{labels.cancel}</Button>
      <Button variant="primary" disabled={!props.dirty || props.saving} onClick={props.onSave}>
        {props.saving ? `${labels.save}…` : labels.save}
      </Button>
    </div>
  )
}
```

`feedback.module.css`：`.bar{display:flex;align-items:center;gap:8px}`、`.spacer{flex:1}`、`.error{color:var(--dsw-alias-state-error-primary)}`、`.saved{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}`。（Button 的 variant prop 名以 ui-primitives 实际导出为准，先 `rg -n "interface ButtonProps|variant" deepseek-harness/packages/client/ui-primitives/src/Button.tsx` 核实再写。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client/shared/feedback.spec.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/client/shared
git commit -m "feat(client): 共享保存反馈件 useToast + SaveBar（toast + ✓ 已保存 + 内联错误）"
```

---

### Task 7: 客户端 api.ts 对齐（bots 输入收窄）

**Files:**
- Modify: `packages/toolkit/src/client/bots/api.ts`
- Test: `packages/toolkit/src/client/bots/bots-api.client.spec.ts`（若无则并入 Task 9 的 spec 间接覆盖）

**Interfaces:**
- Produces: `BotInput` 删除 `persona`/`tools` 字段（`agentOptions` 保留）；`fetchBots`/`createBot`/`updateBot`/`deleteBot`/`startRegisterApp`/`pollRegisterApp`/`fetchProviders`/`fetchModels`/`fetchAgents` 签名不变。

- [ ] **Step 1: 实现（类型收窄，无行为变化）**

`client/bots/api.ts` 的 `BotInput` 删除 `persona?: string`、`tools?: string[]` 两行。

- [ ] **Step 2: typecheck + 全量测试**

Run: `pnpm --filter dsh-agent-toolkit typecheck; if ($?) { pnpm --filter dsh-agent-toolkit test }`
Expected: PASS（若有引用 persona/tools 的客户端代码报错——预期在 BotForm，本任务一并删除对应字段引用，Task 9 再重构其布局）

- [ ] **Step 3: Commit**

```bash
git add packages/toolkit/src/client/bots/api.ts packages/toolkit/src/client/bots/BotForm.tsx
git commit -m "refactor(client): BotInput 删除 persona/tools 字段对齐服务端收窄"
```

---

### Task 8: AgentsPage —— Agent 卡片流 + 内联编辑 + 排序/删除守卫/保存反馈

**Files:**
- Create: `packages/toolkit/src/client/agents/AgentsPage.tsx`
- Modify: `packages/toolkit/src/client/agents/AgentEditor.tsx`（接 SaveBar/反馈；其余字段区不动）
- Modify: `packages/toolkit/src/client/agents/agents.module.css`（卡片流样式）
- Test: `packages/toolkit/src/client/agents/agents-page.client.spec.tsx`

**Interfaces:**
- Consumes: `useToast`/`SaveBar`（Task 6）；`agents/api.ts` 现有函数；`bots/api.ts` 的 `fetchBots`/`BotListItem`（Task 7）。
- Produces（Task 12 壳消费）：

```ts
export function AgentsPage(props: {
  t: (key: ToolkitKey) => string
  useWorkspaces: <S>(selector: (state: { items: readonly unknown[] }) => S) => S
}): ReactNode
```

页面行为契约（spec 第 2 节）：按 fetchAgents 返回顺序渲染卡片（服务端已排序，main 在首）；main 卡只读（无编辑/删除，显示「使用宿主默认模型与装配」说明）；内置卡带「内置」徽标；删除两段确认；409 响应提示 Bot 数量；编辑/新建内联展开 AgentEditor；保存成功 toast + reload；Bot 列表面由 Task 9 的 `BotList`/`BotForm` 填充（本任务先接 `fetchBots` 分组数据并渲染行级只读列表：名称 + 项目路径 + 状态点）。

- [ ] **Step 1: 写失败测试**

`agents-page.client.spec.tsx`（jsdom + stubFetch 模式参照 `agents.spec.tsx`；桩路由：`GET /dsh-agent-toolkit/api/agents` 返回 `[main记录, explorer(createdAt:2), aaa(createdAt:1)]`，`GET /dsh-agent-toolkit/api/bots/bots` 返回 `{ bots: [...] }`）：

```tsx
it('按创建时间升序渲染卡片，main 置顶且只读', async () => {
  render(<AgentsPage t={(k) => k} useWorkspaces={stubUseWorkspaces} />)
  const titles = await screen.findAllByTestId('agent-card-name') // 或按角色名文本定位
  // 顺序：主 Agent → aaa → explorer
})

it('main 卡无编辑/删除按钮，显示只读说明', async () => { /* ... */ })

it('删除名下有 Bot 的角色：展示 409 错误（含 Bot 数量），列表不变', async () => {
  // DELETE 路由返回 409 { error, bots: 2 } → 两段确认后 findByText(/2/)
})

it('保存成功：toast 出现且列表重载', async () => {
  // 编辑 aaa 改名 → 保存 → PUT 200 → findByRole('alert')（toast）+ 第二次 GET 发生
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client/agents/agents-page.client.spec.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 AgentsPage**

骨架（状态与数据流为完整实现，样式类名见 css 文件）：

```tsx
/** Agents 设置页：Agent 卡片流（main 置顶只读），卡内挂 Bot 列表；编辑/新建内联展开。 */
import { useMemo, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentRecord } from '../../agents/store.ts'
import { fetchAgents, saveAgent, deleteAgent } from './api.ts'
import { fetchBots, type BotListItem } from '../bots/api.ts'
import { useLoadState } from '../shared/load-state.ts'
import { useToast } from '../shared/feedback.tsx'
import { AgentEditor } from './AgentEditor.tsx'
import css from './agents.module.css'

export function AgentsPage(props: {
  t: (key: never) => string   // 实际类型由 settings/locales.ts 的 ToolkitKey 替换（Task 12 接线时收紧）
  useWorkspaces: <S>(selector: (state: { items: readonly unknown[] }) => S) => S
}): ReactNode {
  const { showToast, toastNode } = useToast()
  const { state, reload } = useLoadState(
    () => Promise.all([fetchAgents(), fetchBots()]).then(([agents, botsRes]) => ({ agents, bots: botsRes })),
    [],
  )
  const [editingId, setEditingId] = useState<string | null>(null)   // '__new__' 表示新建
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const botsByAgent = useMemo(() => {
    const map = new Map<string, BotListItem[]>()
    if (state.kind === 'ok') {
      for (const bot of state.data.bots) {
        const ref = bot.agentRef ?? 'main'
        map.set(ref, [...(map.get(ref) ?? []), bot])
      }
    }
    return map
  }, [state])

  if (state.kind === 'loading') return <p>加载中…</p>
  if (state.kind === 'error') return <p role="alert">{state.message}</p>

  // 渲染：state.data.agents 顺序即服务端排序（main 在首）；
  // main 卡：只读说明 + Bot 列表；其余卡：名称/model 摘要/工具摘要/Bot 数/内置徽标 + 编辑/删除；
  // editingId === agent.id 时卡片下方内联 <AgentEditor agent={…} onSaved={…} onCancel={…} />
  // editingId === '__new__' 时列表顶部内联 <AgentEditor />
  // onSaved: reload() + showToast(props.t('feedback.saved') as string) + setEditingId(null)
  // 删除两段确认：confirmDeleteId → DELETE → 409 时 setDeleteError(error 文本) 保留卡片
  // ……完整 JSX 按上述契约实现
}
```

`AgentEditor.tsx` 适配（最小改）：底部 actions 行替换为 `SaveBar`（labels 由父级经新 prop `labels: SaveBarLabels` 传入；`dirty` 用字段快照对比、`saved` 由父级 onSaved 后 toast 体现——编辑器内 `saved` 恒 false 即可）；保存失败已有 error 展示，接入 SaveBar 的 `error` prop。不动四个字段区块的表单逻辑。

`agents.module.css` 追加：`.cards{display:flex;flex-direction:column;gap:12px;max-width:760px}`、`.card{border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;padding:12px 16px}`、`.cardHead{display:flex;align-items:center;gap:8px}`、`.badge、.summary、.cardActions、.botRow、.editorWrap`（参照宿主 AgentPresetSection.module.css 的节奏：18px 标题、20px 圆角可按页面密度取 12px）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（旧 `agents.spec.tsx` 测的是 AgentsModal，仍应通过——本任务不删旧文件）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/client/agents
git commit -m "feat(client): AgentsPage 卡片流（main 置顶只读、创建时间升序、内联编辑、保存 toast、删除 409 提示）"
```

---

### Task 9: BotList + BotForm 适配（归属卡片上下文，去 agent 下拉）

**Files:**
- Create: `packages/toolkit/src/client/bots/BotList.tsx`
- Modify: `packages/toolkit/src/client/bots/BotForm.tsx`（props 收窄）
- Modify: `packages/toolkit/src/client/agents/AgentsPage.tsx`（接入 BotList/BotForm）
- Modify: `packages/toolkit/src/client/bots/bots.module.css`
- Test: `packages/toolkit/src/client/bots/bot-list.client.spec.tsx`（新建）、`packages/toolkit/src/client/bots/bot-form.client.spec.tsx`（改写）

**Interfaces:**
- Consumes: Task 8 的 AgentsPage 分组数据；Task 7 收窄后的 `BotInput`。
- Produces:

```ts
export function BotList(props: {
  bots: BotListItem[]
  onEdit: (bot: BotListItem) => void
  onDeleted: () => void          // 父级 reload + toast
}): ReactNode

export function BotForm(props: {
  agentRef: string               // 归属卡片锁定，表单内无 agent 选择
  bot?: BotListItem              // 缺省 = 新建
  useWorkspaces: <S>(selector: (state: { items: readonly unknown[] }) => S) => S
  onSaved: () => void
  onCancel: () => void
}): ReactNode
```

`BotForm` 行为：保留两步向导（1 基本信息 → 2 飞书绑定，含扫码轮询逻辑原样保留）；第 1 步删除「绑定 Agent」字段；provider/模型两个 `<select>` 仅当 `agentRef === 'main'` 时渲染。

- [ ] **Step 1: 写失败测试**

`bot-list.client.spec.tsx`：状态点四色映射保留（`STATUS_LABEL`/`STATUS_DOT` 逻辑从 BotsModal 迁入 BotList）；删除两段确认 → `deleteBot` 调用 → `onDeleted`。
`bot-form.client.spec.tsx` 改写：props 按新签名；断言「agentRef='main' 时渲染 provider/模型下拉；agentRef='role-x' 时不渲染」；扫码流程断言保留（qrcode mock 沿用）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client/bots`
Expected: FAIL

- [ ] **Step 3: 实现**

`BotList.tsx`：从 BotsModal.tsx 迁出行渲染（StateDot + 名称 + 项目路径 + 编辑/删除 + 两段确认），分组逻辑删除（分组已由 AgentsPage 卡片承担）。
`BotForm.tsx`：按新 props 收窄；删除 agent 下拉与相关 `fetchAgents` 调用；`buildInput` 不再输出 persona/tools；`agentOptions` 仅在 `agentRef === 'main'` 时编入。
`AgentsPage.tsx`：卡片展开区渲染 `<BotList bots={botsByAgent.get(agent.id) ?? []} …/>` + 「+ 添加 Bot」按钮 → 内联 `<BotForm agentRef={agent.id} useWorkspaces={props.useWorkspaces} …/>`；bot 保存/删除后 `reload()` + toast。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（旧 `bots-modal.client.spec.tsx` 此刻仍在测 BotsModal——BotsModal 尚未删除，保持其编译通过：BotForm props 变了需同步修 BotsModal 调用处或直接删除 BotsModal 与其 spec。选择：**本任务直接删除** `BotsModal.tsx`、`bots-modal.client.spec.tsx`、`bots/index.ts`、`bots/entry.tsx`、`bots-entry.client.spec.tsx`——底栏 Bots 入口提前下线，新入口在 Task 12 接入）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/client
git commit -m "feat(client): Bot 列表/表单并入 Agents 卡片（归属锁定、仅 main 显示 provider/模型），下线底栏 Bots 入口"
```

---

### Task 10: SchedulePage —— 去弹窗 + 保存反馈

**Files:**
- Create: `packages/toolkit/src/client/schedule/SchedulePage.tsx`
- Modify: `packages/toolkit/src/client/schedule/schedule.module.css`
- Test: `packages/toolkit/src/client/schedule/schedule-page.client.spec.tsx`（由 `schedule-modal.client.spec.tsx` 改写）
- Delete: `packages/toolkit/src/client/schedule/ScheduleModal.tsx`、`entry.tsx`、`index.ts`、`schedule-entry.client.spec.tsx`、`schedule-modal.client.spec.tsx`

**Interfaces:**
- Produces（Task 12 壳消费）：

```ts
export function SchedulePage(props: {
  t: (key: ScheduleKey) => string
  openSession: (sessionId: string) => void
}): ReactNode
```

行为契约：整页任务行列表（名称 + cron 人类可读摘要 + 执行目标 + 启用 Switch + 下次运行）；行内操作编辑/立即触发/删除（两段确认）；点击行展开 `RunHistory`（现有组件原样复用，保留 openSession 跳转）；「+ 添加任务」内联展开 `TaskForm`（直接 JSX 渲染，不再需要 renderForm 闭包——组件树内无 hooks 边界问题，但保留等价回归测试）；保存/删除/开关切换成功均 toast（toast 文本走 `agent-schedule` 既有词典，缺的键补上 zh/en）。

- [ ] **Step 1: 写失败测试（由 schedule-modal spec 改写）**

页面级断言同原 modal 断言（列表渲染、两段确认删除、trigger、RunHistory 展开、openSession 调用），外壳断言改为「无 dialog role」；新增「新建任务渲染 TaskForm」回归（对应原 React #310 测试，直接渲染 `<SchedulePage>` 后点添加）。toast 断言：保存后 `findByRole('alert')`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client/schedule`
Expected: FAIL

- [ ] **Step 3: 实现**

`SchedulePage.tsx` = 原 `ScheduleModalBody` 内容平移：去掉 Modal 外壳；`useLoadState(fetchTasks)` + View 状态机 + `expandedId` + 两段确认逻辑原样；接 `useToast`；词典 `schedule/locales.ts` 补 toast/saved 键（zh/en 同步，`ScheduleKey` 随之扩展）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/client/schedule
git commit -m "feat(client): SchedulePage 设置页化（去弹窗、行式列表 + 行内历史展开、保存/开关 toast），下线底栏 Schedule 入口"
```

---

### Task 11: PromptPage —— 去弹窗 + 四层卡片 + 新手引导

**Files:**
- Create: `packages/toolkit/src/client/prompt/PromptPage.tsx`
- Modify: `packages/toolkit/src/client/prompt/prompt.module.css`
- Test: `packages/toolkit/src/client/prompt/prompt-page.client.spec.tsx`（由 `prompt-layers.spec.tsx` 改写）
- Delete: `packages/toolkit/src/client/prompt/PromptLayersModal.tsx`、`index.ts`、`entry.tsx`、`prompt-entry.client.spec.tsx`、`prompt-layers.spec.tsx`

**Interfaces:**
- Produces（Task 12 壳消费）：`export function PromptPage(props: { t: (key: ToolkitKey) => string }): ReactNode`（ToolkitKey 类型 Task 12 落定；本任务页内新文案先用 props.t 的键位占位，键名以 Task 12 词典为准——实现时直接从 `settings/locales.ts` import type，本任务即创建该文件的最小词典骨架亦可，但词典完整内容由 Task 12 收口；为避免循环，本任务在 `prompt/locales.ts` 新建？否——统一放 `settings/locales.ts`，本任务先创建该文件与 NS，Task 12 复用）。
- 行为契约（spec 第 4 节）：顶部可折叠说明区（默认展开，四层心智模型）；纵向四卡：identity（原生只读 + 覆盖编辑区 + 「仅主 Agent 生效」注）/ 模型层（只读 + 来源注）/ persona（指引 + 2 个示例模板一键填入 + 编辑区）/ 动态层（默认折叠只读）；底部 SaveBar（dirty/saving/error/reset 两段确认保留）；保存成功 toast。
- 新文案进 NS `agent-toolkit` 的 `prompt.*` 键族（zh 真源 + en 镜像），示例模板两个：「资深代码评审」「谨慎的运维助手」（中文正文 + en 译文）。

- [ ] **Step 1: 写失败测试**

覆盖：四层卡渲染顺序与只读/可编辑徽标；说明区默认展开、点击折叠；persona 示例按钮点击后填入 textarea（dirty 变 true）；identity 覆盖编辑留空 = 还原语义（PUT payload identityOverride 为空字符串/省略按现有 api 约定）；保存成功 toast；重置两段确认调 `resetLayers`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client/prompt`
Expected: FAIL

- [ ] **Step 3: 实现**

`PromptPage.tsx`：数据流平移自 `PromptLayersBody`（`useLoadState(fetchPromptLayers)` + local 草稿态）；布局从左右分栏改纵向四卡；`IDENTITY_SECTION`/`MODEL_SECTION`/`MODEL_NOTES_SECTION` 常量与 RuleTabs 逻辑保留（模型层/动态层卡内复用）；新增说明区 `<section>`（`DisclosureRow` 或自建 button+aria-expanded）与 persona 指引/示例按钮（点击 `setPersonaText(t('prompt.exampleReviewer'))` 等）。接 SaveBar + useToast。

`settings/locales.ts`（本任务创建，Task 12 继续扩）：

```ts
export const NS = 'agent-toolkit'
export const zh = {
  nav: 'Agent 工具箱',
  'tab.agents': 'Agents',
  'tab.schedule': '定时任务',
  'tab.prompt': '分层提示词',
  'feedback.saved': '已保存',
  'feedback.deleted': '已删除',
  'prompt.intro': '…（四层心智模型说明全文）',
  'prompt.guide': '…（persona 编写指引全文）',
  'prompt.exampleReviewer': '…',
  'prompt.exampleOps': '…',
} as const
export type ToolkitKey = keyof typeof zh
export const en: Record<ToolkitKey, string> = { /* 逐键英文 */ }
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/client
git commit -m "feat(client): PromptPage 设置页化 + 新手引导（四层说明区、persona 编写指引与示例模板、保存反馈），下线底栏 Prompt 入口"
```

---

### Task 12: settings section 壳注册 + 入口总接线 + 旧文件清扫

**Files:**
- Create: `packages/toolkit/src/client/settings/index.ts`、`ToolkitSection.tsx`、`settings.module.css`
- Modify: `packages/toolkit/src/client/settings/locales.ts`（补齐 agents 页/通用反馈键）、`packages/toolkit/src/client/index.ts`
- Modify: `packages/toolkit/package.json`（devDependencies + `dsh.client.inject`）
- Test: `packages/toolkit/src/client/settings/settings-section.client.spec.tsx`（新建）、`duplicate-guard.spec.ts`（改写）、`index.test.ts`（不变或微调）
- Delete: `packages/toolkit/src/client/agents/{index.ts,entry.tsx,AgentsModal.tsx,agents-entry.client.spec.tsx}`、`agents.spec.tsx`（其断言已由 agents-page spec 覆盖；未被覆盖的用例先迁入 agents-page spec 再删）、`packages/toolkit/src/client/shared/{entry.tsx,entry.module.css,entry.spec.tsx}`（`entry.spec.tsx` 中 useLoadState 用例迁入新建 `shared/load-state.spec.ts` 再删）

**Interfaces:**
- Consumes: `AgentsPage`/`SchedulePage`/`PromptPage`（Task 8/10/11）；`useLoadState`（保留）。
- Produces: `setupSettingsClient(ctx: Context): void`；浏览器半对外契约不变（`inject`/`apply` 签名不动）。

- [ ] **Step 1: 写失败测试**

`settings-section.client.spec.tsx`：

```tsx
it('tab 切换：默认 Agents，点击切换到 Schedule/Prompt', async () => {
  // stubFetch 桩齐 agents/bots/cron/prompt-layers 路由
  render(<ToolkitSection {...props} />)  // props: PropsRuntime 桩（useWorkspaces 等照 agents-entry spec 的 RUNTIME 桩）+ t + openSession + tSchedule
  // 默认见 Agent 卡片；点「定时任务」见任务列表；点「分层提示词」见四层卡
})

it('setupSettingsClient：注册 settings.section（id agent-toolkit, order 25）', () => {
  // 假 ctx（slots.inject 立即执行回调并捕获 register 参数；locale.register/effect 桩）
  // 断言 register 元数据与 label thunk 调用返回 'Agent 工具箱'
})
```

`duplicate-guard.spec.ts` 改写：usage id 抛错时，`settings.section` 的注册仍发生、warn 恰好一次。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client`
Expected: FAIL

- [ ] **Step 3: 实现**

`settings/index.ts`：

```ts
/** 设置面板 section 注册：Agent 工具箱（Agents/Schedule/Prompt 三 tab）。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ToolkitSection, type ToolkitSectionInjected } from './ToolkitSection.tsx'
import { en, NS, zh } from './locales.ts'
import { NS as SCHEDULE_NS, type ScheduleKey } from '../schedule/locales.ts'

export function setupSettingsClient(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agent-toolkit: settings dictionaries')
  const sessions = ctx.sessions as unknown as ISessions
  const openSession = (sessionId: string): void => { sessions.open(sessionId as SessionId) }
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'agent-toolkit',
      order: 25,
      label: () => ctx.locale.bind(NS)('nav'),
      locale: NS,
      inject: (): ToolkitSectionInjected => ({
        openSession,
        tSchedule: ctx.locale.bind(SCHEDULE_NS) as (key: ScheduleKey) => string,
      }),
    }, ToolkitSection))
}
```

`ToolkitSection.tsx`：

```tsx
import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AgentsPage } from '../agents/AgentsPage.tsx'
import { SchedulePage } from '../schedule/SchedulePage.tsx'
import { PromptPage } from '../prompt/PromptPage.tsx'
import { NS, type ToolkitKey } from './locales.ts'
import type { ScheduleKey } from '../schedule/locales.ts'
import css from './settings.module.css'

export interface ToolkitSectionInjected {
  openSession: (sessionId: string) => void
  tSchedule: (key: ScheduleKey) => string
}

type Tab = 'agents' | 'schedule' | 'prompt'
const TAB_KEYS: Record<Tab, ToolkitKey> = { agents: 'tab.agents', schedule: 'tab.schedule', prompt: 'tab.prompt' }

type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & InjectFace<ToolkitSectionInjected>

export function ToolkitSection(props: Props): ReactNode {
  const { t, useWorkspaces, openSession, tSchedule } = props
  const [tab, setTab] = useState<Tab>('agents')
  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <div className={css.tabs} role="tablist">
        {(['agents', 'schedule', 'prompt'] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id}
            className={tab === id ? css.tabActive : css.tab}
            onClick={() => { setTab(id) }}>
            {t(TAB_KEYS[id])}
          </button>
        ))}
      </div>
      {tab === 'agents' && <AgentsPage t={t} useWorkspaces={useWorkspaces} />}
      {tab === 'schedule' && <SchedulePage t={tSchedule} openSession={openSession} />}
      {tab === 'prompt' && <PromptPage t={t} />}
    </div>
  )
}
```

`client/index.ts`：删除 `setupAgentsClient`/`setupPromptClient`/`setupBotsClient`/`setupScheduleClient` 四处 import 与调用，改为 `import { setupSettingsClient } from './settings/index.ts'` 并在 usage 之后调用 `setupSettingsClient(ctx)`；usage 的 try/catch 原样保留。

`package.json`：`devDependencies` 加 `"@deepseek-ai/dsh-client-ui-settings": "link:../../deepseek-harness/packages/client/ui-settings"`（对照现有 link 条目格式）；`dsh.client.inject` 数组加 `"@deepseek-ai/dsh-client-ui-settings"`。加完跑 `pnpm install` 使 link 生效。

删除 Step 0 列出的旧文件（先用 `rg -n "createSidebarEntry|AgentsModal|ScheduleModal|PromptLayersModal|BotsModal" packages/toolkit/src` 确认零引用再删）。

AgentsPage/PromptPage 的 props 类型在本任务统一收紧为 `PropsLocale<typeof NS>['t']` 兼容签名（把 Task 8/11 的占位 `(key: never) => string` 之类替换掉）。

- [ ] **Step 4: typecheck + 全量测试 + bundle**

Run: `pnpm install; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }; if ($?) { pnpm --filter dsh-agent-toolkit test }; if ($?) { pnpm --filter dsh-agent-toolkit bundle }`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit
git commit -m "feat(client): 注册设置面板「Agent 工具箱」section（三 tab），下线底栏四入口与 createSidebarEntry 工厂"
```

---

### Task 13: 门禁 + 文档同步

**Files:**
- Modify: `docs/domains/agents.md`、`docs/domains/feishu.md`、`docs/domains/prompt-layers.md`、`docs/domains/schedule.md`
- Modify: `AGENTS.md`（功能域/开发命令段如有过时描述）
- Modify: `docs/usage/` 对应页面（界面入口与截图说明；截图标注「待补拍」）

- [ ] **Step 1: 全量门禁**

Run: `pnpm --filter dsh-agent-toolkit test; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }; if ($?) { pnpm --filter dsh-agent-toolkit bundle }; if ($?) { pnpm --filter @dsh-agent-toolkit/token-usage test }`
Expected: 全绿（usage 未动，确认无连带破坏）

- [ ] **Step 2: 文档同步**

- `docs/domains/agents.md`：UI 入口改「设置面板 → Agent 工具箱 → Agents」；排序改创建时间升序；删除 409 守卫。
- `docs/domains/feishu.md`：Bot 记录字段收窄（persona/tools 移除、agentOptions 仅 main）、一次性迁移标记 `bots_agent_merge_migrated`、行为变化（主 Agent 名下 Bot 不再有单独 persona/白名单）。
- `docs/domains/prompt-layers.md`：UI 入口变更一句。
- `docs/domains/schedule.md`：UI 入口变更一句。
- `AGENTS.md`：功能域列表与「共享层约定」段更新（`createSidebarEntry` 移除、`useLoadState` 保留、新增 `shared/feedback.tsx` 与 `settings/` 壳）。
- `docs/usage/`：入口描述改设置面板；截图占位标注待补拍。

- [ ] **Step 3: Commit**

```bash
git add docs AGENTS.md
git commit -m "docs: 设置面板收编 + Bot 并入 Agent 的域文档与使用手册同步"
```

- [ ] **Step 4: 开发回路冒烟（可选，需用户在场）**

```powershell
cd deepseek-harness; pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml
```

人工核验：设置面板出现「Agent 工具箱」、三 tab 可用、底栏只剩 Usage 与宿主项、bot 收发消息正常（主 Agent 绑定与角色绑定各一）。

---

## Self-Review 记录

- **Spec 覆盖**：spec §1→Task 12；§2→Task 1/2/8/9；§3→Task 10；§4→Task 11；§5 数据模型→Task 1/3、API→Task 2/4、运行时→Task 5、UI 注册→Task 12、测试策略→各 Task 内嵌、文档→Task 13。
- **对 spec 的两处收窄**（已在 Global Constraints 记录）：不引入 createXXXStore（沿用 useLoadState+local state）；存量硬编码中文不全量词典化（仅新增 chrome 文案进 `agent-toolkit` NS）。
- **类型一致性**：`ToolkitKey`/`ScheduleKey`/`BotListItem`/`ToolkitSectionInjected`/`migrateBotsIntoAgents`/`countBotsForAgent` 跨 Task 引用一致；Task 8/11 的 t 占位类型在 Task 12 收口。
