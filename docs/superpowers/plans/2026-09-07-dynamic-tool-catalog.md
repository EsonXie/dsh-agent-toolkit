# 动态工具名册（preset 面枚举）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents 面板工具白名单名册从静态常量（7 个 native）改为经宿主 `agentPresets.standingKeyFor` + `tools.schemas(scope)` 动态枚举 agent-team preset 真实工具面，并消除角色白名单在委派路径与 bot 会话路径之间的有效性不对称。

**Architecture:** 新增 `tool-catalog.ts` 模块封装动态枚举（每次 `/tools` 请求现算，不缓存）；bot 会话 setup 在 join 后用会话真实可见面对白名单做 warn-drop 求交；存量白名单一次性并入"preset 面 − native 常量"差集（meta 标记幂等）。设计依据：`docs/superpowers/specs/2026-09-07-dynamic-tool-catalog-design.md`。

**Tech Stack:** TypeScript / cordis / vitest / React（浏览器半）；构建 tsdown。

## Global Constraints

- `run_code` 是宿主 Code Mode 保留传输工具名：名册两组都排除，bot 求交时也排除（restrict 会拒收它）。常量 `RUN_CODE_NAME` 从 `@deepseek-ai/dsh-tools` 导入。
- `agentPresets` 是可选服务：一律 `ctx.get('agentPresets', false)` **惰性**解析（禁止 apply 期一次性捕获——attachments 教训）；缺席/枚举失败回退 `NATIVE_TOOL_NAMES` 常量。
- 枚举不缓存：每次调用现算（standing mount 由宿主按 composition 文件代际缓存）。
- 迁移顺序纪律（registry.ts）：全部存量迁移先于 `seedBuiltins` 执行——新装环境的 explorer 由种入直接携带只读白名单，不经过任何并入迁移。
- preset 并入迁移的并入集 = `preset 面 − NATIVE_TOOL_NAMES`（**不是**全量 preset 面）：write/edit 一直在 UI 可勾，用户不勾是有意排除，不得回收改；且跳过 `builtin === true` 的记录（explorer 只读白名单是插件设计，不 widen）。
- 防"fake 单测掩盖宿主语义"（2026-09-03 事故）：完成后必须做真实环境手动验收（见 Task 7）。
- 仓库约定：可调参数进 Config schema；本计划无新配置项（复用 `agentTeamPreset.id` / `botsId`）。
- 构建顺序纪律：toolkit 测试经 node_modules 解析 usage 的 lib/；本计划不改 usage，无需先 bundle usage。

---

### Task 1: 动态名册模块 `tool-catalog.ts`

**Files:**
- Create: `packages/toolkit/src/agents/tool-catalog.ts`
- Test: `packages/toolkit/src/agents/tool-catalog.test.ts`

**Interfaces:**
- Consumes: `NATIVE_TOOL_NAMES`（`../channels/basic-tools.ts`，兜底）；`RUN_CODE_NAME`（`@deepseek-ai/dsh-tools` 运行时导入）；`ScopeKey` 类型（`@deepseek-ai/dsh-scope`）。
- Produces: `export interface ToolCatalog { listPresetTools(): Promise<string[]>; listGlobalTools(): string[] }` 与 `export function createToolCatalog(ctx: Context, presetId: string): ToolCatalog`。**Task 3/4/5 都消费这两个签名**。

- [ ] **Step 1: 写失败测试**

创建 `packages/toolkit/src/agents/tool-catalog.test.ts`：

