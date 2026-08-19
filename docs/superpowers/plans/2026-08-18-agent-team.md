# Agent 团队插件（agent-team）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `packages/agent-team` 插件：preset 作为"团队模式"入口（内含 `teams/*.yml` 多名册），用户在输入框上方 dock 下拉于会话 blank 期选择团队（首条消息后锁定），主 Agent 通过 `team_delegate` 工具把自包含任务前台同步委派给一次性 spawn 子 Agent。

**Architecture:** 设计 spec 见 `docs/superpowers/specs/2026-08-18-agent-team-design.md`（2026-08-19 修订版）。Node 半：激活时读 teams/ 全部名册 → 注册 team_delegate（名册编入 description）+ systemPrompt 段 + `/team` 命令 + `team` 会话投影；切换时 dispose 旧工具注册并以新名册重注册。浏览器半：`conversation.input.dock` 注册 TeamDock 下拉（order -10），读投影回显、`session.command('/team <id>')` 提交。

**Tech Stack:** TypeScript ESM（strict）、cordis 插件、Schemastery（Config 与名册校验）、zod（会话投影 schema，token-usage 先例）、js-yaml、vitest、React 18 + tsdown + lightningcss（浏览器半 bundle，照 token-usage 先例）、`link:` 依赖指向 `deepseek-harness/` 内包源码。

## Global Constraints

- 命名导出 `name` / `inject` / `Config` / `apply`，**无 default export**（dsh 插件协议）；浏览器半入口为 `./client` export + `dsh.client` manifest。
- ESM：`"type": "module"`；本地相对导入带 `.ts` 扩展名（组件 `.tsx`）。
- `strict: true` + `noImplicitAny`；不留裸 `any`。
- 可调参数一律进 Config，不硬编码（仓库约定）。
- 成员**禁止套娃**：委派请求固定携带 `maxDepth: 1`（`resolveChildDepth` = 父深度+1，`childDepth > maxDepth` 抛 `SubagentDepthError`，见 `deepseek-harness/packages/subagent/subagent/src/child-agent.ts:48-57`）。
- 前台收集/异常语义照抄内置 `tool-subagent`（`deepseek-harness/packages/subagent/tool-subagent/src/index.ts:124-199`）。
- cordis 支持异步 `apply`：fiber 在 `await this._execute(...)` 后才 ACTIVE，apply 抛错 → fiber FAILED → preset 挂载被拒（`vendor/cordis/src/fiber.ts:646-673`）。
- **团队锁定**：会话存在 `turn/start` 事件即不可切换（`sessionBlank` 定义照抄 `api-proxy.ts:476-478`）；UI 层禁用 + 宿主命令层拒绝，双层。
- 浏览器半守 client 规范：组件纯 props（四 shares）、无订阅机器、CSS Modules + `--dsw-*` token、中文文案。
- 提交信息风格照 git log：`feat(agent-team): …` / `test(agent-team): …` / `docs: …`。
- 每个 Task 结束跑 `pnpm --filter agent-team test` 与 `pnpm --filter agent-team typecheck`，全绿再 commit。

---

### Task 1: 包骨架（含浏览器半 bundle 基建）

**Files:**
- Create: `packages/agent-team/package.json`
- Create: `packages/agent-team/tsconfig.json`
- Create: `packages/agent-team/tsdown.config.ts`
- Create: `packages/agent-team/vitest.config.ts`
- Create: `packages/agent-team/src/index.ts`
- Create: `packages/agent-team/src/client/index.ts`
- Test: `packages/agent-team/tests/smoke.test.ts`

**Interfaces:**
- Produces: `name = 'agent-team'`（Node 半与 smoke 断言依赖）；`pnpm --filter agent-team test|typecheck|bundle` 命令可用；`lib/client.js` 可构建。

- [ ] **Step 1: 写 smoke 测试（先失败）**

```ts
// packages/agent-team/tests/smoke.test.ts
import { expect, test } from 'vitest'
import { name } from '../src/index.ts'

test('插件导出名', () => {
  expect(name).toBe('agent-team')
})
```

- [ ] **Step 2: 创建 package.json / tsconfig.json / tsdown.config.ts / vitest.config.ts / src 双入口**

