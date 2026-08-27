# Agents 面板 / 侧边栏 / 机器人表单修正 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-08-27-agents-panel-fixes-design.md` 修复 Agents 面板（main 移除/原生工具白名单/单 persona/内部滚动）、侧边栏仅图标、机器人表单去提示词，并卸载第三方 dsh-agent-teams 插件。

**Architecture:** `packages/toolkit` 单插件：Node 半（src/agents、src/prompt、src/channels、src/delegate）+ 浏览器半（src/client）。AgentRecord 的 `promptLayers: LayerConfig[]` 收敛为 `persona?: string`，旧字段保留为 deprecated 仅作迁移输入；读取迁移在 `createRegistry` 单点实施（promptLayers→persona 幂等拼接 + tools.allow 一次性并入原生工具名，meta 表标记幂等）。

**Tech Stack:** TypeScript + vitest（Node 半有测试基建；浏览器半无组件测试，验证 = typecheck + bundle + 人工）。

## Global Constraints

- 所有命令在仓库根 `D:\work\github\dsh\dsh-agent-toolkit` 执行；单测 `pnpm --filter dsh-agent-toolkit test`，类型检查 `pnpm --filter dsh-agent-toolkit typecheck`，构建 `pnpm --filter dsh-agent-toolkit bundle`。
- 任何 src 改动后必须跑 test + typecheck；进入开发回路前必须跑 bundle。
- 测试 import 路径带 `.ts` 后缀（如 `import { x } from './store.ts'`），vitest。
- `AgentRecordSchema` 校验失败信息前缀 `dsh-agent-toolkit:`。
- commit message 沿用仓库风格：`refactor(toolkit): …` / `feat(toolkit): …`（中文摘要）。
- 不改动 `deepseek-harness/` 内任何文件。
- `AgentRecord` 的 `promptLayers` 字段保留在 interface 与 zod schema 中（标 @deprecated），仅作迁移输入；UI/REST/装配代码一律只产出/消费 `persona`。
- 原生工具名常量 `NATIVE_TOOL_NAMES` 平台互斥：win32 首项 `'pwsh'`，其余 `'bash'`；测试断言一律用 `...NATIVE_TOOL_NAMES` 展开，不写死平台名。

---

### Task 1: AgentRecord schema 收敛 persona + migrateAgentRecord + 内置角色改 persona

**Files:**
- Modify: `packages/toolkit/src/agents/store.ts`
- Modify: `packages/toolkit/src/agents/builtin.ts`
- Test: `packages/toolkit/src/agents/store.test.ts`

**Interfaces:**
- Produces: `migrateAgentRecord(record: AgentRecord): AgentRecord`（无需迁移返回原引用；有 `promptLayers` 时按 order 升序拼接 text（`\n\n`，忽略纯空白层）进 `persona`——已有 `persona` 则不覆盖——并剥离 `promptLayers`，返回新对象）。后续 Task 2 消费。
- Produces: `AgentRecord.persona?: string`；`promptLayers` 标 @deprecated 保留。Task 3/4/5/6 消费。

- [ ] **Step 1: 改写 store.test.ts（失败测试先行）**

把 `VALID` 中的 `promptLayers: [{ name: 'persona', order: 0, text: '你是探索员。' }]` 改为 `persona: '你是探索员。'`，并追加：

