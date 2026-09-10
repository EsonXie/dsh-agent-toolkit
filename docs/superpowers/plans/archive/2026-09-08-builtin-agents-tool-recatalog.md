# 内置 Agent 默认工具名单重选实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内置角色 explorer / general 的默认工具名单按 agent-team preset 真实面重选（explorer 5→10、general 无限制→显式 20 个不含 team_delegate），存量环境条件式迁移，并给委派路径补上与 bot 路径对称的白名单求交 warn-drop。

**Architecture:** `builtin.ts` 重选静态名单（shell 平台条件派生）+ `registry.ts` 新增条件式迁移（仅更新仍是旧默认值的 builtin 记录，meta 幂等标记）+ `delegate/tool.ts` 委派时白名单与父会话可见面求交（`scopeOf(agent.ctx)` + scoped schemas，未知名 warn-drop、空交集抛错）。设计依据：`docs/superpowers/specs/2026-09-08-builtin-agents-tool-recatalog-design.md`。

**Tech Stack:** TypeScript / cordis / vitest；构建 tsdown。

## Global Constraints

- shell 名平台互斥派生（win32=`pwsh`、其余=`bash`），任何名单不写死 shell 名——宿主 `tools.restrict` 对未知名响亮失败。
- `run_code` 是宿主 Code Mode 保留传输工具名：任何白名单不得包含；求交时作为不可见名过滤。常量 `RUN_CODE_NAME` 从 `@deepseek-ai/dsh-tools` 导入（`agents/tool-catalog.ts:6`、`channels/agent-setup.ts:9` 已有先例）。
- 迁移顺序纪律（registry.ts）：全部存量迁移先于 `seedBuiltins` 执行；新装环境由 seed 直接携带新名单，不经过迁移。
- 条件式迁移只作用 `builtin === true` 的记录；用户在面板改过的记录 = 自定义，跳过。
- 委派求交与 bot 路径（`channels/agent-setup.ts:41-42`）同款手段：`ctx.tools.schemas(scopeOf(ctx))` 减 `RUN_CODE_NAME`；`scopeOf` 从 `@deepseek-ai/dsh-scope` 导入（`channels/agent-setup.ts:8` 先例）。
- 测试命令：`pnpm --filter dsh-agent-toolkit exec vitest run <path>`；类型检查 `pnpm --filter dsh-agent-toolkit typecheck`。
- 构建顺序纪律：本计划不改 usage，无需先 bundle usage；进开发回路前跑 `pnpm --filter dsh-agent-toolkit bundle`。
- 防"fake 单测掩盖宿主语义"（2026-09-03 事故）：完成后真实环境手动验收（Task 4 Step 4）。

---

### Task 1: `builtin.ts` 名单重选

**Files:**
- Modify: `packages/toolkit/src/agents/builtin.ts`
- Test: `packages/toolkit/src/agents/registry.test.ts`

**Interfaces:**
- Produces: `EXPLORER_READONLY_ALLOW`（10 个，签名不变 `readonly string[]`）；新导出 `GENERAL_ALLOW: readonly string[]`（20 个）与 `LEGACY_EXPLORER_ALLOW: readonly string[]`（旧 5 个，迁移比对基准）。**Task 2 的迁移消费这三个常量。**

- [ ] **Step 1: 改测试（先红）**

`packages/toolkit/src/agents/registry.test.ts`：

- 第 8 行导入改为：

```ts
import { EXPLORER_READONLY_ALLOW, GENERAL_ALLOW, LEGACY_EXPLORER_ALLOW } from './builtin.ts'
```

- 第 191-198 行测试整体替换为：

```ts
test('createRegistry：内置 explorer 默认只读白名单（不含 write/edit）；general 默认 preset 面全量（不含 team_delegate/run_code）', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry.get('explorer')?.tools?.allow).toEqual(EXPLORER_READONLY_ALLOW)
  expect(registry.get('explorer')?.tools?.allow).not.toContain('write')
  expect(registry.get('explorer')?.tools?.allow).not.toContain('edit')
  expect(registry.get('general')?.tools?.allow).toEqual(GENERAL_ALLOW)
  expect(registry.get('general')?.tools?.allow).not.toContain('team_delegate')
  expect(registry.get('general')?.tools?.allow).not.toContain('run_code')
})
```

