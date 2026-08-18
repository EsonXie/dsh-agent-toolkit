# Agent 团队插件（agent-team）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `packages/agent-team` 插件：团队 = preset 目录（含 roles.yml），主 Agent 通过 `team_delegate` 工具把自包含任务前台同步委派给一次性 spawn 子 Agent。

**Architecture:** 设计 spec 见 `docs/superpowers/specs/2026-08-18-agent-team-design.md`（已确认并提交，commit 11a6944）。插件激活时从 preset 目录读 roles.yml → 注册 team_delegate 工具（名册编入 description）+ systemPrompt 团队介绍段；执行时按角色拼装两层提示词（三段基础层 + persona 层）并 `ctx.subagents.start(provider, …)` 前台等待结果。

**Tech Stack:** TypeScript ESM（strict）、cordis 插件、Schemastery（Config 与 roles.yml 校验）、js-yaml（解析 roles.yml）、vitest（单测）、`link:` 依赖指向 `deepseek-harness/` 内包源码（照 token-usage 先例）。

## Global Constraints

- 命名导出 `name` / `inject` / `Config` / `apply`，**无 default export**（dsh 插件协议）。
- ESM：`"type": "module"`；本地相对导入带 `.ts` 扩展名。
- `strict: true` + `noImplicitAny`；不留裸 `any`。
- 可调参数一律进 Config，不硬编码（仓库约定）。
- 成员**禁止套娃**：委派请求固定携带 `maxDepth: 1`（源码已钉死：`resolveChildDepth` = 父深度+1，`childDepth > maxDepth` 抛 `SubagentDepthError`，见 `deepseek-harness/packages/subagent/subagent/src/child-agent.ts:48-57`）。
- 前台收集/异常语义照抄内置 `tool-subagent`（`deepseek-harness/packages/subagent/tool-subagent/src/index.ts:124-199`）。
- cordis 支持异步 `apply`：fiber 在 `await this._execute(...)` 后才 ACTIVE，apply 抛错 → fiber FAILED → preset 挂载被拒（`vendor/cordis/src/fiber.ts:646-673`）。
- 提交信息风格照 git log：`feat(agent-team): …` / `test(agent-team): …` / `docs: …`。
- 每个 Task 结束跑 `pnpm --filter agent-team test` 与 `pnpm --filter agent-team typecheck`，全绿再 commit。

---

### Task 1: 包骨架

**Files:**
- Create: `packages/agent-team/package.json`
- Create: `packages/agent-team/tsconfig.json`
- Create: `packages/agent-team/src/index.ts`
- Test: `packages/agent-team/tests/smoke.test.ts`

**Interfaces:**
- Produces: `name = 'agent-team'`（后续 smoke 测试与 smoke 断言依赖）；`pnpm --filter agent-team test|typecheck` 命令可用。

- [ ] **Step 1: 写 smoke 测试（先失败）**

```ts
// packages/agent-team/tests/smoke.test.ts
import { expect, test } from 'vitest'
import { name } from '../src/index.ts'

test('插件导出名', () => {
  expect(name).toBe('agent-team')
})
```

- [ ] **Step 2: 创建 package.json / tsconfig.json / src/index.ts**

```json
// packages/agent-team/package.json
{
  "name": "agent-team",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./package.json": "./package.json"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "link:../../deepseek-harness/vendor/cordis",
    "@deepseek-ai/dsh-agent": "link:../../deepseek-harness/packages/core/agent",
    "@deepseek-ai/dsh-llm": "link:../../deepseek-harness/packages/llm/llm",
    "@deepseek-ai/dsh-session": "link:../../deepseek-harness/packages/core/session",
    "@deepseek-ai/dsh-subagent": "link:../../deepseek-harness/packages/subagent/subagent",
    "@deepseek-ai/dsh-system-prompt": "link:../../deepseek-harness/packages/core/system-prompt",
    "@deepseek-ai/dsh-tools": "link:../../deepseek-harness/packages/core/tools",
    "@deepseek-ai/schemastery": "link:../../deepseek-harness/vendor/schemastery",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.20.1",
    "typescript": "^6.0.3",
    "vitest": "^3.0.0"
  }
}
```

```json
// packages/agent-team/tsconfig.json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "noImplicitAny": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

```ts
// packages/agent-team/src/index.ts（本 Task 先只放 name，后续 Task 5 补全）
/** agent-team 插件：团队 = preset，主 Agent 经 team_delegate 一次性委派角色成员。 */
export const name = 'agent-team'
```

- [ ] **Step 3: 安装依赖并验证测试由失败转绿**

Run: `pnpm install; pnpm --filter agent-team test`
Expected: PASS（smoke 1 个测试通过）

- [ ] **Step 4: 类型检查**

Run: `pnpm --filter agent-team typecheck`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add packages/agent-team
git commit -m "feat(agent-team): 包骨架"
```