```ts
import { AgentRecordSchema, agentToolkitDomain, migrateAgentRecord } from './store.ts'

// describe('AgentRecordSchema') 内追加：
test('接受 persona 字段与遗留 promptLayers（迁移输入）', () => {
  expect(AgentRecordSchema.safeParse({ id: 'x', name: 'X', persona: 'P' }).success).toBe(true)
  expect(AgentRecordSchema.safeParse({ id: 'x', name: 'X', promptLayers: [{ name: 'persona', order: 0, text: 'P' }] }).success).toBe(true)
})

// 文件末尾追加：
describe('migrateAgentRecord', () => {
  test('promptLayers 按 order 拼接进 persona 并剥离', () => {
    const migrated = migrateAgentRecord({
      id: 'x', name: 'X',
      promptLayers: [
        { name: 'b', order: 10, text: 'B' },
        { name: 'a', order: 0, text: 'A' },
      ],
    })
    expect(migrated).toEqual({ id: 'x', name: 'X', persona: 'A\n\nB' })
  })

  test('无 promptLayers 返回原引用', () => {
    const record = { id: 'x', name: 'X', persona: 'P' }
    expect(migrateAgentRecord(record)).toBe(record)
  })

  test('已有 persona 时保留 persona、剥离 promptLayers', () => {
    const migrated = migrateAgentRecord({
      id: 'x', name: 'X', persona: 'P',
      promptLayers: [{ name: 'a', order: 0, text: 'A' }],
    })
    expect(migrated).toEqual({ id: 'x', name: 'X', persona: 'P' })
  })

  test('promptLayers 全为空白文本则不产生 persona', () => {
    const migrated = migrateAgentRecord({
      id: 'x', name: 'X',
      promptLayers: [{ name: 'a', order: 0, text: '  ' }],
    })
    expect(migrated).toEqual({ id: 'x', name: 'X' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: FAIL —— `migrateAgentRecord` 未导出（导入报错）。

- [ ] **Step 3: 实现 store.ts**

`AgentRecord` interface 中 `promptLayers?: LayerConfig[] // 引用 ../prompt/types.ts` 替换为：

```ts
  persona?: string // 角色唯一可自定义提示层（固定分层中的 persona 层文本）
  /** @deprecated 仅迁移输入：旧版多分层，createRegistry 读取时拼接进 persona 后剥离。 */
  promptLayers?: LayerConfig[]
```

`AgentRecordSchema` 的 `promptLayers: z.array(LayerConfigSchema).optional(),` 行前插入：

```ts
  persona: z.string().optional(),
```

文件末尾追加：

```ts
/**
 * 旧记录迁移：promptLayers 按 order 升序拼接进 persona（忽略纯空白层；persona 已存在不覆盖），
 * 剥离 promptLayers 返回新对象；无需迁移返回原引用（调用方按引用比较决定是否写回）。
 */
export function migrateAgentRecord(record: AgentRecord): AgentRecord {
  if (record.promptLayers === undefined) return record
  const { promptLayers, ...rest } = record
  const joined = [...promptLayers]
    .sort((a, b) => a.order - b.order)
    .map((layer) => layer.text)
    .filter((text) => text.trim().length > 0)
    .join('\n\n')
  const persona = rest.persona ?? joined
  return persona.length > 0 ? { ...rest, persona } : rest
}
```

- [ ] **Step 4: builtin.ts 改用 persona**

删除 `personaLayer` 辅助函数（`builtin.ts:4-6`）；explorer/general 的 `promptLayers: personaLayer(...)` 改为 `persona: \`...\``（模板字符串原文不变，仅换字段名）。main 记录不动。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: store.test.ts 全 PASS；其余文件可能因 promptLayers 引用报错——本任务只需 store.test.ts 通过，后续任务逐个修（可用 `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/store.test.ts` 精准跑）。

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/agents/store.ts packages/toolkit/src/agents/store.test.ts packages/toolkit/src/agents/builtin.ts
git commit -m "refactor(toolkit): AgentRecord 提示分层收敛为单一 persona 字段 + 迁移函数"
```

---

### Task 2: createRegistry 读取迁移 + tools.allow 一次性并入原生工具名

**Files:**
- Modify: `packages/toolkit/src/channels/basic-tools.ts`（新增 NATIVE_TOOL_NAMES）
- Modify: `packages/toolkit/src/agents/registry.ts`
- Test: `packages/toolkit/src/agents/registry.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `migrateAgentRecord`。
- Produces: `NATIVE_TOOL_NAMES: readonly string[]`（`src/channels/basic-tools.ts` 导出）——Task 3 的 /api/tools 与 registry 迁移都用。
- Produces: `TOOLS_NATIVE_MIGRATED_KEY = 'tools_native_migrated'`（registry.ts 导出，meta 表键）。

- [ ] **Step 1: 追加失败测试（registry.test.ts 文件末尾）**