- 文件末尾追加：

```ts
test('内置名单重选：explorer = 旧只读五件 + 只读安全五件（含 skill）；general = preset 面 20 个', () => {
  for (const name of ['web_search', 'todo_write', 'job_list', 'job_output', 'skill']) {
    expect(EXPLORER_READONLY_ALLOW).toContain(name)
  }
  expect(EXPLORER_READONLY_ALLOW).toHaveLength(LEGACY_EXPLORER_ALLOW.length + 5)
  expect(LEGACY_EXPLORER_ALLOW).toHaveLength(5)
  expect(GENERAL_ALLOW).toHaveLength(20)
  for (const name of ['write', 'edit', 'job_kill', 'ralph', 'workflow', 'ask_user_question', 'skill', 'exit_plan_mode', 'create_goal', 'get_goal', 'update_goal']) {
    expect(GENERAL_ALLOW).toContain(name)
  }
  expect(GENERAL_ALLOW).not.toContain('team_delegate')
  expect(GENERAL_ALLOW).not.toContain('run_code')
  // shell 平台条件派生，两名单恰好含一个 shell 名
  expect(GENERAL_ALLOW.filter((n) => n === 'pwsh' || n === 'bash')).toHaveLength(1)
  expect(EXPLORER_READONLY_ALLOW.filter((n) => n === 'pwsh' || n === 'bash')).toHaveLength(1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/registry.test.ts`
Expected: FAIL（`GENERAL_ALLOW`/`LEGACY_EXPLORER_ALLOW` 未导出；general 仍无 tools）。

- [ ] **Step 3: 实现 `builtin.ts`**

`packages/toolkit/src/agents/builtin.ts` 全文替换为：

```ts
/** 内置保底 Agent 记录：main + explorer（只读白名单 10 个）/ general（preset 面全量 20 个、禁二级委派）。 */
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'
import type { AgentRecord } from './store.ts'

const SHELL_NAME = process.platform === 'win32' ? 'pwsh' : 'bash'

/** 旧版 explorer 默认白名单（5 个）：存量条件式迁移的等值比对基准。
 *  独立于 EXPLORER_READONLY_ALLOW 保留旧派生式——比对基准不可随新名单漂移。
 *  shell 名平台互斥（win32=pwsh、其余=bash），必须从 NATIVE_TOOL_NAMES 派生不可写死。 */
export const LEGACY_EXPLORER_ALLOW: readonly string[] = NATIVE_TOOL_NAMES.filter((n) => n !== 'write' && n !== 'edit')

/** explorer 默认白名单（10 个）：只读基础五件（shell/read/read_image/glob/grep，旧派生不变）
 *  + preset 面只读安全五件（web_search/todo_write/job_list/job_output/skill——skill 加载的是
 *  指令文本，本身只读，用户决策默认可用）。
 *  编排类（ralph/workflow）、写文件类（write/edit）、job_kill、ask_user_question、
 *  goal 三件套、exit_plan_mode 不进只读名单。 */
export const EXPLORER_READONLY_ALLOW: readonly string[] = [
  ...LEGACY_EXPLORER_ALLOW,
  'web_search', 'todo_write', 'job_list', 'job_output', 'skill',
]

/** general 默认白名单（20 个）：agent-team preset standing 面全量（2026-09-08 实测枚举），
 *  不含 team_delegate（禁二级委派）与 run_code（宿主 Code Mode 保留名，restrict 拒收）。
 *  静态名单：preset 面日后新增工具不自动进入，需人工再梳理（见 spec 非目标）。 */
export const GENERAL_ALLOW: readonly string[] = [
  SHELL_NAME, 'read', 'write', 'edit', 'read_image', 'glob', 'grep',
  'todo_write', 'web_search', 'ask_user_question', 'skill', 'exit_plan_mode',
  'job_list', 'job_output', 'job_kill', 'create_goal', 'get_goal', 'update_goal',
  'ralph', 'workflow',
]

export const BUILTIN_AGENTS: readonly AgentRecord[] = [
  {
    id: 'main',
    name: '主 Agent',
    builtin: true,
  },
  {
    id: 'explorer',
    name: 'Explorer',
    description: '快速只读代码库探索：定位文件/符号、回答结构与调用关系问题，不做任何修改',
    persona: `你是代码库探索员。快速定位与任务相关的文件与符号，回答关于代码结构、
