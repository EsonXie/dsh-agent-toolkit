# agent-team 重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 agent-team 重构为「扁平角色名册 + team_delegate 一次性委派 + 自定义委派卡」：内置 explorer/general 保底、用户级 `$DSH_HOME/agent-team/roles/*.yml` 覆盖、纯 Node 半委派逻辑 + 浏览器半 keyed 工具卡片。配套改动：prompt-stack 增加子 Agent 隔离（人设/任务层不泄漏进成员提示词；model-notes 模型层主子共用、按成员生效模型命中规则）。

**Architecture:** 名册两层合并（内置常量 ← 用户目录，同名覆盖）在激活期解析一次；team_delegate 经 `ctx.subagents.start('spawn', …)` 前台一次性委派，结果携带 `childSessionId`（本地 run 的 `run.id` 契约上即子 session id）；浏览器半注册 keyed `tool.call.toolview` 渲染器接管委派卡展示与跳转只读子会话。拆除团队层：TeamState/KV/HTTP 路由/dock 全删。

**Tech Stack:** TypeScript（tsx 直跑 Node 半）、Schemastery（Config/Role schema）、vitest（Node 半）+ testing-library/jsdom（浏览器半）、tsdown+lightningcss（浏览器半 bundle）、React 18 + CSS Modules + clsx。

**Spec:** `docs/superpowers/specs/2026-08-20-agent-team-redesign-design.md`（所有决策与源码行号证据在此）

## Global Constraints

- 命令：单测 `pnpm --filter agent-team test`；类型检查 `pnpm --filter agent-team typecheck`；构建 `pnpm --filter agent-team bundle`（src 改动后必须跑）
- 插件形态：命名导出 `name`/`inject`/`Config`/`apply`，**无 default export**；可调参数进 Config，不硬编码
- 纯逻辑（名册/合并/工具构造）与 ctx 接线分离：纯逻辑模块不 import cordis Context
- 每个任务完成后跑 `pnpm --filter agent-team test && pnpm --filter agent-team typecheck`，全绿再 commit
- 浏览器半 CSS：只用 `--dsw-alias-*`/`--dsw-font-*` token，禁字面颜色、禁主题选择器；产品文案中文、代码注释英文
- 浏览器半组件测试：`// @vitest-environment jsdom` pragma 在文件首行；断言用户可见行为，不断言 class 名
- 浏览器半对 `@deepseek-ai/*` 只能 **type-only import**（值导入受 tsdown.config.ts 纯净度门禁限制；`@deepseek-ai/dsh-client-ui-primitives` 与 `clsx` 例外，前者在 CLIENT_EXTERNALS、后者被 bundle）
- commit 信息格式照仓库现状：`feat(agent-team): …` / `refactor(agent-team): …` / `test(agent-team): …`

---

### Task 1: Role schema 与名册文件加载（roles.ts 重写）

**Files:**
- Modify: `packages/agent-team/src/roles.ts`（整体重写）
- Test: `packages/agent-team/tests/roles.test.ts`（整体重写）
- Delete: `packages/agent-team/tests/fixtures/team-preset/`（团队名册夹具不再使用；Task 4 重写集成测试前先删）

**Interfaces:**
- Produces（后续任务依赖）:
  - `interface Role { readonly name: string; readonly description: string; readonly persona: string; readonly provider?: string; readonly model?: string; readonly tools?: RoleTools }`
  - `interface RoleTools { readonly allow?: string[]; readonly deny?: string[] }`
  - `parseRoleYaml(text: string, source: string, fileName: string): Role` — 解析单个角色文件；`fileName` 为去 `.yml` 的文件名
  - `loadRolesDir(dir: string): Promise<Role[]>` — 目录不存在/无 `.yml` → `[]`；任一文件非法 → 抛错
  - `NAME_RE = /^[A-Za-z0-9_-]+$/`

- [ ] **Step 1: 写失败测试**（`tests/roles.test.ts` 全文替换）

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { loadRolesDir, parseRoleYaml } from '../src/roles.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'agent-team-roles-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const VALID = 'description: 只读探索\npersona: 你是探索员。\n'

test('parseRoleYaml：name 省略取文件名；带 tools/provider/model 完整解析', () => {
  const minimal = parseRoleYaml(VALID, 'explorer.yml', 'explorer')
  expect(minimal).toEqual({ name: 'explorer', description: '只读探索', persona: '你是探索员。' })
  const full = parseRoleYaml(
    VALID + 'provider: anthropic\nmodel: claude-sonnet-4\ntools:\n  deny: [write, edit]\n',
    'scout.yml', 'scout',
  )
  expect(full).toEqual({
    name: 'scout', description: '只读探索', persona: '你是探索员。',
    provider: 'anthropic', model: 'claude-sonnet-4', tools: { deny: ['write', 'edit'] },
  })
})

test('parseRoleYaml：name 显式填写但与文件名不一致 → 抛错', () => {
  expect(() => parseRoleYaml('name: other\n' + VALID, 'explorer.yml', 'explorer'))
    .toThrowError(/与文件名/)
})

test('parseRoleYaml：name 非法字符 / description 缺失 / persona 缺失 → 抛错', () => {
  expect(() => parseRoleYaml(VALID, 'bad name.yml', 'bad name')).toThrowError(/非法/)
  expect(() => parseRoleYaml('persona: 有\n', 'x.yml', 'x')).toThrowError(/description|校验失败/)
  expect(() => parseRoleYaml('description: 有\n', 'x.yml', 'x')).toThrowError(/persona|校验失败/)
})

test('parseRoleYaml：tools 空对象（allow/deny 都没有）→ 抛错（宿主空 filter 语义）', () => {
  expect(() => parseRoleYaml(VALID + 'tools: {}\n', 'x.yml', 'x')).toThrowError(/tools/)
})

test('parseRoleYaml：YAML 语法错误 → 抛错且信息含来源名', () => {
  expect(() => parseRoleYaml('description: [未闭合', 'broken.yml', 'broken'))
    .toThrowError(/broken\.yml/)
})

test('loadRolesDir：目录不存在 → 空列表（静默跳过）', async () => {
  await expect(loadRolesDir(join(dir, 'missing'))).resolves.toEqual([])
})

test('loadRolesDir：目录无 .yml → 空列表；按文件名字典序返回', async () => {
  await writeFile(join(dir, 'b.yml'), VALID)
  await writeFile(join(dir, 'a.yml'), VALID)
  await writeFile(join(dir, 'note.txt'), '忽略我')
  const roles = await loadRolesDir(dir)
  expect(roles.map(r => r.name)).toEqual(['a', 'b'])
})

test('loadRolesDir：任一文件非法 → 抛错；目录不可读（非 ENOENT）→ 抛错', async () => {
  await writeFile(join(dir, 'ok.yml'), VALID)
  await writeFile(join(dir, 'bad.yml'), 'description: [未闭合')
  await expect(loadRolesDir(dir)).rejects.toThrowError(/bad\.yml/)
  await expect(loadRolesDir(join(dir, 'ok.yml'))).rejects.toThrowError() // 文件路径当目录 → ENOTDIR
})