```json
// packages/agent-team/package.json
{
  "name": "agent-team",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-conversation"
      ]
    }
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "bundle": "tsdown",
    "watch": "tsdown --watch"
  },
  "dependencies": {
    "clsx": "^2.0.0",
    "js-yaml": "^4.1.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "link:../../deepseek-harness/vendor/cordis",
    "@deepseek-ai/dsh-agent": "link:../../deepseek-harness/packages/core/agent",
    "@deepseek-ai/dsh-client-runtime": "link:../../deepseek-harness/packages/client/runtime",
    "@deepseek-ai/dsh-client-ui-conversation": "link:../../deepseek-harness/packages/client/ui-conversation",
    "@deepseek-ai/dsh-client-ui-primitives": "link:../../deepseek-harness/packages/client/ui-primitives",
    "@deepseek-ai/dsh-client-ui-slots": "link:../../deepseek-harness/packages/client/ui-slots",
    "@deepseek-ai/dsh-commands": "link:../../deepseek-harness/packages/interaction/commands",
    "@deepseek-ai/dsh-llm": "link:../../deepseek-harness/packages/llm/llm",
    "@deepseek-ai/dsh-session": "link:../../deepseek-harness/packages/core/session",
    "@deepseek-ai/dsh-session-projection": "link:../../deepseek-harness/packages/session/session-projection",
    "@deepseek-ai/dsh-subagent": "link:../../deepseek-harness/packages/subagent/subagent",
    "@deepseek-ai/dsh-system-prompt": "link:../../deepseek-harness/packages/core/system-prompt",
    "@deepseek-ai/dsh-tools": "link:../../deepseek-harness/packages/core/tools",
    "@deepseek-ai/schemastery": "link:../../deepseek-harness/vendor/schemastery",
    "@testing-library/react": "^16.1.0",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.20.1",
    "@types/react": "~18.3.1",
    "@types/react-dom": "~18.3.0",
    "jsdom": "^26.1.0",
    "lightningcss": "^1.30.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "tsdown": "^0.22.2",
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
    "jsx": "react-jsx",
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`tsdown.config.ts` 与 `vitest.config.ts` **整体复制** `packages/token-usage/` 同名文件，仅把 `tsdown.config.ts` 中的 `const ID = 'token-usage'` 改为 `'agent-team'`（其余：CLIENT_EXTERNALS 清单、CSS Modules 内联插件、lazy-CJS banner/footer 全部照抄）。

```ts
// packages/agent-team/src/index.ts（本 Task 先只放 name，Task 6 补全）
/** agent-team 插件：团队 = preset 内 teams/ 名册，主 Agent 经 team_delegate 一次性委派角色成员。 */
export const name = 'agent-team'
```

```ts
// packages/agent-team/src/client/index.ts（本 Task 先放空 apply，Task 7 补全）
/** agent-team 浏览器半：占位桩，Task 7 起注册 dock UI。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

export const inject = ['slots']

export function apply(_ctx: ClientContext): void {}
```

- [ ] **Step 3: 安装依赖并验证测试由失败转绿**

Run: `pnpm install; pnpm --filter agent-team test`
Expected: PASS（smoke 1 个测试通过）

- [ ] **Step 4: 类型检查 + bundle 冒烟**

Run: `pnpm --filter agent-team typecheck; pnpm --filter agent-team bundle`
Expected: 无错误；`packages/agent-team/lib/client.js` 生成

- [ ] **Step 5: Commit**

```bash
git add packages/agent-team
git commit -m "feat(agent-team): 包骨架（Node 半 + 浏览器半 bundle 基建）"
```

---

### Task 2: teams/ 名册加载与校验（src/roles.ts）

**Files:**
- Create: `packages/agent-team/src/roles.ts`
- Test: `packages/agent-team/tests/roles.test.ts`

**Interfaces:**
- Produces:
  - `interface Role { readonly name: string; readonly description: string; readonly persona: string; readonly provider?: string; readonly model?: string }`
  - `interface Team { readonly id: string; readonly roles: Role[] }`
  - `parseRolesYaml(text: string, source: string): Role[]` — 解析+校验单个名册文本，非法时 throw（message 含 source 与原因）
  - `loadTeams(dir: string): Promise<Team[]>` — 读目录下全部 `*.yml`（按文件名字典序），逐个解析；目录不可读/无 yml/团队 id 非法/大小写归一重名时 throw（message 含路径或文件名）
- Consumes: 无（叶子模块）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent-team/tests/roles.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadTeams, parseRolesYaml } from '../src/roles.ts'

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

describe('loadTeams', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'agent-team-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  test('读取目录全部 yml，按文件名字典序返回，id 为文件名去后缀', async () => {
    await writeFile(join(dir, 'beta.yml'), VALID)
    await writeFile(join(dir, 'alpha.yml'), VALID)
    await writeFile(join(dir, 'notes.txt'), 'ignored')
    const teams = await loadTeams(dir)
    expect(teams.map(t => t.id)).toEqual(['alpha', 'beta'])
    expect(teams[0].roles.map(r => r.name)).toEqual(['reviewer', 'researcher'])
  })

  test('目录不存在时报错含路径', async () => {
    await expect(loadTeams(join(dir, 'nope'))).rejects.toThrowError(/nope/)
  })

  test('目录内无 yml 文件时报错', async () => {
    await writeFile(join(dir, 'readme.md'), 'x')
    await expect(loadTeams(dir)).rejects.toThrowError(/没有.*\.yml|名册/)
  })

  test('团队 id 非法字符报错含文件名', async () => {
    await writeFile(join(dir, '坏 名.yml'), VALID)
    await expect(loadTeams(dir)).rejects.toThrowError(/坏 名\.yml/)
  })

  test('团队 id 大小写归一重名报错', async () => {
    await writeFile(join(dir, 'Dev.yml'), VALID)
    await writeFile(join(dir, 'dev.yml'), VALID)
    await expect(loadTeams(dir)).rejects.toThrowError(/重复/)
  })

  test('任一名册内容非法时报错含该文件路径', async () => {
    await writeFile(join(dir, 'ok.yml'), VALID)
    await writeFile(join(dir, 'bad.yml'), `roles:\n  - name: x\n    description: y\n`)
    await expect(loadTeams(dir)).rejects.toThrowError(/bad\.yml/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test`
Expected: FAIL（`Cannot find module '../src/roles.ts'`）

- [ ] **Step 3: 实现 src/roles.ts**

```ts
/** teams/*.yml 的加载与校验：团队名册的唯一解析入口。 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
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

/** 一个团队：teams/<id>.yml 解析产物。 */
export interface Team {
  /** 团队 id = 文件名去 .yml 后缀。 */
  readonly id: string
  readonly roles: Role[]
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
 * 解析并校验单个名册文本。
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
 * 读取 teams 目录下全部 .yml 名册。
 * @param dir - teams 目录的绝对路径。
 * @returns 按文件名字典序的团队列表。
 * @throws 目录不可读、无 .yml、团队 id 非法、大小写归一重名、任一文件内容非法。
 */
export async function loadTeams(dir: string): Promise<Team[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    throw new Error(`agent-team: 团队目录不可读：${dir}（${error instanceof Error ? error.message : String(error)}）`)
  }
  const files = entries.filter(f => f.endsWith('.yml')).sort()
  if (files.length === 0) {
    throw new Error(`agent-team: 团队目录中没有 .yml 名册：${dir}`)
  }
  const seen = new Set<string>()
  const teams: Team[] = []
  for (const file of files) {
    const id = file.slice(0, -'.yml'.length)
    if (!NAME_RE.test(id)) {
      throw new Error(`agent-team: 团队文件名非法：${file}（id 只允许字母、数字、-、_）`)
    }
    const key = id.toLowerCase()
    if (seen.has(key)) {
      throw new Error(`agent-team: 团队 id 重复（大小写归一后）：${id}`)
    }
    seen.add(key)
    const path = join(dir, file)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      throw new Error(`agent-team: 角色文件不可读：${path}（${error instanceof Error ? error.message : String(error)}）`)
    }
    teams.push({ id, roles: parseRolesYaml(text, path) })
  }
  return teams
}
```

> 注：schemastery 的 schema callable 形式 `RolesFileSchema(parsed)` 与内置用法一致；若类型不通过，对照 `vendor/schemastery/src/index.ts` 的调用约定修正（token-usage 的 `Config` 也是同名用法）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test`
Expected: PASS（roles 12 个测试）

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm --filter agent-team typecheck`

```bash
git add packages/agent-team/src/roles.ts packages/agent-team/tests/roles.test.ts
git commit -m "feat(agent-team): teams/ 多名册加载与校验"
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
  - host 端 UI presenter：`presentCall(args) → GenericCallView`、`presentResult(args, { isError }) → GenericResultView | undefined`（spec §7.3；host 在 tool/call、tool/result 时调用，回放安全纯函数）

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

test('presentCall 生成「委派 · role: 短标签」卡片，rawInput 为任务书', () => {
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [])) as {
    presentCall: (args: Record<string, unknown>) => unknown
  }
  expect(tool.presentCall({ role: 'reviewer', description: '审查登录模块', prompt: '请审查 src/auth/' }))
    .toEqual({ card: 'generic', title: '委派 · reviewer: 审查登录模块', rawInput: '请审查 src/auth/' })
})

