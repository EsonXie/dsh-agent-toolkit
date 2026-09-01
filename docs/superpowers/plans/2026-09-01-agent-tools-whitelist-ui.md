# Agent 工具白名单 UI 显式化 + deny 彻底清理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents 面板工具区块改为「不限制 / 自定义白名单」radio 二选一，内置 explorer 恢复只读硬约束（派生白名单 + 存量一次性迁移），并彻底删除 import-yaml 的 deny 兼容残留。

**Architecture:** 数据模型 `AgentRecord.tools?: { allow: string[] }` 不变（`undefined` = 不限制）；UI 仅从 records 派生 radio 初值并在保存时映射回省略/携带 tools。explorer 默认白名单从 `NATIVE_TOOL_NAMES` 派生（去 write/edit），存量迁移走 meta 表一次性标记（与 `tools_native_migrated` 同款模式）。

**Tech Stack:** TypeScript / React（浏览器半）/ zod / vitest（jsdom）/ pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-09-01-agent-tools-whitelist-ui-design.md`（已获用户批准）

## Global Constraints

- 仅改动 `packages/toolkit` 与 `docs/usage/agents.md`、`AGENTS.md`；不动 `deepseek-harness/`（只读宿主源码）、`archive/`、`docs/refer/`。
- 工具名不可写死平台名：shell 工具 win32=pwsh、其余=bash 互斥注册，宿主 `tools.restrict` 对未知名响亮失败——一律从 `NATIVE_TOOL_NAMES` 派生。
- 代码注释/文案用中文，风格照现有文件；工具 `execute`/API 行为不变，无 schema 结构变更。
- 每个 Task 完成后跑 `pnpm --filter dsh-agent-toolkit test`；全部完成后跑 typecheck + bundle。
- git commit 步骤需用户确认后执行（仓库规则）。

---

### Task 1: explorer 默认只读白名单 + 存量一次性迁移

**Files:**
- Modify: `packages/toolkit/src/agents/builtin.ts`
- Modify: `packages/toolkit/src/agents/registry.ts`
- Test: `packages/toolkit/src/agents/registry.test.ts`

**Interfaces:**
- Produces: `EXPLORER_READONLY_ALLOW: readonly string[]`（builtin.ts 导出，= `NATIVE_TOOL_NAMES` 去掉 `'write'`/`'edit'`）；`EXPLORER_READONLY_MIGRATED_KEY = 'explorer_readonly_migrated'`（registry.ts 导出）。
- Consumes: 现有 `NATIVE_TOOL_NAMES`（`../channels/basic-tools.ts`，平台条件数组）；`TOOLS_NATIVE_MIGRATED_KEY`（registry.ts 现有导出）。

- [ ] **Step 1: 写失败测试**

在 `registry.test.ts` 顶部 import 行补充：

```ts
import { createRegistry, EXPLORER_READONLY_MIGRATED_KEY, TOOLS_NATIVE_MIGRATED_KEY, type AgentRegistry } from './registry.ts'
import { EXPLORER_READONLY_ALLOW } from './builtin.ts'
```

（原 import 为 `import { createRegistry, type AgentRegistry } from './registry.ts'`，替换之；`EXPLORER_READONLY_ALLOW` 为新行。）

文件末尾追加三个测试：

```ts
test('createRegistry：内置 explorer 默认携带只读白名单（不含 write/edit）；general 不限制', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry.get('explorer')?.tools?.allow).toEqual(EXPLORER_READONLY_ALLOW)
  expect(registry.get('explorer')?.tools?.allow).not.toContain('write')
  expect(registry.get('explorer')?.tools?.allow).not.toContain('edit')
  expect(registry.get('general')?.tools).toBeUndefined()
})

test('createRegistry：存量无 tools 的 explorer 一次性补默认白名单；改回不限制后不再补', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  await agentsOf(domain).put('explorer', { id: 'explorer', name: 'Explorer', builtin: true })
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry.get('explorer')?.tools?.allow).toEqual(EXPLORER_READONLY_ALLOW)
  expect(tablesOf(domain).meta.get(EXPLORER_READONLY_MIGRATED_KEY)).toEqual({ value: '1' })
  // 用户经 UI 显式改回不限制（省略 tools）后，迁移不再回补
  await registry.upsert({ id: 'explorer', name: 'Explorer', builtin: true })
  const registry2 = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry2.get('explorer')?.tools).toBeUndefined()
})