test('loadRolesDir：同目录内角色重名 → 抛错', async () => {
  await writeFile(join(dir, 'x.yml'), 'name: x\n' + VALID)
  // 同名只能来自「name 省略取文件名」之外的途径：两个文件名同名不可能，故构造
  // name 与文件名一致前提下无法重名——此用例改为验证非法 name 在目录加载期即失败
  await writeFile(join(dir, 'x2.yml'), 'description: 有\npersona: 有\ntools:\n  allow: []\n')
  await expect(loadRolesDir(dir)).rejects.toThrowError(/tools/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test -- roles`
Expected: FAIL（`parseRoleYaml`/`loadRolesDir` 不存在）

- [ ] **Step 3: 重写 `src/roles.ts`**

```ts
/** 角色名册文件解析：$DSH_HOME/agent-team/roles/<name>.yml 一角色一文件。 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import z from '@deepseek-ai/schemastery'

/** 角色级工具限制：原样透传为 SubagentStartRequest.toolFilter（精确名白/黑名单，无通配）。 */
export interface RoleTools {
  readonly allow?: string[]
  readonly deny?: string[]
}

/** 一名可委派角色。provider/model 缺省继承主 Agent；tools 缺省不限制。 */
export interface Role {
  readonly name: string
  readonly description: string
  readonly persona: string
  readonly provider?: string
  readonly model?: string
  readonly tools?: RoleTools
}

export const NAME_RE = /^[A-Za-z0-9_-]+$/

const RoleFileSchema = z.object({
  name: z.string(),
  description: z.string().required(),
  persona: z.string().required(),
  provider: z.string(),
  model: z.string(),
  tools: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
})

/**
 * 解析校验单个角色文件。
 * @param text - 文件内容。
 * @param source - 用于错误信息的来源名（通常是文件路径）。
 * @param fileName - 文件名（去 .yml），name 省略时的取值；显式 name 须与它一致。
 * @throws YAML 语法错误、结构非法、name 与文件名不一致、name 非法字符、tools 空对象。
 */
export function parseRoleYaml(text: string, source: string, fileName: string): Role {
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch (error) {
    throw new Error(`agent-team: 角色文件 ${source} 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)
  }
  let raw: { name?: string; description: string; persona: string; provider?: string; model?: string; tools?: RoleTools }
  try {
    raw = RoleFileSchema(parsed as Parameters<typeof RoleFileSchema>[0]) as typeof raw
  } catch (error) {
    throw new Error(`agent-team: 角色文件 ${source} 校验失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const name = raw.name ?? fileName
  if (raw.name !== undefined && raw.name !== fileName) {
    throw new Error(`agent-team: 角色文件 ${source} 的 name "${raw.name}" 与文件名 "${fileName}" 不一致（省略 name 即取文件名）`)
  }
  if (!NAME_RE.test(name)) {
    throw new Error(`agent-team: 角色名 "${name}" 非法（${source}）：只允许字母、数字、-、_`)
  }
  if (raw.tools !== undefined && raw.tools.allow === undefined && raw.tools.deny === undefined) {
    throw new Error(`agent-team: 角色文件 ${source} 的 tools 为空：allow/deny 至少配一个（宿主拒绝空 filter）`)
  }
  return {
    name,
    description: raw.description,
    persona: raw.persona,
    ...raw.provider !== undefined ? { provider: raw.provider } : {},
    ...raw.model !== undefined ? { model: raw.model } : {},
    ...raw.tools !== undefined ? { tools: raw.tools } : {},
  }
}

/**
 * 读取 roles 目录下全部 .yml 角色文件，按文件名字典序返回。
 * @param dir - roles 目录绝对路径。
 * @returns 角色列表；目录不存在或无 .yml 文件时返回空列表（静默跳过，属正常态）。
 * @throws 目录存在但不可读（非 ENOENT）、任一文件内容非法。
 */
export async function loadRolesDir(dir: string): Promise<Role[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`agent-team: 角色目录不可读：${dir}（${error instanceof Error ? error.message : String(error)}）`)
  }
  const files = entries.filter(f => f.endsWith('.yml')).sort()
  const roles: Role[] = []
  for (const file of files) {
    const path = join(dir, file)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      throw new Error(`agent-team: 角色文件不可读：${path}（${error instanceof Error ? error.message : String(error)}）`)
    }
    roles.push(parseRoleYaml(text, path, file.slice(0, -'.yml'.length)))
  }
  return roles
}
```

注：`Team` 接口、`loadTeams`、`parseRolesYaml` 一并删除（无消费者；tool.ts/prompt.ts 的适配在 Task 3，本任务 typecheck 红是预期，跑 test 时用 `pnpm --filter agent-team test -- roles` 只跑本文件）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test -- roles`
Expected: PASS（8 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/agent-team/src/roles.ts packages/agent-team/tests/roles.test.ts
git commit -m "refactor(agent-team): Role 扁平化——一角色一文件解析与目录加载"
```

---

### Task 2: 内置角色与两层合并（builtin-roles.ts + roster.ts）

**Files:**
- Create: `packages/agent-team/src/builtin-roles.ts`
- Create: `packages/agent-team/src/roster.ts`
- Test: `packages/agent-team/tests/roster.test.ts`

**Interfaces:**
- Consumes: `Role`、`loadRolesDir`（Task 1）
- Produces:
  - `BUILTIN_ROLES: readonly Role[]`（explorer + general）
  - `interface Roster { readonly roles: readonly Role[]; readonly overridden: readonly string[] }`
  - `resolveRoster(userDir: string): Promise<Roster>` — 用户目录同名角色覆盖内置；`overridden` 为被覆盖的内置角色名

- [ ] **Step 1: 写失败测试**（`tests/roster.test.ts`）

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { BUILTIN_ROLES } from '../src/builtin-roles.ts'
import { resolveRoster } from '../src/roster.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'agent-team-roster-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('内置名册：explorer（deny write/edit）+ general（不限制），均不配 provider/model', () => {
  const names = BUILTIN_ROLES.map(r => r.name)
  expect(names).toEqual(['explorer', 'general'])
  const explorer = BUILTIN_ROLES[0]
  expect(explorer.tools).toEqual({ deny: ['write', 'edit'] })
  expect(explorer.provider).toBeUndefined()
  expect(explorer.model).toBeUndefined()
  expect(BUILTIN_ROLES[1].tools).toBeUndefined()
  for (const role of BUILTIN_ROLES) {
    expect(role.description.length).toBeGreaterThan(0)
    expect(role.persona.length).toBeGreaterThan(0)
  }
})

test('用户目录不存在：返回内置名册，overridden 为空', async () => {
  const roster = await resolveRoster(join(dir, 'missing'))
  expect(roster.roles.map(r => r.name)).toEqual(['explorer', 'general'])
  expect(roster.overridden).toEqual([])
})

test('用户追加新角色：排在内置之后', async () => {
  await writeFile(join(dir, 'reviewer.yml'), 'description: 代码审查\npersona: 你是审查员。\n')
  const roster = await resolveRoster(dir)
  expect(roster.roles.map(r => r.name)).toEqual(['explorer', 'general', 'reviewer'])
  expect(roster.overridden).toEqual([])
})

test('用户同名覆盖内置：内容替换、位置保持、记入 overridden', async () => {
  await writeFile(join(dir, 'explorer.yml'),
    'description: 定制探索\npersona: 定制。\nmodel: deepseek-reasoner\n')
  const roster = await resolveRoster(dir)
  expect(roster.roles.map(r => r.name)).toEqual(['explorer', 'general'])
  const explorer = roster.roles[0]
  expect(explorer.description).toBe('定制探索')
  expect(explorer.model).toBe('deepseek-reasoner')
  expect(explorer.tools).toBeUndefined()       // 整角色覆盖：内置的 deny 也被替换掉
  expect(roster.overridden).toEqual(['explorer'])
})

test('用户目录含非法文件：激活期响亮抛错', async () => {
  await writeFile(join(dir, 'bad.yml'), 'description: [未闭合')
  await expect(resolveRoster(dir)).rejects.toThrowError(/bad\.yml/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test -- roster`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/builtin-roles.ts`**

```ts
/** 内置保底角色：开箱即用的 explorer + general（用户级同名文件整角色覆盖）。 */
import type { Role } from './roles.ts'

export const BUILTIN_ROLES: readonly Role[] = [
  {
    name: 'explorer',
    description: '快速只读代码库探索：定位文件/符号、回答结构与调用关系问题，不做任何修改',
    persona: `你是代码库探索员。快速定位与任务相关的文件与符号，回答关于代码结构、
调用关系、实现位置的问题。你只读不写：不修改任何文件、不运行有副作用的命令。
输出结论清单，每条附文件路径与行号；信息不足时说明缺口，不要猜测。`,
    tools: { deny: ['write', 'edit'] },
  },
  {
    name: 'general',
    description: '通用多步骤任务执行：可读可写、可运行命令，完成实现/修复类任务',
    persona: `你是通用执行员。按任务书独立完成多步骤工作，可以读写文件、运行命令。
动手前先阅读相关 AGENTS.md 并遵循项目约定；完成后运行与改动相关的检查
（测试/类型检查）验证改动，并在最终输出中报告验证结果。`,
  },
]
```

- [ ] **Step 4: 实现 `src/roster.ts`**

```ts
/** 名册解析管线：内置保底 ← 用户级目录（同名整角色覆盖）。 */
import type { Role } from './roles.ts'
import { BUILTIN_ROLES } from './builtin-roles.ts'
import { loadRolesDir } from './roles.ts'

/** 合并产物：最终名册 + 被用户覆盖的内置角色名（观测日志用）。 */
export interface Roster {
  readonly roles: readonly Role[]
  readonly overridden: readonly string[]
}

/**
 * 解析当前生效名册：内置角色为底，用户目录同名角色整角色覆盖、异名追加在后。
 * @param userDir - 用户级 roles 目录（不存在/为空属正常态）。
 * @throws 用户目录存在但含非法文件（loadRolesDir 原样上抛）。
 */
export async function resolveRoster(userDir: string): Promise<Roster> {
  const userRoles = await loadRolesDir(userDir)
  const userByName = new Map(userRoles.map(r => [r.name, r]))
  const overridden: string[] = []
  const roles: Role[] = BUILTIN_ROLES.map((role) => {
    const userRole = userByName.get(role.name)
    if (userRole === undefined) return role
    overridden.push(role.name)
    userByName.delete(role.name)
    return userRole
  })
  for (const role of userByName.values()) roles.push(role)
  return { roles, overridden }
}
```

- [ ] **Step 5: 跑测试确认通过 + Commit**

Run: `pnpm --filter agent-team test -- roster`
Expected: PASS（5 个用例）

```bash
git add packages/agent-team/src/builtin-roles.ts packages/agent-team/src/roster.ts packages/agent-team/tests/roster.test.ts
git commit -m "feat(agent-team): 内置 explorer/general 保底名册与用户目录同名覆盖合并"
```

---

### Task 3: team_delegate 工具重构（扁平名册 + toolFilter + childSessionId）+ prompt.ts 瘦身

**Files:**
- Modify: `packages/agent-team/src/tool.ts`
- Modify: `packages/agent-team/src/prompt.ts`（删 C 段：`PromptTemplates`/`MODEL_FAMILY_RULES`/模型族模板；`buildMemberPersona(role: Role): string` 单参化）
- Test: `packages/agent-team/tests/tool.test.ts`（重写）
- Test: `packages/agent-team/tests/prompt.test.ts`（重写）

**Interfaces:**
- Consumes: `Role`（Task 1）
- Produces:
  - `interface DelegateToolDeps { readonly roster: () => readonly Role[]; readonly provider: string; readonly startRun: (provider: string, request: SubagentStartRequest) => Promise<SubagentRun> }`（**不再有 templates 字段**）
  - `createDelegateTool(toolName: string, deps: DelegateToolDeps)` — 结果 JSON 增 `childSessionId` 字段；`output.presentationMeta` 投影 `{role, runId, childSessionId}`
  - `buildMemberPersona(role: Role): string` — A 身份契约 + B 能力守则 + 角色 persona（无模型适配；按模型提示词归 prompt-stack，见 spec §4.5）

- [ ] **Step 1: 重写失败测试**（`tests/tool.test.ts` 全文替换）

```ts
import { expect, test } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { Role } from '../src/roles.ts'
import { createDelegateTool, type DelegateToolDeps } from '../src/tool.ts'

const ROSTER: Role[] = [
  { name: 'reviewer', description: '代码审查员', persona: '你是审查员。', provider: 'deepseek', model: 'deepseek-reasoner' },
  { name: 'scout', description: '只读探索', persona: '你是探索员。', tools: { deny: ['write', 'edit'] } },
  { name: 'worker', description: '通用执行', persona: '你是执行员。' },
]

const parent = { options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as Agent

function okRun(output: ContentBlock[], disposeError?: Error): SubagentRun {
  return {
    id: 'child-session-1' as unknown as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve<SubagentResult>({ stopReason: 'completed', output } as SubagentResult),
    dispose: () => disposeError ? Promise.reject(disposeError) : Promise.resolve(),
  } as unknown as SubagentRun
}

interface Captured { provider: string; request: SubagentStartRequest }

function depsWith(run: SubagentRun, captured: Captured[]): DelegateToolDeps {
  return {
    roster: () => ROSTER,
    provider: 'spawn',
    startRun: async (provider, request) => { captured.push({ provider, request }); return run },
  }
}

const exec = { agent: parent, signal: new AbortController().signal }

async function callTool(tool: unknown, args: Record<string, unknown>, execArg: unknown = exec) {
  const execute = (tool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute
  return execute(args, execArg)
}

test('成功委派：请求字段正确，返回规范 JSON 含 childSessionId，run 被 dispose', async () => {
  const captured: Captured[] = []
  let disposed = false
  const run = okRun([{ type: 'text', text: '结论' } as ContentBlock])
  const origDispose = run.dispose
  run.dispose = async () => { disposed = true; return origDispose() }
  const tool = createDelegateTool('team_delegate', depsWith(run, captured))
  const result = await callTool(tool, { role: 'reviewer', description: '审查登录模块', prompt: '请审查 src/auth/' })
  expect(result).toMatchObject({
    kind: 'foreground', role: 'reviewer', runId: 'child-session-1', childSessionId: 'child-session-1',
  })
  expect(captured).toHaveLength(1)
  const { provider, request } = captured[0]
  expect(provider).toBe('spawn')
  expect(request.label).toBe('role:reviewer: 审查登录模块')
  expect(request.maxDepth).toBe(1)
  expect(request.persona).toContain('你是审查员。')
  expect(request.persona).toContain('不能再次委派')
  expect(request.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  expect(request.toolFilter).toBeUndefined()
  expect(request.parent).toBe(parent)
  expect(request.signal).toBe(exec.signal)
  expect(disposed).toBe(true)
})

test('角色配了 tools：透传为 toolFilter（数组拷贝，不共享引用）', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await callTool(tool, { role: 'scout', description: '探索', prompt: '任务' })
  expect(captured[0].request.toolFilter).toEqual({ deny: ['write', 'edit'] })
  expect(captured[0].request.toolFilter?.deny).not.toBe(ROSTER[1].tools?.deny)
})

test('角色未配 provider/model 时不传 agentOptions', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await callTool(tool, { role: 'worker', description: '执行', prompt: '任务' })
  expect(captured[0].request.agentOptions).toBeUndefined()
})

test('未知角色报错并列出可用角色，且不发起委派', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await expect(callTool(tool, { role: 'nobody', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/未知角色 "nobody"。可用角色：reviewer, scout, worker/)
  expect(captured).toHaveLength(0)
})

test('成员异常终止（max-tokens）报错并附部分产出', async () => {
  const run: SubagentRun = {
    id: 'child-2' as unknown as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve<SubagentResult>({ stopReason: 'max-tokens', output: [{ type: 'text', text: '半截结论' }] } as SubagentResult),
    dispose: () => Promise.resolve(),
  } as unknown as SubagentRun
  const tool = createDelegateTool('team_delegate', depsWith(run, []))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/半截结论/)
})

test('dispose 失败不掩盖执行结果失败（AggregateError）', async () => {
  const run: SubagentRun = {
    id: 'child-3' as unknown as SubagentRun['id'],
    localAgent: undefined,
    result: Promise.resolve<SubagentResult>({ stopReason: 'error', output: [] } as SubagentResult),
    dispose: () => Promise.reject(new Error('dispose boom')),
  } as unknown as SubagentRun
  const tool = createDelegateTool('team_delegate', depsWith(run, []))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(AggregateError)
})

test('exec.agent 为空时报错', async () => {
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), []))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' }, { signal: new AbortController().signal }))
    .rejects.toThrowError(/exec\.agent/)
})