test('presentResult 成功保留 generic 卡，isError 返回 undefined 走默认错误卡', () => {
  const tool = createDelegateTool('team_delegate', depsWith(okRun([]), [])) as {
    presentResult: (args: Record<string, unknown>, result: { isError: boolean }) => unknown
  }
  const args = { role: 'reviewer', description: 'x', prompt: 'y' }
  expect(tool.presentResult(args, { isError: false })).toEqual({ card: 'generic' })
  expect(tool.presentResult(args, { isError: true })).toBeUndefined()
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
  /** 当前团队名册。 */
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
    // UI 卡片（spec §7.3）：host 端纯函数，回放安全；成功保留待定态标题，失败回退默认错误卡。
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `委派 · ${args.role}: ${args.description}`,
      rawInput: args.prompt,
    }),
    presentResult: (_args, result) => (result.isError ? undefined : { card: 'generic' as const }),
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

> 注：`SubagentStartRequest`/`SubagentResult`/`SubagentRun` 的确切字段以 `@deepseek-ai/dsh-subagent` 的 `src/types.ts` 为准；若类型报错（如 `signal` 在 Omit 列表、`output` 类型差异），按源码字段名微调，不得改变测试断言的行为语义。presenter 的视图类型以 `@deepseek-ai/dsh-tools` 的 `src/presentation.ts` 为准（`GenericCallView`/`GenericResultView`，字段 `card`/`title`/`rawInput`；内置样板见 `packages/workflow/tool-workflow/src/index.ts:164-177`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test`
Expected: PASS（tool 9 个测试）

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm --filter agent-team typecheck`

```bash
git add packages/agent-team/src/tool.ts packages/agent-team/tests/tool.test.ts
git commit -m "feat(agent-team): team_delegate 委派工具（含 UI presenter）"
```

---

### Task 5: 团队状态机（src/teams.ts + src/types.ts）

**Files:**
- Create: `packages/agent-team/src/types.ts`（纯类型，投影/事件契约的单一来源）
- Create: `packages/agent-team/src/teams.ts`
- Test: `packages/agent-team/tests/teams.test.ts`

**Interfaces:**
- Consumes: `Team`（`./roles.ts`）。
- Produces:
  - `TEAM_SELECTED_EVENT = 'team/selected'`
  - `interface TeamOption { readonly id: string; readonly summary: string }`、`interface TeamProjection { readonly currentId: string; readonly options: readonly TeamOption[] }`（src/types.ts；会话投影视图与浏览器半共用）
  - `foldSelectedTeam(events: readonly SessionEvent[]): string | undefined` — 冷恢复：取最新 `team/selected` 事件的 team
  - `isSessionBlank(events: readonly SessionEvent[]): boolean` — 无 `turn/start` 事件
  - `teamOption(team: Team): TeamOption` — summary 取首角色 description，无角色回退 id
  - `createTeamState(options: { teams: readonly Team[]; defaultTeamId?: string; initialId?: string }): TeamState`
  - `interface TeamState { readonly current: Team; readonly teams: readonly Team[]; trySelect(id: string, events: readonly SessionEvent[]): SelectOutcome }`
  - `type SelectOutcome = { ok: true; changed: boolean } | { ok: false; error: string }`

- [ ] **Step 1: 写失败测试**

```ts
// packages/agent-team/tests/teams.test.ts
import { expect, test } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createTeamState, foldSelectedTeam, isSessionBlank, teamOption } from '../src/teams.ts'
import { TEAM_SELECTED_EVENT } from '../src/types.ts'
import type { Team } from '../src/roles.ts'

const teams: Team[] = [
  { id: 'alpha', roles: [{ name: 'reviewer', description: '代码审查员', persona: 'p' }] },
  { id: 'beta', roles: [{ name: 'researcher', description: '资料调研', persona: 'q' }] },
]

const ev = (type: string, data: unknown = {}) => ({ type, data }) as SessionEvent

test('foldSelectedTeam 取最新 team/selected，无事件返回 undefined', () => {
  expect(foldSelectedTeam([])).toBeUndefined()
  expect(foldSelectedTeam([ev('user/message'), ev(TEAM_SELECTED_EVENT, { team: 'alpha' })])).toBe('alpha')
  expect(foldSelectedTeam([
    ev(TEAM_SELECTED_EVENT, { team: 'alpha' }),
    ev(TEAM_SELECTED_EVENT, { team: 'beta' }),
  ])).toBe('beta')
})

test('isSessionBlank：无 turn/start 为 true，有则为 false', () => {
  expect(isSessionBlank([])).toBe(true)
  expect(isSessionBlank([ev('agent-preset/selected')])).toBe(true)
  expect(isSessionBlank([ev('turn/start')])).toBe(false)
})

test('teamOption 摘要取首角色 description', () => {
  expect(teamOption(teams[0])).toEqual({ id: 'alpha', summary: '代码审查员' })
  expect(teamOption({ id: 'empty', roles: [] })).toEqual({ id: 'empty', summary: 'empty' })
})

test('默认团队：initialId 优先，其次 defaultTeamId，再次字典序首个', () => {
  expect(createTeamState({ teams }).current.id).toBe('alpha')
  expect(createTeamState({ teams, defaultTeamId: 'beta' }).current.id).toBe('beta')
  expect(createTeamState({ teams, defaultTeamId: 'beta', initialId: 'alpha' }).current.id).toBe('alpha')
  // initialId/defaultTeamId 未命中名册时回退首个（激活期已对 defaultTeam 单独响亮失败，此处是防御）
  expect(createTeamState({ teams, defaultTeamId: 'ghost', initialId: 'ghost' }).current.id).toBe('alpha')
})

test('trySelect 成功：切换并报告 changed', () => {
  const state = createTeamState({ teams })
  expect(state.trySelect('beta', [])).toEqual({ ok: true, changed: true })
  expect(state.current.id).toBe('beta')
  expect(state.trySelect('beta', [])).toEqual({ ok: true, changed: false })
})

test('trySelect 未知团队：报错列出可用团队，状态不变', () => {
  const state = createTeamState({ teams })
  const outcome = state.trySelect('ghost', [])
  expect(outcome).toMatchObject({ ok: false })
  expect((outcome as { error: string }).error).toContain('alpha, beta')
  expect(state.current.id).toBe('alpha')
})

test('trySelect 会话已开始：拒绝锁定，状态不变', () => {
  const state = createTeamState({ teams })
  const outcome = state.trySelect('beta', [ev('turn/start')])
  expect(outcome).toMatchObject({ ok: false })
  expect((outcome as { error: string }).error).toContain('锁定')
  expect(state.current.id).toBe('alpha')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test`
Expected: FAIL（`Cannot find module '../src/teams.ts'`）

- [ ] **Step 3: 实现 src/types.ts 与 src/teams.ts**

```ts
// packages/agent-team/src/types.ts
/** 团队选择的持久事件与投影契约（纯类型，Node 半/浏览器半/测试共用）。 */

/** 团队切换成功时追加的会话事件类型。 */
export const TEAM_SELECTED_EVENT = 'team/selected'

/** 投影中的可选项：id + 一句话摘要（首角色 description）。 */
export interface TeamOption {
  readonly id: string
  readonly summary: string
}

/** `team` 会话投影的视图：dock 下拉的唯一数据源。 */
export interface TeamProjection {
  readonly currentId: string
  readonly options: readonly TeamOption[]
}
```