```ts
/** 动态名册：standing 面枚举（减 global、减 run_code、排序）；agentPresets 缺席/失败回退常量。 */
import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createToolCatalog } from './tool-catalog.ts'
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'

/** fake ctx：get('agentPresets') 返回注入的 fake；tools.schemas(scope) 按有无 scope 返回两个视图。 */
function fakeCtx(options: {
  presets?: { standingKeyFor(id?: string): Promise<unknown> } | undefined
  globalNames?: string[]
  presetNames?: string[]
}) {
  const warns: string[] = []
  const ctx = {
    get: (name: string) => (name === 'agentPresets' ? options.presets : undefined),
    tools: {
      schemas: (scope?: unknown) =>
        (scope === undefined ? (options.globalNames ?? []) : (options.presetNames ?? []))
          .map((name) => ({ name, description: '', parameters: {} })),
    },
    logger: { warn: (msg: string) => { warns.push(msg) } },
  } as unknown as Context
  return { ctx, warns }
}

describe('createToolCatalog', () => {
  test('preset 组 = standing 面减 global 名集、减 run_code，字典序排序', async () => {
    const { ctx } = fakeCtx({
      presets: { standingKeyFor: async () => ({ agentPreset: 'agent-team' }) },
      globalNames: ['team_delegate', 'run_code'],
      // standing 视图 = global 层 + preset 层（宿主 view() 语义）
      presetNames: ['web_search', 'team_delegate', 'pwsh', 'todo_write', 'run_code', 'read'],
    })
    const catalog = createToolCatalog(ctx, 'agent-team')
    expect(await catalog.listPresetTools()).toEqual(['pwsh', 'read', 'todo_write', 'web_search'])
  })

  test('agentPresets 缺席（旧宿主）→ 回退 NATIVE_TOOL_NAMES 常量，不 warn', async () => {
    const { ctx, warns } = fakeCtx({ presets: undefined })
    const catalog = createToolCatalog(ctx, 'agent-team')
    expect(await catalog.listPresetTools()).toEqual([...NATIVE_TOOL_NAMES])
    expect(warns).toEqual([])
  })

  test('standingKeyFor 抛错（preset 缺失/broken）→ warn + 回退常量', async () => {
    const { ctx, warns } = fakeCtx({
      presets: { standingKeyFor: async () => { throw new Error('preset "agent-team" not found') } },
    })
    const catalog = createToolCatalog(ctx, 'agent-team')
    expect(await catalog.listPresetTools()).toEqual([...NATIVE_TOOL_NAMES])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('agent-team')
  })

  test('global 组 = 顶层视图减 run_code', () => {
    const { ctx } = fakeCtx({ globalNames: ['team_delegate', 'run_code'] })
    const catalog = createToolCatalog(ctx, 'agent-team')
    expect(catalog.listGlobalTools()).toEqual(['team_delegate'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/tool-catalog.test.ts`
Expected: FAIL（`./tool-catalog.ts` 不存在）。

- [ ] **Step 3: 实现 `tool-catalog.ts`**

创建 `packages/toolkit/src/agents/tool-catalog.ts`：