test('description 为静态委派语义，不含任何具体名册', () => {
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [])) as { description: string }
  expect(tool.description).not.toContain('reviewer')
  expect(tool.description).toMatch(/does NOT see this conversation/)
  expect(tool.description).toMatch(/self-contained/)
  expect(tool.description).toMatch(/system prompt/)
})

test('presentCall/presentResult 保持 generic 兜底；presentationMeta 投影 role/runId/childSessionId', () => {
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [])) as unknown as {
    presentCall: (args: Record<string, unknown>) => unknown
    presentResult: (args: Record<string, unknown>, result: { isError: boolean }) => unknown
    output: { presentationMeta: (args: unknown, value: Record<string, unknown>) => unknown }
  }
  expect(tool.presentCall({ role: 'reviewer', description: '审查登录模块', prompt: '请审查 src/auth/' }))
    .toEqual({ card: 'generic', title: '委派 · reviewer: 审查登录模块', rawInput: '请审查 src/auth/' })
  expect(tool.presentResult({ role: 'reviewer' }, { isError: false })).toEqual({ card: 'generic' })
  expect(tool.presentResult({ role: 'reviewer' }, { isError: true })).toBeUndefined()
  expect(tool.output.presentationMeta({}, {
    kind: 'foreground', role: 'reviewer', runId: 'r1', childSessionId: 'c1', output: [{ type: 'text', text: 'x' }],
  })).toEqual({ role: 'reviewer', runId: 'r1', childSessionId: 'c1' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test -- tool`
Expected: FAIL（`roster` deps 不存在 / 旧 `currentTeamFor` 签名不匹配）

- [ ] **Step 3: 重写 `src/tool.ts`**（在现状基础上改：deps 换名册、加 toolFilter 透传、结果加 childSessionId、output 加 presentationMeta）

完整新文件：

```ts
/** team_delegate 工具：查角色 → 一次性 spawn 前台委派 → 规范 JSON 返回。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { buildMemberPersona } from './prompt.ts'
import type { Role } from './roles.ts'

/** createDelegateTool 的外部依赖。 */
export interface DelegateToolDeps {
  /** 当前生效名册（激活期定值；闭包返回同一数组）。 */
  readonly roster: () => readonly Role[]
  /** ctx.subagents 的 provider 名（默认 'spawn'）。 */
  readonly provider: string
  /** 委派入口：生产为 ctx.subagents.start.bind(ctx.subagents)，测试注入假实现。 */
  readonly startRun: (provider: string, request: SubagentStartRequest) => Promise<SubagentRun>
}

/** 非 completed 的 stopReason 意味着成员未干净完成。 */
function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return '成员运行被取消'
    case 'error': return '成员运行失败'
    case 'max-tokens': return '成员在结束前触及 token 上限'
    case 'refusal': return '成员拒绝了该任务'
    default: return `成员运行异常结束（${String(result.stopReason)}）`
  }
}