```ts
// 文件头部 import 追加：import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'

test('createRegistry：旧记录 promptLayers 迁移为 persona 并写回持久层', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('legacy', {
    id: 'legacy', name: 'Legacy',
    promptLayers: [
      { name: 'b', order: 10, text: 'B' },
      { name: 'a', order: 0, text: 'A' },
    ],
  })
  const { ctx } = makeCtx(domain)
  const registry = await createRegistry(ctx, vi.fn())
  expect(registry.get('legacy')).toEqual({ id: 'legacy', name: 'Legacy', persona: 'A\n\nB' })
  expect(agentsOf(domain).get('legacy')).toEqual({ id: 'legacy', name: 'Legacy', persona: 'A\n\nB' })
})

test('createRegistry：存量 tools.allow 一次性并入原生工具名，meta 标记后不再改动', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('dev', { id: 'dev', name: 'Dev', tools: { allow: ['team_delegate'] } })
  const { ctx } = makeCtx(domain)
  const registry = await createRegistry(ctx, vi.fn())
  expect(registry.get('dev')?.tools?.allow).toEqual(['team_delegate', ...NATIVE_TOOL_NAMES])
  // 标记已置：用户后续编辑（如去掉部分原生工具）不会被再次并入
  await registry.upsert({ id: 'dev', name: 'Dev', tools: { allow: ['read'] } })
  const registry2 = await createRegistry(ctx, vi.fn())
  expect(registry2.get('dev')?.tools?.allow).toEqual(['read'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/registry.test.ts`
Expected: FAIL —— 迁移未实现（persona/原生工具名断言不符；NATIVE_TOOL_NAMES 未导出）。

- [ ] **Step 3: basic-tools.ts 新增常量**

文件末尾追加：

```ts
/** 原生工具名（白名单 UI 与存量迁移用）：与 BASIC_TOOLS 挂载插件注册的工具名一一对应。
 *  名字来源（宿主 deepseek-harness 源码）：dsh-tool-pwsh/dsh-tool-bash → 'pwsh'/'bash'（平台互斥）；
 *  dsh-tool-fs → 'read'/'write'/'edit'/'read_image'；dsh-tool-fs-search → 'glob'/'grep'。
 *  这些工具 scoped 挂载在 agentCtx，不出现在顶层 ctx.tools.schemas()，故需显式常量。 */
export const NATIVE_TOOL_NAMES: readonly string[] = [
  process.platform === 'win32' ? 'pwsh' : 'bash',
  'read',
  'write',
  'edit',
  'read_image',
  'glob',
  'grep',
]
```

- [ ] **Step 4: registry.ts 接入迁移**

顶部 import 追加：

```ts
import { migrateAgentRecord } from './store.ts'
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'
```

`createRegistry` 中 `await importRolesYaml(...)` 之后、构建 `cache` 之前插入：

```ts
  // 旧记录迁移：promptLayers → persona（逐条幂等）；tools.allow 一次性并入原生工具名
  // （meta 标记幂等——UI 从未提供原生工具勾选项，存量白名单缺失原生名非用户本意；
  // 标记置位后用户再编辑 allow 不会被回改）。
  const nativeMigrated = meta.get(TOOLS_NATIVE_MIGRATED_KEY) !== undefined
  for (const [id, record] of agents.entries()) {
    let next = migrateAgentRecord(record)
    if (!nativeMigrated && next.tools !== undefined) {
      const allow = next.tools.allow
      const missing = NATIVE_TOOL_NAMES.filter((name) => !allow.includes(name))
      if (missing.length > 0) next = { ...next, tools: { allow: [...allow, ...missing] } }
    }
    if (next !== record) await agents.put(id, next)
  }
  if (!nativeMigrated) await meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' })
```

文件顶部（interface 之后）追加导出：

```ts
/** tools.allow 一次性并入原生工具名的 meta 表标记键。 */
export const TOOLS_NATIVE_MIGRATED_KEY = 'tools_native_migrated'
```

`upsert` 中 `const parsed = ...` 校验通过后、守卫与 `agents.put` 之前，把记录过一遍迁移（防旧客户端重新写入 promptLayers）：

