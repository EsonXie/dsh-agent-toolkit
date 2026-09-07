# Agent 团队可见性开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent 记录新增 `visibleInTeam?: boolean` 开关：隐藏（`false`）的 Agent 不进团队名册段、不可被 `team_delegate` 委派；bot 绑定不受影响；缺省 = 可见，存量零迁移。

**Architecture:** 可选布尔字段落在 `agents/store.ts`（schema 单一来源），导出统一判定 `isTeamVisible(role) = role.visibleInTeam !== false`；委派链路两个挂钩点（`delegate/index.ts` 名册段 + `delegate/tool.ts` 执行入口）共用该判定；UI 在 Agents 面板编辑器加 checkbox（省略语义）+ 列表徽标。CRUD/落库链路零改动（可选字段自动透传）。

**Tech Stack:** TypeScript + zod（schema）、vitest（单测）、React + @testing-library/react（面板 UI 测试）、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-09-04-agent-team-visibility-design.md`

## Global Constraints

- 所有改动在 `packages/toolkit/` 内；工作目录为仓库根 `D:\work\github\dsh\dsh-agent-toolkit`。
- 单测命令：`pnpm --filter dsh-agent-toolkit test`；单文件：`pnpm --filter dsh-agent-toolkit exec vitest run <相对 packages/toolkit 的路径>`；类型检查：`pnpm --filter dsh-agent-toolkit typecheck`；构建：`pnpm --filter dsh-agent-toolkit bundle`。
- **省略语义**：`visibleInTeam` 缺省/`undefined`/`true` 均 = 可见；仅显式 `false` 隐藏。UI 勾选时省略字段，取消勾选时提交 `visibleInTeam: false`。
- Agents 面板（`src/client/agents/`）文案为**硬编码中文**（该面板不走 locale 系统），新文案照此模式硬编码；不要引入 locale 词条。
- 遵循现有代码风格：无分号以外的特殊约定、单引号、2 空格缩进；测试为中文描述。
- **git commit 需用户逐次确认**：每个任务的 Commit 步骤先向用户展示 `git status`/`git diff` 并征得同意后再执行。
- 不修改 `deepseek-harness/` 下任何文件。

---

### Task 1: 数据模型——`visibleInTeam` 字段 + `isTeamVisible` 判定

**Files:**
- Modify: `packages/toolkit/src/agents/store.ts`
- Test: `packages/toolkit/src/agents/store.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces:
  - `AgentRecord.visibleInTeam?: boolean`（interface + zod schema，可选布尔）
  - `export function isTeamVisible(role: Pick<AgentRecord, 'visibleInTeam'>): boolean`——缺省/true → `true`，`false` → `false`。Task 2/3 的过滤判定与 Task 5/6 的 UI 派生均以此为准。

- [ ] **Step 1: 写失败测试**

在 `packages/toolkit/src/agents/store.test.ts` 的 `describe('AgentRecordSchema')` 块末尾追加：

```ts
  test('接受 visibleInTeam 可选布尔（省略/true/false 均合法，非布尔拒绝）', () => {
    expect(AgentRecordSchema.safeParse({ id: 'x', name: 'X' }).success).toBe(true)
    expect(AgentRecordSchema.safeParse({ id: 'x', name: 'X', visibleInTeam: true }).success).toBe(true)
    expect(AgentRecordSchema.safeParse({ id: 'x', name: 'X', visibleInTeam: false }).success).toBe(true)
    expect(AgentRecordSchema.safeParse({ id: 'x', name: 'X', visibleInTeam: 'yes' }).success).toBe(false)
  })
```

文件末尾追加：

```ts
describe('isTeamVisible', () => {
  test('缺省与 true 可见，仅显式 false 隐藏', () => {
    expect(isTeamVisible({})).toBe(true)
    expect(isTeamVisible({ visibleInTeam: true })).toBe(true)
    expect(isTeamVisible({ visibleInTeam: false })).toBe(false)
  })
})
```

import 行改为：

```ts
import { AgentRecordSchema, agentToolkitDomain, isTeamVisible, migrateAgentRecord } from './store.ts'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/store.test.ts`
Expected: FAIL——`isTeamVisible is not a function` / 导入不存在。

- [ ] **Step 3: 实现**

`packages/toolkit/src/agents/store.ts` 三处改动：

`AgentRecord` interface（`builtin` 行之后追加字段）：

```ts
  builtin?: boolean
  /** 团队可见性：省略/true = 出现在 Agent 团队名册并可被委派；false = 隐藏。bot 绑定不受此字段影响。 */
  visibleInTeam?: boolean
```

`AgentRecordSchema`（`builtin` 行之后追加）：

```ts
  builtin: z.boolean().optional(),
  visibleInTeam: z.boolean().optional(),
```

