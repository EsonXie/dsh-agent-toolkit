# Agent 团队插件（agent-team）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **2026-08-19 v2 修订**：设计第二次修订（spec 同日版）——取消 `/team` 命令与 `team/selected` 会话事件（宿主 `assertEventsSupported` 拒载含未知非 ignorable 事件的日志，`session-persistence/src/coordinator.ts:1061-1066`；外部插件事件进不了生成的 `KNOWN_SESSION_EVENT_TYPES` 且 `Session.append` 不写 ignorable）。团队选择改走插件自建 HTTP 端点（GET/POST，路径含 sessionId）+ 插件自有 KV（storageDomain）持久化；dock 数据源从会话投影改为 HTTP GET。Task 1-4 已按 v1 落地且不受影响；Task 5-8 为修订后版本。

> **2026-08-19 v3 修订（当前执行版）**：真机验证发现 v2 挂载假设错误——preset 插件实例是 **standing scope、按 preset 代共享、跨会话单例**（`agent-presets/src/index.ts:491-534`），`ctx.agent` 恒 undefined（`core/agent/src/index.ts:40-48`）→ v2 的 `ctx.agent!.session.id` 激活即崩、select RPC 回退。另实证：浏览器半靠 preset 挂载进 boot 图有"建会话后须刷新整页"的脆弱时序。v3 决策（用户已裁）：① Node 半改 standing 语义——`Map<sessionId, TeamState>` 懒建（KV 恢复）、prefix 路由 `path: '/agent-team'` 自解析 sid（`webserver/src/index.ts:24-33,241-249`）、`ctx.on('session/disposed')` 清 Map、blank 检查经 `ctx.sessions.get(sid).events`；② 工具**单次共享注册**、description 静态通用；**名册动态可见性走 prompt section 函数 text**（`system-prompt/src/index.ts:67,514`，`dispatch.ts:174-176` 注入 `agent`）；③ 浏览器半接入 = 同一包在 cordis.yml 全局挂 `config: { clientOnly: true }` 行（单 npm 包不拆包，client-modules 扫描只要求活 fiber）；④ 默认团队定案：`default.yml` = explorer + general（opencode 风格），**删 review.yml**；⑤ spec §7.5 修正：激活期失败不标 broken（broken 仅 discovery 期），真实报错在 chip hover title / select RPC reason。终审裁决补记（2026-08-19）：非本 preset 会话的 GET/POST 按归属门控返 404（spec §7.2 同步改为归属门控表述），畸形 % 编码 sid 与 provider 后到缺能力均改 404/fail-loud。v3 返工 Task 见文末「v3 返工任务」节；v2 Task 6/8 的相应内容被取代，Task 1/2/3/5/7 产物基本沿用。

**Goal:** 实现 `packages/agent-team` 插件：preset 作为"团队模式"入口（内含 `teams/*.yml` 多名册），用户在输入框上方 dock 下拉于会话 blank 期选择团队（首条消息后锁定），主 Agent 通过 `team_delegate` 工具把自包含任务前台同步委派给一次性 spawn 子 Agent。

**Architecture:** 设计 spec 见 `docs/superpowers/specs/2026-08-18-agent-team-design.md`（2026-08-19 第二版）。Node 半：激活时读 teams/ 全部名册 + KV 冷恢复 → 注册 team_delegate（名册编入 description）+ systemPrompt 段 + 每会话两条 HTTP 路由（GET state / POST select）；切换时 dispose 旧工具注册并以新名册重注册 + 写 KV。浏览器半：`conversation.input.dock` 注册 TeamDock 下拉（order -10），GET 读状态、POST 提交选择。

**Tech Stack:** TypeScript ESM（strict）、cordis 插件、Schemastery（Config 与名册校验）、zod（KV 记录 schema，token-usage 先例）、js-yaml、@deepseek-ai/dsh-storage-domain（KV）、@deepseek-ai/dsh-host-webserver（HTTP 路由）、vitest、React 18 + tsdown + lightningcss（浏览器半 bundle，照 token-usage 先例）、`link:` 依赖指向 `deepseek-harness/` 内包源码。

## Global Constraints

- 命名导出 `name` / `inject` / `Config` / `apply`，**无 default export**（dsh 插件协议）；浏览器半入口为 `./client` export + `dsh.client` manifest。
- ESM：`"type": "module"`；本地相对导入带 `.ts` 扩展名（组件 `.tsx`）。
- `strict: true` + `noImplicitAny`；不留裸 `any`。
- 可调参数一律进 Config，不硬编码（仓库约定）。
- 成员**禁止套娃**：委派请求固定携带 `maxDepth: 1`（`resolveChildDepth` = 父深度+1，`childDepth > maxDepth` 抛 `SubagentDepthError`，见 `deepseek-harness/packages/subagent/subagent/src/child-agent.ts:48-57`）。
- 前台收集/异常语义照抄内置 `tool-subagent`（`deepseek-harness/packages/subagent/tool-subagent/src/index.ts:124-199`）。
- cordis 支持异步 `apply`：fiber 在 `await this._execute(...)` 后才 ACTIVE，apply 抛错 → fiber FAILED → preset 挂载被拒（`vendor/cordis/src/fiber.ts:646-673`）。
- **禁止自定义会话事件**：宿主拒绝加载含未知非 ignorable 事件类型的日志（`session-persistence/src/coordinator.ts:1061-1066`），外部插件事件进不了生成的 `KNOWN_SESSION_EVENT_TYPES`；团队选择持久化一律走 storageDomain KV，不 append 任何插件事件。
- **团队锁定**：会话存在 `turn/start` 事件即不可切换（`isSessionBlank` 定义照抄 `api-proxy.ts:476-478`）；UI 层禁用 + 宿主 POST 层 409 拒绝，双层。
- 浏览器半守 client 规范：组件纯 props（fetch 封装经 inject 面注入，组件不直接 fetch）、无订阅机器、CSS Modules + `--dsw-*` token、中文文案。
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