调用关系、实现位置的问题。你只读不写：不修改任何文件、不运行有副作用的命令。
输出结论清单，每条附文件路径与行号；信息不足时说明缺口，不要猜测。`,
    builtin: true,
    tools: { allow: [...EXPLORER_READONLY_ALLOW] },
  },
  {
    id: 'general',
    name: 'General',
    description: '通用多步骤任务执行：可读可写、可运行命令，完成实现/修复类任务',
    persona: `你是通用执行员。按任务书独立完成多步骤工作，可以读写文件、运行命令。
动手前先阅读相关 AGENTS.md 并遵循项目约定；完成后运行与改动相关的检查
（测试/类型检查）验证改动，并在最终输出中报告验证结果。`,
    builtin: true,
    tools: { allow: [...GENERAL_ALLOW] },
  },
]
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/registry.test.ts src/agents/import-yaml.test.ts`
Expected: PASS（import-yaml 只透明使用 explorer 记录，不受名单内容影响）。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/agents/builtin.ts packages/toolkit/src/agents/registry.test.ts
git commit -m "feat(toolkit): 内置名单按 preset 面重选（explorer 5→10 只读安全件，general 显式 20 禁二级委派）"
```

---

### Task 2: `registry.ts` 存量条件式迁移

**Files:**
- Modify: `packages/toolkit/src/agents/registry.ts`
- Test: `packages/toolkit/src/agents/registry.test.ts`

**Interfaces:**
- Consumes: `EXPLORER_READONLY_ALLOW` / `GENERAL_ALLOW` / `LEGACY_EXPLORER_ALLOW`（Task 1）。
- Produces: `export const BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY = 'builtin_tools_recatalog_migrated'`（meta 标记键，文档任务引用）。

- [ ] **Step 1: 写失败测试**

`packages/toolkit/src/agents/registry.test.ts`：

- 第 7 行导入改为：

```ts
import { createRegistry, BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY, EXPLORER_READONLY_MIGRATED_KEY, TOOLS_NATIVE_MIGRATED_KEY, type AgentRegistry } from './registry.ts'
```

- 文件末尾追加：

```ts
test('createRegistry：旧默认内置名单一次性重选（explorer 5→10、general 无→20），meta 标记幂等', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' }) // 隔离原生并入（否则 LEGACY 先被补 write/edit，等值比对永不命中）
  await tables.agents.put('explorer', { id: 'explorer', name: 'Explorer', builtin: true, tools: { allow: [...LEGACY_EXPLORER_ALLOW] } })
  await tables.agents.put('general', { id: 'general', name: 'General', builtin: true })
  const registry = await createRegistry(vi.fn(), tables)
  expect(registry.get('explorer')?.tools?.allow).toEqual(EXPLORER_READONLY_ALLOW)
  expect(registry.get('general')?.tools?.allow).toEqual(GENERAL_ALLOW)
  expect(tables.meta.get(BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY)).toEqual({ value: '1' })
  // 标记已置：用户后续编辑（如 explorer 去掉并入项）不会被回收改
  await registry.upsert({ id: 'explorer', name: 'Explorer', builtin: true, tools: { allow: ['read'] } })
  const registry2 = await createRegistry(vi.fn(), tables)
  expect(registry2.get('explorer')?.tools?.allow).toEqual(['read'])
})

test('createRegistry：用户自定义过的内置记录跳过（explorer 改过白名单 / general 已配 tools），标记仍置位', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' }) // 隔离原生并入
  await tables.agents.put('explorer', { id: 'explorer', name: 'Explorer', builtin: true, tools: { allow: ['read'] } })
  await tables.agents.put('general', { id: 'general', name: 'General', builtin: true, tools: { allow: ['read', 'write'] } })
  const registry = await createRegistry(vi.fn(), tables)
  expect(registry.get('explorer')?.tools?.allow).toEqual(['read'])
  expect(registry.get('general')?.tools?.allow).toEqual(['read', 'write'])
  expect(tables.meta.get(BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY)).toEqual({ value: '1' })
})