```ts
/** 动态工具名册：团队 preset 面经宿主 standing mount 枚举（standingKeyFor + scoped schemas），
 *  agentPresets 缺席/枚举失败回退 NATIVE_TOOL_NAMES 常量。每次调用现算，不缓存——standing
 *  mount 由宿主按 composition 文件代际缓存，view 遍历是纯内存操作。
 *  设计：docs/superpowers/specs/2026-09-07-dynamic-tool-catalog-design.md */
import type { Context } from '@deepseek-ai/cordis'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
// type-only 激活 dsh-tools 对 cordis Context 的声明合并（ctx.tools）。
import type {} from '@deepseek-ai/dsh-tools'
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'

/** agentPresets 服务的结构类型（可选服务经 ctx.get 读取，team-preset.ts AgentPresetsLike 先例）。 */
interface PresetStandingLike {
  standingKeyFor(id?: string): Promise<ScopeKey>
}

/** Agents 面板/迁移/创建命令共用的工具名册。 */
export interface ToolCatalog {
  /** 团队 preset 工具面（不含 global 名与 run_code 保留名，字典序）。 */
  listPresetTools(): Promise<string[]>
  /** 顶层注册表全局工具名（不含 run_code 保留名）。 */
  listGlobalTools(): string[]
}

export function createToolCatalog(ctx: Context, presetId: string): ToolCatalog {
  return {
    async listPresetTools() {
      // 惰性解析（attachments 教训：apply 期一次性捕获会吃到未注册的 undefined）。
      const presets = ctx.get('agentPresets', false) as PresetStandingLike | undefined
      if (presets === undefined) return [...NATIVE_TOOL_NAMES]
      try {
        const key = await presets.standingKeyFor(presetId)
        const global = new Set(ctx.tools.schemas().map((s) => s.name))
        return ctx.tools.schemas(key).map((s) => s.name)
          .filter((n) => !global.has(n) && n !== RUN_CODE_NAME)
          .sort()
      } catch (error) {
        ctx.logger.warn(
          `dsh-agent-toolkit: 枚举 preset "${presetId}" 工具面失败，回退内置常量：${error instanceof Error ? error.message : String(error)}`,
        )
        return [...NATIVE_TOOL_NAMES]
      }
    },
    listGlobalTools() {
      return ctx.tools.schemas().map((s) => s.name).filter((n) => n !== RUN_CODE_NAME)
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/tool-catalog.test.ts`
Expected: PASS（4 个测试）。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/agents/tool-catalog.ts packages/toolkit/src/agents/tool-catalog.test.ts
git commit -m "feat(toolkit): 动态工具名册模块（standing 面枚举 + 常量兜底）"
```

---

### Task 2: bot 会话白名单求交（`agent-setup.ts`）

**Files:**
- Modify: `packages/toolkit/src/channels/agent-setup.ts`
- Test: `packages/toolkit/src/channels/agent-setup.test.ts`

**Interfaces:**
- Consumes: `ScopeJoiner`（`./scope-joiner.ts`，不变）；`scopeOf`（`@deepseek-ai/dsh-scope` 运行时导入，tool-scope.ts:3 已有先例）；`RUN_CODE_NAME`（Task 1 同款导入）。
- Produces: `setupAgentScope(agentCtx, hooks, joiner)` 签名**不变**；行为变化：`hooks.tools` 先与会话可见面求交（warn-drop 未知名），全丢弃则 throw。**Task 3 的迁移依赖本任务先落地**。

- [ ] **Step 1: 改测试（先红）**

`packages/toolkit/src/channels/agent-setup.test.ts` 的 `fakeAgentCtx` 增加 `tools.schemas`（求交的数据源）与 `logger.warn`：

```ts
/** fake agentCtx：记录 section / restrict 调用序列；schemas 返回注入的可见面。 */
function fakeAgentCtx(visibleNames: readonly string[] = ['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep']) {
  const calls: string[] = []
  const warns: string[] = []
  const ctx = {
    systemPrompt: { section: (input: { name: string; order?: number; text?: string }) => { calls.push(`section:${input.name}:${input.order}:${input.text ?? '-'}`) } },
    tools: {
      restrict: (input: { allow: readonly string[] }) => { calls.push(`restrict:${input.allow.join(',')}`) },
      schemas: () => visibleNames.map((name) => ({ name, description: '', parameters: {} })),
    },
    logger: { warn: (msg: string) => { warns.push(msg) } },
  }
  return { ctx: ctx as unknown as Context, calls, warns }
}
```

既有 5 个测试的 `fakeAgentCtx()` 调用不改（默认可见面含 `bash`，原断言全成立）。在 `describe('setupAgentScope')` 末尾追加：

```ts
  test('白名单含不可见工具：warn-drop 后 restrict 有效子集', async () => {
    const { ctx, calls, warns } = fakeAgentCtx(['bash', 'read'])
    await setupAgentScope(ctx, { tools: ['bash', 'web_search', 'read'] }, fakeToolsScope(calls))
    expect(calls).toEqual(['join', 'restrict:bash,read'])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('web_search')
  })

  test('白名单含 run_code：作为不可见名 warn-drop（restrict 拒收保留名）', async () => {
    const { ctx, calls, warns } = fakeAgentCtx(['bash', 'run_code'])
    await setupAgentScope(ctx, { tools: ['bash', 'run_code'] }, fakeToolsScope(calls))
    expect(calls).toEqual(['join', 'restrict:bash'])
    expect(warns[0]).toContain('run_code')
  })

  test('白名单求交后为空：抛错（防静默零工具会话）', async () => {
    const { ctx, calls } = fakeAgentCtx(['bash'])
    await expect(setupAgentScope(ctx, { tools: ['web_search'] }, fakeToolsScope(calls)))
      .rejects.toThrow('求交后为空')
    expect(calls).toEqual(['join']) // 不 restrict
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/agent-setup.test.ts`
Expected: 新增 3 个 FAIL（`web_search` 未 drop / 全丢弃未抛错）。

- [ ] **Step 3: 实现求交**

`packages/toolkit/src/channels/agent-setup.ts`：

- 文件头注释第 15-17 行末尾追加一句：`hooks.tools 先与该会话真实可见面求交（warn-drop 未知名）——同一白名单同时喂委派 toolFilter（父 preset 面）与 bot 会话（agent-bot 面），求交消除两条路径的有效性不对称。`
- 顶部导入追加：

```ts
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
```

- `if (hooks.tools !== undefined)` 块（现第 33-35 行）替换为：

```ts
  if (hooks.tools !== undefined) {
    // 求交：join 后的 scoped schemas = global + 祖先层（preset standing 或 BASIC_TOOLS
    // fallback standing），正是 restrict 的合法命名空间；未知名 warn-drop 而非抛错，
    // 使同一角色白名单在委派（父 preset 面）与 bot（agent-bot 面）两条路径都安全。
    const visible = new Set(agentCtx.tools.schemas(scopeOf(agentCtx)).map((s) => s.name)
      .filter((n) => n !== RUN_CODE_NAME))
    const effective = hooks.tools.filter((n) => visible.has(n))
    const dropped = hooks.tools.filter((n) => !visible.has(n))
    if (dropped.length > 0) {
      agentCtx.logger.warn(`dsh-agent-toolkit: 工具白名单含本会话不可见工具，已忽略：${dropped.join(', ')}`)
    }
    if (effective.length === 0) {
      throw new Error(`dsh-agent-toolkit: 工具白名单求交后为空（原 ${hooks.tools.length} 个均不可见）：${hooks.tools.join(', ')}`)
    }
    agentCtx.tools.restrict({ allow: effective })
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/agent-setup.test.ts`
Expected: PASS（8 个测试）。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/agent-setup.ts packages/toolkit/src/channels/agent-setup.test.ts
git commit -m "fix(toolkit): bot 会话白名单与会话可见面求交（warn-drop 未知名，消委派/bot 不对称）"
```

---

### Task 3: 存量白名单并入 preset 差集迁移（`registry.ts`）

**Files:**
- Modify: `packages/toolkit/src/agents/registry.ts`
- Test: `packages/toolkit/src/agents/registry.test.ts`

**Interfaces:**
- Consumes: `ToolCatalog.listPresetTools`（Task 1 的签名，作为可选第三参注入）；`NATIVE_TOOL_NAMES`（已导入）。
- Produces: `export const TOOLS_PRESET_MIGRATED_KEY = 'tools_preset_catalog_migrated'`；`createRegistry(warn, tables, listPresetTools?)`——**第三参可选**，Task 4 的 index.ts 接线传入；测试与旧调用方两参调用不受影响。

- [ ] **Step 1: 写失败测试**

`packages/toolkit/src/agents/registry.test.ts` 末尾追加（文件已导入 `NATIVE_TOOL_NAMES`、`FakeDomain`、`tablesOf`、`agentsOf`）：

```ts
test('createRegistry：存量自定义白名单一次性并入 preset 面减 native 的差集；builtin 不 widen', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('dev', { id: 'dev', name: 'Dev', tools: { allow: ['read'] } })
  await agentsOf(domain).put('explorer', { id: 'explorer', name: 'Explorer', builtin: true, tools: { allow: ['read'] } })
  const presetSurface = [...NATIVE_TOOL_NAMES, 'todo_write', 'web_search']
  const registry = await createRegistry(vi.fn(), tablesOf(domain), async () => presetSurface)
  // 差集（todo_write/web_search）并入普通角色；write/edit 属 native，不回收改
  expect(registry.get('dev')?.tools?.allow).toEqual(['read', 'todo_write', 'web_search'])
  // builtin explorer 的只读白名单是插件设计，不 widen
  expect(registry.get('explorer')?.tools?.allow).toEqual(['read'])
  expect(tablesOf(domain).meta.get('tools_preset_catalog_migrated')).toEqual({ value: '1' })
  // 标记已置：用户后续编辑（去掉并入项）不会再被并入
  await registry.upsert({ id: 'dev', name: 'Dev', tools: { allow: ['read'] } })
  const registry2 = await createRegistry(vi.fn(), tablesOf(domain), async () => presetSurface)
  expect(registry2.get('dev')?.tools?.allow).toEqual(['read'])
})

test('createRegistry：枚举失败 → 跳过迁移且不置标记（下次启动重试）', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('dev', { id: 'dev', name: 'Dev', tools: { allow: ['read'] } })
  const registry = await createRegistry(vi.fn(), tablesOf(domain), async () => { throw new Error('preset broken') })
  expect(registry.get('dev')?.tools?.allow).toEqual(['read'])
  expect(tablesOf(domain).meta.get('tools_preset_catalog_migrated')).toBeUndefined()
  // 下次启动枚举恢复 → 迁移执行
  const registry2 = await createRegistry(vi.fn(), tablesOf(domain), async () => ['read', 'todo_write'])
  expect(registry2.get('dev')?.tools?.allow).toEqual(['read', 'todo_write'])
})

test('createRegistry：不传 listPresetTools（两参调用）→ 跳过迁移且不置标记', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('dev', { id: 'dev', name: 'Dev', tools: { allow: ['read'] } })
  await createRegistry(vi.fn(), tablesOf(domain))
  expect(tablesOf(domain).meta.get('tools_preset_catalog_migrated')).toBeUndefined()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/registry.test.ts`
Expected: FAIL（`createRegistry` 不接受第三参 / 标记未置）。

- [ ] **Step 3: 实现迁移**

`packages/toolkit/src/agents/registry.ts`：

- 常量区（现第 20-24 行附近）追加：

```ts
/** tools.allow 一次性并入「preset 面 − 原生常量」差集的 meta 表标记键。 */
export const TOOLS_PRESET_MIGRATED_KEY = 'tools_preset_catalog_migrated'
```

- `createRegistry` 签名加可选第三参：

```ts
export async function createRegistry(
  warn: (msg: string) => void,
  tables: { agents: KvTable<string, AgentRecord>; meta: KvTable<string, { value: string }> },
  /** 动态 preset 工具面（tool-catalog.ts）；缺席 = 跳过 preset 并入迁移（不置标记）。 */
  listPresetTools?: () => Promise<string[]>,
): Promise<AgentRegistry> {
```

- 在原生并入块结束（`if (!nativeMigrated) await meta.put(...)` 之后）与 explorer 只读迁移之前，插入：

```ts
  // preset 并入：UI 从未提供 preset 工具名，存量自定义白名单缺它们非用户本意。
  // 并入集 = preset 面 − NATIVE_TOOL_NAMES（native 名一直在 UI 可勾，用户不勾是有意排除，
  // 不回收改）；builtin 记录跳过（explorer 只读白名单是插件设计，不 widen）。
  // 枚举失败/服务缺席：跳过且不置标记，下次启动重试。
  if (meta.get(TOOLS_PRESET_MIGRATED_KEY) === undefined && listPresetTools !== undefined) {
    let extra: string[] | undefined
    try {
      const surface = await listPresetTools()
      extra = surface.filter((n) => !NATIVE_TOOL_NAMES.includes(n))
    } catch {
      extra = undefined
    }
    if (extra !== undefined) {
      for (const [id, record] of agents.entries()) {
        if (record.builtin === true || record.tools === undefined) continue
        const missing = extra.filter((n) => !record.tools!.allow.includes(n))
        if (missing.length > 0) await agents.put(id, { ...record, tools: { allow: [...record.tools!.allow, ...missing] } })
      }
      await meta.put(TOOLS_PRESET_MIGRATED_KEY, { value: '1' })
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/registry.test.ts`
Expected: PASS（含既有测试——既有两参调用走"不传第三参"分支，行为不变）。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/agents/registry.ts packages/toolkit/src/agents/registry.test.ts
git commit -m "feat(toolkit): 存量白名单一次性并入 preset 面差集（builtin 不 widen，失败不置标记）"
```

---

### Task 4: `/tools` API 改 `{preset, global}` + index.ts 接线

**Files:**
- Modify: `packages/toolkit/src/agents/api.ts`
- Modify: `packages/toolkit/src/index.ts`
- Test: `packages/toolkit/src/agents/api.test.ts`

**Interfaces:**
- Consumes: `createToolCatalog`（Task 1）；`createRegistry` 第三参（Task 3）。
- Produces: `AgentsApiDeps.listPresetTools(): Promise<string[]>`（新增必需字段）；`GET /dsh-agent-toolkit/api/tools` 响应形状 `{ preset: string[]; global: string[] }`——**Task 6 的浏览器半按此形状消费**。

- [ ] **Step 1: 改测试（先红）**

`packages/toolkit/src/agents/api.test.ts`：

- `harness` 的 `deps` 字面量（第 74-80 行）加一行：`listPresetTools: async () => ['pwsh', 'read', 'todo_write', 'web_search'],`
- 末尾 `/tools` 测试（第 261-270 行）替换为：

```ts
test('GET /tools 返回分组工具名册（preset 动态面 + global 全局注册）', async () => {
  const { handler } = harness()
  const res = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/tools'), res)
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({
    preset: ['pwsh', 'read', 'todo_write', 'web_search'],
    global: ['bash', 'read', 'write'],
  })
})
```

- 删除第 7 行 `import { NATIVE_TOOL_NAMES } ...`（不再使用）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/api.test.ts`
Expected: FAIL（`listPresetTools` 不在 deps 类型 / 响应仍是 `{native, global}`）。

- [ ] **Step 3: 改 api.ts**

`packages/toolkit/src/agents/api.ts`：

- 删第 8 行 `import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'`。
- `AgentsApiDeps`（第 15-21 行）在 `listTools` 后加：

```ts
  /** 团队 preset 工具面（tool-catalog 动态枚举，含回退）。 */
  listPresetTools(): Promise<string[]>
```

- `/tools` 分支（第 34-38 行）替换为：

```ts
    if (sub === '/tools' && method === 'GET') {
      // 分组名册：preset = agent-team standing 面动态枚举（缺席回退常量），global = 顶层注册表。
      json(res, 200, { preset: await deps.listPresetTools(), global: deps.listTools() })
      return
    }
```

- [ ] **Step 4: 改 index.ts 接线（含 setupAgentTeamPreset 前移）**

`packages/toolkit/src/index.ts`：

- 顶部导入追加：`import { createToolCatalog } from './agents/tool-catalog.ts'`
- 把第 168-169 行（`// agentPresets 为可选服务…` 注释 + `await setupAgentTeamPreset(ctx, config.agentTeamPreset)`）**剪切**到 `createRegistry` 调用（第 127 行）之前，注释改写为：

```ts
  // agent-team / agent-bot preset 生成必须先于 createRegistry：preset 并入迁移要枚举
  // agent-team 面（standingKeyFor 按 composition 文件挂载，首启时尚未生成会枚举失败跳过）。
  // agentPresets 为可选服务（rc2 旧宿主缺席时内部静默跳过），不进 inject。
  await setupAgentTeamPreset(ctx, config.agentTeamPreset)
  const toolCatalog = createToolCatalog(ctx, config.agentTeamPreset.id)
```

- `createRegistry` 调用（第 127 行）改为：

```ts
  const registry = await createRegistry(warn, { agents: tables.agents, meta: tables.meta }, toolCatalog.listPresetTools)
```

注意：`toolCatalog.listPresetTools` 是不带 this 的闭包方法（Task 1 实现为对象字面量箭头函数），直接传引用安全。

- 第 146 行 `const listTools = ...` 删除；`setupAgentsApi` 与 `setupCreateAgentCommand` 调用改为：

```ts
  setupAgentsApi(ctx, {
    registry,
    listTools: toolCatalog.listGlobalTools,
    listPresetTools: toolCatalog.listPresetTools,
    listProviders: () => ctx.llm.listProviders().map(({ id, name }) => ({ id, name })),
    listModels: (provider) => ctx.llm.listModels(provider).then((models) => models.map(({ id, name }) => ({ id, name }))),
  })
  // /create-agent 命令恒启用（引导主 Agent 访谈并复用面板 API 落库，不新增工具/API）。
  setupCreateAgentCommand(ctx, { registry, listTools: toolCatalog.listGlobalTools, listPresetTools: toolCatalog.listPresetTools })
```

（`setupCreateAgentCommand` 的 deps 变更在 Task 5 落地；本步先只改 `listTools` 来源，`listPresetTools` 在 Task 5 加——若 typecheck 因多传字段报错则本步不加最后一项，Task 5 补。）

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/api.test.ts` → PASS
Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 通过，或仅 `create-command.ts` 相关报错（`listPresetTools` 多传）——若有，从 `setupCreateAgentCommand` 调用中暂删该字段，Task 5 补回。

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/agents/api.ts packages/toolkit/src/agents/api.test.ts packages/toolkit/src/index.ts
git commit -m "feat(toolkit): /tools API 改 {preset, global} 动态名册，preset 生成前移至注册表迁移之前"
```

---

### Task 5: `/create-agent` 引导文本用动态名册

**Files:**
- Modify: `packages/toolkit/src/agents/create-command.ts`
- Test: `packages/toolkit/src/agents/create-command.test.ts`
- （可能）Modify: `packages/toolkit/src/index.ts`（若 Task 4 Step 5 暂删了 `listPresetTools` 传参，此处补回）

**Interfaces:**
- Consumes: `ToolCatalog.listPresetTools`（Task 1，经 deps 注入）。
- Produces: `CreateAgentCommandDeps.listPresetTools(): Promise<string[]>`（新增必需字段）；`CreateAgentGuidanceInput.presetTools: string[]`（替换文本中对 `NATIVE_TOOL_NAMES` 的直接引用）。

- [ ] **Step 1: 改测试（先红）**

`packages/toolkit/src/agents/create-command.test.ts`：

- 删第 5 行 `import { NATIVE_TOOL_NAMES } ...`。
- `BASE_INPUT`（第 8-13 行）加字段：

```ts
  presetTools: ['pwsh', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'todo_write', 'web_search'],
```

- 第 21 行 `for (const name of NATIVE_TOOL_NAMES) ...` 替换为：

```ts
  for (const name of BASE_INPUT.presetTools) expect(text).toContain(name)
  expect(text).toContain('团队 preset 工具：')
```

- 三个 `setupCreateAgentCommand` 测试的 deps 都加 `listPresetTools: async () => []`；handler 改 async 后三处 `captured[0]!.handler({...})` 调用前加 `await`，三个测试函数签名改 `async`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/create-command.test.ts`
Expected: FAIL（`presetTools` 不在 input 类型 / 文本无「团队 preset 工具」行）。

- [ ] **Step 3: 改 create-command.ts**

- 删第 8 行 `import { NATIVE_TOOL_NAMES } ...`。
- `CreateAgentGuidanceInput` 在 `globalTools` 前加：

```ts
  /** 团队 preset 工具名（动态名册）。 */
  presetTools: string[]
```

- 工具清单节（第 46-49 行）替换为：

```ts
    '## 可用工具清单',
    `团队 preset 工具：${input.presetTools.join(', ')}`,
    `全局工具：${input.globalTools.join(', ')}`,
    '省略 tools 字段表示不限制（Agent 可使用全部工具）。一旦给出白名单，该 Agent 只有列出的工具可用：通常应保留 read/glob/grep/shell 等基础工具，否则失去读文件/搜索/执行命令等基本能力（最终取舍按需求判断，如只读角色可去掉 write/edit）。',
```

- `CreateAgentCommandDeps` 加：`listPresetTools(): Promise<string[]>`。
- handler 改 async 并 await 名册：

```ts
    handler: async ({ rawInput, agent }: { rawInput: string; agent: { followup(message: unknown): void } }) => {
      const webServer = ctx.get('webServer') as { port: number } | undefined
      const origin = webServer === undefined ? undefined : `http://127.0.0.1:${webServer.port}`
      const text = buildCreateAgentGuidance({
        requirement: rawInput.trim(),
        agentIds: deps.registry.list().map((agent) => agent.id),
        presetTools: await deps.listPresetTools(),
        globalTools: deps.listTools(),
        origin,
      })
```

（宿主 commands 的 handler 类型即 `CommandResult | Promise<CommandResult>`——已核实 `interaction/commands/src/index.ts:54`。）

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/create-command.test.ts` → PASS
Run: `pnpm --filter dsh-agent-toolkit typecheck` → 通过（若 index.ts 尚缺 `listPresetTools` 传参，此处补回后再跑）。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/agents/create-command.ts packages/toolkit/src/agents/create-command.test.ts packages/toolkit/src/index.ts
git commit -m "feat(toolkit): /create-agent 引导文本改用动态 preset 名册"
```

---

### Task 6: 浏览器半 catalog 形状与分组标签

**Files:**
- Modify: `packages/toolkit/src/client/agents/api.ts:29`
- Modify: `packages/toolkit/src/client/agents/AgentEditor.tsx`
- Test: `packages/toolkit/src/client/agents/agents.spec.tsx`、`packages/toolkit/src/client/agents/agents-entry.client.spec.tsx`

**Interfaces:**
- Consumes: Task 4 的 `/tools` 响应形状 `{ preset: string[]; global: string[] }`。
- Produces: `ToolsCatalog { preset: string[]; global: string[] }`（`client/agents/api.ts`）；无其他消费方。

- [ ] **Step 1: 改测试夹具（先红）**

`agents.spec.tsx` 第 39 行：

```ts
    '/dsh-agent-toolkit/api/tools': () => ({ preset: ['bash', 'read'], global: ['write'] }),
```

`agents-entry.client.spec.tsx` 第 24 行：把 `{ native: ['bash'], global: [] }` 改为 `{ preset: ['bash'], global: [] }`。

agents.spec.tsx 中若有断言引用「原生工具」文案，改为「团队 preset 工具」（先用 grep 确认：`rg -n "原生" packages/toolkit/src/client/agents/`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/agents/`
Expected: FAIL（`native` 字段不存在 / 分组标签不匹配）。

- [ ] **Step 3: 改 client 代码**

`client/agents/api.ts` 第 29 行：

```ts
export interface ToolsCatalog { preset: string[]; global: string[] }
```

`client/agents/AgentEditor.tsx`：

- 第 38 行 `useState<ToolsCatalog>({ native: [], global: [] })` → `useState<ToolsCatalog>({ preset: [], global: [] })`
- 第 52 行 `if (creating) setTools([...c.native, ...c.global])` → `if (creating) setTools([...c.preset, ...c.global])`（行内注释「原生 + 扩展」改「preset + 全局」）
- 第 186 行 `catalog.native.length === 0 && catalog.global.length === 0` → `catalog.preset.length === 0 && catalog.global.length === 0`
- 第 190 行 `<p className={css.toolGroupTitle}>原生工具</p>` → `团队 preset 工具`
- 第 192 行 `catalog.native.map` → `catalog.preset.map`
- 第 202 行 `<p className={css.toolGroupTitle}>扩展工具</p>` → `全局工具`
- 第 204 行 `catalog.global.map` 不变

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/agents/`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/client/agents/
git commit -m "feat(toolkit): Agents 面板工具名册分组改 preset/全局（动态名册）"
```

---

### Task 7: 注释/文档收尾 + 全量验证 + 真实环境手动验收

**Files:**
- Modify: `packages/toolkit/src/channels/basic-tools.ts`（注释语义改写）
- Modify: `docs/usage/agents.md`
- Modify: `AGENTS.md`
- 验证：`pnpm --filter dsh-agent-toolkit test` + `typecheck` + `bundle`

- [ ] **Step 1: basic-tools.ts 注释改写**

`NATIVE_TOOL_NAMES` 的块注释（第 35-38 行）改写为：

```ts
/** 内置工具名常量（兜底名单）：agentPresets 缺席或 standing 枚举失败时，Agents 面板名册
 *  与存量迁移回退到这份常量。语义已降级为"兜底"，不再承诺是完整原生工具面——完整面 =
 *  团队 preset 动态枚举（agents/tool-catalog.ts）。explorer 只读白名单仍从本常量派生
 *  （刻意的最小集，不追求完整）。 */
```

- [ ] **Step 2: docs/usage/agents.md 更新**

- 第 20 行表格行：「原生工具」（pwsh/bash、…glob/grep）和「扩展工具」（顶层全局工具）两组 → 改为「团队 preset 工具」（动态枚举 agent-team preset 真实挂载的工具面）和「全局工具」（顶层全局工具）两组。
- 第 66 行后追加一行迁移说明：`- 存量自定义白名单会一次性并入「preset 面 − 内置常量」差集（\`meta\` 表 \`tools_preset_catalog_migrated\` 标记，幂等；内置角色不 widen，枚举失败下次启动重试）`
- 第 79 行 API 表：`{native, global}` → `{preset, global}`。
- 工具白名单语义处补一句：bot 会话加载角色白名单时与会话可见面求交，不可见名记 warn 忽略（不再抛错）。

- [ ] **Step 3: AGENTS.md 更新**

- 「dsh 插件开发要点」节中 Agents 注册表段落的白名单描述更新：`/tools` 名册 = 动态枚举 agent-team standing 面（`agents/tool-catalog.ts`，缺席/失败回退 `NATIVE_TOOL_NAMES` 兜底）；bot 会话白名单 warn-drop 求交（`channels/agent-setup.ts`）；新增迁移标记 `tools_preset_catalog_migrated`。

- [ ] **Step 4: 全量三件套**

Run: `pnpm --filter dsh-agent-toolkit test` → 449+ 全过
Run: `pnpm --filter dsh-agent-toolkit typecheck` → 过
Run: `pnpm --filter dsh-agent-toolkit bundle` → 产出 lib/index.js + lib/client.js

- [ ] **Step 5: 真实环境手动验收（防 fake 掩盖宿主语义，2026-09-03 事故教训）**

```bash
cd deepseek-harness
pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml
```

验收清单：
1. Agents 面板打开编辑器 → 工具白名单出现「团队 preset 工具」组，含 `todo_write`、`web_search`、`ask_user_question`、`job_list`、`skill`、`exit_plan_mode` 等，且无 `run_code`；
2. 新建白名单含 `web_search` 的角色 → 主会话 `team_delegate` 委派该角色 → 子会话可用 `web_search`；
3. bot 绑定该角色 → 飞书 `/new` 建会话不抛错，宿主日志有 warn 记录被忽略的不可见名（若有）；
4. `/create-agent` 引导文本含「团队 preset 工具：」行动态名单。

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/channels/basic-tools.ts docs/usage/agents.md AGENTS.md
git commit -m "docs(toolkit): 动态工具名册文档与注释收尾"
```

---

## Self-Review 记录

- **Spec 覆盖**：动态枚举（Task 1）/ API 变更（Task 4）/ UI 分组（Task 6）/ bot 求交（Task 2）/ 存量迁移（Task 3）/ create-command（Task 5）/ explorer 不动 + 兜底常量语义（Task 7）/ 非目标无需任务。✅
- **顺序依赖**：Task 2（求交）先于 Task 3（迁移 widen）——spec 的硬约束，已排序。✅
- **类型一致性**：`ToolCatalog`/`listPresetTools`/`TOOLS_PRESET_MIGRATED_KEY`/`{preset, global}` 跨任务一致；Task 4 与 Task 5 对 index.ts 的接力改动已显式标注条件分支。✅
- **占位符**：无 TBD；所有代码步含完整代码。✅