文件末尾（`migrateAgentRecord` 之后）追加：

```ts
/** 团队可见性判定：缺省（undefined）与 true 均可见；仅显式 false 隐藏。 */
export function isTeamVisible(role: Pick<AgentRecord, 'visibleInTeam'>): boolean {
  return role.visibleInTeam !== false
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/store.test.ts`
Expected: PASS（全部既有 + 新增用例）。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/agents/store.ts packages/toolkit/src/agents/store.test.ts
git commit -m "feat(toolkit): AgentRecord 新增 visibleInTeam 团队可见性字段与 isTeamVisible 判定"
```

---

### Task 2: 名册段过滤——`teamSectionText` 排除隐藏角色

**Files:**
- Modify: `packages/toolkit/src/delegate/index.ts:22-33`
- Test: `packages/toolkit/src/delegate/index.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isTeamVisible`。
- Produces: `teamSectionText(toolName, roles, toolVisible)` 签名不变，但 `roles` 元素类型从 `Pick<AgentRecord, 'id' | 'name' | 'description'>` 扩为 `Pick<AgentRecord, 'id' | 'name' | 'description' | 'visibleInTeam'>`；隐藏角色不列出名册。

- [ ] **Step 1: 写失败测试**

`packages/toolkit/src/delegate/index.test.ts` 的 `describe('teamSectionText')` 块内追加：

```ts
  test('visibleInTeam: false 的成员不进名册；缺省与 true 照常列出', () => {
    const roster = [
      { id: 'main', name: '主 Agent' },
      { id: 'reviewer', name: 'Reviewer', description: '代码审查员' },
      { id: 'hidden', name: 'Hidden', description: '团队不可见', visibleInTeam: false },
      { id: 'shown', name: 'Shown', visibleInTeam: true },
    ]
    const text = teamSectionText('team_delegate', roster, true)
    expect(text).toContain('reviewer: 代码审查员')
    expect(text).toContain('shown: Shown')
    expect(text).not.toContain('hidden')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/index.test.ts`
Expected: FAIL——`text` 仍含 `hidden`。

- [ ] **Step 3: 实现**

`packages/toolkit/src/delegate/index.ts`：

import 行（第 4 行）改为：

```ts
import { isTeamVisible, type AgentRecord } from '../agents/store.ts'
```

`teamSectionText` 的 roles 参数类型与过滤行（:24、:29）改为：

```ts
export function teamSectionText(
  toolName: string,
  roles: readonly Pick<AgentRecord, 'id' | 'name' | 'description' | 'visibleInTeam'>[],
  toolVisible: boolean,
): string {
  if (!toolVisible) return ''
  const rosterText = roles
    .filter(r => r.id !== 'main' && isTeamVisible(r))
    .map(r => `${r.id}: ${r.description ?? r.name}`)
    .join('\n')
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/index.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/delegate/index.ts packages/toolkit/src/delegate/index.test.ts
git commit -m "feat(toolkit): 团队名册段排除团队不可见角色"
```

---

### Task 3: 委派工具拦截——`team_delegate` 拒绝向隐藏角色委派

**Files:**
- Modify: `packages/toolkit/src/delegate/tool.ts:142-147`
- Test: `packages/toolkit/src/delegate/tool.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isTeamVisible`；`DelegateToolDeps.roster` 签名不变（返回全量，过滤在工具内部）。
- Produces: 无新接口——隐藏角色走既有「未知角色」报错路径，错误清单只含可见角色。

- [ ] **Step 1: 写失败测试**

`packages/toolkit/src/delegate/tool.test.ts` 在「不能委派给 main」测试之后追加：

```ts
test('团队不可见角色不可委派：报错且不出现在可用清单，不发起委派', async () => {
  const captured: Captured[] = []
  const roster: AgentRecord[] = [
    ...ROSTER,
    { id: 'hidden', name: 'Hidden', visibleInTeam: false },
  ]
  const deps: DelegateToolDeps = { ...depsWith(okRun([]), captured), roster: () => roster }
  const tool = createDelegateTool('team_delegate', deps)
  await expect(callTool(tool, { role: 'hidden', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/未知角色 "hidden"。可用角色：reviewer, scout, worker/)
  expect(captured).toHaveLength(0)
})

test('显式 visibleInTeam: true 的角色照常可委派', async () => {
  const captured: Captured[] = []
  const roster: AgentRecord[] = [{ id: 'shown', name: 'Shown', visibleInTeam: true }]
  const deps: DelegateToolDeps = { ...depsWith(okRun([]), captured), roster: () => roster }
  const tool = createDelegateTool('team_delegate', deps)
  await callTool(tool, { role: 'shown', description: '执行', prompt: '任务' })
  expect(captured).toHaveLength(1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/tool.test.ts`
Expected: FAIL——第一个新用例中委派成功（`captured` 长度 1，不抛错）。

- [ ] **Step 3: 实现**

`packages/toolkit/src/delegate/tool.ts`：

import 行（第 7 行）改为：

```ts
import { isTeamVisible, type AgentRecord } from '../agents/store.ts'
```

`execute` 内 roster 过滤行与注释（:142-143）改为：

```ts
      // 主 Agent 与团队不可见角色不可委派：查找与错误清单都排除。
      const roster = deps.roster().filter(r => r.id !== 'main' && isTeamVisible(r))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/delegate/tool.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/delegate/tool.ts packages/toolkit/src/delegate/tool.test.ts
git commit -m "feat(toolkit): team_delegate 拒绝向团队不可见角色委派"
```

---

### Task 4: 守护测试——bot 绑定隐藏角色照常建会话

**Files:**
- Test: `packages/toolkit/src/channels/router.test.ts`（仅测试，无实现改动）

**Interfaces:**
- Consumes: Task 1 的 `visibleInTeam` 字段（`AgentRecord`）；`Router.ensure` 既有行为。
- Produces: 无——固化「`resolveSession` 的 `registry.get(ref)` 不做可见性过滤」这一不变量，防未来回归。

**说明：** 这是行为守护测试——bot 绑定路径本就不读 `visibleInTeam`，测试应当**直接通过**。若失败说明 Task 1-3 误伤了 bot 绑定链路，必须停下排查。

- [ ] **Step 1: 写测试**

`packages/toolkit/src/channels/router.test.ts` 的 `describe('Router.ensure agentRef 绑定')` 块内（「agentRef 指向不存在角色」用例之前）追加：

```ts
  test('agentRef 指向团队不可见角色：bot 绑定照常（角色形态 section/tools/agentOptions）', async () => {
    const hidden: AgentRecord = { ...REVIEWER_ROLE, visibleInTeam: false }
    const { router, created, defaultModel } = setup(undefined, fakeRegistry([MAIN_ROLE, hidden]).registry)
    await router.ensure(fakeBot({ agentRef: 'reviewer' }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).not.toHaveBeenCalled()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(created[0].input.hooks).toEqual({
      sections: [
        { name: 'dsh-agent-toolkit:agent:persona', order: 0, text: '你是团队的评审成员。\n只审查 diff，不修改代码。' },
        SENDER,
      ],
      tools: ['bash', 'fs_read'],
    })
  })
```

- [ ] **Step 2: 跑测试确认通过（守护语义）**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/router.test.ts`
Expected: PASS（全部用例，含新增）。**若新增用例失败 → 停止，排查 Task 1-3 是否影响 bot 绑定路径。**

- [ ] **Step 3: Commit（需用户确认）**

```bash
git add packages/toolkit/src/channels/router.test.ts
git commit -m "test(toolkit): 守护 bot 可绑定团队不可见角色"
```

---

### Task 5: 编辑器开关——AgentEditor「在 Agent 团队中可见」checkbox

**Files:**
- Modify: `packages/toolkit/src/client/agents/AgentEditor.tsx`
- Test: `packages/toolkit/src/client/agents/agents.spec.tsx`

**Interfaces:**
- Consumes: Task 1 的 `AgentRecord.visibleInTeam`；既有 `saveAgent`（PUT 全量替换，可选字段自动透传）。
- Produces: 编辑器 checkbox `aria-label="在 Agent 团队中可见"`；保存语义：勾选 → 记录省略 `visibleInTeam`，取消勾选 → `visibleInTeam: false`。

- [ ] **Step 1: 写失败测试**

`packages/toolkit/src/client/agents/agents.spec.tsx` 末尾追加：

```ts
test('编辑角色：「在 Agent 团队中可见」默认勾选，取消勾选后保存携带 visibleInTeam: false', async () => {
  const calls = stubFetch(routes())
  render(<AgentsModal open onClose={() => undefined} />)
  await screen.findByText('Explorer')

  fireEvent.click(screen.getByText('侦察'))
  const checkbox = screen.getByLabelText('在 Agent 团队中可见') as HTMLInputElement
  expect(checkbox.checked).toBe(true)
  fireEvent.click(checkbox)
  expect(checkbox.checked).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/agents/scout' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).toMatchObject({ id: 'scout', visibleInTeam: false })
  })
})

test('编辑团队不可见角色：checkbox 回显为不勾选；勾选后保存省略 visibleInTeam 字段', async () => {
  const hiddenAgents = [...AGENTS, { id: 'ghost', name: '幕后', visibleInTeam: false }]
  const calls = stubFetch({ ...routes(), '/dsh-agent-toolkit/api/agents': () => hiddenAgents })
  render(<AgentsModal open onClose={() => undefined} />)
  await screen.findByText('Explorer')

  fireEvent.click(screen.getByText('幕后'))
  const checkbox = screen.getByLabelText('在 Agent 团队中可见') as HTMLInputElement
  expect(checkbox.checked).toBe(false)
  fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/agents/ghost' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).toMatchObject({ id: 'ghost' })
    expect(put?.body).not.toHaveProperty('visibleInTeam')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/agents/agents.spec.tsx`
Expected: FAIL——`getByLabelText('在 Agent 团队中可见')` 找不到元素。

- [ ] **Step 3: 实现**

`packages/toolkit/src/client/agents/AgentEditor.tsx` 三处改动：

state（`toolsMode` state 之后，约 :35 处）追加：

```ts
  // 团队可见性：省略/true = 可见（checkbox 勾选）；false = 隐藏。保存时勾选省略字段、不勾选写 false。
  const [visibleInTeam, setVisibleInTeam] = useState(agent?.visibleInTeam !== false)
```

`save()` 的 record 组装（:79-86，`tools` 展开行之后）追加：

```ts
      ...(toolsMode === 'custom' && tools.length > 0 ? { tools: { allow: tools } } : {}),
      ...(visibleInTeam ? {} : { visibleInTeam: false }),
```

基本信息区块内「描述」label 之后（:132 `</label>` 与 :133 `</section>` 之间）插入：

```tsx
        <label className={css.toolCheck}>
          <input type="checkbox" checked={visibleInTeam} aria-label="在 Agent 团队中可见"
            onChange={(e) => { setVisibleInTeam(e.target.checked) }} />
          在 Agent 团队中可见
        </label>
```

（`css.toolCheck` 是本模块 css 里已有的横向勾选行样式，:167 等处已用。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/agents/agents.spec.tsx`
Expected: PASS（全部用例）。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/client/agents/AgentEditor.tsx packages/toolkit/src/client/agents/agents.spec.tsx
git commit -m "feat(toolkit): Agent 编辑器加「在 Agent 团队中可见」开关"
```

---

### Task 6: 列表徽标——AgentsModal「团队不可见」标识

**Files:**
- Modify: `packages/toolkit/src/client/agents/AgentsModal.tsx:75`
- Test: `packages/toolkit/src/client/agents/agents.spec.tsx`

**Interfaces:**
- Consumes: Task 1 的 `visibleInTeam` 字段；既有 `Pill` 组件与 `css.builtinBadge` 样式（直接复用，视觉与「内置」徽标一致）。
- Produces: 列表中 `visibleInTeam === false` 的角色行渲染文本为「团队不可见」的 Pill。

- [ ] **Step 1: 写失败测试**

`packages/toolkit/src/client/agents/agents.spec.tsx` 末尾追加：

```ts
test('列表渲染：团队不可见角色带「团队不可见」徽标，可见角色不带', async () => {
  const withHidden = [...AGENTS, { id: 'ghost', name: '幕后', visibleInTeam: false }]
  stubFetch({ ...routes(), '/dsh-agent-toolkit/api/agents': () => withHidden })
  render(<AgentsModal open onClose={() => undefined} />)

  expect(await screen.findByText('幕后')).toBeTruthy()
  expect(screen.getAllByText('团队不可见')).toHaveLength(1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/agents/agents.spec.tsx`
Expected: FAIL——找不到「团队不可见」文本。

- [ ] **Step 3: 实现**

`packages/toolkit/src/client/agents/AgentsModal.tsx` 角色行（:75 内置徽标行之后）追加：

```tsx
            {agent.builtin === true && <Pill className={css.builtinBadge}>内置</Pill>}
            {agent.visibleInTeam === false && <Pill className={css.builtinBadge}>团队不可见</Pill>}
```

（复用 `css.builtinBadge`：同款 `flex: none; align-self: flex-start;` 布局，不新增 CSS。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/agents/agents.spec.tsx`
Expected: PASS。

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/client/agents/AgentsModal.tsx packages/toolkit/src/client/agents/agents.spec.tsx
git commit -m "feat(toolkit): Agents 面板列表加「团队不可见」徽标"
```

---

### Task 7: 全量回归 + 构建

**Files:** 无改动（验证任务）。

- [ ] **Step 1: 全量单测**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: 全部 PASS（374 + 本计划新增用例）。

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 无错误。

- [ ] **Step 3: 构建**

Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 成功产出 `lib/index.js` 与 `lib/client.js`。

- [ ] **Step 4: 开发回路人工验证（可选，需用户在场）**

按 AGENTS.md 开发回路：link 插件 → Agents 面板把某角色设为团队不可见 → 主会话新开会话，系统提示名册段不含该角色、`team_delegate` 向其委派报「未知角色」→ 飞书 bot 绑定该角色仍可正常收发消息。