test('createRegistry：原生并入加写后的 explorer（旧 5 + write/edit 共 7 个形状）同样更新为新名单，write/edit 随之移除', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' })
  await tables.agents.put('explorer', { id: 'explorer', name: 'Explorer', builtin: true, tools: { allow: [...LEGACY_EXPLORER_ALLOW, 'write', 'edit'] } })
  const registry = await createRegistry(vi.fn(), tables)
  expect(registry.get('explorer')?.tools?.allow).toEqual(EXPLORER_READONLY_ALLOW)
  expect(registry.get('explorer')?.tools?.allow).not.toContain('write')
  expect(registry.get('explorer')?.tools?.allow).not.toContain('edit')
})

test('createRegistry：同 id 非 builtin 记录不动（用户数据），builtin 才迁移', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' })
  await tables.agents.put('general', { id: 'general', name: '自定义', builtin: false })
  const registry = await createRegistry(vi.fn(), tables)
  expect(registry.get('general')).toEqual({ id: 'general', name: '自定义', builtin: false })
  expect(tables.meta.get(BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY)).toEqual({ value: '1' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/registry.test.ts`
Expected: FAIL（`BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY` 未导出 / 迁移未执行）。

- [ ] **Step 3: 实现迁移**

`packages/toolkit/src/agents/registry.ts`：

- 第 4 行导入改为：

```ts
import { BUILTIN_AGENTS, EXPLORER_READONLY_ALLOW, GENERAL_ALLOW, LEGACY_EXPLORER_ALLOW } from './builtin.ts'
```

- 常量区（第 27 行 `TOOLS_PRESET_MIGRATED_KEY` 之后）追加：

```ts
/** 内置角色工具名单重选（explorer 5→10 / general 无→20）一次性迁移的 meta 表标记键。 */
export const BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY = 'builtin_tools_recatalog_migrated'
```

- 文件头注释第 30 行迁移清单句改为：`打开 dsh_agent_toolkit 域 → 首启 YAML 导入 → 旧记录迁移（promptLayers/原生并入/preset 差集并入/explorer 只读/内置名单重选）→`

- explorer 只读迁移块（第 84-91 行）之后、`await seedBuiltins(agents)`（第 93 行）之前，插入：

```ts
  // 内置名单重选一次性迁移（2026-09-08）：explorer 旧默认 → 新 10 个；general 无 tools
  // → preset 面全量 20 个。条件式：仅更新仍是旧默认值的 builtin 记录（用户面板改过的 =
  // 自定义，跳过）。explorer 旧默认有两种形状：纯净 5 个（seed/只读迁移写入的 LEGACY 派生
  // 顺序）与原生并入加写后的 7 个（[...LEGACY, write, edit]——0.2.x 时代 native 合并不
  // 跳过 builtin 记录，真实存量多为此形状）；7 个形状替换后 write/edit 随之移除，只读
  // 约束随新名单恢复。同 id 非 builtin 记录是用户数据，不动。无外部依赖，跑完即置标记。
  if (meta.get(BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY) === undefined) {
    const explorer = agents.get('explorer')
    const legacyShapes: readonly string[][] = [LEGACY_EXPLORER_ALLOW, [...LEGACY_EXPLORER_ALLOW, 'write', 'edit']]
    if (explorer?.builtin === true && explorer.tools !== undefined
      && legacyShapes.some((shape) => explorer.tools!.allow.length === shape.length
        && explorer.tools!.allow.every((n, i) => n === shape[i]))) {
      await agents.put('explorer', { ...explorer, tools: { allow: [...EXPLORER_READONLY_ALLOW] } })
    }
    const general = agents.get('general')
    if (general?.builtin === true && general.tools === undefined) {
      await agents.put('general', { ...general, tools: { allow: [...GENERAL_ALLOW] } })
    }
    await meta.put(BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY, { value: '1' })
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/registry.test.ts`
Expected: PASS（全部，含既有测试——既有两参调用走同一迁移块，新装 seed 直接带新名单、迁移 no-op 置标记）。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/agents/registry.ts packages/toolkit/src/agents/registry.test.ts
git commit -m "feat(toolkit): 内置名单重选存量条件式迁移（仅旧默认值记录，自定义跳过，幂等标记）"
```

---

### Task 3: 委派路径白名单求交（`delegate/tool.ts` + 接线）

**Files:**
- Modify: `packages/toolkit/src/delegate/tool.ts`
- Modify: `packages/toolkit/src/delegate/index.ts`
- Test: `packages/toolkit/src/delegate/tool.test.ts`

**Interfaces:**
- Consumes: `RUN_CODE_NAME`（`@deepseek-ai/dsh-tools`）；`scopeOf`（`@deepseek-ai/dsh-scope`，接线处）。
- Produces: `DelegateToolDeps` 新增两个必需字段——`visibleSurface(agent: Agent): string[]` 与 `warn(msg: string): void`。无其他消费方。

- [ ] **Step 1: 改测试（先红）**

`packages/toolkit/src/delegate/tool.test.ts`：

- `depsWith` 的 `extras` 参数类型与返回体扩展（第 37-51 行替换为）：

```ts
function depsWith(
  run: SubagentRun,
  captured: Captured[],
  buildPersona: (role: AgentRecord) => string = fakePersona,
  extras: {
    active?: ActiveRoutes
    recordRoute?: (id: string, route: DelegateRoute) => Promise<void>
    visibleSurface?: (agent: Agent) => string[]
    warn?: (msg: string) => void
  } = {},
): DelegateToolDeps {
  return {
    roster: () => ROSTER,
    provider: 'spawn',
    buildPersona,
    startRun: async (provider, request) => { captured.push({ provider, request }); return run },
    active: extras.active ?? createActiveRoutes(),
    recordRoute: extras.recordRoute ?? (async () => {}),
    // 默认可见面含 scout 白名单两名（read/search），既有透传断言不受影响。
    visibleSurface: extras.visibleSurface ?? (() => ['read', 'search', 'write', 'bash']),
    warn: extras.warn ?? (() => {}),
  }
}
```

- 第 260-267 行字面量 deps（'角色 model 字段含空串'测试内）补两个字段：

```ts
    recordRoute: async (id, route) => { recorded.push({ id, route }) },
    visibleSurface: () => ['read', 'search', 'write', 'bash'],
    warn: () => {},
  })
```

- 第 99 行测试标题改为「角色配了 tools.allow：与可见面求交后传 toolFilter（数组拷贝，不共享引用）」（断言不变：默认可见面含 read/search，结果仍 `{ allow: ['read', 'search'] }`）。

- 文件末尾追加：

```ts
test('白名单与父会话可见面求交：未知名 warn-drop 后传有效子集', async () => {
  const captured: Captured[] = []
  const warns: string[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured, fakePersona, {
    visibleSurface: () => ['read'],
    warn: (msg) => { warns.push(msg) },
  }))
  await callTool(tool, { role: 'scout', description: '探索', prompt: '任务' }) // scout allow = ['read', 'search']
  expect(captured[0].request.toolFilter).toEqual({ allow: ['read'] })
  expect(warns).toHaveLength(1)
  expect(warns[0]).toContain('search')
})

test('白名单含 run_code：即便可见面误含保留名也 warn-drop（宿主 restrict 拒收）', async () => {
  const captured: Captured[] = []
  const warns: string[] = []
  const roster: AgentRecord[] = [{ id: 'coder', name: 'Coder', tools: { allow: ['read', 'run_code'] } }]
  const deps: DelegateToolDeps = {
    ...depsWith(okRun([]), captured),
    roster: () => roster,
    visibleSurface: () => ['read', 'run_code'],
    warn: (msg) => { warns.push(msg) },
  }
  const tool = createDelegateTool('team_delegate', deps)
  await callTool(tool, { role: 'coder', description: '执行', prompt: '任务' })
  expect(captured[0].request.toolFilter).toEqual({ allow: ['read'] })
  expect(warns[0]).toContain('run_code')
})

test('白名单求交后为空：抛错且不发起委派（防静默零工具子会话）', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured, fakePersona, {
    visibleSurface: () => ['write'],
  }))
  await expect(callTool(tool, { role: 'scout', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/求交后为空/)
  expect(captured).toHaveLength(0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/tool.test.ts`
Expected: 新增 3 个 FAIL（求交未实现，toolFilter 仍是原始白名单）；`pnpm --filter dsh-agent-toolkit typecheck` 报 `DelegateToolDeps` 缺字段。

- [ ] **Step 3: 实现求交 + 接线**

`packages/toolkit/src/delegate/tool.ts`：

- 第 5 行导入改为：`import { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'`
- `DelegateToolDeps`（第 11-24 行）在 `recordRoute` 后追加：

```ts
  /** 父会话真实可见工具面（生产走 scopeOf(agent.ctx) + scoped schemas；测试注入 fake）。 */
  readonly visibleSurface: (agent: Agent) => string[]
  /** 未知名 warn-drop 日志（生产 ctx.logger.warn）。 */
  readonly warn: (msg: string) => void
```

- execute 内 `const persona = deps.buildPersona(role)`（第 148 行）之后插入求交块，并把请求构造里的 tools spread（第 159-161 行）替换：

插入：

```ts
      // 白名单与父会话真实可见面求交（warn-drop 未知名）——宿主 child-agent 对 toolFilter
      // 直接 restrict，未知名响亮失败（spawn-in-process 测试 "an unknown toolFilter name
      // fails the spawn loudly" 佐证）；与 bot 会话路径（channels/agent-setup.ts）对称，
      // 消除两条路径的白名单有效性不对称。求交为空抛错防静默零工具子会话。
      let toolFilter: { allow: string[] } | undefined
      if (role.tools !== undefined) {
        const visible = new Set(deps.visibleSurface(parent).filter((n) => n !== RUN_CODE_NAME))
        const effective = role.tools.allow.filter((n) => visible.has(n))
        const dropped = role.tools.allow.filter((n) => !visible.has(n))
        if (dropped.length > 0) {
          deps.warn(`dsh-agent-toolkit: 角色 ${role.id} 白名单含本会话不可见工具，委派时忽略：${dropped.join(', ')}`)
        }
        if (effective.length === 0) {
          throw new Error(`dsh-agent-toolkit: 角色 ${role.id} 工具白名单求交后为空（原 ${role.tools.allow.length} 个均不可见）：${role.tools.allow.join(', ')}`)
        }
        toolFilter = { allow: effective }
      }
```

替换 spread 为：

```ts
        ...toolFilter !== undefined
          ? { toolFilter }
          : {},
```

`packages/toolkit/src/delegate/index.ts`：

- 顶部导入追加：`import { scopeOf } from '@deepseek-ai/dsh-scope'`
- `createDelegateTool` 的 deps 字面量（第 70-78 行）在 `recordRoute` 后追加：

```ts
        // 父会话真实可见面：scoped schemas = global + 祖先层，与 bot 路径同款手段
        // （scopeOf 对未 scoped ctx 返回 undefined，schemas 接受 undefined 为顶层视图——
        // channels/agent-setup.ts:41 先例）。
        visibleSurface: (agent) => agent.ctx.tools.schemas(scopeOf(agent.ctx)).map((s) => s.name),
        warn: (msg) => { ctx.logger.warn(msg) },
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/` → PASS
Run: `pnpm --filter dsh-agent-toolkit typecheck` → 通过

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/delegate/tool.ts packages/toolkit/src/delegate/tool.test.ts packages/toolkit/src/delegate/index.ts
git commit -m "fix(toolkit): 委派路径白名单与父会话可见面求交（warn-drop 未知名，与 bot 路径对称）"
```

---

### Task 4: 全量验证 + 文档收尾

**Files:**
- Modify: `docs/usage/agents.md`
- Modify: `AGENTS.md`
- 验证：`pnpm --filter dsh-agent-toolkit test` + `typecheck` + `bundle`

- [ ] **Step 1: docs/usage/agents.md 更新（3 处）**

- 「角色字段」节工具白名单表格行之后的求交说明句（现：「bot 会话加载角色白名单时与会话可见面求交，不可见名记 warn 忽略（不再抛错）。」）替换为：

```markdown
bot 会话与委派两条路径加载角色白名单时都会与会话真实可见面求交：不可见名记 warn 忽略（不再抛错），求交后为空则报错（防静默零工具会话）。
```

- 「内置角色」节第 34 行整段替换为：

```markdown
内置角色可编辑 persona/模型/工具，但 `builtin` 标记不可移除、角色不可删除。`explorer` 默认携带只读白名单 10 个（`pwsh`/`bash` + `read`/`read_image`/`glob`/`grep` + `web_search`/`todo_write`/`job_list`/`job_output`/`skill`），委派时硬约束只读；`general` 默认携带 agent-team preset 面全量 20 个工具的显式白名单（不含 `team_delegate`，禁二级委派）。两者均可在面板改选「不限制」或自行调整。
```

- 「存储与迁移」节列表末尾（`explorer_readonly_migrated` 行之后）追加：

```markdown
- 仍是旧默认名单的内置角色会一次性更新为重选后的新名单（`meta` 表 `builtin_tools_recatalog_migrated` 标记，幂等；在面板改过的记录视为自定义，跳过）。
```

- [ ] **Step 2: AGENTS.md 更新**

「dsh 插件开发要点」节 Agent 注册表段落中：

- 「内置 explorer 默认携带只读白名单（NATIVE_TOOL_NAMES 去 write/edit 派生，存量经 meta 标记 `explorer_readonly_migrated` 一次性补齐）」改为「内置 explorer 默认携带只读白名单 10 个（旧 5 个派生 + web_search/todo_write/job_list/job_output/skill），general 默认显式 preset 面 20 个（不含 team_delegate/run_code），存量仍是旧默认值的 builtin 记录经 meta 标记 `builtin_tools_recatalog_migrated` 一次性条件迁移（用户改过的跳过）」。
- 「bot 会话加载角色白名单时与会话可见面求交、未知名 warn-drop（`channels/agent-setup.ts`，不再抛 unknown global tools）」改为「bot 会话与委派两条路径加载角色白名单时均与会话可见面求交、未知名 warn-drop、空交集抛错（`channels/agent-setup.ts` / `delegate/tool.ts`，不再抛 unknown global tools）」。

- [ ] **Step 3: 全量三件套**

Run: `pnpm --filter dsh-agent-toolkit test` → 449+ 全过
Run: `pnpm --filter dsh-agent-toolkit typecheck` → 过
Run: `pnpm --filter dsh-agent-toolkit bundle` → 产出 lib/index.js + lib/client.js

- [ ] **Step 4: 真实环境手动验收（防 fake 掩盖宿主语义，2026-09-03 事故教训）**

```bash
cd deepseek-harness
pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml
```

验收清单：
1. 存量 profile（当前开发 profile 即存量）：Agents 面板 explorer 白名单从 5 → 10（多 `web_search`/`todo_write`/`job_list`/`job_output`/`skill`），general 出现显式 20 个白名单（无 `team_delegate`）；
2. 面板里把 explorer 白名单去掉一项保存 → 重启 → 改动保留（迁移不回收改）；
3. 主会话 `team_delegate` 委派 explorer / general 正常完成（可见面求交不破坏默认名单——默认名单全部在 agent-team 面内）；
4. （可选）换一个不含 `web_search` 的 preset 起会话委派 explorer → 不抛 unknown tools，正常跑完。

- [ ] **Step 5: Commit**

```bash
git add docs/usage/agents.md AGENTS.md
git commit -m "docs(toolkit): 内置名单重选与委派求交文档收尾"
```

---

## Self-Review 记录

- **Spec 覆盖**：名单重选（Task 1）/ 条件式迁移（Task 2）/ 委派求交（Task 3）/ 文档 + 验收（Task 4）；非目标无需任务。✅
- **顺序依赖**：Task 2 消费 Task 1 的三个常量，Task 3 独立（可并行但与 Task 1/2 同文件无交集），Task 4 收尾。✅
- **类型一致性**：`GENERAL_ALLOW`/`LEGACY_EXPLORER_ALLOW`/`BUILTIN_TOOLS_RECATALOG_MIGRATED_KEY`/`visibleSurface`/`warn` 跨任务一致；既有测试断言兼容已逐一核对（scout 透传测试靠 depsWith 默认可见面保持绿；line 72-78 非 builtin general 测试靠迁移的 builtin 守卫保持绿）。✅
- **迁移干扰已隔离**：原生并入迁移会先于本迁移给 LEGACY explorer 补 write/edit 破坏等值比对——测试显式预置 `TOOLS_NATIVE_MIGRATED_KEY`；真实存量环境该标记早已置位（0.2.x 时代即迁移过），无干扰。✅
- **占位符**：无 TBD；所有代码步含完整代码。✅