```ts
      const normalized = migrateAgentRecord(parsed.data)
```
后续守卫里的 `record` 引用与 `agents.put(record.id, record)` / `cache.set(record.id, record)` 改用 `normalized`（守卫读取的 `existing.name`/`builtin` 比较对象不变，put/cache 写 `normalized`）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/registry.test.ts src/agents/store.test.ts`
Expected: PASS（全部）。

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/channels/basic-tools.ts packages/toolkit/src/agents/registry.ts packages/toolkit/src/agents/registry.test.ts
git commit -m "feat(toolkit): createRegistry 读取迁移（persona 拼接 + 原生工具名一次性并入）"
```

---

### Task 3: /api/tools 分组响应（原生/扩展）

**Files:**
- Modify: `packages/toolkit/src/agents/api.ts:60-63`
- Modify: `packages/toolkit/src/client/agents/api.ts:29`
- Test: `packages/toolkit/src/agents/api.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `NATIVE_TOOL_NAMES`。
- Produces: 浏览器半 `ToolsCatalog = { native: string[]; global: string[] }` 与 `fetchTools(): Promise<ToolsCatalog>`——Task 6 消费。
- `AgentsApiDeps.listTools(): string[]` 签名不变（仍只列全局工具）；分组在 handler 内完成。

- [ ] **Step 1: 改写 api.test.ts 的 /tools 测试（失败先行）**

`api.test.ts:236` 附近的 `GET /tools` 测试改为：

```ts
test('GET /tools 返回分组工具名册（native 常量 + global 全局注册）', async () => {
  const { handler } = harness()
  const res = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/tools'), res)
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({
    native: [...NATIVE_TOOL_NAMES],
    global: ['bash', 'read', 'write'],
  })
})
```

文件头部 import 追加 `import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'`。

同时把 `api.test.ts:101` PUT 测试 body 里的 `promptLayers: [{ name: 'persona', order: 0, text: '只读观察' }],` 改为 `persona: '只读观察',`（schema 已换，测试跟着新契约走）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/api.test.ts`
Expected: FAIL —— /tools 仍返回裸数组。

- [ ] **Step 3: api.ts handler 分组**

`api.ts:60-63` 改为：

```ts
    if (sub === '/tools' && method === 'GET') {
      // 分组名册：native = BASIC_TOOLS scoped 挂载的原生工具名（常量），global = 顶层注册表全局工具。
      json(res, 200, { native: [...NATIVE_TOOL_NAMES], global: deps.listTools() })
      return
    }
```

顶部 import 追加 `import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'`。

- [ ] **Step 4: 浏览器半 api.ts 改型**

`src/client/agents/api.ts:29` 改为：

```ts
export interface ToolsCatalog { native: string[]; global: string[] }

export const fetchTools = () => request<ToolsCatalog>('/dsh-agent-toolkit/api/tools')
```

- [ ] **Step 5: 跑测试 + typecheck**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/api.test.ts`; 然后 `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 测试 PASS；typecheck 报 `AgentEditor.tsx` 的 fetchTools 旧用法——属预期，Task 6 修（本步只确认报错清单不含 api.ts 自身）。

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/agents/api.ts packages/toolkit/src/agents/api.test.ts packages/toolkit/src/client/agents/api.ts
git commit -m "feat(toolkit): /api/tools 改为原生/扩展分组名册"
```

---

### Task 4: import-yaml persona 直写

**Files:**
- Modify: `packages/toolkit/src/agents/import-yaml.ts:82`
- Test: `packages/toolkit/src/agents/import-yaml.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AgentRecord.persona`。

- [ ] **Step 1: 改测试（失败先行）**

`import-yaml.test.ts:47` 的期望 `promptLayers: [{ name: 'persona', order: 0, text: '你是探索员。' }],` 改为 `persona: '你是探索员。',`；`:107` 的 `expect(agents.get('explorer')?.promptLayers).toEqual([{ name: 'persona', order: 0, text: '新文本。' }])` 改为 `expect(agents.get('explorer')?.persona).toBe('新文本。')`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/import-yaml.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

`import-yaml.ts:82` 的 `promptLayers: [{ name: 'persona', order: 0, text: raw.persona }],` 改为 `persona: raw.persona,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/import-yaml.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/agents/import-yaml.ts packages/toolkit/src/agents/import-yaml.test.ts
git commit -m "refactor(toolkit): 角色 YAML 导入直写 persona 字段"
```

---

### Task 5: buildAgentPersona 与 router 单 persona section

**Files:**
- Modify: `packages/toolkit/src/prompt/persona.ts:15-24`
- Modify: `packages/toolkit/src/channels/router.ts:60-82`
- Test: `packages/toolkit/src/prompt/persona.test.ts`
- Test: `packages/toolkit/src/channels/router.test.ts`

**Interfaces:**
- Produces: `buildAgentPersona(config, role: { name: string; persona?: string }, model?)`——`delegate/index.ts:50-51` 传入 `AgentRecord`（结构兼容，无需改 delegate）。
- router 角色形态 hooks：`sections: [{ name: 'dsh-agent-toolkit:agent:persona', order: 0, text }]`.

- [ ] **Step 1: 改 persona.test.ts（失败先行）**

第二个测试「role.promptLayers 与全局层按 order 交错合并」整体替换为：

```ts
  test('role.persona 作为 order 0 层排进全局层序列（稳定排序，同 order 全局层在前）', () => {
    const config = configOf(
      [
        { name: 'base', order: 0, text: 'B' },
        { name: 'task', order: 50, text: 'T' },
      ],
      [],
    )
    const persona = buildAgentPersona(config, { name: 'general', persona: 'R' })
    expect(persona).toBe(`${SECTION_A('general')}\n\n${SECTION_B}\n\nB\n\nR\n\nT`)
  })