test('createRegistry：已配 tools 的存量 explorer 不被只读迁移改动', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const tables = tablesOf(domain)
  await tables.meta.put(TOOLS_NATIVE_MIGRATED_KEY, { value: '1' }) // 隔离原生并入的干扰
  await tables.agents.put('explorer', { id: 'explorer', name: 'Explorer', builtin: true, tools: { allow: ['read'] } })
  const registry = await createRegistry(vi.fn(), tables)
  expect(registry.get('explorer')?.tools?.allow).toEqual(['read'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: FAIL（`EXPLORER_READONLY_ALLOW` / `EXPLORER_READONLY_MIGRATED_KEY` 未导出）

- [ ] **Step 3: 实现 builtin.ts**

`packages/toolkit/src/agents/builtin.ts` 全文改为：

```ts
/** 内置保底 Agent 记录：main + explorer（只读白名单）/ general（不限制）。 */
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'
import type { AgentRecord } from './store.ts'

/** explorer 默认白名单：原生工具去掉写类（write/edit）。shell 名平台互斥（win32=pwsh、其余=bash），
 *  必须从 NATIVE_TOOL_NAMES 派生不可写死——宿主 tools.restrict 对未知名响亮失败。 */
export const EXPLORER_READONLY_ALLOW: readonly string[] = NATIVE_TOOL_NAMES.filter((n) => n !== 'write' && n !== 'edit')

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
  },
]
```

（persona/description 文本与原文件逐字一致，仅 explorer 增加 `tools` 行、头部增加 import 与 `EXPLORER_READONLY_ALLOW`。）

- [ ] **Step 4: 实现 registry.ts 迁移（含种入顺序调整）**

`registry.ts` 第 4 行 import 改为：

```ts
import { BUILTIN_AGENTS, EXPLORER_READONLY_ALLOW } from './builtin.ts'
```

在 `TOOLS_NATIVE_MIGRATED_KEY` 导出后追加：

```ts
/** explorer 只读白名单一次性并入的 meta 表标记键。 */
export const EXPLORER_READONLY_MIGRATED_KEY = 'explorer_readonly_migrated'
```

`createRegistry` 的启动序列重排——**把 `await seedBuiltins(agents)` 从 importRolesYaml 之前移到所有迁移之后**（关键：新种入的 explorer 自带只读白名单，若先种入，原生并入循环会把 write/edit 合并回去，只读约束在新装环境即失效）。`createRegistry` 的 docstring 首行同步改为「打开 dsh_agent_toolkit 域 → 首启 YAML 导入 → 旧记录迁移（promptLayers/原生并入/explorer 只读）→ 缺 main/explorer/general 时种入内置 → 构建内存缓存」。

重排后的函数开头至 cache 构建前的完整形态：

```ts
  const { agents, meta } = tables

  await importRolesYaml({ agents, meta, warn })

  // 旧记录迁移：promptLayers → persona（逐条幂等）；tools.allow 一次性并入原生工具名
  // （meta 标记幂等——UI 从未提供原生工具勾选项，存量白名单缺原生名非用户本意；
  //  标记置位后用户再编辑 allow 不会被回收改）。
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

  // explorer 只读白名单一次性迁移：deny 语义取消后 explorer 失去硬约束，此处补派生白名单恢复。
  // 先于 seedBuiltins 执行：新装环境的 explorer 由种入直接携带白名单，不经过本迁移与原生并入。
  const explorerMigrated = meta.get(EXPLORER_READONLY_MIGRATED_KEY) !== undefined
  if (!explorerMigrated) {
    const explorer = agents.get('explorer')
    if (explorer !== undefined && explorer.tools === undefined) {
      await agents.put('explorer', { ...explorer, tools: { allow: [...EXPLORER_READONLY_ALLOW] } })
    }
    await meta.put(EXPLORER_READONLY_MIGRATED_KEY, { value: '1' })
  }

  await seedBuiltins(agents)
```

（原生并入循环与原代码逐字一致，仅位置仍在 importRolesYaml 之后；`seedBuiltins` 函数本体不变，仅调用点下移。）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（含三个新测试；旧测试不受影响）

- [ ] **Step 6: Commit（需用户确认）**

```bash
git add packages/toolkit/src/agents/builtin.ts packages/toolkit/src/agents/registry.ts packages/toolkit/src/agents/registry.test.ts
git commit -m "feat(toolkit): explorer 内置默认只读白名单 + 存量一次性迁移"
```

---

### Task 2: import-yaml 的 deny 兼容残留彻底清理

**Files:**
- Modify: `packages/toolkit/src/agents/import-yaml.ts`
- Modify: `packages/toolkit/src/agents/store.ts:9`
- Modify: `docs/usage/agents.md:59`
- Test: `packages/toolkit/src/agents/import-yaml.test.ts`

**Interfaces:**
- Consumes: 无（Task 1 与本任务互不依赖）。
- Produces: `parseRoleYaml(text, source, fileName)`——**删除第 4 个 `warn` 参数**；deny-only 的 YAML 现在因 tools 为空抛错（deny 键被 zod 静默剥离后 allow 缺失），由 `importRolesYaml` 逐文件容错 warn 跳过。

- [ ] **Step 1: 改失败测试**

`import-yaml.test.ts` 中替换第 60-67 行的 deny 测试为：

```ts
test('parseRoleYaml：deny 作未知键剥离；deny-only → tools 空抛错', () => {
  const withAllow = parseRoleYaml(VALID + 'tools:\n  allow: [read]\n  deny: [write]\n', 's.yml', 's')
  expect(withAllow.tools).toEqual({ allow: ['read'] })
  expect(() => parseRoleYaml(VALID + 'tools:\n  deny: [write, edit]\n', 's.yml', 's')).toThrowError(/tools 为空/)
})
```

（其余测试不变——`tools: {}` 抛错断言仍匹配 `/tools/`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: FAIL（deny-only 当前不抛错，而是丢弃并 warn）

- [ ] **Step 3: 实现 import-yaml.ts 清理**

四处修改：

① schema（33-36 行）删 deny 字段：

```ts
  tools: z.object({
    allow: z.array(z.string()).optional(),
  }).optional(),
```

② `parseRoleYaml` 签名与 docstring：删第 4 参数 `warn?: (msg: string) => void`，docstring 的 `@param warn` 行删除。

③ 空 tools 校验（68-73 行）改为：

```ts
  if (hasTools && raw.tools !== undefined && (raw.tools.allow?.length ?? 0) === 0) {
    throw new Error(`dsh-agent-toolkit: 角色文件 ${source} 的 tools 为空：allow 至少配一个（不需要限制请整段省略 tools）`)
  }
```

（同时删掉 deny warn 分支——原 71-73 行。）

④ `importRolesYaml` 内调用（159 行）改为：

```ts
      const record = parseRoleYaml(text, ref.path, ref.fileName)
```

- [ ] **Step 4: store.ts 注释清理**

`store.ts` 第 9 行改为：

```ts
/** 一条 Agent 注册表记录。tools 仅白名单。 */
```

- [ ] **Step 5: docs/usage/agents.md 清理**

第 59 行 `- \`tools.allow\`：白名单；\`tools.deny\` 被忽略并记 warn（注册表仅支持白名单）；\`tools\` 不能配成空对象` 改为：

```markdown
- `tools.allow`：白名单（仅支持 allow，无 deny 语义）；`tools` 不能配成空对象
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS

- [ ] **Step 7: Commit（需用户确认）**

```bash
git add packages/toolkit/src/agents/import-yaml.ts packages/toolkit/src/agents/import-yaml.test.ts packages/toolkit/src/agents/store.ts docs/usage/agents.md
git commit -m "refactor(toolkit): 彻底删除 import-yaml 的 deny 兼容残留"
```

---

### Task 3: UI 工具区块 radio 二选一显式化

**Files:**
- Modify: `packages/toolkit/src/client/agents/AgentEditor.tsx`
- Modify: `packages/toolkit/src/client/agents/agents.module.css`
- Modify: `docs/usage/agents.md:20`
- Test: `packages/toolkit/src/client/agents/agents.spec.tsx`

**Interfaces:**
- Consumes: 现有 `ToolsCatalog`（api.ts）、现有 css 类（`.toolCheck`/`.toolGrid`/`.toolGroupTitle`/`.hint`）。
- Produces: 无新导出；UI 行为契约 = radio `aria-label`「不限制（继承会话全部工具）」「自定义白名单」，保存时不限制 → 省略 `tools`，自定义 → `tools: { allow: [...] }`。

- [ ] **Step 1: 改 fixture 与失败测试**

`agents.spec.tsx` 的 `AGENTS` fixture 中 explorer 行改为带白名单：

```ts
  { id: 'explorer', name: 'Explorer', description: '快速只读代码库探索', builtin: true, tools: { allow: ['read'] } },
```

文件末尾追加三个测试：

```ts
test('编辑已配白名单角色：默认选中「自定义白名单」并回显勾选', async () => {
  stubFetch(routes())
  render(<AgentsModal open onClose={() => undefined} />)
  // 初始选中首个可见角色 explorer（fixture 带 tools.allow ['read']）
  await screen.findByText('Explorer')
  expect((screen.getByLabelText('自定义白名单') as HTMLInputElement).checked).toBe(true)
  await vi.waitFor(() => {
    expect((screen.getByLabelText('工具 read') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('工具 bash') as HTMLInputElement).checked).toBe(false)
  })
})

test('编辑无 tools 角色：默认选中「不限制」，checkbox 禁用；保存省略 tools 字段', async () => {
  const calls = stubFetch(routes())
  render(<AgentsModal open onClose={() => undefined} />)
  await screen.findByText('Explorer')

  fireEvent.click(screen.getByText('侦察')) // scout 无 tools
  expect((screen.getByLabelText('不限制（继承会话全部工具）') as HTMLInputElement).checked).toBe(true)
  await vi.waitFor(() => {
    expect((screen.getByLabelText('工具 bash') as HTMLInputElement).disabled).toBe(true)
  })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/agents/scout' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).not.toHaveProperty('tools')
  })
})

test('自定义白名单全不勾 → 保存禁用并提示', async () => {
  stubFetch(routes())
  render(<AgentsModal open onClose={() => undefined} />)
  await screen.findByText('Explorer')

  // explorer 自定义回显 read → 取消勾选 → 空自定义
  await vi.waitFor(() => {
    expect((screen.getByLabelText('工具 read') as HTMLInputElement).checked).toBe(true)
  })
  fireEvent.click(screen.getByLabelText('工具 read'))
  expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('自定义白名单至少勾选一个工具，或改选不限制')).toBeTruthy()
})
```

并在既有「新建角色→保存」测试的工具全勾断言前加一行 radio 默认值断言：

```ts
  expect((screen.getByLabelText('自定义白名单') as HTMLInputElement).checked).toBe(true)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: FAIL（radio 不存在，`getByLabelText('自定义白名单')` 抛错）