/** 报错时附上成员已产出的部分文本，让截断/取消的真实产出仍回到主 Agent。 */
function withPartialText(error: string, output: ContentBlock[]): string {
  const text = output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\n成员中断前的部分产出：\n${text}`
}

/** 收集并释放一次前台运行；dispose 失败不掩盖独立的结果失败。 */
async function settleForegroundRun(run: SubagentRun, roleName: string) {
  // 本地 run 的 run.id 契约上即子 session id（dsh-subagent types.ts:249-255）。
  const childSessionId = String(run.id)
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withPartialText(error, result.output))
      return {
        kind: 'foreground' as const,
        role: roleName,
        runId: String(run.id),
        childSessionId,
        output: result.output as unknown as JsonValue[],
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError([execution.reason, disposal.reason],
        `成员运行失败：${String(execution.reason)}；dispose 失败：${String(disposal.reason)}`)
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/**
 * 创建 team_delegate 工具。
 * @param toolName - 模型可见工具名（Config.toolName，默认 team_delegate）。
 * @param deps - 名册、provider、模板与委派入口。
 * @returns defineTool 产物，交给 ctx.tools.register。
 *
 * 工具注册是 standing scope 的单次注册，description 无法内嵌名册；名册对模型的
 * 可见性走系统提示团队段（index.ts）。
 */
export function createDelegateTool(toolName: string, deps: DelegateToolDeps) {
  return defineTool({
    name: toolName,
    description:
      'Delegate a self-contained task to a team member (a separate agent with its own persona and '
      + 'optional model override). The member does NOT see this conversation — give it a complete, '
      + 'standalone prompt. Available members and their descriptions are listed in the team section '
      + 'of the system prompt. This call waits for the member and returns its result.',
    parameters: {
      role: { type: 'string', required: true, description: 'The member to delegate to. Must be one of the listed names.' },
      description: { type: 'string', required: true, description: 'A short (3-5 word) description of the delegated task, for display.' },
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the member. It does not share this conversation\'s context, so include everything it needs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          role: { type: 'string', required: true },
          runId: { type: 'string', required: true },
          childSessionId: { type: 'string', required: true },
          output: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{
        type: 'text' as const,
        text: (value.output as { type: string; text?: string }[])
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text).join(''),
      }],
      // 浏览器半委派卡经 tool/result 的持久化 meta 读子会话坐标（回放可重建）。
      presentationMeta: (_args, value) => ({
        role: value.role as string,
        runId: value.runId as string,
        childSessionId: value.childSessionId as string,
      }),
    },
    // 成员不改父会话；父方无写操作。与内置 subagent 工具同款。
    isConcurrencySafe: () => true,
    // generic 兜底（浏览器半缺席/回放旧事件时降级；generic title 在 Web 不渲染，
    // 供 headless 与日志使用）。
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `委派 · ${args.role}: ${args.description}`,
      rawInput: args.prompt,
    }),
    presentResult: (_args, result) => (result.isError ? undefined : { card: 'generic' as const }),
    async execute(args, exec) {
      const parent: Agent | undefined = exec.agent
      if (!parent) throw new Error('team_delegate 需要调用方 agent（exec.agent 为空）')
      const roster = deps.roster()
      const role = roster.find(r => r.name === args.role)
      if (!role) {
        throw new Error(`未知角色 "${args.role}"。可用角色：${roster.map(r => r.name).join(', ')}`)
      }
      const persona = buildMemberPersona(role)
      const request: SubagentStartRequest = {
        label: `role:${role.name}: ${args.description}`,
        prompt: [{ type: 'text', text: args.prompt } as ContentBlock],
        parent,
        persona,
        maxDepth: 1, // 禁止套娃：成员（深度 1）再委派时 childDepth 2 > 1，provider 响亮拒绝
        signal: exec.signal,
        ...role.provider !== undefined || role.model !== undefined
          ? { agentOptions: { ...role.provider !== undefined ? { provider: role.provider } : {}, ...role.model !== undefined ? { model: role.model } : {} } }
          : {},
        ...role.tools !== undefined
          ? { toolFilter: {
              ...role.tools.allow !== undefined ? { allow: [...role.tools.allow] } : {},
              ...role.tools.deny !== undefined ? { deny: [...role.tools.deny] } : {},
            } }
          : {},
      } as SubagentStartRequest
      const run = await deps.startRun(deps.provider, request)
      return settleForegroundRun(run, role.name)
    },
  })
}
```

- [ ] **Step 3.5: 重写 `src/prompt.ts`（删 C 段）与 `tests/prompt.test.ts`**

新 `src/prompt.ts` 全文：

```ts
/** 成员系统提示词：基础层（A 身份契约 / B 能力守则）+ 角色 persona。
 *  按模型区分提示词归 prompt-stack（其子 Agent 隔离后不作用于成员，spec §4.5）；
 *  角色的模型适配由角色 persona 针对所配模型自足撰写。 */
import type { Role } from './roles.ts'

/** A 段：身份与契约。 */
const SECTION_A = (roleName: string): string => `你是团队中的一名成员（角色：${roleName}），由主 Agent 委派任务。
- 你看不到主对话；任务书包含你完成工作所需的全部上下文。
- 你的最终输出会作为结果完整返回给主 Agent：直接给出结论与必要细节。
- 你不能再次委派他人；任务需要拆分时，自己按顺序完成。`

/** B 段：能力使用守则。 */
const SECTION_B = `能力使用守则：
- 你可以使用与主 Agent 相同的工具与 MCP 资源，但只在任务必需时调用。
- 动手修改代码前，先阅读项目根目录及涉及目录的 AGENTS.md，并遵循其中约定。
- 产生或修改文件后，运行相关检查（测试、类型检查）验证你的改动。`

/**
 * 拼装一名成员的完整系统提示词。
 * @param role - 角色定义（persona 层来源）。
 * @returns A+B+persona 以空行连接的完整提示词。
 */
export function buildMemberPersona(role: Role): string {
  return [SECTION_A(role.name), SECTION_B, role.persona].join('\n\n')
}
```

新 `tests/prompt.test.ts` 全文：

```ts
import { expect, test } from 'vitest'
import { buildMemberPersona } from '../src/prompt.ts'

const role = { name: 'explorer', description: '探索', persona: '你是探索员。' }

test('A 段含角色名与委派契约（看不到主对话/结果返回/不能再委派）', () => {
  const text = buildMemberPersona(role)
  expect(text).toContain('角色：explorer')
  expect(text).toContain('看不到主对话')
  expect(text).toContain('不能再次委派')
})

test('B 段含 AGENTS.md 与验证守则', () => {
  const text = buildMemberPersona(role)
  expect(text).toContain('AGENTS.md')
  expect(text).toContain('测试、类型检查')
})

test('拼接顺序 A → B → persona，空行分隔；无 C 段模型适配残留', () => {
  const text = buildMemberPersona(role)
  const idxA = text.indexOf('角色：explorer')
  const idxB = text.indexOf('能力使用守则')
  const idxP = text.indexOf('你是探索员。')
  expect(idxA).toBeGreaterThanOrEqual(0)
  expect(idxA).toBeLessThan(idxB)
  expect(idxB).toBeLessThan(idxP)
  expect(text).not.toContain('先结论') // 旧 chat 族模板已删除
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test -- tool && pnpm --filter agent-team test -- prompt`
Expected: PASS（tool 9 个用例 + prompt 3 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/agent-team/src/tool.ts packages/agent-team/src/prompt.ts packages/agent-team/tests/tool.test.ts packages/agent-team/tests/prompt.test.ts
git commit -m "refactor(agent-team): team_delegate 扁平名册 + toolFilter 透传 + childSessionId；prompt 删 C 段"
```

---

### Task 4: 插件激活重构（index.ts）—— 拆 KV/路由/TeamState，接名册管线

**Files:**
- Modify: `packages/agent-team/src/index.ts`（重写）
- Delete: `packages/agent-team/src/teams.ts`、`packages/agent-team/src/types.ts`、`packages/agent-team/tests/teams.test.ts`、`packages/agent-team/tests/fixtures/team-preset/`（如 Task 1 未删）
- Test: `packages/agent-team/tests/integration.test.ts`（重写）、`packages/agent-team/tests/smoke.test.ts`（按现状内容适配：命名导出形态断言不变，只更新 inject 断言）

**Interfaces:**
- Consumes: `resolveRoster`（Task 2）、`createDelegateTool`（Task 3）、`resolveDshHome`（`@deepseek-ai/dsh-home-paths`，link 依赖在 Task 6 加入 package.json——本任务先在 package.json devDependencies 加一行 `"@deepseek-ai/dsh-home-paths": "link:../../deepseek-harness/packages/util/home-paths"` 并跑 `pnpm install`，否则 import 解析不到）
- Produces: 新 `Config`（仅 `provider`/`toolName`/`clientOnly`/`promptTemplates`）；`inject = ['tools', 'subagents', 'systemPrompt']`

- [ ] **Step 1: 加依赖**

`packages/agent-team/package.json` devDependencies 增加：
```json
"@deepseek-ai/dsh-home-paths": "link:../../deepseek-harness/packages/util/home-paths",
```
Run: `pnpm install`（仓库根）

- [ ] **Step 2: 重写失败测试**（`tests/integration.test.ts` 全文替换）

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../src/index.ts'

interface RegisteredTool { name: string; description: string }
type Disposer = () => void | Promise<void>
type ProviderCaps = { outputSchema: boolean; depthLimit: boolean; toolFilter: boolean; persona: boolean }
const FULL_CAPS: ProviderCaps = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
type FakeCtxOptions = {
  providerCapabilities?: Partial<ProviderCaps>
  providerAbsent?: boolean
}

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-team-home-'))
  vi.stubEnv('DSH_HOME', home)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

function fakeCtx(opts: FakeCtxOptions = {}) {
  const tools: RegisteredTool[] = []
  const activeTools = new Map<string, RegisteredTool>()
  const sections: { name: string; order: number; text: unknown }[] = []
  const disposers: Disposer[] = []
  const listeners: { event: string; cb: (payload: unknown) => void }[] = []
  const errors: string[] = []
  const infos: string[] = []
  const ctx = {
    tools: {
      register: (tool: RegisteredTool) => {
        tools.push(tool)
        activeTools.set(tool.name, tool)
        const disposer: Disposer = () => { activeTools.delete(tool.name) }
        disposers.push(disposer)
        return disposer
      },
    },
    systemPrompt: {
      section: (s: { name: string; order: number; text: unknown }) => {
        sections.push(s)
        const disposer: Disposer = () => {
          const i = sections.indexOf(s)
          if (i >= 0) sections.splice(i, 1)
        }
        disposers.push(disposer)
        return disposer
      },
    },
    subagents: {
      start: async () => { throw new Error('integration test 不发起真实委派') },
      getProvider: (name: string) => {
        if (opts.providerAbsent === true) return undefined
        return { name, capabilities: { ...FULL_CAPS, ...opts.providerCapabilities }, inheritsParentContext: false }
      },
    },
    on: (event: string, cb: (payload: unknown) => void) => {
      listeners.push({ event, cb })
      return () => {}
    },
    effect: (fn: () => unknown) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer as Disposer)
    },
    logger: {
      info: (msg: string) => { infos.push(String(msg)) },
      warn: () => {},
      error: (msg: string) => { errors.push(String(msg)) },
    },
  }
  return {
    ctx: ctx as unknown as Context,
    tools, activeTools, sections, disposers, errors, infos,
    emit: (event: string, payload: unknown) => {
      for (const l of listeners) if (l.event === event) l.cb(payload)
    },
  }
}

async function loadMod(): Promise<typeof import('../src/index.ts')> {
  vi.resetModules()
  return import('../src/index.ts')
}

test('挂载：工具注册一次、提示段为静态文本且列出内置角色、无路由无 KV', async () => {
  const mod = await loadMod()
  const { ctx, tools, sections } = fakeCtx()
  await mod.apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(tools).toHaveLength(1)
  expect(sections).toHaveLength(1)
  const text = sections[0].text
  expect(typeof text).toBe('string')
  expect(text).toContain('explorer:')
  expect(text).toContain('general:')
  expect(sections[0].name).toBe('plugin:agent-team')
  expect(mod.inject).toEqual(['tools', 'subagents', 'systemPrompt'])
})

test('用户目录角色进入提示段；同名覆盖写激活日志', async () => {
  const rolesDir = join(home, 'agent-team', 'roles')
  await writeFile(join(rolesDir, 'reviewer.yml'), 'description: 代码审查\npersona: 你是审查员。\n', { recursive: true } as never).catch(async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(rolesDir, { recursive: true })
    await writeFile(join(rolesDir, 'reviewer.yml'), 'description: 代码审查\npersona: 你是审查员。\n')
  })
  const mod = await loadMod()
  const { ctx, sections, infos } = fakeCtx()
  await mod.apply(ctx, {} as Config)
  expect(sections[0].text).toContain('reviewer: 代码审查')
  // 同名覆盖日志
  await writeFile(join(rolesDir, 'explorer.yml'), 'description: 定制\npersona: 定制。\n')
  const mod2 = await loadMod()
  const second = fakeCtx()
  await mod2.apply(second.ctx, {} as Config)
  expect(second.sections[0].text).toContain('explorer: 定制')
  expect(second.infos.join('\n')).toContain('explorer')
})

test('clientOnly: true：无工具/提示段注册，不读名册', async () => {
  const mod = await loadMod()
  const { ctx, tools, sections } = fakeCtx()
  await mod.apply(ctx, { clientOnly: true } as Config)
  expect(tools).toHaveLength(0)
  expect(sections).toHaveLength(0)
})

test('用户目录含非法文件：激活期响亮失败', async () => {
  const rolesDir = join(home, 'agent-team', 'roles')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(rolesDir, { recursive: true })
  await writeFile(join(rolesDir, 'bad.yml'), 'description: [未闭合')
  const mod = await loadMod()
  const { ctx } = fakeCtx()
  await expect(mod.apply(ctx, {} as Config)).rejects.toThrowError(/bad\.yml/)
})

test('HMR 安全：卸载后工具/提示段摘除，fresh ctx 重挂载成功', async () => {
  const mod = await loadMod()
  const first = fakeCtx()
  await mod.apply(first.ctx, {} as Config)
  for (const dispose of first.disposers) await dispose()
  expect(first.activeTools.size).toBe(0)
  expect(first.sections).toHaveLength(0)
  const second = fakeCtx()
  await mod.apply(second.ctx, {} as Config)
  expect(second.tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(second.sections).toHaveLength(1)
})

test('provider 缺 persona/depthLimit 能力：激活响亮失败', async () => {
  const mod = await loadMod()
  await expect(mod.apply(fakeCtx({ providerCapabilities: { persona: false } }).ctx, {} as Config))
    .rejects.toThrowError(/persona/)
  await expect(mod.apply(fakeCtx({ providerCapabilities: { depthLimit: false } }).ctx, {} as Config))
    .rejects.toThrowError(/depthLimit/)
})

test('provider 尚未注册：工具延迟挂载，provider-added 后注册；缺能力则 logger.error 且可恢复', async () => {
  const mod = await loadMod()
  const { ctx, tools, errors, emit } = fakeCtx({ providerAbsent: true })
  await mod.apply(ctx, {} as Config)
  expect(tools).toHaveLength(0)
  emit('subagent/provider-added', { name: 'spawn', capabilities: { ...FULL_CAPS, persona: false }, inheritsParentContext: false })
  expect(tools).toHaveLength(0)
  expect(errors.join('\n')).toContain('persona')
  emit('subagent/provider-removed', 'spawn')
  emit('subagent/provider-added', { name: 'spawn', capabilities: FULL_CAPS, inheritsParentContext: false })
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
})
```

`tests/smoke.test.ts` 按现状保留命名导出断言，仅把 `inject` 期望值改为 `['tools', 'subagents', 'systemPrompt']`（先读现状文件再改）。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter agent-team test -- integration`
Expected: FAIL（index.ts 仍引用 teams.ts/types.ts/KV/路由）

- [ ] **Step 4: 重写 `src/index.ts`**

```ts
/** agent-team 插件：扁平角色名册（内置保底 + 用户目录覆盖），主 Agent 经 team_delegate 一次性委派。 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { resolveRoster } from './roster.ts'
import { createDelegateTool } from './tool.ts'

export const name = 'agent-team'

export const inject = ['tools', 'subagents', 'systemPrompt']

/** 团队名册段在 prompt 中的位置：紧随内置 subagent 段（116.5）之后。 */
const TEAM_SECTION_ORDER = 116.6

export interface Config {
  /** ctx.subagents provider 名（默认 'spawn'）。 */
  provider?: string
  /** 模型可见工具名（默认 'team_delegate'）。注意：浏览器半委派卡按 'team_delegate' key 注册，改名后卡片不生效（落 generic 兜底）。 */
  toolName?: string
  /** cordis.yml 全局挂载用：true 时 Node 半立即返回，仅让浏览器半 bundle 进 boot 清单。 */
  clientOnly?: boolean
}

export const Config: z<Config> = z.object({
  provider: z.string().default('spawn'),
  toolName: z.string().default('team_delegate'),
  clientOnly: z.boolean(),
})

/** 用户级角色目录：$DSH_HOME/agent-team/roles。 */
function userRolesDir(): string {
  return join(resolveDshHome(), 'agent-team', 'roles')
}

/**
 * 激活（standing scope）：解析名册（内置保底 ← 用户目录同名覆盖）→ 注册 team_delegate
 * 与静态名册提示段。名册激活期读一次；改 roles/*.yml 需重挂 preset/重启生效。
 * provider 能力守卫与生命周期镜像同内置 tool-subagent：persona/depthLimit 缺失响亮报错，
 * 工具随 provider 在场与否挂载/摘除。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.clientOnly === true) return
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'team_delegate'
  const roster = await resolveRoster(userRolesDir())
  if (roster.overridden.length > 0) {
    ctx.logger.info(`agent-team: 内置角色被用户级名册覆盖：${roster.overridden.join(', ')}`)
  }
  const rosterText = roster.roles.map(r => `${r.name}: ${r.description}`).join('\n')
  let disposeTool: (() => void) | undefined
  let providerFailed = false
  const mountTool = (p: SubagentProvider): void => {
    const missing: string[] = []
    if (!p.capabilities.persona) missing.push('persona')
    if (!p.capabilities.depthLimit) missing.push('depthLimit')
    if (missing.length > 0) {
      throw new Error(
        `agent-team: provider "${p.name}" 缺少 team_delegate 委派必需能力 ${missing.join('/')}（固定发送 persona 与 maxDepth:1）——请配置具备 persona 与 depthLimit 能力的 provider（如 spawn/fork）`,
      )
    }
    if (disposeTool === undefined) {
      disposeTool = ctx.tools.register(createDelegateTool(toolName, {
        roster: () => roster.roles,
        provider,
        startRun: (pr, request) => ctx.subagents.start(pr, request),
      }))
    }
  }
  ctx.on('subagent/provider-added', (p) => {
    if (p.name !== provider || providerFailed) return
    try {
      mountTool(p)
    } catch (error) {
      providerFailed = true
      ctx.logger.error(error instanceof Error ? error.message : String(error))
    }
  })
  ctx.on('subagent/provider-removed', (removed) => {
    if (removed !== provider) return
    providerFailed = false
    if (disposeTool !== undefined) {
      disposeTool()
      disposeTool = undefined
    }
  })
  const present = ctx.subagents.getProvider(provider)
  if (present !== undefined) {
    mountTool(present)
  } else {
    ctx.logger.info(`agent-team: subagent provider "${provider}" 尚未注册；team_delegate 将等它出现时挂载`)
  }
  ctx.systemPrompt.section({
    name: `plugin:${name}`,
    order: TEAM_SECTION_ORDER,
    text: `你有一组可委派的成员：用 ${toolName} 把自包含的子任务委派给合适的成员，成员结果会作为工具返回值回到本对话。\n可用成员：\n${rosterText}`,
  })
}

// buildMemberPersona 仅经 tool.ts 使用；此处再导出便于宿主/调试方直接复用。
export { buildMemberPersona } from './prompt.ts'
```

同时删除 `src/teams.ts`、`src/types.ts`、`tests/teams.test.ts`、`tests/fixtures/team-preset/`。

注：原 index.ts 的 `import type {} from '@deepseek-ai/dsh-host-webserver'`、storageDomain、sessions、agent-presets 相关 import 全部随重写移除。

- [ ] **Step 5: 跑测试与类型检查**

Run: `pnpm --filter agent-team test && pnpm --filter agent-team typecheck`
Expected: 全 PASS（roles/roster/tool/integration/smoke/prompt）

- [ ] **Step 6: Commit**

```bash
git add packages/agent-team
git commit -m "refactor(agent-team): 拆除团队层（TeamState/KV/路由），接入两层名册管线"
```

---

### Task 5: prompt-stack 子 Agent 隔离（配套改动，spec §4.5）

**Files:**
- Modify: `packages/prompt-stack/src/index.ts`
- Test: `packages/prompt-stack/tests/assemble.test.ts`（追加用例）

**Interfaces:**
- Consumes: 现状 prompt-stack `apply`/`Config`（不变）
- Produces: 语义变化——`AssembleContext.agent.session.header.origin === 'subagent'` 时**除 `model-notes` 外**的全部 prompt-stack 层渲染空串（被组装期丢弃）；`model-notes` 层不隔离，按子 Agent 生效模型照常命中规则；导出面不变

- [ ] **Step 1: 写失败测试**（`tests/assemble.test.ts` 的 describe 块内追加）

```ts
  test('子 Agent（origin=subagent）：人设/任务层渲染空串，model-notes 按子的模型照常命中', async () => {
    const ctx = await boot()
    const childContext = {
      agent: {
        options: { provider: 'deepseek', model: 'deepseek-v4' },
        session: { header: { origin: 'subagent' } },
      } as unknown as Agent,
    }
    const assembly = await ctx.systemPrompt.assemble(childContext)
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('')
    expect(texts['prompt-stack:task']).toBe('')          // 规则命中的覆盖层同样隔离
    expect(texts['prompt-stack:model-notes']).toBe('V4-NOTES') // 模型层共用：按子模型命中
    expect(renderPrompt(assembly)).not.toContain('BASE')
    expect(renderPrompt(assembly)).toContain('V4-NOTES')
  })

  test('非子 Agent（origin 缺省）：分层与规则照常生效', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble(agentContext({ provider: 'deepseek', model: 'deepseek-v4' }))
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:task']).toBe('V4-TASK')
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter prompt-stack test -- assemble`
Expected: FAIL（子 Agent 用例：base/task 仍渲染，隔离未生效）

- [ ] **Step 3: 修改 `src/index.ts`**——`apply` 内加隔离守卫，只套普通层（model-notes 不套）：

```ts
export function apply(ctx: Context, config: ConfigT): void {
  validateConfig(config)
  const notesOrder = Math.max(...config.layers.map(layer => layer.order)) + 1
  const hitRule = (context: AssembleContext): Rule | undefined =>
    selectRule(config.rules, context.agent?.options?.provider, context.agent?.options?.model)
  // 子 Agent 隔离：人设/领域/任务等普通层不泄漏进子 Agent 组装（spec §4.5）；
  // model-notes 是模型层（模型的通用使用说明），主子共用、按子的生效模型命中规则。
  const isSubagent = (context: AssembleContext): boolean =>
    context.agent?.session.header.origin === 'subagent'
  for (const layer of config.layers) {
    ctx.systemPrompt.section({
      name: `prompt-stack:${layer.name}`,
      order: layer.order,
      text: (context) =>
        isSubagent(context) ? '' : (hitRule(context)?.overrides?.[layer.name] ?? layer.text),
    })
  }
  ctx.systemPrompt.section({
    name: `prompt-stack:${MODEL_NOTES_LAYER}`,
    order: notesOrder,
    text: (context) => hitRule(context)?.append ?? '',
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter prompt-stack test && pnpm --filter prompt-stack typecheck`
Expected: 全 PASS（含既有用例无回归）

- [ ] **Step 5: Commit**

```bash
git add packages/prompt-stack/src/index.ts packages/prompt-stack/tests/assemble.test.ts
git commit -m "feat(prompt-stack): 子 Agent 隔离——普通层对 origin=subagent 渲染空串，model-notes 主子共用"
```

---

### Task 6: 浏览器半委派卡（client/ 重写）

**Files:**
- Delete: `packages/agent-team/src/client/TeamDock.tsx`、`packages/agent-team/src/client/TeamDock.module.css`、`packages/agent-team/tests/team-dock.client.spec.tsx`
- Create: `packages/agent-team/src/client/locales.ts`
- Create: `packages/agent-team/src/client/delegate-card.tsx`
- Create: `packages/agent-team/src/client/delegate-card.module.css`
- Modify: `packages/agent-team/src/client/index.ts`（重写）
- Test: `packages/agent-team/tests/delegate-card.client.spec.tsx`

**Interfaces:**
- Consumes: `ToolCallViewProps`（`@deepseek-ai/dsh-client-ui-tool/client`，type-only）；`SubagentAddress`/`ClientContext`（`@deepseek-ai/dsh-client-runtime/client`，type-only）；`PropsLocale`（`@deepseek-ai/dsh-client-ui-slots`，type-only）；`StateDot`、`MarkdownText`（`@deepseek-ai/dsh-client-ui-primitives`，值导入，在 CLIENT_EXTERNALS）
- Produces: 浏览器半 `apply(ctx: ClientContext)` + `inject = ['sessions', 'slots', 'locale']`；组件 `DelegateCard`（内部，不导出）；`DelegateCardInjected { openChild: (address: SubagentAddress) => void }`

- [ ] **Step 1: 写失败测试**（`tests/delegate-card.client.spec.tsx`）

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { DelegateCard } from '../src/client/delegate-card.tsx'

afterEach(cleanup)

const runningBlock = {
  callId: 'c1',
  name: 'team_delegate',
  argsRaw: JSON.stringify({ role: 'explorer', description: '定位登录入口', prompt: '请找出登录页组件' }),
  turn: 1, step: 1, time: 0, callView: null, subCalls: [],
} as unknown as ToolCallBlock

const settledBlock = {
  kind: 'tool-result',
  seq: 2, time: 1, callId: 'c1',
  call: { name: 'team_delegate', argsRaw: runningBlock.argsRaw },
  callTime: 0,
  content: [{ type: 'text', text: '登录页在 src/pages/login.tsx' }],
  isError: false,
  meta: { role: 'explorer', runId: 'child-1', childSessionId: 'child-1' },
  callView: null, resultView: null, subCalls: [],
} as unknown as ToolCallBlock

function renderCard(block: ToolCallBlock, openChild = () => {}) {
  return render(
    <DelegateCard
      callId="c1"
      toolName="team_delegate"
      block={block}
      openFile={() => {}}
      sessionId="parent-1"
      openChild={openChild}
      t={((key: string) => key) as never}
    />,
  )
}

test('运行中：角色 chip + 任务描述 + running 隐藏文本，无结果区', () => {
  renderCard(runningBlock)
  expect(screen.getByText('explorer')).toBeTruthy()
  expect(screen.getByText('定位登录入口')).toBeTruthy()
  expect(screen.queryByText('查看子对话')).toBeNull()
})

test('整行 toggle：点击展开后可见任务书全文', () => {
  renderCard(runningBlock)
  expect(screen.queryByText('请找出登录页组件')).toBeNull()
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  expect(screen.getByText('请找出登录页组件')).toBeTruthy()
})

test('完成后：结果文本渲染 + 「查看子对话」按钮回调 openChild 携带父子会话坐标', () => {
  const opened: unknown[] = []
  renderCard(settledBlock, (address) => opened.push(address))
  expect(screen.getByText('登录页在 src/pages/login.tsx')).toBeTruthy()
  fireEvent.click(screen.getByText('查看子对话'))
  expect(opened).toEqual([{ parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'one-shot' }])
})

test('失败态：meta 缺 childSessionId 时不显示跳转按钮，显示错误内容', () => {
  const failed = { ...settledBlock, isError: true, meta: undefined,
    content: [{ type: 'text', text: '成员运行被取消' }] } as unknown as ToolCallBlock
  renderCard(failed)
  expect(screen.getByText('成员运行被取消')).toBeTruthy()
  expect(screen.queryByText('查看子对话')).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test -- delegate-card`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 `src/client/locales.ts`**

```ts
/** agent-team 浏览器半文案：zh 为真源，en 键集严格一致。 */
export const NS = 'agent-team'

export const zh = {
  'card.viewChild': '查看子对话',
  'card.running': '成员执行中',
  'card.failed': '委派失败',
} as const

export type AgentTeamKey = keyof typeof zh

export const en: Record<AgentTeamKey, string> = {
  'card.viewChild': 'View sub-conversation',
  'card.running': 'Member running',
  'card.failed': 'Delegation failed',
}
```

- [ ] **Step 4: 实现 `src/client/delegate-card.tsx`**（bash-sample 姿态：只依赖 props + 自带 module.css）

```tsx
/** 委派卡：team_delegate 的 keyed tool.call.toolview 渲染器。 */
import type { SubagentAddress, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import clsx from 'clsx'
import { useState } from 'react'
import css from './delegate-card.module.css'
import type { NS } from './locales.ts'

/** 经 slots.register 的 inject 面注入的回调。 */
export interface DelegateCardInjected {
  readonly openChild: (address: SubagentAddress) => void
}

interface DelegateMeta {
  readonly childSessionId?: string
}

interface DelegateArgs {
  readonly role?: string
  readonly description?: string
  readonly prompt?: string
}

function argsOf(block: ToolCallBlock): DelegateArgs {
  const raw = 'kind' in block && block.kind === 'tool-result' ? block.call?.argsRaw : (block as { argsRaw?: string }).argsRaw
  if (typeof raw !== 'string') return {}
  try {
    return JSON.parse(raw) as DelegateArgs
  } catch {
    return {}
  }
}

function resultText(block: ToolCallBlock): string {
  if (!('kind' in block) || block.kind !== 'tool-result') return ''
  return block.content
    .filter((b): b is { type: 'text'; text: string } => (b as { type: string }).type === 'text')
    .map(b => b.text).join('')
}

export type DelegateCardProps = ToolCallViewProps & DelegateCardInjected & PropsLocale<typeof NS>

export function DelegateCard(props: DelegateCardProps) {
  const { block, sessionId, openChild, t } = props
  const settled = 'kind' in block && block.kind === 'tool-result'
  const isError = settled && block.isError
  const args = argsOf(block)
  const meta = settled ? (block.meta as DelegateMeta | undefined) : undefined
  const [expanded, setExpanded] = useState(false)
  const state = !settled ? 'ongoing' as const : isError ? 'error' as const : 'done' as const
  return (
    <div className={css.root} data-state={!settled ? 'running' : isError ? 'error' : 'ok'}>
      <div
        className={css.row}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v) } }}
      >
        <StateDot state={state} />
        {args.role !== undefined && <span className={css.chip}>{args.role}</span>}
        <span className={css.summary}>{args.description ?? ''}</span>
        <span className={css.visuallyHidden}>
          {!settled ? t('card.running') : isError ? t('card.failed') : ''}
        </span>
      </div>
      {expanded && (
        <div className={css.body}>
          {args.prompt !== undefined && <pre className={css.prompt}>{args.prompt}</pre>}
          {settled && resultText(block) !== '' && (
            <div className={css.result}><MarkdownText text={resultText(block)} /></div>
          )}
          {settled && !isError && meta?.childSessionId !== undefined && (
            <button
              type="button"
              className={css.childLink}
              onClick={(e) => {
                e.stopPropagation()
                openChild({ parentSessionId: sessionId, childSessionId: meta.childSessionId, mode: 'one-shot' })
              }}
            >
              {t('card.viewChild')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
```

注：若 `MarkdownText` 的 prop 名不是 `text`，以 `@deepseek-ai/dsh-client-ui-primitives` 实际导出为准微调（实现时读 `deepseek-harness/packages/client/ui-primitives/src/index.ts` 确认）；`sessionId` 为 session scope 槽位的框架注入 prop（ui-subagent 同款，`SubagentCatalogAction.tsx:414`）。

- [ ] **Step 5: 实现 `src/client/delegate-card.module.css`**（只用 alias token；24px 行、默认折叠、260px 内滚）

```css
/* 委派卡：几何照 ToolRow（24px 单行、整行 toggle、展开体内滚）。 */
.root { margin: 4px 0 4px 4px; }
.row {
  display: flex; align-items: center; gap: 6px;
  height: 24px; cursor: pointer; user-select: none;
}
.row:hover { background: var(--dsw-alias-interactive-bg-hover-solid); }
.chip {
  flex: none; padding: 0 6px; border-radius: 6px;
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-state-business-primary);
  border: 1px solid var(--dsw-alias-border-l2);
}
.summary {
  flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-tertiary);
}
.body {
  margin: 4px 0 4px 16px; max-height: 260px; overflow-y: auto;
  border-left: 1px solid var(--dsw-alias-border-l1); padding-left: 8px;
}
.prompt {
  margin: 0 0 6px; white-space: pre-wrap; word-break: break-word;
  font: var(--dsw-font-markdown-code-block-small);
  color: var(--dsw-alias-label-secondary);
}
.result { color: var(--dsw-alias-label-primary); }
.childLink {
  margin-top: 6px; padding: 2px 10px; border-radius: 999px; cursor: pointer;
  font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-state-business-primary);
  border: 1px solid var(--dsw-alias-border-l2); background: transparent;
}
.childLink:hover { background: var(--dsw-alias-interactive-bg-hover-solid); }
.visuallyHidden {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap;
}
.root[data-state='error'] .summary { color: var(--dsw-alias-state-error-primary); }
```

若某 token 名在宿主不存在，实现时以 `deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css` 实际变量名为准替换（禁止自造颜色字面值）。

- [ ] **Step 6: 重写 `src/client/index.ts`**

```ts
/** agent-team 浏览器半：注册 team_delegate 的 keyed 委派卡 + 文案词典。 */
import type { ClientContext, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { DelegateCard, type DelegateCardInjected } from './delegate-card.tsx'
import { en, NS, zh, type AgentTeamKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 委派卡文案。 */
    'agent-team': AgentTeamKey
  }
}

export const inject = ['sessions', 'slots', 'locale']

/**
 * 浏览器半入口。委派卡按固定 key 'team_delegate' 注册：Node 半 Config.toolName
 * 改名后卡片不生效（落 generic 兜底）。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-team: dictionaries')
  const sessions = ctx.sessions
  const injected: DelegateCardInjected = {
    openChild(address: SubagentAddress) {
      sessions.openSubagent(address)
    },
  }
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register(
      { name: 'tool.call.toolview', key: 'team_delegate', locale: NS, inject: injected },
      DelegateCard,
    ))
}
```

删除 `src/client/TeamDock.tsx`、`src/client/TeamDock.module.css`、`tests/team-dock.client.spec.tsx`。

- [ ] **Step 7: 跑测试确认通过 + bundle**

Run: `pnpm --filter agent-team test -- delegate-card`
Expected: PASS（4 个用例）
Run: `pnpm --filter agent-team bundle`
Expected: 产出 `lib/client.js` 无报错（纯净度门禁不拦截 type-only import；若拦 `@deepseek-ai/dsh-client-ui-tool`，把该包名加进 tsdown.config.ts 的 `INLINE_SAFE` 正则——类型导入正常会被擦除，拦说明误写了值导入，先检查）

- [ ] **Step 8: Commit**

```bash
git add packages/agent-team/src/client packages/agent-team/tests/delegate-card.client.spec.tsx
git commit -m "feat(agent-team): 浏览器半委派卡（角色 chip + 折叠 + 跳转只读子会话）"
```

---

### Task 7: 包配置、preset 薄壳化、文档同步与开发回路验证

**Files:**
- Modify: `packages/agent-team/package.json`（`dsh.client.inject` 改为 `["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-tool"]`；devDependencies 已无 ui-conversation 需求则移除该行——先 grep src 确认无残留 import 再删）
- Modify: `packages/agent-team/presets/team/preset.yml`（展示名改「Agent 团队」）
- Delete: `packages/agent-team/presets/team/teams/`（整目录；名册已入代码常量）
- Modify: `cordis.yml`（仓库根：agent-team 条目确认双挂载——preset 内真实挂载 + 全局 `clientOnly: true` 行；按现状核对，无需改则跳过）
- Modify: `AGENTS.md`（agent-team 条目更新为扁平角色形态）
- Verify: preset 裸包名解析（spec §8 验证项）

- [ ] **Step 1: 清理 package.json**

- `dsh.client.inject` 改为 `["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-tool"]`
- `rg "@deepseek-ai/dsh-client-ui-conversation" packages/agent-team/src` 无命中则从 devDependencies 删该行；有命中先改代码
- 确认 devDependencies 含 `@deepseek-ai/dsh-home-paths`（Task 4 已加）与 `@deepseek-ai/dsh-client-ui-tool`（缺则补 `"link:../../deepseek-harness/packages/client/ui-tool"`）
- Run: `pnpm install`

- [ ] **Step 2: preset 薄壳化**

- 删除 `packages/agent-team/presets/team/teams/` 整目录
- `preset.yml` 的 `name` 改为 `Agent 团队`（description 同步为扁平角色语义）
- `agent.cordis.yml` 改为**基础编码工具组合 + agent-team 挂载**（persona/agent-instructions 身份层、tool-bash/tool-pwsh 双 shell、tool-fs/tool-fs-search、末尾 `- name: agent-team` 裸包名），见文末「实施期修订」（2026-08-21 修正案：薄壳组合无基础工具 → tools.restrict() 响亮失败）

Run: `pnpm --filter agent-team test && pnpm --filter agent-team typecheck && pnpm --filter agent-team bundle`
Expected: 全绿

- [ ] **Step 3: 更新 AGENTS.md**

把 agent-team 相关段落更新为：扁平角色名册（内置 explorer/general + `$DSH_HOME/agent-team/roles/*.yml` 覆盖）、纯 Node 半委派 + 浏览器半委派卡、双挂载点约束不变、测试/构建命令不变。删除 teams/、dock、KV、`/agent-team` 路由、单团队约束（§9 duplicate route 随路由删除而消失）等过时描述。

- [ ] **Step 4: 裸包名解析验证（spec §8）**

- 把 `presets/team/agent.cordis.yml` 的挂载行临时改为 `- name: agent-team`，跑开发回路：
  `cd deepseek-harness && pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml`
- 若 preset 挂载成功（团队会话可用 team_delegate）：保留裸包名写法，并在 preset 注释里写明"依赖 profile node_modules 平铺 fallback 解析"
- 若解析失败：改回绝对路径，注释保留"部署方复制后需改路径"说明，并在 spec §8 标注验证结果

- [ ] **Step 5: 开发回路人工验证清单**

启动 `pnpm dsh web --patch …\cordis.yml` 后逐项确认：
1. 新建会话 preset 选择器出现「Agent 团队」
2. 选中后让主 Agent 委派 explorer 一个只读任务：委派卡显示角色 chip + 描述，运行中有 running 态
3. 完成后卡片展开可见结果，点「查看子对话」打开只读子会话
4. 会话头子 Agent 目录（宿主原生）也能看到该子会话
5. `$DSH_HOME/agent-team/roles/` 放一个自定义角色 yml，重挂后提示段出现新角色

- [ ] **Step 6: Commit**

```bash
git add packages/agent-team cordis.yml AGENTS.md
git commit -m "chore(agent-team): preset 薄壳化与仓库文档同步"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3 目标形态→Task 1-6 文件结构一致；§4 名册管线→Task 1/2；§4.5 prompt-stack 职责划分与子 Agent 隔离→Task 3（删 C 段）+ Task 5（隔离）；§5 调度工具→Task 3；§6 提示段→Task 4（静态文本，与 spec 修订一致）；§7 委派卡→Task 6；§8 preset/安装→Task 7（含裸包名验证项）；§9 错误处理→Task 1/2/3/4 测试用例；§10 测试策略→各任务测试文件；§11 AGENTS.md→Task 7 Step 3。
- **类型一致性**：`Role`/`RoleTools`（Task 1）→ roster/tool（Task 2/3）一致；`DelegateToolDeps.roster`（Task 3）→ index.ts 注入 `() => roster.roles`（Task 4）一致；`DelegateCardInjected.openChild`（Task 5 组件/入口/测试三处）一致；`childSessionId`（Task 3 结果+meta → Task 5 卡片读取）一致。
- **已知实现期微调点**（非占位符，均有既定求证路径）：`MarkdownText` 的 prop 名（查 ui-primitives 导出）、CSS token 名（查 design-platform.css）、smoke.test.ts 现状内容（先读后改）。

---

## 实施期修订（2026-08-21 修正案）

**背景**：dev loop 发现 Task 7 薄壳 preset（`agent.cordis.yml` 仅挂 agent-team 一行）下，团队会话没有任何 shell/fs 工具——基础编码工具并非环境常驻，standard preset 也是逐行挂载。内置 explorer 角色配了 `deny: [write, edit]`，名单里的未知名（组合内根本没注册 write/edit）在委派时经宿主 `tools.restrict()` **响亮失败**，委派完全不可用。

**修正案（人类已批准）**：team preset 的组合扩展为「基础编码工具组合（persona/instructions/shell/fs/fs-search，与 standard 同源）+ agent-team 挂载」：

- `agent.cordis.yml` 按 standard 结构逐行挂载：`dsh-persona`（同款文案）→ `dsh-agent-instructions`（maxBytes 65536）→ `dsh-tool-bash`（win32 禁用）→ `dsh-tool-pwsh`（非 win32 禁用）→ `dsh-tool-fs`（read/write/edit）→ `dsh-tool-fs-search`（glob/grep）→ 末尾 `- name: agent-team` 裸包名（**已验证可行**：preset 行经 profile 的 node_modules 平铺 fallback 解析，2026-08-21 dev loop）。
- 不加 jobs/goal/plan/compaction/web/skill 行，保持组合最小。
- 成员经 composeFrom 继承父会话工具层，角色 `tools` 过滤名单必须命中组合内已注册工具名（否则 restrict 响亮失败）——设计 spec §8、AGENTS.md 已同步该约束。
- 门禁复核：`pnpm --filter agent-team test && pnpm --filter agent-team typecheck && pnpm --filter agent-team bundle` 全绿（不触代码，仅确认无回归）。