```

第一个测试标题中「无 role.promptLayers」改为「无 role.persona」（断言不变）。

- [ ] **Step 2: 改 router.test.ts（失败先行）**

`REVIEWER_ROLE`（`:24-32`）的 `promptLayers: [...]` 改为：

```ts
  persona: '你是团队的评审成员。\n只审查 diff，不修改代码。',
```

`:195` 与 `:209` 两个测试的 `sections` 期望都改为：

```ts
      sections: [
        { name: 'dsh-agent-toolkit:agent:persona', order: 0, text: '你是团队的评审成员。\n只审查 diff，不修改代码。' },
      ],
```

`:195` 测试标题改为「agentRef 指向角色：注册单 persona section + tools.restrict({ allow }) + agentOptions=role.model」。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/prompt/persona.test.ts src/channels/router.test.ts`
Expected: FAIL。

- [ ] **Step 4: persona.ts 实现**

`buildAgentPersona` 签名与合并段改为：

```ts
export function buildAgentPersona(
  config: { layers: LayerConfig[]; rules: Rule[] },
  role: { name: string; persona?: string },
  model?: { provider?: string; model?: string },
): string {
  const rule = selectRule(config.rules, model?.provider, model?.model)
  // 角色 persona 固定为 order 0 层；数组稳定排序保证同 order 的全局层（如 base）排在 persona 之前。
  const roleLayers: LayerConfig[] = role.persona === undefined ? [] : [{ name: 'persona', order: 0, text: role.persona }]
  const merged = [...config.layers, ...roleLayers].sort((a, b) => a.order - b.order)
  const texts = merged.map(layer => rule?.overrides?.[layer.name] ?? layer.text)
  if (rule?.append !== undefined) texts.push(rule.append)
  return [SECTION_A(role.name), SECTION_B, ...texts].join('\n\n')
}
```

文件头注释里「全局层 + 角色层」措辞不变（语义仍成立）。

- [ ] **Step 5: router.ts 实现**

`resolveSession` 的角色分支（`:72-82`）改为：

```ts
    const sections = role.persona === undefined || role.persona.trim().length === 0
      ? []
      : [{ name: 'dsh-agent-toolkit:agent:persona', order: 0, text: role.persona }]
    return {
      agentOptions: role.model ?? this.resolveOptions(bot),
      hooks: {
        ...(sections.length > 0 ? { sections } : {}),
        ...(role.tools !== undefined ? { tools: role.tools.allow } : {}),
      },
    }
```

上方 doc 注释（`:60`）「promptLayers 逐层 section（按 layer.order）」改为「persona 单 section」。