- [ ] **Step 3: 实现 AgentEditor.tsx**

① state 区（31 行 `tools` 声明后）加：

```tsx
  // 工具模式：不限制（省略 tools 字段）/ 自定义白名单。编辑态按记录有无 tools 派生；新建默认自定义（名册到达后全勾）。
  const [toolsMode, setToolsMode] = useState<'unrestricted' | 'custom'>(
    agent === undefined || agent.tools !== undefined ? 'custom' : 'unrestricted',
  )
```

② 保存载荷（81 行）改为：

```ts
      ...(toolsMode === 'custom' && tools.length > 0 ? { tools: { allow: tools } } : {}),
```

③ 工具白名单 section（160-192 行）整体改为：

```tsx
      <section className={css.block}>
        <h3 className={css.blockTitle}>工具白名单</h3>
        <div className={css.toolMode}>
          <label className={css.toolCheck}>
            <input type="radio" name="agent-tools-mode" checked={toolsMode === 'unrestricted'}
              aria-label="不限制（继承会话全部工具）" onChange={() => { setToolsMode('unrestricted') }} />
            不限制（继承会话全部工具）
          </label>
          <label className={css.toolCheck}>
            <input type="radio" name="agent-tools-mode" checked={toolsMode === 'custom'}
              aria-label="自定义白名单" onChange={() => { setToolsMode('custom') }} />
            自定义白名单
          </label>
        </div>
        {catalog.native.length === 0 && catalog.global.length === 0 ? (
          <p className={css.hint}>暂无可用工具</p>
        ) : (
          <fieldset className={css.toolGroupSet} disabled={toolsMode !== 'custom'}>
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
          </fieldset>
        )}
        {toolsMode === 'custom' && tools.length === 0 && catalogLoaded && (
          <p className={css.hint}>自定义白名单至少勾选一个工具，或改选不限制</p>
        )}
      </section>
```