```ts
// packages/agent-team/src/teams.ts
/** 团队状态机：当前团队 ref、fold 冷恢复、blank 锁定——全部纯逻辑，不含 ctx 接线。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Team } from './roles.ts'
import { TEAM_SELECTED_EVENT, type TeamOption } from './types.ts'

/**
 * 冷恢复：从会话日志取最新团队选择。
 * @param events - 会话事件（日志序）。
 * @returns 最新 team/selected 的 team；无事件返回 undefined。
 */
export function foldSelectedTeam(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === TEAM_SELECTED_EVENT) {
      const team = (event.data as { team?: unknown }).team
      return typeof team === 'string' ? team : undefined
    }
  }
  return undefined
}

/**
 * 会话是否仍处于 blank 期（可切团队的唯一时间窗）。
 * 定义照抄宿主 sessionBlank（api-proxy.ts:476-478）：无 turn/start 事件。
 */
export function isSessionBlank(events: readonly SessionEvent[]): boolean {
  return !events.some(event => event.type === 'turn/start')
}

/** 团队的投影选项：摘要取首角色 description，空名册回退 id。 */
export function teamOption(team: Team): TeamOption {
  return { id: team.id, summary: team.roles[0]?.description ?? team.id }
}

/** trySelect 的结果。 */
export type SelectOutcome =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly error: string }

/** 团队状态：当前团队 + 切换入口。 */
export interface TeamState {
  readonly current: Team
  readonly teams: readonly Team[]
  /**
   * 尝试切换团队。
   * @param id - 目标团队 id。
   * @param events - 当前会话事件（blank 判定用）。
   */
  trySelect(id: string, events: readonly SessionEvent[]): SelectOutcome
}

/**
 * 创建团队状态机。
 * @param options.teams - 激活时加载的全部团队（非空，loadTeams 保证）。
 * @param options.defaultTeamId - Config.defaultTeam（激活期已校验命中）。
 * @param options.initialId - 冷恢复 fold 结果。
 */
export function createTeamState(options: {
  teams: readonly Team[]
  defaultTeamId?: string
  initialId?: string
}): TeamState {
  const { teams } = options
  const byId = new Map(teams.map(t => [t.id, t]))
  const pick = (id: string | undefined): string | undefined =>
    id !== undefined && byId.has(id) ? id : undefined
  let currentId = pick(options.initialId) ?? pick(options.defaultTeamId) ?? teams[0].id
  return {
    teams,
    get current() { return byId.get(currentId)! },
    trySelect(id, events) {
      if (!byId.has(id)) {
        return { ok: false, error: `未知团队 "${id}"。可用团队：${teams.map(t => t.id).join(', ')}` }
      }
      if (!isSessionBlank(events)) {
        return { ok: false, error: '会话已开始，团队已锁定' }
      }
      const changed = id !== currentId
      currentId = id
      return { ok: true, changed }
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test`
Expected: PASS（teams 7 个测试）

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm --filter agent-team typecheck`

```bash
git add packages/agent-team/src/types.ts packages/agent-team/src/teams.ts packages/agent-team/tests/teams.test.ts
git commit -m "feat(agent-team): 团队状态机（fold 冷恢复 + blank 锁定）"
```

---

### Task 6: 插件入口组装（src/index.ts）+ 集成测试

**Files:**
- Modify: `packages/agent-team/src/index.ts`（Task 1 的占位改为完整入口）
- Create: `packages/agent-team/tests/fixtures/team-preset/teams/alpha.yml`
- Create: `packages/agent-team/tests/fixtures/team-preset/teams/beta.yml`
- Test: `packages/agent-team/tests/integration.test.ts`

**Interfaces:**
- Consumes: `loadTeams` / `Team`（`./roles.ts`）；`createDelegateTool`（`./tool.ts`）；`createTeamState` / `foldSelectedTeam` / `teamOption`（`./teams.ts`）；`TEAM_SELECTED_EVENT` / `TeamProjection`（`./types.ts`）。
- Produces:
  - `name = 'agent-team'`、`inject = ['tools', 'subagents', 'systemPrompt']`
  - `Config`：`{ teamsDir?: string（默认 './teams'）; defaultTeam?: string; provider?: string（默认 'spawn'）; toolName?: string（默认 'team_delegate'）; promptTemplates?: { default?: string; families?: Record<string,string> } }`
  - `apply(ctx, config): Promise<void>`（异步；teams/ 读不到或 defaultTeam 未命中即抛错 → preset 挂载被拒）
  - `/team` 命令（经 `ctx.inject(['commands'], …)`，handler 语义见测试）；`team` 会话投影（经 `ctx.inject(['sessionProjections'], …)`）

**实现期核实点**（spec §7.2 同款，集成测试即为钉死手段）：
1. preset scope 下 `ctx.inject(['commands'], …)` 是否拿到命令注册表；拿不到则退 Typert Remote RPC（dock onSelect 同步改）。
2. 激活时读取会话事件的途径：先试 `ctx.agent.session.events`；不存在则以 cordis agent scope 实际属性为准（集成测试的 fake ctx 按最终选择接线）。
3. 会话进行中重注册工具后下步请求拿到新 description：集成测试断言重注册产物 description 含新名册。

- [ ] **Step 1: 写 fixture 与失败测试**

```yaml
# packages/agent-team/tests/fixtures/team-preset/teams/alpha.yml
roles:
  - name: reviewer
    description: 代码审查员
    persona: 你是资深代码审查员。
```

```yaml
# packages/agent-team/tests/fixtures/team-preset/teams/beta.yml
roles:
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
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { apply, type Config } from '../src/index.ts'
import { TEAM_SELECTED_EVENT, type TeamProjection } from '../src/types.ts'

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'team-preset')

interface RegisteredTool { name: string; description: string }
interface CommandDef {
  name: string
  handler: (inv: { agent: unknown; rawInput: string }) => { kind: string; text: string }
}
interface ProjectionDef {
  key: string
  init: () => TeamProjection
  apply: (state: TeamProjection, event: SessionEvent) => TeamProjection
}

function fakeCtx(events: SessionEvent[], baseUrl?: string) {
  const tools: RegisteredTool[] = []
  const toolDisposers: (() => void)[] = []
  const sections: { name: string; order: number; text: unknown }[] = []
  const commands: CommandDef[] = []
  const projections: ProjectionDef[] = []
  const appended: SessionEvent[] = []
  const agent = {
    session: {
      events,
      append: (type: string, data: unknown) => {
        const event = { type, data } as SessionEvent
        events.push(event)
        appended.push(event)
      },
    },
  }
  const services: Record<string, unknown> = {
    commands: { register: (def: CommandDef) => { commands.push(def); return () => {} } },
    sessionProjections: { register: (def: ProjectionDef) => { projections.push(def); return () => {} } },
  }
  const ctx = {
    baseUrl,
    agent,
    tools: { register: (tool: RegisteredTool) => { tools.push(tool); const d = () => {}; toolDisposers.push(d); return d } },
    systemPrompt: { section: (s: { name: string; order: number; text: unknown }) => { sections.push(s); return () => {} } },
    subagents: { start: async () => { throw new Error('integration test 不发起真实委派') } },
    inject: (names: string[], cb: (c: unknown) => void) => { cb({ ...ctx, [names[0]]: services[names[0]] }) },
    logger: { info: () => {}, warn: () => {} },
  }
  return { ctx: ctx as unknown as Context, tools, sections, commands, projections, appended, agent }
}