- [ ] **Step 6: 跑测试确认通过 + 全量 test**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/prompt/persona.test.ts src/channels/router.test.ts`; 然后 `pnpm --filter dsh-agent-toolkit test`
Expected: 目标文件 PASS；全量中若 `delegate/tool.test.ts` 等仍有用 promptLayers 的夹具导致失败，按新 schema 把夹具的 `promptLayers: [{ name: 'persona', order: 0, text: X }]` 改为 `persona: X`（仅夹具改字段，断言逻辑不动）。

- [ ] **Step 7: Commit**

```bash
git add packages/toolkit/src/prompt/persona.ts packages/toolkit/src/prompt/persona.test.ts packages/toolkit/src/channels/router.ts packages/toolkit/src/channels/router.test.ts
# 若 Step 6 改了 delegate 夹具：git add packages/toolkit/src/delegate/tool.test.ts
git commit -m "refactor(toolkit): 委派 persona 装配与 bot 角色绑定收敛为单 persona"
```

---

### Task 6: Agents 面板 UI（main 移除 + persona textarea + 分组白名单 + 内部滚动）

**Files:**
- Modify: `packages/toolkit/src/client/agents/AgentsModal.tsx`
- Modify: `packages/toolkit/src/client/agents/AgentEditor.tsx`
- Modify: `packages/toolkit/src/client/agents/agents.module.css`

**Interfaces:**
- Consumes: Task 3 的 `fetchTools(): Promise<ToolsCatalog>`；Task 1 的 `AgentRecord.persona`。
- 浏览器半无组件测试基建：本任务验证 = typecheck + bundle，人工验证在 Task 9。

- [ ] **Step 1: AgentsModal.tsx 过滤 main**

- `useState('main')` 改为 `useState('')`（selectedId 初值空，靠回退取第一个）。
- `const agents = state.kind === 'ok' ? state.data : []` 之后插入/改写：

```tsx
  // main 不进管理列表（仍作运行时默认 Agent 存在；机器人绑定下拉不受影响——它不经本组件过滤）
  const visible = agents.filter((a) => a.id !== 'main')
  const selected = creating ? undefined : (visible.find((a) => a.id === selectedId) ?? visible[0])
```

（删掉原 `const selected = creating ? undefined : agents.find(...)` 行。）
- 列表渲染 `agents.map` 改为 `visible.map`；删除 main 的「锁定」徽标 JSX（`{agent.id === 'main' && <span className={css.lock} …>锁定</span>}`）。
- `handleDeleted` 里 `setSelectedId('main')` 改为 `setSelectedId('')`（回退自动取第一个）。

- [ ] **Step 2: AgentEditor.tsx persona + 分组白名单**

- 删除 `import type { LayerConfig }` 与 `newLayer`/`addLayer`/`updateLayer`/`removeLayer`/`moveLayer` 五个函数。
- `const [layers, setLayers] = useState<LayerConfig[]>(agent?.promptLayers ?? [])` 改为 `const [persona, setPersona] = useState(agent?.persona ?? '')`。
- `const [availableTools, setAvailableTools] = useState<string[]>([])` 改为 `const [catalog, setCatalog] = useState<ToolsCatalog>({ native: [], global: [] })`；import 处 `fetchTools` 同 import 语句追加 `type ToolsCatalog`。
- 首个 useEffect 中 `fetchTools().then((ts) => { if (!stale) setAvailableTools(ts) })` 改为：

```ts
    fetchTools().then((c) => {
      if (stale) return
      setCatalog(c)
      // 新建模式默认全勾（原生 + 扩展）；编辑模式以记录 allow 为准
      if (creating) setTools([...c.native, ...c.global])
    }).catch(() => undefined)
```

- 「提示词分层」整个 section（`:153-176`）替换为：

```tsx
      <section className={css.block}>
        <h3 className={css.blockTitle}>Persona</h3>
        <textarea
          className={css.textarea} value={persona} aria-label="Persona" rows={6}
          placeholder="角色人设与职责（固定分层中唯一可自定义的 persona 层）"
          onChange={(e) => { setPersona(e.target.value) }}
        />
      </section>