④ 保存按钮（200 行）disabled 改为：

```tsx
        <Button variant="primary" disabled={saving || (creating && !catalogLoaded) || (toolsMode === 'custom' && tools.length === 0)} onClick={() => { void save() }}>保存</Button>
```

- [ ] **Step 4: CSS 补充**

`agents.module.css` 在 `.toolGrid` 规则前追加：

```css
.toolMode {
  display: flex;
  gap: 8px;
}
.toolGroupSet {
  border: none;
  margin: 0;
  padding: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.toolGroupSet:disabled { opacity: 0.55; }
```

- [ ] **Step 5: docs/usage/agents.md 第 20 行同步**

改为：

```markdown
| 工具白名单 | 「不限制（继承会话全部工具）/ 自定义白名单」radio 二选一 + checkbox 列表，分「原生工具」（pwsh/bash、read/write/edit/read_image、glob/grep）和「扩展工具」（顶层全局工具）两组。仅白名单语义：勾选的才可用，**没有 deny**。新建模式默认自定义 + 全勾；自定义下全不勾不可保存（改选不限制请用 radio） |
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（含三个新测试与既有「新建角色→保存」「名册未到保存禁用」）

- [ ] **Step 7: Commit（需用户确认）**

```bash
git add packages/toolkit/src/client/agents/AgentEditor.tsx packages/toolkit/src/client/agents/agents.module.css packages/toolkit/src/client/agents/agents.spec.tsx docs/usage/agents.md
git commit -m "feat(toolkit): Agents 面板工具区块改为不限制/自定义白名单 radio 二选一"
```

---

### Task 4: 全量验证 + AGENTS.md 同步

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: Task 1-3 全部产物。
- Produces: 无代码产物。

- [ ] **Step 1: 类型检查**

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS（无错误）

- [ ] **Step 2: 构建**

Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 成功产出 lib/index.js + lib/client.js

- [ ] **Step 3: 全量单测复跑**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: 全绿

- [ ] **Step 4: AGENTS.md 同步**

`AGENTS.md` 的「Agent 注册表」段落（"Agent 注册表：UI 管理（Agents 面板，创建/编辑/删除）+ YAML 首启导入（`roles_yaml_imported` 一次性标记）…"）末尾追加一句：

```markdown
内置 explorer 默认携带只读白名单（NATIVE_TOOL_NAMES 去 write/edit 派生，存量经 meta 标记 `explorer_readonly_migrated` 一次性补齐）；Agents 面板工具区块为「不限制 / 自定义白名单」radio 二选一（不限制 = 省略 tools 字段），deny 语义不存在。
```

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md 同步 explorer 只读白名单与工具区块 radio 二选一"
```

- [ ] **Step 6: 开发回路冒烟（告知用户）**

提示用户：`bundle` 产物已更新，web profile 经 link: 装载的插件在下次启动（或 HMR）后生效；存量 explorer 会在首次激活时自动补只读白名单，Agents 面板可验证 radio 回显。