### Task 5: 团队状态机修订——去会话事件化（src/types.ts + src/teams.ts）

**Files:**
- Modify: `packages/agent-team/src/types.ts`（事件/投影契约改为 HTTP wire 契约）
- Modify: `packages/agent-team/src/teams.ts`（删 foldSelectedTeam；其余不动）
- Test: `packages/agent-team/tests/teams.test.ts`（删 fold 测试块；其余不动）

**Interfaces:**
- Produces:
  - `interface TeamOption { readonly id: string; readonly summary: string }`（src/types.ts）
  - `interface TeamStateView { readonly currentId: string; readonly options: readonly TeamOption[] }`（GET/POST 响应体）
  - `interface SelectTeamRequest { readonly team: string }`（POST 请求体）
  - `isSessionBlank(events: readonly SessionEvent[]): boolean`、`teamOption(team: Team): TeamOption`、`createTeamState(options: { teams; defaultTeamId?; initialId? }): TeamState`、`type SelectOutcome`、`interface TeamState`（teams.ts，签名不变；`initialId` 语义改注：KV 冷恢复结果）
- Removed: `TEAM_SELECTED_EVENT`、`TeamProjection`、`foldSelectedTeam`（设计 v2：不再写自定义会话事件，冷恢复走 KV）。

- [ ] **Step 1: 改测试（先失败）**

`tests/teams.test.ts`：删除 `foldSelectedTeam` 的 import 与整个 `test('foldSelectedTeam …')` 块；删除 `TEAM_SELECTED_EVENT` 的 import（`../src/types.ts` 不再导出，编译即失败 = RED）。其余 6 个测试原样保留。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test`
Expected: FAIL（`TEAM_SELECTED_EVENT`/`foldSelectedTeam` 无导出）

- [ ] **Step 3: 改 src/types.ts 与 src/teams.ts**

```ts
// packages/agent-team/src/types.ts（整体替换）
/** 团队选择的 HTTP wire 契约（纯类型，Node 半/浏览器半/测试共用）。 */

/** 可选团队：id + 一句话摘要（首角色 description）。 */
export interface TeamOption {
  readonly id: string
  readonly summary: string
}

/** GET /agent-team/<sessionId>/state 与 POST /agent-team/<sessionId>/select 的响应体。 */
export interface TeamStateView {
  readonly currentId: string
  readonly options: readonly TeamOption[]
}

/** POST /agent-team/<sessionId>/select 的请求体。 */
export interface SelectTeamRequest {
  readonly team: string
}
```

`src/teams.ts`：删除 `TEAM_SELECTED_EVENT` 的 import 与 `foldSelectedTeam` 函数；`createTeamState` 的 `@param options.initialId` 注释改为"KV 冷恢复结果（按 sessionId 读回）"；文件头注释改为"团队状态机：当前团队 ref、trySelect、blank 锁定——全部纯逻辑，不含 ctx 接线"。其余代码不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test`
Expected: PASS（teams 6 个测试 + 既有全部）

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm --filter agent-team typecheck`

```bash
git add packages/agent-team/src/types.ts packages/agent-team/src/teams.ts packages/agent-team/tests/teams.test.ts
git commit -m "feat(agent-team): 团队状态机去会话事件化，types.ts 改 HTTP wire 契约"
```

> 注：本 Task 会暂时打破 `src/index.ts`（import 了已删除的符号）与 `tests/integration.test.ts` 的类型检查——Task 6 紧随其后整体重写两者。若 typecheck 因此失败属预期，在报告中说明并直接继续 Task 6，Task 6 结束时两者必须全绿。

---

### Task 6: 插件入口组装 v2（HTTP 路由 + KV 持久化）+ 集成测试重写

**Files:**
- Modify: `packages/agent-team/package.json`（devDependencies 增 `"@deepseek-ai/dsh-storage-domain": "link:../../deepseek-harness/packages/support/storage-domain"` 与 `"@deepseek-ai/dsh-host-webserver": "link:../../deepseek-harness/packages/host/webserver"`——确切相对路径先 `Test-Path` 核实，照 token-usage 的 package.json 抄）
- Modify: `packages/agent-team/src/index.ts`（整体重写）
- Test: `packages/agent-team/tests/integration.test.ts`（整体重写；fixtures 不变）

**Interfaces:**
- Consumes: `loadTeams`/`Team`（`./roles.ts`）；`createDelegateTool`（`./tool.ts`）；`createTeamState`/`isSessionBlank`/`teamOption`/`TeamState`（`./teams.ts`）；`TeamStateView`/`SelectTeamRequest`（`./types.ts`）。
- Produces:
  - `name = 'agent-team'`、`inject = ['tools', 'subagents', 'systemPrompt', 'storageDomain']`
  - `Config` 不变（teamsDir/defaultTeam/provider/toolName/promptTemplates）
  - `apply(ctx, config): Promise<void>`（异步；teams/ 读不到、defaultTeam 未命中、storageDomain 打开失败即抛错 → preset 挂载被拒）
  - 每会话两条 HTTP 路由（路径含 sessionId）：`GET /agent-team/<sid>/state` → 200 `TeamStateView`；`POST /agent-team/<sid>/select`（body `SelectTeamRequest`）→ 200 `TeamStateView` / 400 未知团队 / 409 已锁定

**已钉死的宿主 API**（照抄先例，非占位）：
- KV：`ctx.storageDomain.open(domain)` → `domain.table('selectedTeam')` 得 `KvTable<string,string>`（`get` 同步、`put` 返回 Promise）；domain 声明 `defineDomain({ name, version, tables: { selectedTeam: domainTable<string, string>(zod.string()) } })`，**domain 名受 `^[a-z][a-z0-9_]*$` 约束，禁用连字符**（先例：`packages/token-usage/src/store.ts:32-37`、用法 `packages/token-usage/src/index.ts:33-36`）。
- webServer：`ctx.inject(['webServer'], webCtx => { webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler }), 'label') })`；handler 是原生 Node `(req, res)`，`res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))`（先例：`packages/token-usage/src/index.ts:84-105`）。webServer 是可选服务，**不进顶层 inject**。
- 会话身份与事件：`ctx.agent.session.id`（`SessionId`，`String()` 化进路径）、`ctx.agent.session.events`（`core/session/src/index.ts:446` 起）。

- [ ] **Step 1: 重写集成测试（先失败）**

```ts
// packages/agent-team/tests/integration.test.ts（整体替换）
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { apply, type Config } from '../src/index.ts'
import type { TeamStateView } from '../src/types.ts'

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'team-preset')