```

- 「工具白名单」section（`:198-213`）替换为：

```tsx
      <section className={css.block}>
        <h3 className={css.blockTitle}>工具白名单</h3>
        {catalog.native.length === 0 && catalog.global.length === 0 ? (
          <p className={css.hint}>暂无可用工具</p>
        ) : (
          <>
            <p className={css.toolGroupTitle}>原生工具</p>
            <div className={css.toolGrid}>
              {catalog.native.map((t) => (
                <label key={t} className={css.toolCheck}>
                  <input type="checkbox" checked={tools.includes(t)} aria-label={`工具 ${t}`}
                    onChange={(e) => { toggleTool(t, e.target.checked) }} />
                  {t}
                </label>
              ))}
            </div>
            {catalog.global.length > 0 && (
              <>
                <p className={css.toolGroupTitle}>扩展工具</p>
                <div className={css.toolGrid}>
                  {catalog.global.map((t) => (
                    <label key={t} className={css.toolCheck}>
                      <input type="checkbox" checked={tools.includes(t)} aria-label={`工具 ${t}`}
                        onChange={(e) => { toggleTool(t, e.target.checked) }} />
                      {t}
                    </label>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </section>
```

- `save()` 载荷中 `...(layers.length > 0 ? { promptLayers: layers } : {}),` 改为 `...(persona.trim() ? { persona: persona.trim() } : {}),`。

- [ ] **Step 3: agents.module.css 内部滚动 + 新类**

- `.editorPane` 改为：

```css
.editorPane {
  flex: 1;
  min-width: 0;
  max-height: 70vh;
  overflow-y: auto;
}
```

- `.actions` 改为（sticky 钉底，背景防透出）：

```css
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
  position: sticky;
  bottom: 0;
  padding: 8px 0;
  background: var(--dsw-alias-bg-layer-1);
}
```

- 追加 `.toolGroupTitle`：

```css
.toolGroupTitle {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
```

- 删除不再使用的类：`.layer`、`.layerRow`、`.layerName`、`.iconButton`（含 hover/disabled 两条）、`.lock`。

- [ ] **Step 4: typecheck + bundle**

Run: `pnpm --filter dsh-agent-toolkit typecheck`; 然后 `pnpm --filter dsh-agent-toolkit bundle`
Expected: 均通过（bundle 需等到 Task 7/8 完成后仍会再跑一次，本步验证可编译）。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/client/agents/AgentsModal.tsx packages/toolkit/src/client/agents/AgentEditor.tsx packages/toolkit/src/client/agents/agents.module.css
git commit -m "feat(toolkit): Agents 面板移除 main、persona 单文本、分组白名单与内部滚动"
```

---

### Task 7: 侧边栏入口恒为仅图标 + Tooltip

**Files:**
- Modify: `packages/toolkit/src/client/shared/entry.tsx`
- Modify: `packages/toolkit/src/client/shared/entry.module.css`
- Modify: `packages/toolkit/src/client/agents/agents.module.css:1-31`（残留清理）

**Interfaces:**
- 无新接口；三个入口组件（agents/usage/bots entry.tsx）注册方式不变。

- [ ] **Step 1: entry.tsx 仅图标**

文件头注释改为「侧边栏底栏入口工厂：宽栏窄栏统一仅图标 + Tooltip，点击经 renderModal 打开模态框。」
`:29-40` 的 Tooltip/button 块改为：

```tsx
        <Tooltip label={title} delayMs={500}>
          <button
            type="button"
            className={clsx(css.trigger, !wide && css.rail)}
            aria-label={title}
            onClick={() => { setOpen(true) }}
          >
            {icon}
          </button>
        </Tooltip>
```

（删除 `disabled={wide}` 与 `{wide && <span className={css.triggerLabel}>{title}</span>}`。）

- [ ] **Step 2: entry.module.css 清理**

删除 `.triggerLabel` 规则（`:35-38`）。`.trigger` 的 `padding: 0 10px 0 8px` 改为 `padding: 0 8px`（无文字后左右对称）。

- [ ] **Step 3: agents.module.css 删除残留**

删除 `:1-31` 的 `.trigger`/`.trigger:hover`/`.trigger.rail`/`.triggerLabel` 四条规则（与 shared/entry.module.css 重复的残留；入口实际走 shared）。

- [ ] **Step 4: typecheck + bundle**

Run: `pnpm --filter dsh-agent-toolkit typecheck`; `pnpm --filter dsh-agent-toolkit bundle`
Expected: 通过。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/client/shared/entry.tsx packages/toolkit/src/client/shared/entry.module.css packages/toolkit/src/client/agents/agents.module.css
git commit -m "feat(toolkit): 侧边栏入口统一仅图标 + Tooltip，清理残留样式"
```

---

### Task 8: BotForm 删除提示词字段

**Files:**
- Modify: `packages/toolkit/src/client/bots/BotForm.tsx`

**Interfaces:**
- 无接口变更：`BotRecord.persona`（`src/bots/store.ts:26`）与服务端 API 保留，存量 bot 已配 persona 继续生效。

- [ ] **Step 1: 定位 persona 全部引用**

Run: `pnpm --filter dsh-agent-toolkit exec rg -n persona src/client/bots/BotForm.tsx`
Expected: 列出 state 声明（`useState(bot?.persona ?? '')` 形态）、payload 的 `...(persona.trim() ? { persona } : {})`（约 :184）、第一步的「提示词」textarea（约 :228-231）。

- [ ] **Step 2: 删除三处**

- 删除 `persona`/`setPersona` 的 useState 声明行；
- 删除 payload 中的 `...(persona.trim() ? { persona } : {}),` 行；
- 删除第一步的「提示词」`<label className={css.field}>…textarea…</label>` 整块（:228-231）。

- [ ] **Step 3: typecheck + bundle**

Run: `pnpm --filter dsh-agent-toolkit typecheck`; `pnpm --filter dsh-agent-toolkit bundle`
Expected: 通过（无 persona 残留引用）。

- [ ] **Step 4: Commit**

```bash
git add packages/toolkit/src/client/bots/BotForm.tsx
git commit -m "feat(toolkit): 机器人表单删除提示词字段（后端 persona 保留兼容存量）"
```

---

### Task 9: 环境清理 + 全量门禁 + 人工验证

**Files:**
- 无代码变更。

- [ ] **Step 1: 全量门禁**

Run: `pnpm --filter dsh-agent-toolkit test`; `pnpm --filter dsh-agent-toolkit typecheck`; `pnpm --filter dsh-agent-toolkit bundle`
Expected: 305 测试全绿（数量随本计划新增用例增加）、typecheck 通过、双半 bundle 成功。

- [ ] **Step 2: 卸载第三方插件**

先停掉运行中的 dsh web（若在跑），再执行：

```powershell
pnpm dsh plugin --profile web remove @nanmicoder/dsh-agent-teams
```

（工作目录 `D:\work\github\dsh\dsh-agent-toolkit\deepseek-harness`）
Expected: profile 依赖列表只剩 `dsh-agent-toolkit` 与 `dsh-better-sidebar`（可用 `pnpm dsh plugin --profile web list` 核对）。

- [ ] **Step 3: 重启 dsh web**

```powershell
$log = "C:\Users\Eson\AppData\Local\Temp\opencode\dsh-web.log"
if (Test-Path $log) { Remove-Item $log }
$args = '/c pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml > "' + $log + '" 2>&1'
Start-Process -FilePath "cmd.exe" -ArgumentList $args -WorkingDirectory "D:\work\github\dsh\dsh-agent-toolkit\deepseek-harness" -WindowStyle Hidden
```

约 25 秒后查日志应出现 `dsh web: http://127.0.0.1:3080` 且无插件报错。

- [ ] **Step 4: 人工验证清单（交用户确认）**

浏览器打开 http://127.0.0.1:3080 ：
1. 侧边栏底栏三个入口仅图标、悬停出 Tooltip，不再遮挡后续图标。
2. Agent 管理：列表无「主 Agent」；编辑表单为 基本信息 / Persona（单文本框）/ 模型 / 工具白名单（原生工具组含 pwsh、read、write、edit、read_image、glob、grep；扩展工具组无 agent_teams_*）；长表单内部滚动且保存按钮恒可见。
3. 消息机器人设置第一步只有 名称/绑定项目/绑定 Agent/Provider/模型 五项。
4. 存量带白名单的角色已自动并入原生工具名（打开任一旧角色确认勾选状态）。
5. 委派功能正常（主 Agent 会话中 team_delegate 可用，委派卡渲染正常）。