---

### Task 2: roles.yml 加载与校验（src/roles.ts）

**Files:**
- Create: `packages/agent-team/src/roles.ts`
- Test: `packages/agent-team/tests/roles.test.ts`

**Interfaces:**
- Produces:
  - `interface Role { readonly name: string; readonly description: string; readonly persona: string; readonly provider?: string; readonly model?: string }`
  - `parseRolesYaml(text: string, source: string): Role[]` — 解析+校验，非法时 throw（message 含 source 与原因）
  - `loadRoles(path: string): Promise<Role[]>` — 读文件后调 parseRolesYaml；文件不可读时 throw（message 含 path）
- Consumes: 无（叶子模块）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent-team/tests/roles.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { loadRoles, parseRolesYaml } from '../src/roles.ts'

const VALID = `
roles:
  - name: reviewer
    description: 代码审查员
    persona: 你是资深代码审查员。
    provider: deepseek
    model: deepseek-reasoner
  - name: researcher
    description: 资料调研
    persona: 你是调研分析员。
`

test('解析合法名册', () => {
  const roles = parseRolesYaml(VALID, 'test.yml')
  expect(roles).toHaveLength(2)
  expect(roles[0]).toMatchObject({ name: 'reviewer', provider: 'deepseek', model: 'deepseek-reasoner' })
  expect(roles[1].provider).toBeUndefined()
  expect(roles[1].model).toBeUndefined()
})

test('缺 persona 报错并指出角色名', () => {
  const bad = `roles:\n  - name: reviewer\n    description: x\n`
  expect(() => parseRolesYaml(bad, 'r.yml')).toThrowError(/persona/)
})

test('重名角色报错', () => {
  const bad = `roles:\n  - { name: a, description: x, persona: p }\n  - { name: a, description: y, persona: q }\n`
  expect(() => parseRolesYaml(bad, 'r.yml')).toThrowError(/重复/)
})

test('非法 name 字符报错', () => {
  const bad = `roles:\n  - { name: "坏 名", description: x, persona: p }\n`
  expect(() => parseRolesYaml(bad, 'r.yml')).toThrowError(/name/)
})

test('顶层缺 roles 键报错', () => {
  expect(() => parseRolesYaml(`foo: 1`, 'r.yml')).toThrowError(/roles/)
})

test('非法 YAML 报错含来源', () => {
  expect(() => parseRolesYaml(`roles: [unclosed`, 'bad/roles.yml')).toThrowError(/bad\/roles\.yml/)
})