interface RegisteredTool { name: string; description: string }
type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeCtx(events: SessionEvent[], baseUrl?: string, opts: { webServer?: boolean; kv?: Map<string, string> } = {}) {
  const tools: RegisteredTool[] = []
  const sections: { name: string; order: number; text: unknown }[] = []
  const routes = new Map<string, Handler>()
  const kv = opts.kv ?? new Map<string, string>()
  const agent = { session: { id: 's1', events } }
  const services: Record<string, unknown> = {
    ...(opts.webServer === false ? {} : {
      webServer: {
        register: (route: { kind: string; path: string; handler: Handler }) => {
          routes.set(route.path, route.handler)
          return () => { routes.delete(route.path) }
        },
      },
    }),
  }
  const table = { get: (k: string) => kv.get(k), put: async (k: string, v: string) => { kv.set(k, v) } }
  const ctx = {
    baseUrl,
    agent,
    tools: { register: (tool: RegisteredTool) => { tools.push(tool); return () => {} } },
    systemPrompt: { section: (s: { name: string; order: number; text: unknown }) => { sections.push(s); return () => {} } },
    subagents: { start: async () => { throw new Error('integration test 不发起真实委派') } },
    storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
    inject: (names: string[], cb: (c: unknown) => void) => {
      const service = services[names[0]]
      if (service !== undefined) cb({ ...ctx, [names[0]]: service })
    },
    logger: { info: () => {}, warn: () => {} },
  }
  return { ctx: ctx as unknown as Context, tools, sections, routes, kv, agent }
}

const presetUrl = () => pathToFileURL(FIXTURE_DIR + '/').href

function fakeReqRes(method: string, body?: unknown) {
  const req = {
    method,
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  const res = {
    status: 0,
    body: '',
    writeHead(status: number) { res.status = status; return res },
    end(chunk?: string) { if (chunk !== undefined) res.body += chunk; return res },
  }
  return { req, res }
}

async function callRoute(routes: Map<string, Handler>, path: string, method: string, body?: unknown) {
  const handler = routes.get(path)
  expect(handler, `路由已注册：${path}`).toBeDefined()
  const { req, res } = fakeReqRes(method, body)
  await handler!(req, res)
  return { status: res.status, json: res.body === '' ? undefined : JSON.parse(res.body) as TeamStateView & { error?: string } }
}

test('激活：注册 team_delegate（默认团队名册入 description）、state/select 路由与提示段', async () => {
  const { ctx, tools, sections, routes } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(tools[0].description).toContain('reviewer: 代码审查员')   // 默认团队 = 字典序首个 alpha
  expect(tools[0].description).not.toContain('researcher')
  expect([...routes.keys()].sort()).toEqual(['/agent-team/s1/select', '/agent-team/s1/state'])
  expect(sections).toHaveLength(1)
  expect(String(sections[0].text)).toContain('team_delegate')
})

test('GET state：返回当前团队与选项摘要', async () => {
  const { ctx, routes } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/state', 'GET')
  expect(status).toBe(200)
  expect(json).toEqual({
    currentId: 'alpha',
    options: [{ id: 'alpha', summary: '代码审查员' }, { id: 'beta', summary: '资料调研与分析' }],
  })
})

test('POST select 成功：工具重注册（description 含新名册）、KV 写入、返回新视图', async () => {
  const { ctx, tools, routes, kv } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  expect(status).toBe(200)
  expect(json?.currentId).toBe('beta')
  expect(tools).toHaveLength(2)                                   // 重注册产物
  expect(tools[1].description).toContain('researcher: 资料调研与分析')
  expect(kv.get('s1')).toBe('beta')
})

test('POST select 同团队：200 但不重注册、不写 KV', async () => {
  const { ctx, tools, routes, kv } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const { status } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'alpha' })
  expect(status).toBe(200)
  expect(tools).toHaveLength(1)
  expect(kv.has('s1')).toBe(false)
})

test('POST select 未知团队：400 列出可用团队，不重注册', async () => {
  const { ctx, tools, routes } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'ghost' })
  expect(status).toBe(400)
  expect(json?.error).toContain('alpha, beta')
  expect(tools).toHaveLength(1)
})

test('POST select 会话已开始：409 锁定，不重注册、不写 KV', async () => {
  const events = [{ type: 'turn/start', data: {} } as SessionEvent]
  const { ctx, tools, routes, kv } = fakeCtx(events, presetUrl())
  await apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  expect(status).toBe(409)
  expect(json?.error).toContain('锁定')
  expect(tools).toHaveLength(1)
  expect(kv.has('s1')).toBe(false)
})