const presetUrl = () => pathToFileURL(FIXTURE_DIR + '/').href

test('激活：注册 team_delegate（默认团队名册入 description）、/team 命令、team 投影与提示段', async () => {
  const { ctx, tools, sections, commands, projections } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(tools[0].description).toContain('reviewer: 代码审查员')   // 默认团队 = 字典序首个 alpha
  expect(tools[0].description).not.toContain('researcher')
  expect(commands.map(c => c.name)).toEqual(['team'])
  expect(projections.map(p => p.key)).toEqual(['team'])
  expect(projections[0].init()).toEqual({
    currentId: 'alpha',
    options: [{ id: 'alpha', summary: '代码审查员' }, { id: 'beta', summary: '资料调研与分析' }],
  })
  expect(sections).toHaveLength(1)
  expect(String(sections[0].text)).toContain('team_delegate')
})

test('defaultTeam 命中时作为初始团队；未命中时激活失败', async () => {
  const ok = fakeCtx([], presetUrl())
  await apply(ok.ctx, { defaultTeam: 'beta' } as Config)
  expect(ok.tools[0].description).toContain('researcher: 资料调研与分析')
  const bad = fakeCtx([], presetUrl())
  await expect(apply(bad.ctx, { defaultTeam: 'ghost' } as Config)).rejects.toThrowError(/ghost/)
})

test('/team 无参数：返回当前团队与可用列表', async () => {
  const { ctx, commands, agent } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const result = commands[0].handler({ agent, rawInput: '' })
  expect(result.kind).toBe('success')
  expect(result.text).toContain('alpha')
})

test('/team 切换成功：旧工具注册被 dispose、新工具 description 含新名册、事件入日志', async () => {
  const { ctx, tools, commands, appended, agent } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const result = commands[0].handler({ agent, rawInput: 'beta' })
  expect(result.kind).toBe('success')
  expect(tools).toHaveLength(2)                                   // 重注册产物
  expect(tools[1].description).toContain('researcher: 资料调研与分析')
  expect(appended.map(e => e.type)).toEqual([TEAM_SELECTED_EVENT])
  expect((appended[0].data as { team: string }).team).toBe('beta')
})

test('/team 未知团队：error 且列出可用团队，不重注册', async () => {
  const { ctx, tools, commands, agent } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const result = commands[0].handler({ agent, rawInput: 'ghost' })
  expect(result.kind).toBe('error')
  expect(result.text).toContain('alpha, beta')
  expect(tools).toHaveLength(1)
})

test('/team 会话已开始：拒绝锁定，不重注册、不入日志', async () => {
  const events = [{ type: 'turn/start', data: {} } as SessionEvent]
  const { ctx, tools, commands, appended, agent } = fakeCtx(events, presetUrl())
  await apply(ctx, {} as Config)
  const result = commands[0].handler({ agent, rawInput: 'beta' })
  expect(result.kind).toBe('error')
  expect(result.text).toContain('锁定')
  expect(tools).toHaveLength(1)
  expect(appended).toHaveLength(0)
})

test('冷恢复：日志含 team/selected 时初始团队与投影 currentId 跟随', async () => {
  const events = [{ type: TEAM_SELECTED_EVENT, data: { team: 'beta' } } as SessionEvent]
  const { ctx, tools, projections } = fakeCtx(events, presetUrl())
  await apply(ctx, {} as Config)
  expect(tools[0].description).toContain('researcher')
  expect(projections[0].init().currentId).toBe('beta')
})

test('投影 apply：team/selected 事件更新 currentId，其他事件原样', async () => {
  const { ctx, projections } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const init = projections[0].init()
  const next = projections[0].apply(init, { type: TEAM_SELECTED_EVENT, data: { team: 'beta' } } as SessionEvent)
  expect(next.currentId).toBe('beta')
  expect(projections[0].apply(init, { type: 'user/message', data: {} } as SessionEvent)).toBe(init)
})