describe('loadRoles', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'agent-team-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  test('读取并解析文件', async () => {
    const path = join(dir, 'roles.yml')
    await writeFile(path, VALID)
    const roles = await loadRoles(path)
    expect(roles.map(r => r.name)).toEqual(['reviewer', 'researcher'])
  })

  test('文件不存在时报错含路径', async () => {
    const path = join(dir, 'nope.yml')
    await expect(loadRoles(path)).rejects.toThrowError(/nope\.yml/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test`
Expected: FAIL（`Cannot find module '../src/roles.ts'`）

- [ ] **Step 3: 实现 src/roles.ts**

```ts
/** roles.yml 的加载与校验：团队角色名册的唯一解析入口。 */
import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import z from '@deepseek-ai/schemastery'

/** 一名团队成员（角色）。 */
export interface Role {
  /** 标识符：字母数字 + -_；模型调用 team_delegate 时的 role 参数值。 */
  readonly name: string
  /** 一句话职责，编入工具 description，是主 Agent 选角的唯一依据。 */
  readonly description: string
  /** 角色层系统提示词（拼在插件基础层之后）。 */
  readonly persona: string
  /** 可选：覆盖模型供应商，缺省继承主 Agent。 */
  readonly provider?: string
  /** 可选：覆盖模型，缺省继承主 Agent。 */
  readonly model?: string
}

const RoleSchema = z.object({
  name: z.string().required(),
  description: z.string().required(),
  persona: z.string().required(),
  provider: z.string(),
  model: z.string(),
})

const RolesFileSchema = z.object({
  roles: z.array(RoleSchema).required(),
})

const NAME_RE = /^[A-Za-z0-9_-]+$/

/**
 * 解析并校验 roles.yml 文本。
 * @param text - 文件内容。
 * @param source - 用于错误信息的来源名（通常是文件路径）。
 * @returns 校验通过的角色列表。
 * @throws YAML 语法错误、结构非法、name 非法、角色重名。
 */
export function parseRolesYaml(text: string, source: string): Role[] {
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch (error) {
    throw new Error(`agent-team: 角色文件 ${source} 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)
  }
  let roles: Role[]
  try {
    roles = RolesFileSchema(parsed) as Role[]
  } catch (error) {
    throw new Error(`agent-team: 角色文件 ${source} 校验失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const seen = new Set<string>()
  for (const role of roles) {
    if (!NAME_RE.test(role.name)) {
      throw new Error(`agent-team: 角色文件 ${source} 中 name "${role.name}" 非法：只允许字母、数字、-、_`)
    }
    if (seen.has(role.name)) {
      throw new Error(`agent-team: 角色文件 ${source} 中角色 "${role.name}" 重复定义`)
    }
    seen.add(role.name)
  }
  return roles
}

/**
 * 从磁盘读取 roles.yml 并解析。
 * @param path - roles.yml 的绝对路径。
 * @returns 校验通过的角色列表。
 * @throws 文件不存在/不可读，或内容非法（含路径）。
 */
export async function loadRoles(path: string): Promise<Role[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`agent-team: 角色文件不可读：${path}（${error instanceof Error ? error.message : String(error)}）`)
  }
  return parseRolesYaml(text, path)
}
```

> 注：schemastery 的 schema  callable 形式 `RolesFileSchema(parsed)` 与内置用法一致（`z<Config>` 调用签名）；若类型不通过，改用 `RolesFileSchema.parse? …` 前先对照 `vendor/schemastery/src/index.ts` 的调用约定修正（token-usage 的 `Config` 也是同名用法）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test`
Expected: PASS（roles 8 个测试）

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm --filter agent-team typecheck`

```bash
git add packages/agent-team/src/roles.ts packages/agent-team/tests/roles.test.ts
git commit -m "feat(agent-team): roles.yml 加载与校验"
```

---

### Task 3: 两层提示词拼装（src/prompt.ts）

**Files:**
- Create: `packages/agent-team/src/prompt.ts`
- Test: `packages/agent-team/tests/prompt.test.ts`

**Interfaces:**
- Consumes: `Role`（`./roles.ts`）。
- Produces:
  - `interface PromptTemplates { default?: string; families?: Record<string, string> }`（Config 覆盖入口的解析后形态；字段可选，缺省用内置）
  - `buildMemberPersona(role: Role, model: string | undefined, templates?: PromptTemplates): string` — 返回 A+B+C+persona 四段以 `\n\n` 连接
  - `MODEL_FAMILY_RULES: readonly (readonly [RegExp, string])[]`（模型名→族，供测试与未来扩展）

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent-team/tests/prompt.test.ts
import { expect, test } from 'vitest'
import { buildMemberPersona } from '../src/prompt.ts'
import type { Role } from '../src/roles.ts'

const role: Role = { name: 'reviewer', description: '代码审查员', persona: '你是资深代码审查员。' }

test('拼装含基础层三段与 persona 层，persona 在最后', () => {
  const text = buildMemberPersona(role, 'deepseek-chat')
  expect(text).toContain('角色：reviewer')        // A 段含角色名
  expect(text).toContain('不能再次委派')          // A 段契约
  expect(text).toContain('AGENTS.md')             // B 段能力守则
  const personaIndex = text.lastIndexOf('你是资深代码审查员。')
  expect(personaIndex).toBeGreaterThan(-1)
  expect(text.slice(personaIndex)).toBe('你是资深代码审查员。')
})

test('reasoning 族模型用 reasoning 模板', () => {
  const text = buildMemberPersona(role, 'deepseek-reasoner')
  expect(text).toContain('推理能力')
})

test('chat 族模型用 chat 模板', () => {
  expect(buildMemberPersona(role, 'deepseek-chat')).toContain('先结论，后依据')
})

test('未知模型与 undefined 都用 default 模板', () => {
  expect(buildMemberPersona(role, 'gpt-5')).toContain('自包含')
  expect(buildMemberPersona(role, undefined)).toContain('自包含')
})

test('Config 模板覆盖：families 优先，其次 default', () => {
  const custom = buildMemberPersona(role, 'deepseek-reasoner', {
    families: { reasoning: '自定义推理模板' },
  })
  expect(custom).toContain('自定义推理模板')
  const customDefault = buildMemberPersona(role, 'gpt-5', { default: '自定义兜底' })
  expect(customDefault).toContain('自定义兜底')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test`
Expected: FAIL（`Cannot find module '../src/prompt.ts'`）

- [ ] **Step 3: 实现 src/prompt.ts**

```ts
/** 成员系统提示词：基础层（A 身份契约 / B 能力守则 / C 模型适配）+ persona 层。 */
import type { Role } from './roles.ts'

/** Config 的模型适配模板覆盖入口（缺省字段用内置文本）。 */
export interface PromptTemplates {
  /** C 段兜底模板（无族匹配时）。 */
  readonly default?: string
  /** 按族名覆盖 C 段模板，如 { reasoning: '…' }。 */
  readonly families?: Record<string, string>
}

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

/** C 段内置模板：按模型族。 */
const BUILTIN_FAMILY_TEMPLATES: Record<string, string> = {
  reasoning: '你使用的模型具备推理能力；直接给出高质量结论，无需外化逐步推理过程。',
  chat: '请在输出中保持结构清晰：先结论，后依据；涉及多处修改时分节列出。',
}

/** C 段内置兜底模板。 */
const BUILTIN_DEFAULT_TEMPLATE = '请确保输出自包含：主 Agent 只看到你的最终文本。'

/** 模型名 → 族，按序首个命中生效。 */
export const MODEL_FAMILY_RULES = [
  [/reason/i, 'reasoning'],
  [/chat/i, 'chat'],
] as const

/**
 * 解析模型的族名。
 * @param model - 实际生效的模型名（可能为 undefined）。
 * @returns 族名，未命中返回 undefined。
 */
function modelFamily(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  for (const [pattern, family] of MODEL_FAMILY_RULES) {
    if (pattern.test(model)) return family
  }
  return undefined
}

/**
 * 拼装一名成员的完整系统提示词。
 * @param role - 角色定义（persona 层来源）。
 * @param model - 本次委派实际生效的模型（角色配置或继承主 Agent）。
 * @param templates - Config 的 C 段覆盖。
 * @returns A+B+C+persona 以空行连接的完整提示词。
 */
export function buildMemberPersona(role: Role, model: string | undefined, templates?: PromptTemplates): string {
  const family = modelFamily(model)
  const sectionC = (family !== undefined && templates?.families?.[family])
    ?? (family !== undefined ? BUILTIN_FAMILY_TEMPLATES[family] : undefined)
    ?? templates?.default
    ?? BUILTIN_DEFAULT_TEMPLATE
  return [SECTION_A(role.name), SECTION_B, sectionC, role.persona].join('\n\n')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test`
Expected: PASS（prompt 5 个测试）

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm --filter agent-team typecheck`

```bash
git add packages/agent-team/src/prompt.ts packages/agent-team/tests/prompt.test.ts
git commit -m "feat(agent-team): 成员提示词两层三段拼装"
```

---

### Task 4: team_delegate 工具（src/tool.ts）

**Files:**
- Create: `packages/agent-team/src/tool.ts`
- Test: `packages/agent-team/tests/tool.test.ts`

**Interfaces:**
- Consumes: `Role`（`./roles.ts`）；`buildMemberPersona` / `PromptTemplates`（`./prompt.ts`）。
- Produces:
  - `interface DelegateToolDeps { roles: readonly Role[]; provider: string; templates?: PromptTemplates; startRun: (provider: string, request: SubagentStartRequest) => Promise<SubagentRun> }`
  - `createDelegateTool(toolName: string, deps: DelegateToolDeps): Tool`（`defineTool` 产物，`ctx.tools.register` 直接消费）
  - 工具返回值类型：`{ kind: 'foreground'; role: string; runId: string; output: JsonValue[] }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent-team/tests/tool.test.ts
import { expect, test } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { createDelegateTool, type DelegateToolDeps } from '../src/tool.ts'
import type { Role } from '../src/roles.ts'

const roles: Role[] = [
  { name: 'reviewer', description: '代码审查员', persona: '你是审查员。', provider: 'deepseek', model: 'deepseek-reasoner' },
  { name: 'researcher', description: '资料调研', persona: '你是调研员。' },
]

const parent = { id: 'parent-1', options: { provider: 'deepseek', model: 'deepseek-chat' } } as unknown as Agent

function okRun(output: ContentBlock[], disposeError?: Error): SubagentRun {
  return {
    id: 'run-1',
    result: Promise.resolve<SubagentResult>({ stopReason: 'completed', output } as SubagentResult),
    dispose: () => disposeError ? Promise.reject(disposeError) : Promise.resolve(),
  } as unknown as SubagentRun
}

interface Captured { provider: string; request: SubagentStartRequest }

function depsWith(run: SubagentRun, captured: Captured[]): DelegateToolDeps {
  return {
    roles,
    provider: 'spawn',
    startRun: async (provider, request) => { captured.push({ provider, request }); return run },
  }
}

const exec = { agent: parent, signal: new AbortController().signal }

async function callTool(tool: unknown, args: Record<string, unknown>, execArg: unknown = exec) {
  const execute = (tool as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute
  return execute(args, execArg)
}

test('成功委派：请求字段正确，返回规范 JSON，run 被 dispose', async () => {
  const captured: Captured[] = []
  let disposed = false
  const run = okRun([{ type: 'text', text: '结论' } as ContentBlock])
  const origDispose = run.dispose
  run.dispose = async () => { disposed = true; return origDispose() }
  const tool = createDelegateTool('team_delegate', depsWith(run, captured))
  const result = await callTool(tool, { role: 'reviewer', description: '审查登录模块', prompt: '请审查 src/auth/' })
  expect(result).toMatchObject({ kind: 'foreground', role: 'reviewer', runId: 'run-1' })
  expect(captured).toHaveLength(1)
  const { provider, request } = captured[0]
  expect(provider).toBe('spawn')
  expect(request.label).toBe('role:reviewer: 审查登录模块')
  expect(request.maxDepth).toBe(1)
  expect(request.persona).toContain('你是审查员。')
  expect(request.persona).toContain('不能再次委派')
  expect(request.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  expect(request.parent).toBe(parent)
  expect(request.signal).toBe(exec.signal)
  expect(disposed).toBe(true)
})

test('角色未配 provider/model 时不传 agentOptions，persona 按主 Agent 模型选模板', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await callTool(tool, { role: 'researcher', description: '调研', prompt: '任务' })
  expect(captured[0].request.agentOptions).toBeUndefined()
  expect(captured[0].request.persona).toContain('先结论，后依据') // parent model deepseek-chat → chat 族
})

test('未知角色报错并列出可用角色，且不发起委派', async () => {
  const captured: Captured[] = []
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), captured))
  await expect(callTool(tool, { role: 'nobody', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/未知角色 "nobody"。可用角色：reviewer, researcher/)
  expect(captured).toHaveLength(0)
})

test('成员异常终止（max-tokens）报错并附部分产出', async () => {
  const run: SubagentRun = {
    id: 'run-2',
    result: Promise.resolve<SubagentResult>({ stopReason: 'max-tokens', output: [{ type: 'text', text: '半截结论' }] } as SubagentResult),
    dispose: () => Promise.resolve(),
  } as unknown as SubagentRun
  const tool = createDelegateTool('team_delegate', depsWith(run, []))
  await expect(callTool(tool, { role: 'reviewer', description: 'x', prompt: 'y' }))
    .rejects.toThrowError(/半截结论/)
})

test('dispose 失败不掩盖执行结果失败（AggregateError）', async () => {
  const run: SubagentRun = {
    id: 'run-3',
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

test('工具 description 编入名册', () => {
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [])) as { description: string }
  expect(tool.description).toContain('reviewer: 代码审查员')
  expect(tool.description).toContain('researcher: 资料调研')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test`
Expected: FAIL（`Cannot find module '../src/tool.ts'`）

- [ ] **Step 3: 实现 src/tool.ts**（前台收集语义照抄内置 tool-subagent:124-199）

```ts
/** team_delegate 工具：查角色 → 一次性 spawn 前台委派 → 规范 JSON 返回。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { buildMemberPersona, type PromptTemplates } from './prompt.ts'
import type { Role } from './roles.ts'

/** createDelegateTool 的外部依赖。 */
export interface DelegateToolDeps {
  /** 当前团队名册（插件激活时一次性读入）。 */
  readonly roles: readonly Role[]
  /** ctx.subagents 的 provider 名（默认 'spawn'）。 */
  readonly provider: string
  /** C 段模板覆盖（Config.promptTemplates）。 */
  readonly templates?: PromptTemplates
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
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const error = stopReasonError(result)
      if (error !== undefined) throw new Error(withPartialText(error, result.output))
      return {
        kind: 'foreground' as const,
        role: roleName,
        runId: run.id,
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
 */
export function createDelegateTool(toolName: string, deps: DelegateToolDeps) {
  const roster = deps.roles.map(r => `- ${r.name}: ${r.description}`).join('\n')
  return defineTool({
    name: toolName,
    description:
      'Delegate a self-contained task to a team member (a separate agent with its own persona and optional '
      + 'model override). The member does NOT see this conversation — give it a complete, standalone prompt. '
      + 'This call waits for the member and returns its result. Available members:\n' + roster,
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
          output: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{
        type: 'text' as const,
        text: (value.output as { type: string; text?: string }[])
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text).join(''),
      }],
    },
    // 成员不改父会话；父方无写操作。与内置 subagent 工具同款。
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent: Agent | undefined = exec.agent
      if (!parent) throw new Error('team_delegate 需要调用方 agent（exec.agent 为空）')
      const role = deps.roles.find(r => r.name === args.role)
      if (!role) {
        throw new Error(`未知角色 "${args.role}"。可用角色：${deps.roles.map(r => r.name).join(', ')}`)
      }
      const model = role.model ?? parent.options.model
      const persona = buildMemberPersona(role, model, deps.templates)
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
      } as SubagentStartRequest
      const run = await deps.startRun(deps.provider, request)
      return settleForegroundRun(run, role.name)
    },
  })
}
```

> 注：`SubagentStartRequest`/`SubagentResult`/`SubagentRun` 的确切字段以 `@deepseek-ai/dsh-subagent` 的 `src/types.ts` 为准；若类型报错（如 `signal` 在 Omit 列表、`output` 类型差异），按源码字段名微调，不得改变测试断言的行为语义。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test`
Expected: PASS（tool 7 个测试）

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm --filter agent-team typecheck`

```bash
git add packages/agent-team/src/tool.ts packages/agent-team/tests/tool.test.ts
git commit -m "feat(agent-team): team_delegate 委派工具"
```

---

### Task 5: 插件入口组装（src/index.ts）+ 集成测试

**Files:**
- Modify: `packages/agent-team/src/index.ts`（Task 1 的占位改为完整入口）
- Create: `packages/agent-team/tests/fixtures/team/roles.yml`
- Test: `packages/agent-team/tests/integration.test.ts`

**Interfaces:**
- Consumes: `loadRoles`（`./roles.ts`）；`createDelegateTool` / `PromptTemplates`（`./tool.ts`、`./prompt.ts`）。
- Produces:
  - `name = 'agent-team'`、`inject = ['tools', 'subagents', 'systemPrompt']`
  - `Config`：`{ rolesFile?: string（默认 './roles.yml'）; provider?: string（默认 'spawn'）; toolName?: string（默认 'team_delegate'）; promptTemplates?: { default?: string; families?: Record<string,string> } }`
  - `apply(ctx, config): Promise<void>`（异步；roles.yml 读不到即抛错 → preset 挂载被拒）

- [ ] **Step 1: 写 fixture 与失败测试**

```yaml
# packages/agent-team/tests/fixtures/team/roles.yml
roles:
  - name: reviewer
    description: 代码审查员
    persona: 你是资深代码审查员。
  - name: researcher
    description: 资料调研与分析
    persona: 你是调研分析员。
```

```ts
// packages/agent-team/tests/integration.test.ts
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index.ts'

const FIXTURE_DIR = join(__dirname, 'fixtures', 'team')

interface RegisteredTool { name: string; description: string }
interface RegisteredSection { name: string; order: number; text: unknown }

function fakeCtx(baseUrl?: string) {
  const tools: RegisteredTool[] = []
  const sections: RegisteredSection[] = []
  const ctx = {
    baseUrl,
    tools: { register: (tool: RegisteredTool) => { tools.push(tool); return () => {} } },
    systemPrompt: { section: (section: RegisteredSection) => { sections.push(section); return () => {} } },
    subagents: { start: async () => { throw new Error('integration test 不发起真实委派') } },
    logger: { info: () => {}, warn: () => {} },
  }
  return { ctx: ctx as unknown as Context, tools, sections }
}

test('激活后注册 team_delegate，description 含名册，并注册团队介绍段', async () => {
  const { ctx, tools, sections } = fakeCtx(pathToFileURL(FIXTURE_DIR + '/').href)
  await apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(tools[0].description).toContain('reviewer: 代码审查员')
  expect(tools[0].description).toContain('researcher: 资料调研与分析')
  expect(sections).toHaveLength(1)
  expect(String(sections[0].text)).toContain('team_delegate')
})

test('rolesFile 指向缺失文件时激活失败', async () => {
  const { ctx } = fakeCtx(pathToFileURL(FIXTURE_DIR + '/').href)
  await expect(apply(ctx, { rolesFile: './missing.yml' } as Config)).rejects.toThrowError(/missing\.yml/)
})

test('toolName/provider 可配置', async () => {
  const { ctx, tools } = fakeCtx(pathToFileURL(FIXTURE_DIR + '/').href)
  await apply(ctx, { toolName: 'dispatch' } as Config)
  expect(tools[0].name).toBe('dispatch')
})
```

> 注：`__dirname` 在 ESM 下不存在，测试文件顶部用 `import.meta.dirname`（Node ≥22 支持）替换。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test`
Expected: FAIL（apply/Config 未导出）

- [ ] **Step 3: 实现完整 src/index.ts**

```ts
/** agent-team 插件：团队 = preset，主 Agent 经 team_delegate 一次性委派角色成员。 */
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { buildMemberPersona } from './prompt.ts'
import { loadRoles } from './roles.ts'
import { createDelegateTool } from './tool.ts'

export const name = 'agent-team'

export const inject = ['tools', 'subagents', 'systemPrompt']

/** 团队介绍段在 prompt 中的位置：紧随内置 subagent 段（116.5）之后。 */
const TEAM_SECTION_ORDER = 116.6

export interface Config {
  /** roles.yml 路径，相对 preset 目录（默认 './roles.yml'）。 */
  rolesFile?: string
  /** ctx.subagents provider 名（默认 'spawn'）。 */
  provider?: string
  /** 模型可见工具名（默认 'team_delegate'）。 */
  toolName?: string
  /** C 段模型适配模板覆盖。 */
  promptTemplates?: {
    default?: string
    families?: Record<string, string>
  }
}

export const Config: z<Config> = z.object({
  rolesFile: z.string().default('./roles.yml'),
  provider: z.string().default('spawn'),
  toolName: z.string().default('team_delegate'),
  promptTemplates: z.object({
    default: z.string(),
    families: z.dict(z.string()),
  }),
})

/** 把 rolesFile 解析为绝对路径：绝对路径原样，相对路径基于 preset 目录（ctx.baseUrl）。 */
function resolveRolesPath(rolesFile: string, baseUrl: string | undefined): string {
  if (isAbsolute(rolesFile)) return rolesFile
  if (baseUrl === undefined) {
    throw new Error('agent-team: 无法解析相对 rolesFile——ctx.baseUrl 为空（插件应由 preset 挂载）')
  }
  return fileURLToPath(new URL(rolesFile, baseUrl))
}

/**
 * 激活：读名册 → 注册委派工具与团队介绍段。
 * 直接 apply() 绕过 Schemastery 默认值，这里手动补默认（内置 tool-subagent 同款防御）。
 * roles.yml 缺失/非法时抛错：fiber FAILED，preset 挂载被拒，新建会话立即报错。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const rolesFile = config.rolesFile ?? './roles.yml'
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'team_delegate'
  const roles = await loadRoles(resolveRolesPath(rolesFile, ctx.baseUrl))
  ctx.tools.register(createDelegateTool(toolName, {
    roles,
    provider,
    templates: config.promptTemplates,
    startRun: (p, request) => ctx.subagents.start(p, request),
  }))
  ctx.systemPrompt.section({
    name: `plugin:${name}`,
    order: TEAM_SECTION_ORDER,
    text: `你有一个团队可用：用 ${toolName} 把自包含的子任务委派给合适的成员，成员结果会作为工具返回值回到本对话。`,
  })
}

// buildMemberPersona 仅经 tool.ts 使用；此处再导出便于宿主/调试方直接复用。
export { buildMemberPersona }
```

> 注：`ctx.baseUrl` 的类型若不是 `string | undefined`（cordis Context 上由 loader 设置），以 vendor/cordis 类型为准微调；preset 挂载会把 baseUrl 重写到 preset 目录（`agent-presets/src/mount.ts:48`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test`
Expected: PASS（全部测试）

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm --filter agent-team typecheck`

```bash
git add packages/agent-team/src packages/agent-team/tests
git commit -m "feat(agent-team): 插件入口组装（读名册/注册工具与提示段）"
```

---

### Task 6: 示例团队 preset + 开发回路接入

**Files:**
- Create: `packages/agent-team/presets/team/agent.cordis.yml`
- Create: `packages/agent-team/presets/team/preset.yml`
- Create: `packages/agent-team/presets/team/roles.yml`

**Interfaces:**
- Consumes: Task 5 的插件入口（preset 行 name 指向包绝对路径）。
- Produces: Web UI 新建会话出现"团队模式" chip；选它开会话即可用 team_delegate。

- [ ] **Step 1: 创建 preset 三文件**

```yaml
# packages/agent-team/presets/team/agent.cordis.yml
# 团队模式组合：挂载 agent-team 插件。
# 注意：name 为绝对路径——preset 行的裸包名相对 harness 解析，本地包必须给绝对路径；
# 部署方 copy 本 preset 后需把路径改为自己机器上的包位置。
- name: D:/work/github/dsh/dsh-agent-toolkit/packages/agent-team
  # config 全省略 → rolesFile 默认 ./roles.yml（相对本 preset 目录）
```

```yaml
# packages/agent-team/presets/team/preset.yml
name: 团队模式
description: 主 Agent + 可委派的成员团队（角色定义见本目录 roles.yml）
order: 10
```

```yaml
# packages/agent-team/presets/team/roles.yml
roles:
  - name: reviewer
    description: 代码审查员，按严重度分级输出问题
    persona: |
      你是资深代码审查员。关注正确性、边界条件、并发安全与可读性。
      输出按严重度分级：blocker / major / minor，每条给出文件与理由。
  - name: researcher
    description: 资料调研与分析，输出带来源的结论
    persona: |
      你是调研分析员。围绕任务收集资料、交叉验证，输出结论清单并标注来源。
```

- [ ] **Step 2: 把示例团队放进用户 preset root**

背景（源码已确认）：`agent-presets` 服务自动把 `$DSH_HOME/.agent-presets/` 追加为 user root（`packages/preset/agent-presets/src/index.ts:134`），发现非缓存、立即可见。CLI 的 profile-boot 末尾会用 overlay 把 config.roots 重置为 shipped-only（`apps/cli/src/profile-boot.ts:159-167`），所以**开发回路走 user root，不走 patch 加 roots**。

Run（PowerShell，在仓库根）:
```powershell
$home_dir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
New-Item -ItemType Directory -Force (Join-Path $home_dir '.agent-presets') | Out-Null
Copy-Item -Recurse -Force packages/agent-team/presets/team (Join-Path $home_dir '.agent-presets/team')
```
Expected: `$home_dir/.agent-presets/team/` 下出现三文件。若 `$DSH_HOME` 实际布局不同（以 `dshHomePath` 实现为准），先跑 `pnpm --filter agent-team test` 无关——启动 dsh 后在 UI 设置里确认 user preset 目录位置再复制。

- [ ] **Step 3: 手动验证清单（开发回路）**

Run: `cd deepseek-harness; pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml`

逐项确认：
- [ ] 新建会话 hero 区出现"团队模式" chip
- [ ] 选"团队模式"开会话，会话头显示团队名标签
- [ ] 对话中让主 Agent "请 reviewer 审查一下当前目录的某个文件" → 主 Agent 调用 team_delegate，成员以 deepseek 默认模型（roles.yml 未配 provider/model）执行，结果回到主对话
- [ ] 修改 `$DSH_HOME/.agent-presets/team/roles.yml`（如加一个角色）→ **新建**会话后工具 description 含新角色（旧会话不变，generation 语义）
- [ ] 把 roles.yml 改坏（删 persona）→ 新建"团队模式"会话立即报错（挂载被拒）

- [ ] **Step 4: Commit**

```bash
git add packages/agent-team/presets
git commit -m "feat(agent-team): 示例团队 preset（团队模式）"
```

---

### Task 7: 仓库文档同步

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: 前 6 个 Task 的产物。
- Produces: AGENTS.md 反映 agent-team 的存在与开发方式。

- [ ] **Step 1: 更新 AGENTS.md**

- 目录结构节：`packages/agent-team/` 条目标注"已建成"，补 `presets/team/` 说明
- 开发命令节：加 `pnpm --filter agent-team test` / `typecheck`
- "dsh 插件开发要点"或目录结构附近补一句：agent-team 经 user preset root（`$DSH_HOME/.agent-presets/team`）接入开发回路，不走 cordis.yml patch（CLI overlay 会重置 roots）

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md 记录 agent-team 插件与团队模式接入方式"
```

---

## Self-Review 记录

- **spec 覆盖**：spec §2 包结构 → Task 1/5/6；§3 Config → Task 5；§4 roles.yml → Task 2；§5 两层提示词 → Task 3；§6 工具契约 → Task 4；§7 错误处理 → Task 2/4/5 测试逐条对应；§8 发行 → Task 6（开发回路采用 user root，patch-roots 路径因 CLI overlay 重置而弃用，已在 Task 6 注明）；§9 测试策略 → Task 2/4/5 单测 + 集成测试（结构化 fake ctx 直接调 apply，替代 heavyweight REAL-composition——与 token-usage 的务实先例一致，E2E 真实委派走 Task 6 手动清单）；§10 范围之外 → 计划中无对应任务。
- **类型一致性**：`Role`/`PromptTemplates`/`DelegateToolDeps`/`buildMemberPersona(role, model, templates)`/`createDelegateTool(toolName, deps)` 在 Task 2-5 间签名一致。
- **已知实现期核实点**（非占位符，均有确切位置）：①`SubagentStartRequest` 字段微调（tool.ts 注）；②`ctx.baseUrl` 类型（index.ts 注）；③`$DSH_HOME` 实际布局（Task 6 Step 2）。