test('冷恢复：KV 已有选择时初始团队跟随（工具名册与 GET state）', async () => {
  const { ctx, tools, routes } = fakeCtx([], presetUrl(), { kv: new Map([['s1', 'beta']]) })
  await apply(ctx, {} as Config)
  expect(tools[0].description).toContain('researcher')
  const { json } = await callRoute(routes, '/agent-team/s1/state', 'GET')
  expect(json?.currentId).toBe('beta')
})

test('defaultTeam 命中时作为初始团队；未命中时激活失败', async () => {
  const ok = fakeCtx([], presetUrl())
  await apply(ok.ctx, { defaultTeam: 'beta' } as Config)
  expect(ok.tools[0].description).toContain('researcher: 资料调研与分析')
  const bad = fakeCtx([], presetUrl())
  await expect(apply(bad.ctx, { defaultTeam: 'ghost' } as Config)).rejects.toThrowError(/ghost/)
})

test('teamsDir 指向缺失目录时激活失败', async () => {
  const { ctx } = fakeCtx([], presetUrl())
  await expect(apply(ctx, { teamsDir: './missing' } as Config)).rejects.toThrowError(/missing/)
})

test('无 webServer 服务（headless）：激活成功，无路由，工具与提示段在', async () => {
  const { ctx, tools, sections, routes } = fakeCtx([], presetUrl(), { webServer: false })
  await apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(sections).toHaveLength(1)
  expect(routes.size).toBe(0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm install; pnpm --filter agent-team test`
Expected: FAIL（新符号未导出/旧断言引用已删除的 /team 命令与投影）

- [ ] **Step 3: 整体重写 src/index.ts**

```ts
/** agent-team 插件：团队 = preset 内 teams/ 名册，主 Agent 经 team_delegate 一次性委派角色成员。 */
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { buildMemberPersona } from './prompt.ts'
import { loadTeams, type Team } from './roles.ts'
import { createTeamState, isSessionBlank, teamOption, type TeamState } from './teams.ts'
import type { SelectTeamRequest, TeamStateView } from './types.ts'

export const name = 'agent-team'

export const inject = ['tools', 'subagents', 'systemPrompt', 'storageDomain']

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

/** 团队选择存储域：key = sessionId，value = teamId。domain 名受 ^[a-z][a-z0-9_]*$ 约束（禁用连字符）。 */
const teamDomain = defineDomain({
  name: 'agent_team',
  version: 1,
  tables: { selectedTeam: domainTable<string, string>(zod.string()) },
})

/** 把 teamsDir 解析为绝对路径：绝对路径原样，相对路径基于 preset 目录（ctx.baseUrl）。 */
function resolveTeamsPath(teamsDir: string, baseUrl: string | undefined): string {
  if (isAbsolute(teamsDir)) return teamsDir
  if (baseUrl === undefined) {
    throw new Error('agent-team: 无法解析相对 teamsDir——ctx.baseUrl 为空（插件应由 preset 挂载）')
  }
  return fileURLToPath(new URL(teamsDir, baseUrl))
}

/** 当前团队视图：GET/POST 的响应体。 */
function viewOf(state: TeamState): TeamStateView {
  return { currentId: state.current.id, options: state.teams.map(teamOption) }
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

/** 读 POST 请求的 JSON body；解析失败返回 undefined。 */
async function readJsonBody(req: AsyncIterable<unknown>): Promise<unknown> {
  const chunks: string[] = []
  for await (const chunk of req) chunks.push(String(chunk))
  try {
    return JSON.parse(chunks.join(''))
  } catch {
    return undefined
  }
}

/**
 * 注册每会话的 state/select 两条 HTTP 路由（路径含 sessionId，多会话互不干扰，
 * fiber 卸载时 cordis 自动摘除）。webServer 是可选能力（headless 无此服务），
 * 走 ctx.inject 条件注册，token-usage 同款（packages/token-usage/src/index.ts:84-105）。
 */
function installTeamRoutes(ctx: Context, sessionId: string, state: TeamState, table: KvTable<string, string>, reinstall: () => void): void {
  ctx.inject(['webServer'], (webCtx: Context) => {
    const base = `/agent-team/${encodeURIComponent(sessionId)}`
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${base}/state`,
      handler: async (req: { method?: string }, res: { writeHead(s: number, h?: Record<string, string>): unknown; end(c?: string): unknown }) => {
        if (req.method !== 'GET') { res.writeHead(405).end(); return }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(viewOf(state)))
      },
    }), 'agent-team: state route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: `${base}/select`,
      handler: async (req: { method?: string } & AsyncIterable<unknown>, res: { writeHead(s: number, h?: Record<string, string>): unknown; end(c?: string): unknown }) => {
        if (req.method !== 'POST') { res.writeHead(405).end(); return }
        const fail = (status: number, error: string) =>
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error }))
        const body = await readJsonBody(req)
        const team = (body as Partial<SelectTeamRequest> | undefined)?.team
        if (typeof team !== 'string') { fail(400, '请求体缺 team 字段或不是 JSON'); return }
        const events = ctx.agent.session.events
        if (!isSessionBlank(events)) { fail(409, '会话已开始，团队已锁定'); return }
        const outcome = state.trySelect(team, events)
        if (!outcome.ok) { fail(400, outcome.error); return }
        if (outcome.changed) {
          reinstall()
          await table.put(sessionId, team)
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(viewOf(state)))
      },
    }), 'agent-team: select route')
  })
}

/**
 * 激活：读名册 → 开 KV → 建团队状态（KV 冷恢复）→ 注册委派工具、HTTP 路由与团队介绍段。
 * 直接 apply() 绕过 Schemastery 默认值，这里手动补默认（内置 tool-subagent 同款防御）。
 * teams/ 缺失/非法、defaultTeam 未命中或 storageDomain 打开失败时抛错：
 * fiber FAILED，preset 挂载被拒并标记 broken。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const teamsDir = config.teamsDir ?? './teams'
  const provider = config.provider ?? 'spawn'
  const toolName = config.toolName ?? 'team_delegate'
  const teams = await loadTeams(resolveTeamsPath(teamsDir, ctx.baseUrl))
  if (config.defaultTeam !== undefined && !teams.some(t => t.id === config.defaultTeam)) {
    throw new Error(`agent-team: defaultTeam "${config.defaultTeam}" 不在名册中（可用：${teams.map(t => t.id).join(', ')}）`)
  }
  const domain = await ctx.storageDomain.open(teamDomain)
  const table: KvTable<string, string> = domain.table('selectedTeam')
  ctx.effect(() => async () => { await domain.close() })
  const sessionId = String(ctx.agent.session.id)
  const state = createTeamState({
    teams,
    defaultTeamId: config.defaultTeam,
    initialId: table.get(sessionId),
  })
  let disposeTool = registerDelegateTool(ctx, toolName, provider, state.current, config)
  installTeamRoutes(ctx, sessionId, state, table, () => {
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

> 注：① `defineDomain`/`domainTable`/`KvTable` 的确切泛型签名以 `deepseek-harness/packages/support/storage-domain/src`（路径先核实）与 token-usage `src/store.ts:32-37` 为准微调。② `ctx.agent.session` 的类型面以 `core/agent/src/index.ts` 为准；若 preset scope 的 `ctx.agent` 需要经别的属性到达，按真实类型修正（集成测试 fake 同步跟随），不得改变断言语义。③ handler 的 req/res 类型：与 token-usage 一致按结构化最小类型声明；若 webServer 包导出了 handler 类型则优先 import。④ `table.get` 同步、`table.put` 返回 Promise（token-usage `src/index.ts:51` 同款用法）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test`
Expected: PASS（integration 10 + 既有全部）

- [ ] **Step 5: 类型检查 + Commit**

Run: `pnpm --filter agent-team typecheck`

```bash
git add packages/agent-team/package.json packages/agent-team/src packages/agent-team/tests pnpm-lock.yaml
git commit -m "feat(agent-team): 插件入口 v2——HTTP state/select 路由 + KV 冷恢复（去 /team 命令与投影）"
```

---

### Task 7: 浏览器半 TeamDock v2（HTTP 数据源）

**Files:**
- Modify: `packages/agent-team/src/client/index.ts`（改为 fetch 注入）
- Modify: `packages/agent-team/src/client/TeamDock.tsx`（投影改为 fetchState/selectTeam）
- Test: `packages/agent-team/tests/team-dock.client.spec.tsx`（整体重写）
- 不变: `packages/agent-team/src/client/TeamDock.module.css`

**Interfaces:**
- Consumes: `TeamStateView`/`SelectTeamRequest`（`../types.ts`，type-only）；槽位 `conversation.input.dock`（ui-conversation 声明，type-only 合并 SlotMap）。
- Produces: 浏览器半 `apply`：dock 注册 `id: 'team'`、`order: -10`；组件 `TeamDock` props = `PropsRuntime<'conversation.input.dock'> & TeamDockInjected`，`TeamDockInjected = { fetchState: () => Promise<TeamStateView | null>; selectTeam: (team: string) => Promise<TeamStateView> }`。

- [ ] **Step 1: 重写失败测试（jsdom，props 直接喂桩）**

```tsx
// packages/agent-team/tests/team-dock.client.spec.tsx（整体替换）
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TeamDock, type TeamDockProps } from '../src/client/TeamDock.tsx'
import type { TeamStateView } from '../src/types.ts'

afterEach(cleanup)

const STATE: TeamStateView = {
  currentId: 'alpha',
  options: [
    { id: 'alpha', summary: '代码审查员' },
    { id: 'beta', summary: '资料调研与分析' },
  ],
}

function propsOf(state: TeamStateView | null, blank: boolean, selectTeam?: TeamDockProps['selectTeam']) {
  return {
    useSession: (selector: (s: { blank: boolean }) => unknown) => selector({ blank }),
    fetchState: vi.fn(async () => state),
    selectTeam: selectTeam ?? vi.fn(async (team: string) => ({ ...state!, currentId: team })),
  } as unknown as TeamDockProps
}

test('非团队会话（fetchState 返回 null）时不渲染', async () => {
  const props = propsOf(null, true)
  const { container } = render(<TeamDock {...props} />)
  await waitFor(() => expect(props.fetchState).toHaveBeenCalled())
  expect(container.firstChild).toBeNull()
})

test('渲染团队下拉：当前值选中，选项带摘要，blank 期可用', async () => {
  render(<TeamDock {...propsOf(STATE, true)} />)
  const select = await screen.findByRole('combobox') as HTMLSelectElement
  expect(select.value).toBe('alpha')
  expect(screen.getByText('beta · 资料调研与分析')).toBeTruthy()
  expect(select.disabled).toBe(false)
})

test('选择团队成功：selectTeam 被调，UI 更新为新团队', async () => {
  const props = propsOf(STATE, true)
  render(<TeamDock {...props} />)
  const select = await screen.findByRole('combobox') as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'beta' } })
  await waitFor(() => expect(props.selectTeam).toHaveBeenCalledWith('beta'))
  await waitFor(() => expect(select.value).toBe('beta'))
})

test('选择失败（如锁定 409）：回退原值并在 title 显示错误', async () => {
  const selectTeam = vi.fn(async () => { throw new Error('会话已开始，团队已锁定') })
  render(<TeamDock {...propsOf(STATE, true, selectTeam)} />)
  const select = await screen.findByRole('combobox') as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'beta' } })
  await waitFor(() => expect(select.title).toContain('锁定'))
  expect(select.value).toBe('alpha')
})

test('会话已开始时禁用并提示锁定', async () => {
  render(<TeamDock {...propsOf(STATE, false)} />)
  const select = await screen.findByRole('combobox') as HTMLSelectElement
  expect(select.disabled).toBe(true)
  expect(select.title).toContain('锁定')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter agent-team test`
Expected: FAIL（props 签名不匹配/元素缺失）

- [ ] **Step 3: 重写 TeamDock.tsx 与 client/index.ts**

```tsx
// packages/agent-team/src/client/TeamDock.tsx（整体替换）
/** 团队选择 dock：blank 期可切，首条消息后锁定；数据来自插件 HTTP 端点（fetch 封装经 inject 面注入）。 */
import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TeamStateView } from '../types.ts'
import css from './TeamDock.module.css'

/** inject 面：团队状态读取与切换提交。 */
export interface TeamDockInjected {
  /** 读当前团队状态；非团队会话（插件未挂载）返回 null。 */
  readonly fetchState: () => Promise<TeamStateView | null>
  /** 提交团队选择；失败 reject（错误文本为宿主返回的 error）。 */
  readonly selectTeam: (team: string) => Promise<TeamStateView>
}

export type TeamDockProps = PropsRuntime<'conversation.input.dock'> & TeamDockInjected

export function TeamDock({ useSession, fetchState, selectTeam }: TeamDockProps) {
  const blank = useSession(s => s.blank)
  const [view, setView] = useState<TeamStateView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    fetchState()
      .then(v => { if (live) { setView(v); setLoaded(true) } })
      .catch(() => { if (live) setLoaded(true) }) // 端点故障等同无团队：不渲染
      return () => { live = false }
  }, [fetchState])
  if (!loaded || view === null) return null
  const onChange = (team: string) => {
    setError(null)
    // select 是受控组件：成功前 view 不变即视觉回退；失败仅提示。
    selectTeam(team).then(setView).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    })
  }
  return (
    <div className={css.dock}>
      <span className={css.label}>团队</span>
      <select
        className={css.select}
        value={view.currentId}
        disabled={!blank}
        title={blank ? (error ?? '选择本会话使用的团队') : '会话已开始，团队已锁定'}
        onChange={event => onChange(event.target.value)}
      >
        {view.options.map(option => (
          <option key={option.id} value={option.id}>{option.id} · {option.summary}</option>
        ))}
      </select>
    </div>
  )
}
```

```ts
// packages/agent-team/src/client/index.ts（整体替换）
/** agent-team 浏览器半：在 conversation.input.dock 注册团队选择下拉（数据走插件 HTTP 端点）。 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// 触发 ui-conversation 对 SlotMap 的声明合并（conversation.input.dock 键）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TeamDock } from './TeamDock.tsx'
import type { SelectTeamRequest, TeamStateView } from '../types.ts'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  // inject() 等 ui-conversation 声明该槽位后再注册，声明消失自动回滚。
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'team',
        order: -10, // 现有 occupant：todo=0、goal=10、queue=20；负值栈顶
        inject: (sessionId: SessionId) => {
          const base = `/agent-team/${encodeURIComponent(String(sessionId))}`
          return {
            fetchState: async (): Promise<TeamStateView | null> => {
              const res = await fetch(`${base}/state`)
              if (res.status === 404) return null // 非团队会话：插件未挂载，路由不存在
              if (!res.ok) throw new Error(`agent-team state: HTTP ${res.status}`)
              return await res.json() as TeamStateView
            },
            selectTeam: async (team: string): Promise<TeamStateView> => {
              const res = await fetch(`${base}/select`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ team } satisfies SelectTeamRequest),
              })
              const body = await res.json() as TeamStateView & { error?: string }
              if (!res.ok) throw new Error(body.error ?? `agent-team select: HTTP ${res.status}`)
              return body
            },
          }
        },
      },
      TeamDock,
    ))
}
```

> 注：`PropsRuntime<'conversation.input.dock'>` 的 `useSession` 面与 Task 1 占位相同；`SessionId` 的字符串化以 `client/runtime` 的 brand 定义为准（`String()` 兜底）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter agent-team test`
Expected: PASS（team-dock 5 个测试 + 既有全部）

- [ ] **Step 5: 类型检查 + bundle**

Run: `pnpm --filter agent-team typecheck; pnpm --filter agent-team bundle`
Expected: 无错误；`lib/client.js` 含 TeamDock 注册代码

- [ ] **Step 6: Commit**

```bash
git add packages/agent-team/src/client packages/agent-team/tests/team-dock.client.spec.tsx
git commit -m "feat(agent-team): 浏览器半 TeamDock v2（HTTP fetchState/selectTeam，blank 锁定）"
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
- [ ] **dock 下拉（§7.1）**：输入框正上方出现团队下拉（位于 todo/goal/queue 条之上），当前值 = default（字典序首个），选项带摘要；非团队 preset 会话不出现该下拉（GET state 404）
- [ ] **切换团队**：下拉选 review → 下拉当前值变 review（无命令回执行）；让主 Agent 委派 → 工具 description 已是 review 名册（模型只见到 reviewer/tester）
- [ ] **锁定**：发送第一条消息后下拉禁用且 tooltip 提示锁定；`curl -X POST http://<host>/agent-team/<sid>/select -d '{"team":"default"}'` 返回 409 "会话已开始，团队已锁定"
- [ ] **委派卡片（§7.3）**：待定态卡片标题显示「委派 · reviewer: <短标签>」，展开 IN 区显示任务书原文；完成后标题保留、OUT 区显示成员最终文本
- [ ] **子代理目录（§7.4）**：成员运行期间会话页头子代理目录按钮出现 `role:reviewer: <短标签>` 条目，父会话行带蓝色活动指示器；点击条目进入子会话可见成员完整工具流
- [ ] **错误行（§7.3）**：让主 Agent 委派不存在的角色 → 红色错误行，首行显示"未知角色 … 可用角色：…"
- [ ] **冷恢复（KV）**：blank 期切到 review → 刷新页面重开会话 → 下拉当前值仍为 review，工具名册跟随；已开始会话刷新后下拉显示锁定团队且禁用
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

- **spec 覆盖**（v2）：spec §2 包结构 → Task 1/6/7/8；§3 Config → Task 6；§4 teams/ 名册 → Task 2；§5 两层提示词 → Task 3；§6 工具契约 → Task 4；§7.1 dock → Task 7；§7.2 状态机 + HTTP 通道 + KV → Task 5/6（工具重注册断言在 Task 6 集成测试钉死，浏览器半加载 spike 在 Task 8 Step 3 首项）；§7.3 presenter → Task 4；§7.4 子代理目录 → Task 8 手动清单；§7.5 旅程 → Task 8 手动清单；§8 错误处理 → Task 2/4/5/6 测试逐条对应；§9 发行 → Task 8（user root 路径）；§10 测试策略 → Task 2/4/5/6 单测 + 集成测试 + Task 7 组件测试 + Task 8 手动清单；§11 范围之外 → 计划中无对应任务。
- **类型一致性**（v2）：`Role`/`Team`/`PromptTemplates`/`DelegateToolDeps`/`TeamState`/`SelectOutcome`/`TeamOption`/`TeamStateView`/`SelectTeamRequest`/`buildMemberPersona(role, model, templates)`/`createDelegateTool(toolName, deps)`/`createTeamState({teams, defaultTeamId, initialId})` 在 Task 2-7 间签名一致；`TeamDockProps` 消费 `PropsRuntime<'conversation.input.dock'>` + `TeamDockInjected`（`fetchState`/`selectTeam`），与 client/index.ts 的 inject 面一致。
- **已知实现期核实点**（非占位符，均有确切位置）：①`defineDomain`/`KvTable` 泛型签名与 storage-domain 包相对路径（Task 6 注①，token-usage `src/store.ts:32-37` 先例）；②preset scope 的 `ctx.agent.session` 类型面（Task 6 注②）；③`SubagentStartRequest` 字段（Task 4 注）；④`PropsRuntime` 钩子面与 `SessionId` 字符串化（Task 7 注）；⑤preset 插件浏览器半加载（Task 8 spike，含备选）；⑥`$DSH_HOME` 实际布局（Task 8 Step 2）。
- **v1 → v2 变更记录**：删除 `/team` 命令、`team/selected` 会话事件、`team` 会话投影、SessionEventMap/投影图合并（v1 Task 5/6 曾落地，v2 Task 5/6 移除）；新增 storageDomain KV 持久化与每会话 HTTP GET/POST 路由；浏览器半从"读投影 + session.command"改为"fetchState/selectTeam 注入"。

---

## v3 返工任务（取代 v2 Task 6/8 相应内容；Task 1/2/3/5/7 产物沿用）

### Task 4b: team_delegate 静态 description + 按会话校验

**Files:**
- Modify: `packages/agent-team/src/tool.ts`
- Modify: `packages/agent-team/tests/tool.spec.ts`（或现有工具测试文件名）

- [x] **Step 1: 失败测试**——① description 为静态常量：含委派语义（成员看不到本对话、任务须自包含、`role` 须命中当前会话团队、可用成员见系统提示团队段）且**不含任何具体名册**；② execute 经 `deps.currentTeamFor(agent)` 取该会话团队校验 role：未命中 → 报错列出**该团队**角色名；③ 两个不同 agent 返回不同团队时各自按自己团队校验。

- [x] **Step 2: 改 `DelegateToolDeps`**——`roles: readonly Role[]` 替换为：

```ts
/** 返回调用方会话的当前团队（standing 共享注册下按 exec.agent 解析；懒建保证不空）。 */
currentTeamFor: (agent: Agent) => Team
```

- execute 内：`const agent = exec.agent; if (!agent) throw …`（原断言保留）→ `const team = deps.currentTeamFor(agent)` → `team.roles.find(r => r.name === args.role)`，未命中报错列 `team.roles` 名字。persona 拼装、spawn、结果收集不变。
- description 静态文本（单常量，中文或英文与现有风格一致），要点：委派给当前团队成员；成员看不到本对话、任务书须自包含；`role` 必须命中当前会话团队的成员；可用成员名单见系统提示的团队段。

- [x] **Step 3: 跑测试至绿；Step 4: `pnpm --filter agent-team test && pnpm --filter agent-team typecheck`；Step 5: Commit** `refactor(agent-team): team_delegate 静态 description 与按会话团队校验`

### Task 6b: index.ts standing 语义重写

**Files:**
- Modify: `packages/agent-team/src/index.ts`、`packages/agent-team/tests/*.spec.ts`（集成测试重写）
- Modify: `packages/agent-team/package.json`（Config 说明注释，如有）

- [x] **Step 1: 失败集成测试**——① 挂载后工具仅注册一次、description 静态；② 注册的 prompt section 的 `text` 为函数：以带 `agent` 的 AssembleContext 调用 → 文案含该会话当前团队名册（每角色一行 `name: description`）；无 `agent` 时返回通用介绍不抛错；③ GET `/agent-team/<sid>/state` 惰性建态返回 200；④ POST select 切 team2 → 同 sid 再调 section text → 名册变为 team2，工具注册不变；⑤ 两个不同 sid 各自独立切换互不影响；⑥ 已发 `turn/start` 的会话 POST → 409；⑦ 模拟 `session/disposed` → 该 sid 状态清除（再 GET 重新懒建）；⑧ KV 冷恢复：写 KV 后新挂载代 GET 返回已选团队；⑨ `clientOnly: true` 挂载 → 无工具/路由/提示段注册。

- [x] **Step 2: 重写 apply**：

```ts
export function apply(ctx: Context, config: Config) {
  if (config.clientOnly) return        // 全局挂载点：仅让浏览器半 bundle 进 boot 清单
  // inject 增加 'sessions'（SessionStore）；禁止触碰 ctx.agent
}
```

- `Map<string, TeamState>`（key = sessionId 字符串）；`stateFor(sid)` 懒建：initialId = KV 命中 ?? Config.defaultTeam ?? 字典序首个；`currentTeamFor(agent)` 闭包供工具。
- HTTP：`ctx.inject(['webServer'], …)` 内注册**一条** `{ kind: 'prefix', path: '/agent-team', handler }`（`webserver/src/index.ts:28-33,241-249`；path 无尾斜杠）。handler：`new URL(req.url ?? '', 'http://localhost').pathname` 去掉 `/agent-team/` 前缀 → `<sid>/state`（GET）/`<sid>/select`（POST），其余 → 404。POST blank 检查：`ctx.sessions.get(<SessionId>)?.events` 走 `isSessionBlank`；会话不存在按 blank 处理（尚未产生事件）。
- prompt section：`text: (context) => …` 函数形式；`context.agent` 缺省返回通用文案。
- `ctx.on('session/disposed', ({ session }) => states.delete(String(session.id)))`。
- 保留：KV 模块级共享单例 + refcount、provider 能力 mount 期校验、loadTeams fail loud。
- 移除：`ctx.agent!` 用法、每会话 exact 路由、切换时工具重注册。

- [x] **Step 3: 跑测试至绿；Step 4: 全量 `test` + `typecheck`；Step 5: Commit** `fix(agent-team): standing scope 语义——按会话懒建态、prefix 路由、prompt 段动态名册`

### Task 8b: 默认名册 opencode 化 + 双挂载点接入

**Files:**
- Modify: `packages/agent-team/presets/team/teams/default.yml`
- Delete: `packages/agent-team/presets/team/teams/review.yml`（及引用它的文档/注释）
- Modify: `cordis.yml`（仓库根，开发 patch）
- 文件系统：重新同步 `C:\Users\Eson\.dsh\.agent-presets\team\`（含删旧 review.yml）

- [x] **Step 1: default.yml 重写为两角色**（persona 用中文，与 spec §4 格式一致；description 为主 Agent 选角唯一依据，写清分工边界）：
  - `explorer`：快速只读代码库探索——定位文件/符号、回答结构与调用关系问题，不修改文件；persona 强调只读、结论附路径行号。
  - `general`：通用多步骤任务执行——可读可写、跑命令，完成实现/修复类任务；persona 强调动手前读 AGENTS.md、完成后跑相关检查。
- [x] **Step 2: 删 review.yml**；grep 全仓确认无残留引用（文档中提及示例名册处同步更新）。
- [x] **Step 3: cordis.yml 追加全局挂载行**：

```yaml
- name: D:\work\github\dsh\dsh-agent-toolkit\packages\agent-team
  config:
    clientOnly: true
```

- [x] **Step 4: 同步 user preset root**（覆盖复制 presets/team → `C:\Users\Eson\.dsh\.agent-presets\team`，删除其中旧 review.yml）；手动验证清单更新：dock 打开页面即在（无需建会话后刷新）；激活失败反馈看 chip hover title。
- [x] **Step 5: Commit** `feat(agent-team): 默认团队 explorer+general；cordis.yml 全局 clientOnly 挂载`

### Task 9b: 文档增量

- [x] AGENTS.md：agent-team 条目补——双挂载点（preset 行真实工作 + cordis.yml 全局 `clientOnly: true` 行供浏览器半进 boot 清单）；默认团队 explorer/general；激活失败反馈位置（chip hover title）。
- [x] 插件 README（如已有）：Config 增 `clientOnly` 行；安装步骤加 cordis.yml 全局行。
- [x] Commit `docs: agent-team v3 接入方式与默认名册`

## v3 Self-Review 记录

- **spec 覆盖**（v3）：§1 standing/双挂载点 → Task 6b/8b；§3 `clientOnly` → Task 6b；§6 静态 description + section 动态名册 → Task 4b/6b；§7.2 Map 懒建/prefix 路由/session-disposed → Task 6b；§7.5 失败反馈修正 → Task 8b 手动清单；§9 发行③ → Task 8b Step 3；§10 测试策略 → Task 4b/6b 测试。
- **类型一致性**（v3）：`DelegateToolDeps.currentTeamFor(agent): Team` 由 Task 4b 定义、Task 6b 提供闭包实现；`TeamState`/`Team` 复用 Task 3/2 产物。
- **已钉死的宿主事实**（v3 调研实证）：`WebRoute = { kind, path, handler }`、prefix 最长优先（`webserver/src/index.ts:24-33,241-249`）；section text 函数按 `AssembleContext.agent` 求值（`system-prompt/src/index.ts:67,514`、`dispatch.ts:174-176`）；`ctx.sessions.get`（`core/session/src/index.ts:1055-1057`）；standing scope 共享语义（`agent-presets/src/index.ts:491-534`）；client-modules 扫描要求活 fiber 且递归扫 loader subtree（实证 graph() 含 preset 内插件）。