test('teamsDir 指向缺失目录时激活失败', async () => {
  const { ctx } = fakeCtx([], presetUrl())
  await expect(apply(ctx, { teamsDir: './missing' } as Config)).rejects.toThrowError(/missing/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test`
Expected: FAIL（apply/Config 未导出）

- [ ] **Step 3: 实现完整 src/index.ts**

```ts
/** agent-team 插件：团队 = preset 内 teams/ 名册，主 Agent 经 team_delegate 一次性委派角色成员。 */
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { buildMemberPersona } from './prompt.ts'
import { loadTeams, type Team } from './roles.ts'
import { createTeamState, foldSelectedTeam, teamOption, type TeamState } from './teams.ts'
import { createDelegateTool } from './tool.ts'
import { TEAM_SELECTED_EVENT, type TeamProjection } from './types.ts'

export const name = 'agent-team'

export const inject = ['tools', 'subagents', 'systemPrompt']

/** 团队介绍段在 prompt 中的位置：紧随内置 subagent 段（116.5）之后。 */
const TEAM_SECTION_ORDER = 116.6

export interface Config {
  /** teams 目录路径，相对 preset 目录（默认 './teams'）。 */
  teamsDir?: string
  /** 默认团队 id；缺省取 teams/ 下文件名字典序第一个。未命中名册时激活失败。 */
  defaultTeam?: string
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
  teamsDir: z.string().default('./teams'),
  defaultTeam: z.string(),
  provider: z.string().default('spawn'),
  toolName: z.string().default('team_delegate'),
  promptTemplates: z.object({
    default: z.string(),
    families: z.dict(z.string()),
  }),
})

/** team 投影的 wire schema（zod，permission-presets/token-usage 先例）。 */
const TeamProjectionSchema = zod.object({
  currentId: zod.string(),
  options: zod.array(zod.object({ id: zod.string(), summary: zod.string() })),
}) as unknown as zod.ZodType<TeamProjection>

/** 把 teamsDir 解析为绝对路径：绝对路径原样，相对路径基于 preset 目录（ctx.baseUrl）。 */
function resolveTeamsPath(teamsDir: string, baseUrl: string | undefined): string {
  if (isAbsolute(teamsDir)) return teamsDir
  if (baseUrl === undefined) {
    throw new Error('agent-team: 无法解析相对 teamsDir——ctx.baseUrl 为空（插件应由 preset 挂载）')
  }
  return fileURLToPath(new URL(teamsDir, baseUrl))
}

/** 激活时读会话事件（冷恢复 fold 用）；agent scope 的实际属性名以 cordis 类型为准微调。 */
function sessionEventsOf(ctx: Context): readonly SessionEvent[] {
  const agent = (ctx as { agent?: { session?: { events?: readonly SessionEvent[] } } }).agent
  return agent?.session?.events ?? []
}

/** 以指定团队注册 team_delegate，返回 disposer（切换时先 dispose 再重注册）。 */
function registerDelegateTool(ctx: Context, toolName: string, provider: string, team: Team, config: Config): () => void {
  return ctx.tools.register(createDelegateTool(toolName, {
    roles: team.roles,
    provider,
    templates: config.promptTemplates,
    startRun: (p, request) => ctx.subagents.start(p, request),
  }))
}

/** 注册 /team 命令与 team 投影（服务仅在对应注册表被组合时存在，故走条件 inject）。 */
function installTeamSwitch(ctx: Context, state: TeamState, reinstall: () => void): void {
  ctx.inject(['commands'], (commandCtx: Context) => {
    commandCtx.commands.register({
      name: 'team',
      description: '切换当前团队（仅会话开始前可用）',
      input: { hint: '<team>' },
      handler: ({ agent, rawInput }: { agent: { session: { events: SessionEvent[]; append(type: string, data: unknown): void } }; rawInput: string }) => {
        const id = rawInput.trim()
        if (id === '') {
          return { kind: 'success' as const, text: `当前团队 ${state.current.id}（可用：${state.teams.map(t => t.id).join(', ')}）` }
        }
        const outcome = state.trySelect(id, agent.session.events)
        if (!outcome.ok) return { kind: 'error' as const, text: outcome.error }
        if (outcome.changed) {
          reinstall()
          agent.session.append(TEAM_SELECTED_EVENT, { team: id })
        }
        return { kind: 'success' as const, text: `团队 ${id}` }
      },
    })
  })
  ctx.inject(['sessionProjections'], (projectionCtx: Context) => {
    projectionCtx.sessionProjections.register({
      key: 'team',
      schema: TeamProjectionSchema,
      init: (): TeamProjection => ({ currentId: state.current.id, options: state.teams.map(teamOption) }),
      apply: (projection: TeamProjection, event: SessionEvent): TeamProjection =>
        event.type === TEAM_SELECTED_EVENT
          ? { ...projection, currentId: (event.data as { team: string }).team }
          : projection,
      view: (projection: TeamProjection) => projection,
      stateVersion: 1,
    })
  })
}

/**
 * 激活：读名册 → 建团队状态（冷恢复 fold）→ 注册委派工具、/team 命令、team 投影与团队介绍段。
 * 直接 apply() 绕过 Schemastery 默认值，这里手动补默认（内置 tool-subagent 同款防御）。
 * teams/ 缺失/非法或 defaultTeam 未命中时抛错：fiber FAILED，preset 挂载被拒并标记 broken。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const teamsDir = config.teamsDir ?? './teams'
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'team_delegate'
  const teams = await loadTeams(resolveTeamsPath(teamsDir, ctx.baseUrl))
  if (config.defaultTeam !== undefined && !teams.some(t => t.id === config.defaultTeam)) {
    throw new Error(`agent-team: defaultTeam "${config.defaultTeam}" 不在名册中（可用：${teams.map(t => t.id).join(', ')}）`)
  }
  const state = createTeamState({
    teams,
    defaultTeamId: config.defaultTeam,
    initialId: foldSelectedTeam(sessionEventsOf(ctx)),
  })
  let disposeTool = registerDelegateTool(ctx, toolName, provider, state.current, config)
  installTeamSwitch(ctx, state, () => {
    disposeTool()
    disposeTool = registerDelegateTool(ctx, toolName, provider, state.current, config)
  })
  ctx.systemPrompt.section({
    name: `plugin:${name}`,
    order: TEAM_SECTION_ORDER,
    text: `你有一个团队可用：用 ${toolName} 把自包含的子任务委派给合适的成员，成员结果会作为工具返回值回到本对话。`,
  })
}

// buildMemberPersona 仅经 tool.ts 使用；此处再导出便于宿主/调试方直接复用。
export { buildMemberPersona }
```

> 注：① `ctx.baseUrl` / agent scope 的会话访问（`sessionEventsOf`）以 vendor/cordis 与 core/agent 类型为准微调；preset 挂载会把 baseUrl 重写到 preset 目录（`agent-presets/src/mount.ts:48`）。② `commands.register` 的 handler 签名（`{ agent, rawInput }` 及 `{ kind: 'success' | 'error', text }` 返回）以 `interaction/commands/src/index.ts:28-55` 为准。③ `sessionProjections.register` 的 `init/apply/view/stateVersion` 签名以 `session/session-projection/src/index.ts` 为准（`permission-presets/src/index.ts:243-252` 是逐字段先例）。④ `team/selected` 事件的类型化：按"typed events use declaration merging"规约，在 `src/types.ts` 增补 `declare module '@deepseek-ai/dsh-session'` 的 `SessionEventMap`（先例：`session/session-title/src/types.ts`）；若 dsh-session 的合并接口名不同，以 `core/session/src/types.ts` 为准。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test`
Expected: PASS（全部测试）

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm --filter agent-team typecheck`

```bash
git add packages/agent-team/src packages/agent-team/tests
git commit -m "feat(agent-team): 插件入口组装（名册/团队状态机//team 命令/投影/提示段）"
```

---

### Task 7: 浏览器半 TeamDock（src/client/）

**Files:**
- Modify: `packages/agent-team/src/client/index.ts`（占位改为真实注册）
- Create: `packages/agent-team/src/client/TeamDock.tsx`
- Create: `packages/agent-team/src/client/TeamDock.module.css`
- Test: `packages/agent-team/tests/team-dock.client.spec.tsx`

**Interfaces:**
- Consumes: `TeamProjection`（`../types.ts`，type-only）；槽位 `conversation.input.dock`（ui-conversation 声明，type-only 合并 SlotMap）。
- Produces: 浏览器半 `apply`：dock 注册 `id: 'team'`、`order: -10`；组件 `TeamDock` props = `PropsRuntime<'conversation.input.dock'> & { onSelect: (team: string) => void }`。

- [ ] **Step 1: 写失败测试（jsdom，props 直接喂桩）**

```tsx
// packages/agent-team/tests/team-dock.client.spec.tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TeamDock, type TeamDockProps } from '../src/client/TeamDock.tsx'
import type { TeamProjection } from '../src/types.ts'

afterEach(cleanup)

function propsOf(projection: TeamProjection | undefined, blank: boolean, onSelect = vi.fn()) {
  return {
    useProjection: () => projection,
    useSession: (selector: (s: { blank: boolean }) => unknown) => selector({ blank }),
    onSelect,
  } as unknown as TeamDockProps
}

const PROJECTION: TeamProjection = {
  currentId: 'alpha',
  options: [
    { id: 'alpha', summary: '代码审查员' },
    { id: 'beta', summary: '资料调研与分析' },
  ],
}

test('无投影（非团队会话）时不渲染', () => {
  const { container } = render(<TeamDock {...propsOf(undefined, true)} />)
  expect(container.firstChild).toBeNull()
})

test('渲染团队下拉：当前值选中，选项带摘要', () => {
  render(<TeamDock {...propsOf(PROJECTION, true)} />)
  const select = screen.getByRole('combobox') as HTMLSelectElement
  expect(select.value).toBe('alpha')
  expect(screen.getByText('beta · 资料调研与分析')).toBeTruthy()
  expect(select.disabled).toBe(false)
})

test('选择团队时回调 onSelect', () => {
  const onSelect = vi.fn()
  render(<TeamDock {...propsOf(PROJECTION, true, onSelect)} />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'beta' } })
  expect(onSelect).toHaveBeenCalledWith('beta')
})

test('会话已开始时禁用并提示锁定', () => {
  render(<TeamDock {...propsOf(PROJECTION, false)} />)
  const select = screen.getByRole('combobox') as HTMLSelectElement
  expect(select.disabled).toBe(true)
  expect(select.title).toContain('锁定')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test`
Expected: FAIL（`Cannot find module '../src/client/TeamDock.tsx'`）

- [ ] **Step 3: 实现 TeamDock.tsx / TeamDock.module.css / client/index.ts**

```tsx
// packages/agent-team/src/client/TeamDock.tsx
/** 团队选择 dock：输入卡片正上方整宽行内的左对齐下拉；blank 期可切，首条消息后锁定。 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TeamProjection } from '../types.ts'
import css from './TeamDock.module.css'

/** inject 面：提交团队选择。 */
export interface TeamDockInjected {
  readonly onSelect: (team: string) => void
}

export type TeamDockProps = PropsRuntime<'conversation.input.dock'> & TeamDockInjected

export function TeamDock({ useProjection, useSession, onSelect }: TeamDockProps) {
  const projection = useProjection('team') as TeamProjection | null | undefined
  const blank = useSession(s => s.blank)
  if (projection == null) return null
  return (
    <div className={css.dock}>
      <span className={css.label}>团队</span>
      <select
        className={css.select}
        value={projection.currentId}
        disabled={!blank}
        title={blank ? '选择本会话使用的团队' : '会话已开始，团队已锁定'}
        onChange={event => onSelect(event.target.value)}
      >
        {projection.options.map(option => (
          <option key={option.id} value={option.id}>{option.id} · {option.summary}</option>
        ))}
      </select>
    </div>
  )
}
```

```css
/* packages/agent-team/src/client/TeamDock.module.css */
.dock {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
}

.label {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}

.select {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: none;
  cursor: pointer;
}

.select:disabled {
  color: var(--dsw-alias-label-dimmed);
  cursor: default;
}
```

```ts
// packages/agent-team/src/client/index.ts
/** agent-team 浏览器半：在 conversation.input.dock 注册团队选择下拉。 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// 触发 ui-conversation 对 SlotMap 的声明合并（conversation.input.dock 键）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TeamDock } from './TeamDock.tsx'

export const inject = ['slots', 'sessions']

export function apply(ctx: ClientContext): void {
  // inject() 等 ui-conversation 声明该槽位后再注册，声明消失自动回滚。
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'team',
        order: -10, // 现有 occupant：todo=0、goal=10、queue=20；负值栈顶
        inject: (sessionId: SessionId) => ({
          onSelect: (team: string) => {
            void ctx.sessions.binding(sessionId)?.session.command(`/team ${team}`)
          },
        }),
      },
      TeamDock,
    ))
}
```

> 注：① `useProjection`/`useSession` 经 `PropsRuntime<'conversation.input.dock'>` 到达组件（GoalDock 先例：`ui-goal/src/client/GoalBar.tsx:172-176`）；`useProjection('team')` 的键类型依赖 Task 6 注④的投影图合并，若类型未合并成功则先以 `as TeamProjection | null | undefined` 断言（已在组件签名中体现）。② `sessions.binding(sessionId)?.session.command(line)` 以 `client/runtime/src/client/sessions/session.ts:358-362` 为准。③ `--dsw-alias-label-*` token 名以 `ui-theme/src/styles/` 实际清单为准（token-usage 的 UsageModal.module.css 同款用法）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test`
Expected: PASS（team-dock 4 个测试）

- [ ] **Step 5: 类型检查 + bundle**

Run: `pnpm --filter agent-team typecheck; pnpm --filter agent-team bundle`
Expected: 无错误；`lib/client.js` 含 TeamDock 注册代码

- [ ] **Step 6: Commit**

```bash
git add packages/agent-team/src/client packages/agent-team/tests/team-dock.client.spec.tsx
git commit -m "feat(agent-team): 浏览器半 TeamDock（input.dock 团队下拉，blank 锁定）"
```

---

### Task 8: 示例团队 preset + 开发回路接入

**Files:**
- Create: `packages/agent-team/presets/team/agent.cordis.yml`
- Create: `packages/agent-team/presets/team/preset.yml`
- Create: `packages/agent-team/presets/team/teams/default.yml`
- Create: `packages/agent-team/presets/team/teams/review.yml`

**Interfaces:**
- Consumes: Task 6 的插件入口 + Task 7 的浏览器半（preset 行 name 指向包绝对路径）。
- Produces: Web UI 新建会话出现"团队模式" chip；选它开会话后 dock 出现团队下拉，可用 team_delegate。

- [ ] **Step 1: 创建 preset 四文件**

```yaml
# packages/agent-team/presets/team/agent.cordis.yml
# 团队模式组合：挂载 agent-team 插件。
# 注意：name 为绝对路径——preset 行的裸包名相对 harness 解析，本地包必须给绝对路径；
# 部署方 copy 本 preset 后需把路径改为自己机器上的包位置。
- name: D:/work/github/dsh/dsh-agent-toolkit/packages/agent-team
  # config 全省略 → teamsDir 默认 ./teams（相对本 preset 目录）
```

```yaml
# packages/agent-team/presets/team/preset.yml
name: 团队模式
description: 主 Agent + 可委派的成员团队（会话开始前在输入框上方选择团队；名册见本目录 teams/）
order: 10
```

```yaml
# packages/agent-team/presets/team/teams/default.yml
roles:
  - name: researcher
    description: 资料调研与分析，输出带来源的结论
    persona: |
      你是调研分析员。围绕任务收集资料、交叉验证，输出结论清单并标注来源。
  - name: writer
    description: 文案与文档撰写，输出结构化成稿
    persona: |
      你是技术写作者。按任务要求输出结构清晰的成稿，先提纲后正文。
```

```yaml
# packages/agent-team/presets/team/teams/review.yml
roles:
  - name: reviewer
    description: 代码审查员，按严重度分级输出问题
    persona: |
      你是资深代码审查员。关注正确性、边界条件、并发安全与可读性。
      输出按严重度分级：blocker / major / minor，每条给出文件与理由。
  - name: tester
    description: 测试设计员，输出用例清单与覆盖缺口
    persona: |
      你是测试设计员。针对任务给出测试用例清单（正常/边界/异常），并指出覆盖缺口。
```

- [ ] **Step 2: 把示例团队放进用户 preset root**

背景（源码已确认）：`agent-presets` 服务自动把 `$DSH_HOME/.agent-presets/` 追加为 user root（`packages/preset/agent-presets/src/index.ts:134`），发现非缓存、立即可见。CLI 的 profile-boot 末尾会用 overlay 把 config.roots 重置为 shipped-only（`apps/cli/src/profile-boot.ts:159-167`），所以**开发回路走 user root，不走 patch 加 roots**。

Run（PowerShell，在仓库根）:
```powershell
$home_dir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
New-Item -ItemType Directory -Force (Join-Path $home_dir '.agent-presets') | Out-Null
Copy-Item -Recurse -Force packages/agent-team/presets/team (Join-Path $home_dir '.agent-presets/team')
```
Expected: `$home_dir/.agent-presets/team/` 下出现 `agent.cordis.yml` / `preset.yml` / `teams/`。若 `$DSH_HOME` 实际布局不同（以 `dshHomePath` 实现为准），启动 dsh 后在 UI 设置里确认 user preset 目录位置再复制。

- [ ] **Step 3: 手动验证清单（开发回路）**

Run: `pnpm --filter agent-team bundle; cd deepseek-harness; pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml`

**首要核实点（spike）**：preset scope 挂载插件的**浏览器半 bundle 是否被 web 端加载**（client-modules 的 bundle 清单是否覆盖 preset 内插件）。
- [ ] 开"团队模式"会话 → 输入框上方出现团队下拉 → 已加载
- [ ] 若未加载：排查 `host/webserver` 的 client bundle 注册来源；备选方案 = 拆一个仅含浏览器半的兄弟包全局挂载（Node 半 apply 在无 baseUrl 时立即返回空），并把该决策回写 spec §7.1

逐项确认：
- [ ] 新建会话 hero 区出现"团队模式" chip
- [ ] 选"团队模式"开会话，会话头显示团队名标签
- [ ] **dock 下拉（§7.1）**：输入框正上方出现团队下拉（位于 todo/goal/queue 条之上），当前值 = default（字典序首个），选项带摘要；非团队 preset 会话不出现该下拉
- [ ] **切换团队**：下拉选 review → 会话流出现 `/team review` 命令行与成功回执；让主 Agent 委派 → 工具 description 已是 review 名册（模型只见到 reviewer/tester）
- [ ] **锁定**：发送第一条消息后再试下拉 → 禁用且 tooltip 提示锁定；手动输入 `/team default` → 错误回执"会话已开始，团队已锁定"
- [ ] **委派卡片（§7.3）**：待定态卡片标题显示「委派 · reviewer: <短标签>」，展开 IN 区显示任务书原文；完成后标题保留、OUT 区显示成员最终文本
- [ ] **子代理目录（§7.4）**：成员运行期间会话页头子代理目录按钮出现 `role:reviewer: <短标签>` 条目，父会话行带蓝色活动指示器；点击条目进入子会话可见成员完整工具流
- [ ] **错误行（§7.3）**：让主 Agent 委派不存在的角色 → 红色错误行，首行显示"未知角色 … 可用角色：…"
- [ ] **冷恢复**：blank 期切到 review → 刷新页面重开会话 → 下拉当前值仍为 review，工具名册跟随
- [ ] 修改 `$DSH_HOME/.agent-presets/team/teams/`（如加一个名册文件）→ **新建**会话后下拉出现新团队（旧会话不变，generation 语义）
- [ ] 把某个名册改坏（删 persona）→ 新建"团队模式"会话立即报错；设置→管理区"团队模式"卡片变红框 + "加载失败"徽标，hero chip 菜单中消失（§7.5 失败反馈）；改回后恢复

- [ ] **Step 4: Commit**

```bash
git add packages/agent-team/presets
git commit -m "feat(agent-team): 示例团队 preset（团队模式，双名册）"
```

---

### Task 9: 仓库文档同步

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: 前 8 个 Task 的产物。
- Produces: AGENTS.md 反映 agent-team 的存在与开发方式。

- [ ] **Step 1: 更新 AGENTS.md**

- 目录结构节：`packages/agent-team/` 条目标注"已建成"，补 `presets/team/`（含 `teams/` 多名册）说明
- 开发命令节：加 `pnpm --filter agent-team test` / `typecheck` / `bundle`
- "dsh 插件开发要点"或目录结构附近补一句：agent-team 经 user preset root（`$DSH_HOME/.agent-presets/team`）接入开发回路，不走 cordis.yml patch（CLI overlay 会重置 roots）；含浏览器半，改动后需 `bundle`

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md 记录 agent-team 插件与团队模式接入方式"
```

---

## Self-Review 记录

- **spec 覆盖**：spec §2 包结构 → Task 1/6/7/8；§3 Config → Task 6；§4 teams/ 名册 → Task 2；§5 两层提示词 → Task 3；§6 工具契约 → Task 4；§7.1 dock → Task 7；§7.2 切换状态机 → Task 5/6（核实点①②③在 Task 6 集成测试钉死，浏览器半加载 spike 在 Task 8 Step 3 首项）；§7.3 presenter → Task 4；§7.4 子代理目录 → Task 8 手动清单；§7.5 旅程 → Task 8 手动清单；§8 错误处理 → Task 2/4/5/6 测试逐条对应；§9 发行 → Task 8（user root 路径）；§10 测试策略 → Task 2/4/5/6 单测 + 集成测试 + Task 7 组件测试 + Task 8 手动清单；§11 范围之外 → 计划中无对应任务。
- **类型一致性**：`Role`/`Team`/`PromptTemplates`/`DelegateToolDeps`/`TeamState`/`SelectOutcome`/`TeamProjection`/`TEAM_SELECTED_EVENT`/`buildMemberPersona(role, model, templates)`/`createDelegateTool(toolName, deps)`/`createTeamState({teams, defaultTeamId, initialId})` 在 Task 2-7 间签名一致；`TeamDockProps` 消费 `PropsRuntime<'conversation.input.dock'>` + `TeamDockInjected`，与 client/index.ts 的 inject 面一致。
- **已知实现期核实点**（非占位符，均有确切位置）：①`ctx.inject(['commands'])` 在 preset scope 的可用性 + 激活期会话事件访问途径（Task 6 注）；②`sessionProjections.register` 字段签名与 SessionEventMap/投影图合并接口名（Task 6 注④）；③`SubagentStartRequest` 字段（Task 4 注）；④`PropsRuntime` 钩子面与 `session.command`（Task 7 注）；⑤preset 插件浏览器半加载（Task 8 spike，含备选）；⑥`$DSH_HOME` 实际布局（Task 8 Step 2）。
