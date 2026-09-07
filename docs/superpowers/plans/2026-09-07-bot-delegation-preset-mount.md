# bot 会话挂 preset 修复委派子会话工具继承 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bot 会话改挂 toolkit 启动生成的最小 preset `agent-bot`（内容 = BASIC_TOOLS 5 行），使宿主 spawn 驱动的 `composeFrom` 能认父，委派子会话继承同一组合；`agentPresets` 缺席或 mount 失败时回退现有 `bots-tools` standing scope（bot 可用性优先）。

**Architecture:** `team-preset.ts` 启动生成机制扩出第二个 preset（`botsId`，composition 由新模块 `bot-preset.ts` 从 `BASIC_TOOLS` 常量序列化）；`setupAgentScope` 第三参泛化为 `ScopeJoiner`；bots 模块构造 preset 优先 joiner（`scope-joiner.ts`：join 时惰性 `ctx.get('agentPresets')` → `mount` → 失败 warn 回退 `toolsScope`）。join 之后的 persona/sections/restrict 全部不变。

**Tech Stack:** TypeScript / vitest / js-yaml / cordis / 真实 `@deepseek-ai/dsh-agent-presets`（守护测试）。

**Spec:** `docs/superpowers/specs/2026-09-07-bot-delegation-preset-mount-design.md`

## Global Constraints

- 仓库根：`D:\work\github\dsh\dsh-agent-toolkit`；包：`packages/toolkit`（npm 名 `dsh-agent-toolkit`）。
- bot 会话工具面零变化：agent-bot composition 与 `BASIC_TOOLS` 一一对应，序列化单一来源是 `BASIC_TOOLS` 常量，不维护第二份文本。
- 回退语义：`agentPresets` 服务缺席（rc2 旧宿主）静默回退；`mount` 抛错 warn（文案含"委派子会话将看不到基础工具"）后回退。会话创建绝不因 preset 问题失败。
- 单测命令：`pnpm --filter dsh-agent-toolkit test`；类型检查：`pnpm --filter dsh-agent-toolkit typecheck`；构建：`pnpm --filter dsh-agent-toolkit bundle`（src 改动后必须跑）。usage 包无改动。
- 所有 `git commit` 步骤仅在用户当场确认后执行；执行者不得自行提交。

---

### Task 1: Config 增加 `agentTeamPreset.botsId`

**Files:**
- Modify: `packages/toolkit/src/index.ts:100-112`（agentTeamPreset schema 与 `.default({...})` 字面量）
- Test: `packages/toolkit/src/index.test.ts`（`Config({})` 全量默认值断言，约 line 140）

**Interfaces:**
- Produces: `AgentTeamPresetConfig.botsId: string`（默认 `'agent-bot'`）；Task 3 生成与 Task 4 接线共用。

- [ ] **Step 1: 改失败测试** — `index.test.ts` 中 `expect(config.agentTeamPreset).toEqual({...})` 对象字面量加一行 `botsId: 'agent-bot',`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/index.test.ts`
Expected: FAIL（`toEqual` 多出 `botsId` 键）

- [ ] **Step 3: 实现** — `index.ts` agentTeamPreset schema 的 `description` 行后加 `botsId: z.string().default('agent-bot'),`，下方 `.default({...})` 字面量同步加 `botsId: 'agent-bot',`。同时更新上方注释为"……；另生成 bot 会话最小 preset（botsId，委派子会话 composeFrom 认父的前提）"。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/index.ts packages/toolkit/src/index.test.ts
git commit -m "feat(toolkit): agentTeamPreset.botsId 配置项"
```

---

### Task 2: `bot-preset.ts` 组合序列化模块

**Files:**
- Create: `packages/toolkit/src/agents/bot-preset.ts`
- Test: `packages/toolkit/src/agents/bot-preset.test.ts`

**Interfaces:**
- Consumes: `BASIC_TOOLS`（`../channels/basic-tools.ts`，平台相关 shell 行已选定）。
- Produces:
  - `export function serializeBotRows(tools: readonly BasicTool[]): Record<string, unknown>[]`（纯函数，便于测试未登记映射的抛错分支）
  - `export function botPresetComposition(): string`（= `yaml.dump(serializeBotRows(BASIC_TOOLS), { lineWidth: -1 })`）
  - `export const BOT_PRESET_NAME` / `export const BOT_PRESET_DESCRIPTION`（preset.yml 元数据常量）

- [ ] **Step 1: 写失败测试** — `bot-preset.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import yaml from 'js-yaml'
import { BASIC_TOOLS } from '../channels/basic-tools.ts'
import { botPresetComposition, serializeBotRows } from './bot-preset.ts'

describe('botPresetComposition', () => {
  test('与 BASIC_TOOLS 一一对应：5 行、行 id/name/config 全对齐', () => {
    const rows = yaml.load(botPresetComposition())
    const shellId = process.platform === 'win32' ? 'tool-pwsh' : 'tool-bash'
    const shellName = process.platform === 'win32' ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash'
    expect(rows).toEqual([
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { text: 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.' } },
      { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
      { id: shellId, name: shellName },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    ])
  })

  test('行序与 BASIC_TOOLS 一致', () => {
    const rows = yaml.load(botPresetComposition()) as { name: string }[]
    expect(rows.map((r) => r.name)).toEqual(BASIC_TOOLS.map((t) => t.id))
  })
})

describe('serializeBotRows', () => {
  test('未登记映射的 BASIC_TOOLS 行：抛错（生成被 setup 层 catch 转 warn）', () => {
    expect(() => serializeBotRows([{ id: '@deepseek-ai/dsh-tool-unknown' }])).toThrow(/未登记/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/agents/bot-preset.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** — `bot-preset.ts`：

```ts
/** agent-bot preset 组合序列化：BASIC_TOOLS → preset 行（bot 会话挂载的最小组合，
 *  委派子会话 composeFrom 认父的前提；spec: docs/superpowers/specs/2026-09-07-bot-delegation-preset-mount-design.md）。 */
import yaml from 'js-yaml'
import { BASIC_TOOLS, type BasicTool } from '../channels/basic-tools.ts'

/** BASIC_TOOLS 插件包名 → preset 行 id（与 standard/agent-team 的行 id 对齐）。新增 BASIC_TOOLS 行必须在此登记。 */
const ROW_IDS: Record<string, string> = {
  '@deepseek-ai/dsh-persona': 'persona',
  '@deepseek-ai/dsh-agent-instructions': 'agent-instructions',
  '@deepseek-ai/dsh-tool-pwsh': 'tool-pwsh',
  '@deepseek-ai/dsh-tool-bash': 'tool-bash',
  '@deepseek-ai/dsh-tool-fs': 'tool-fs',
  '@deepseek-ai/dsh-tool-fs-search': 'tool-fs-search',
}

export const BOT_PRESET_NAME = 'Bot 会话'
export const BOT_PRESET_DESCRIPTION = '飞书 bot 会话组合：基础工具行（persona/instructions/shell/fs/fs-search）；委派子会话经 composeFrom 继承同一组合'

/** BASIC_TOOLS → preset 行对象数组（未登记映射的包名抛错，防新增工具行静默丢 id）。 */
export function serializeBotRows(tools: readonly BasicTool[]): Record<string, unknown>[] {
  return tools.map((tool) => {
    const rowId = ROW_IDS[tool.id]
    if (rowId === undefined) throw new Error(`bot-preset: BASIC_TOOLS 行 ${tool.id} 未登记 preset 行 id 映射`)
    return { id: rowId, name: tool.id, ...tool.config !== undefined ? { config: tool.config } : {} }
  })
}

/** agent-bot composition 文本（平台相关 shell 行已由 BASIC_TOOLS 选定，不用 !!js）。 */
export function botPresetComposition(): string {
  return yaml.dump(serializeBotRows(BASIC_TOOLS), { lineWidth: -1 })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/agents/bot-preset.test.ts`
Expected: PASS

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/agents/bot-preset.ts packages/toolkit/src/agents/bot-preset.test.ts
git commit -m "feat(toolkit): agent-bot preset 组合序列化模块"
```

---

### Task 3: `team-preset.ts` 生成第二个 preset

**Files:**
- Modify: `packages/toolkit/src/agents/team-preset.ts`
- Test: `packages/toolkit/src/agents/team-preset.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `config.botsId`；Task 2 的 `botPresetComposition()` / `BOT_PRESET_NAME` / `BOT_PRESET_DESCRIPTION`。
- Produces: `setupAgentTeamPreset` 启动时写两个 preset 目录（`config.id` 与 `config.botsId`），各自独立 try/catch、独立 marker 保护；**bot preset 不依赖源 preset 读取**（`read` 失败只跳过 agent-team，agent-bot 照写）。

- [ ] **Step 1: 写失败测试** — `team-preset.test.ts`：

- `CONFIG` 字面量加 `botsId: 'agent-bot'`；加 `const botDir = () => join(userRoot, 'agent-bot')`。
- 既有"正常路径"用例追加断言：`botDir()` 下 3 个文件；composition 以自动生成头部开头、`yaml.load` 后为 5 行（`tool-fs` 行在列）；`preset.yml` = `{ name: BOT_PRESET_NAME, description: BOT_PRESET_DESCRIPTION }`（从 bot-preset.ts 导入常量，不复刻字面量）。
- 新增用例：

```ts
test('read 失败：agent-team 跳过，agent-bot 照写（bot 组合不依赖源 preset）', async () => {
  const agentPresets = makeAgentPresets({ read: () => Promise.reject(new Error('preset "standard" not found')) })
  const { ctx, warn } = makeCtx(agentPresets)
  await setupAgentTeamPreset(ctx, CONFIG)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('preset "standard" not found'))
  await expect(readFile(join(botDir(), 'agent.cordis.yml'), 'utf8')).resolves.toContain('tool-fs')
})

test('非法 botsId：warn 跳过 agent-bot，agent-team 照常生成', async () => {
  const { ctx, warn } = makeCtx(makeAgentPresets())
  await setupAgentTeamPreset(ctx, { ...CONFIG, botsId: '../evil' })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('botsId'))
  await expect(readFile(join(targetDir(), 'agent.cordis.yml'), 'utf8')).resolves.toContain('disabled: true')
  await expect(readFile(join(userRoot, 'evil'), 'utf8')).rejects.toThrow()
})

test('agent-bot 同名用户目录保护：不覆盖，agent-team 照常生成', async () => {
  await mkdir(botDir(), { recursive: true })
  await writeFile(join(botDir(), 'keep.txt'), 'user data', 'utf8')
  const { ctx, warn } = makeCtx(makeAgentPresets())
  await setupAgentTeamPreset(ctx, CONFIG)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('不覆盖'))
  expect(await readFile(join(botDir(), 'keep.txt'), 'utf8')).toBe('user data')
  await expect(readFile(join(targetDir(), 'agent.cordis.yml'), 'utf8')).resolves.toContain('disabled: true')
})
```

- 既有 `enabled=false` / 服务缺席用例补断言：`botDir()` 同样无文件。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/agents/team-preset.test.ts`
Expected: FAIL（agent-bot 目录不存在）

- [ ] **Step 3: 实现** — `team-preset.ts`：

1. `AgentTeamPresetConfig` 接口加 `/** bot 会话挂载的最小 preset id（内容 = BASIC_TOOLS 5 行）。 */ botsId: string`。
2. 把现有"marker 保护检查 + mkdir + 写 3 文件"抽成私有助手：

```ts
/** 写一个生成 preset 目录：无标记的同名用户目录不覆盖（warn 返回 false）；marker-first 写入。 */
async function writeGeneratedPreset(dir: string, composition: string, metadata: { name: string; description: string }, warn: (msg: string) => void): Promise<boolean>
```

3. `setupAgentTeamPreset` 主体：id 校验与 agent-team 生成保持原样（走助手）；随后独立块：

```ts
  // agent-bot：bot 会话挂载的最小组合，内容来自 BASIC_TOOLS，不依赖源 preset 读取。
  if (!PRESET_ID.test(config.botsId)) {
    warn(`dsh-agent-toolkit: agentTeamPreset.botsId "${config.botsId}" 不是合法 preset id，跳过 agent-bot 生成`)
  } else {
    try {
      await writeGeneratedPreset(
        join(resolve(expandHomePath(root.path)), config.botsId),
        GENERATED_HEADER + botPresetComposition(),
        { name: BOT_PRESET_NAME, description: BOT_PRESET_DESCRIPTION },
        warn,
      )
    } catch (error) {
      warn(`dsh-agent-toolkit: 写入 agent-bot preset 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
```

注意：`root` 的解析（`roots.find(trust=user)`）要提到 agent-team 块之前供两块共用；`root` 缺席时两者都跳过（现有 warn 文案保留一处即可）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/agents/team-preset.test.ts`
Expected: PASS（含既有用例）

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/agents/team-preset.ts packages/toolkit/src/agents/team-preset.test.ts
git commit -m "feat(toolkit): 启动生成 agent-bot 最小 preset"
```

---

### Task 4: preset 优先 joiner + agent-setup 泛化 + bots 接线

**Files:**
- Create: `packages/toolkit/src/channels/scope-joiner.ts`
- Modify: `packages/toolkit/src/channels/agent-setup.ts:6,19-24`（第三参类型 `ToolsScope` → `ScopeJoiner`）
- Modify: `packages/toolkit/src/bots/index.ts:47-50,69,77,85`（`BotsDeps` 加 `botPresetId?`；构造 joiner）
- Modify: `packages/toolkit/src/index.ts:167`（下达 `botPresetId`）
- Test: `packages/toolkit/src/channels/scope-joiner.test.ts`（新）；`packages/toolkit/src/channels/agent-setup.test.ts`（回归确认）

**Interfaces:**
- Produces:
  - `export interface ScopeJoiner { join(agentCtx: Context): Promise<unknown> }`（`ToolsScope` 结构兼容：`Promise<ScopeKey>` 可赋给 `Promise<unknown>` 返回标注）
  - `export function createScopeJoiner(ctx: Context, presetId: string, fallback: ToolsScope, warn: (msg: string) => void): ScopeJoiner`
  - `BotsDeps.botPresetId?: string`（`undefined` = 不用 preset 路径，直接 toolsScope）
- Consumes: Task 1 的 `config.agentTeamPreset.botsId` / `enabled`。

- [ ] **Step 1: 写失败测试** — `scope-joiner.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createScopeJoiner } from './scope-joiner.ts'
import type { ToolsScope } from './tool-scope.ts'

function harness(agentPresets: unknown) {
  const ctx = { get: vi.fn(() => agentPresets) } as unknown as Context
  const agentCtx = { fake: 'agentCtx' } as unknown as Context
  const fallbackJoin = vi.fn(() => Promise.resolve({ origin: 'fallback' }))
  const fallback = { join: fallbackJoin, dispose: vi.fn() } as unknown as ToolsScope
  const warn = vi.fn()
  return { ctx, agentCtx, fallback, fallbackJoin, warn }
}

describe('createScopeJoiner', () => {
  test('mount 成功：挂 preset，不进回退', async () => {
    const mount = vi.fn(() => Promise.resolve({ id: 'agent-bot' }))
    const { ctx, agentCtx, fallbackJoin, warn } = harness({ mount })
    await createScopeJoiner(ctx, 'agent-bot', { join: fallbackJoin } as unknown as ToolsScope, warn).join(agentCtx)
    expect(mount).toHaveBeenCalledWith(agentCtx, 'agent-bot')
    expect(fallbackJoin).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  test('mount 抛错：warn（含 preset id 与委派缺陷提示）后回退 toolsScope', async () => {
    const mount = vi.fn(() => Promise.reject(new Error('preset "agent-bot" not found')))
    const { ctx, agentCtx, fallbackJoin, warn } = harness({ mount })
    await createScopeJoiner(ctx, 'agent-bot', { join: fallbackJoin } as unknown as ToolsScope, warn).join(agentCtx)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent-bot'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('委派子会话'))
    expect(fallbackJoin).toHaveBeenCalledWith(agentCtx)
  })

  test('agentPresets 缺席（rc2 旧宿主）：静默回退，不 warn', async () => {
    const { ctx, agentCtx, fallbackJoin, warn } = harness(undefined)
    await createScopeJoiner(ctx, 'agent-bot', { join: fallbackJoin } as unknown as ToolsScope, warn).join(agentCtx)
    expect(fallbackJoin).toHaveBeenCalledWith(agentCtx)
    expect(warn).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/scope-joiner.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`scope-joiner.ts`（新文件）：

```ts
/** preset 优先的 agent scope joiner：agentPresets 在场且 mount 成功 → 父链是 preset standing mount，
 *  宿主 spawn 驱动的 composeFrom 能认父（委派子会话继承同一组合）；失败回退 toolsScope（bot 可用性优先）。 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolsScope } from './tool-scope.ts'

/** setupAgentScope 的作用域加入策略（ToolsScope 结构兼容）。 */
export interface ScopeJoiner {
  join(agentCtx: Context): Promise<void>
}

/** agentPresets 服务的挂载面结构类型（可选服务经 ctx.get 读取，team-preset.ts AgentPresetsLike 先例）。 */
interface PresetMountLike {
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

export function createScopeJoiner(ctx: Context, presetId: string, fallback: ToolsScope, warn: (msg: string) => void): ScopeJoiner {
  return {
    async join(agentCtx) {
      // join 时惰性解析（attachments 教训：apply 期一次性捕获会吃到未注册的 undefined）。
      const agentPresets = ctx.get('agentPresets', false) as PresetMountLike | undefined
      if (agentPresets !== undefined) {
        try {
          await agentPresets.mount(agentCtx, presetId)
          return
        } catch (error) {
          warn(`dsh-agent-toolkit: bot 会话挂载 preset "${presetId}" 失败，回退基础工具 standing scope（此后该会话委派子会话将看不到基础工具）：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await fallback.join(agentCtx)
    },
  }
}
```

`agent-setup.ts`：import 换成 `import type { ScopeJoiner } from './scope-joiner.ts'`，`setupAgentScope` 第三参 `toolsScope: ToolsScope` 改为 `joiner: ScopeJoiner`，函数体 `await joiner.join(agentCtx)`；顶部 JSDoc 中"加入基础工具行 standing scope"改为"加入作用域组合（preset 或基础工具 standing scope 回退）"。

`bots/index.ts`：
- `BotsDeps` 加 `/** bot 会话挂载的 preset id（agentTeamPreset 开启时下达；undefined = 直接 toolsScope）。 */ botPresetId?: string`。
- `const toolsScope = createToolsScope(ctx)` 之后加：

```ts
  // preset 优先：mount 成功后委派子会话 composeFrom 认父；未下达 id 时维持 toolsScope 直挂。
  const scopeJoiner: ScopeJoiner = deps.botPresetId !== undefined
    ? createScopeJoiner(ctx, deps.botPresetId, toolsScope, log.warn)
    : toolsScope
```

- 两处 `setupAgentScope(agentCtx, input.hooks, toolsScope)` 改传 `scopeJoiner`；import 补 `createScopeJoiner` / `ScopeJoiner`。
- 第 68 行注释"preset 机制整体移除"已过时，改为"创作期注入：preset 优先 joiner（agent-bot 组合）+ persona/tools（spec: docs/superpowers/specs/2026-09-07-bot-delegation-preset-mount-design.md）"。

`src/index.ts:167`：

```ts
  if (config.modules.feishu) setupBots(ctx, config.feishu, { registry, botPresetId: config.agentTeamPreset.enabled ? config.agentTeamPreset.botsId : undefined })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/`
Expected: PASS（scope-joiner 3 用例 + agent-setup/tool-scope 既有用例回归）

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/channels/scope-joiner.ts packages/toolkit/src/channels/scope-joiner.test.ts packages/toolkit/src/channels/agent-setup.ts packages/toolkit/src/bots/index.ts packages/toolkit/src/index.ts
git commit -m "feat(toolkit): bot 会话 preset 优先 joiner（composeFrom 认父修复）"
```

---

### Task 5: 真实组合守护测试（composeFrom 认父 + 子会话工具继承）

**Files:**
- Modify: `packages/toolkit/package.json`（devDependencies 加 3 个 link）
- Test: `packages/toolkit/src/channels/scope-joiner.composition.test.ts`（新）

**Interfaces:**
- Consumes: Task 4 的 `createScopeJoiner`；真实 `@deepseek-ai/dsh-agent-presets` 服务。
- 守护目标（本仓库 0.2.3/0.2.4 两起"fake 单测掩盖宿主语义"事故的直接对策）：joiner 的 mount 路径产生的父链**真实可被执行中的 `composeFrom` 认到**，子 scope 继承到 preset 注册的工具。

- [ ] **Step 1: 加 devDependencies 并安装**

`packages/toolkit/package.json` devDependencies 加三行（按字母序就位）：

```json
    "@deepseek-ai/cordis-plugin-include": "link:../../deepseek-harness/vendor/include",
    "@deepseek-ai/cordis-plugin-loader": "link:../../deepseek-harness/vendor/loader",
    "@deepseek-ai/dsh-agent-presets": "link:../../deepseek-harness/packages/preset/agent-presets",
```

Run: `pnpm install`（仓库根）

- [ ] **Step 2: 写守护测试** — `scope-joiner.composition.test.ts`：

harness 镜像宿主 `agent-presets/tests/mount.spec.ts:41-54` 的最小集（不建真 agent，只用 `createScope` 造 scoped context）：

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { createScopeJoiner } from './scope-joiner.ts'
import { createToolsScope } from './tool-scope.ts'

// fixture 插件镜像宿主 agent-presets/tests/fixtures/plugins/contribute.js：注册一个按 config 命名的工具。
const FIXTURE_PLUGIN = `
export const name = 'contribute'
export const inject = ['tools', 'systemPrompt']
export function apply(ctx, config) {
  ctx.effect(() => ctx.tools.register({
    name: config.tool,
    description: 'fixture tool ' + config.tool,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: () => Promise.resolve(config.tool),
  }))
}
`
```

beforeEach：mkdtemp 下写 `plugins/contribute.mjs`（FIXTURE_PLUGIN）与 `presets/agent-bot/agent.cordis.yml`（单行 preset：`- id: fixture` / `name: '../../plugins/contribute.mjs'`（相对 composition 目录解析，宿主 fixture 同款）/ `config: { tool: bot-fixture }`，可用 js-yaml dump 或直接模板字符串）；boot：

```ts
ctx = new Context()
ctx.baseUrl = pathToFileURL(tempDir).href + '/'
await ctx.plugin(Loader)
ctx.loader.builtins.include = Include
await ctx.plugin(SystemPrompt, { persona: '' })
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentPresets, { default: 'agent-bot', roots: [{ path: join(tempDir, 'presets'), trust: 'user' }], includeUserRoot: false })
```

（`AgentPresets` 的 `Config` 类型若要求更多字段以 typecheck 为准补齐；若 boot 期报缺服务，按 mount.spec.ts harness 顺序补插件。）

用例：

```ts
test('joiner mount 路径：composeFrom 认父，子 scope 继承 preset 工具', async () => {
  const parentScope = createScope(ctx, { fake: 'parent' })
  const fallback = createToolsScope(ctx, async () => ((() => undefined) as never))
  await createScopeJoiner(ctx, 'agent-bot', fallback, vi.fn()).join(parentScope.ctx)
  expect(ctx.agentPresets.composedPreset(parentScope.ctx)).toBe('agent-bot')
  const childScope = createScope(ctx, { fake: 'child' })
  expect(ctx.agentPresets.composeFrom(childScope.ctx, parentScope.ctx)).toBe('agent-bot')
  expect(ctx.tools.get('bot-fixture', scopeOf(childScope.ctx)!)).toBeDefined()
  await fallback.dispose()
})

test('回退路径（负例守护）：toolsScope 父链不被 composeFrom 认到，子 scope 无工具', async () => {
  const parentScope = createScope(ctx, { fake: 'parent-fb' })
  const fallback = createToolsScope(ctx, async () => ((() => undefined) as never))
  // mount 一个 roster 里不存在的 id → 抛错 → 回退。
  await createScopeJoiner(ctx, 'nonexistent', fallback, vi.fn()).join(parentScope.ctx)
  const childScope = createScope(ctx, { fake: 'child-fb' })
  expect(ctx.agentPresets.composeFrom(childScope.ctx, parentScope.ctx)).toBeUndefined()
  await fallback.dispose()
})
```

注：`ctx.tools.get(name, scope)` 的 scope 形参形状以宿主 dsh-tools 类型为准（delegate/index.ts 的 `context.scope` 先例）；若签名不接受 ScopeKey，断言降级为 `ctx.agentPresets.composedPreset(childScope.ctx) === 'agent-bot'`（join 事实），工具继承由宿主自身 mount.spec 覆盖——实现时先试 `get`。

afterEach：`await rm(tempDir, { recursive: true, force: true })`（ctx  dispose 如 cordis 提供 `ctx.scope.dispose()`/`await ctx.exit()` 则一并调，防句柄泄漏挂住 vitest）。

- [ ] **Step 3: 跑测试**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/scope-joiner.composition.test.ts`
Expected: PASS（若 loader/服务装配报错，按报错补 harness——不允许把测试改假）

- [ ] **Step 4: Commit（需用户确认）**

```bash
git add packages/toolkit/package.json pnpm-lock.yaml packages/toolkit/src/channels/scope-joiner.composition.test.ts
git commit -m "test(toolkit): 真实组合守护——bot preset 父链可被子会话 composeFrom 继承"
```

---

### Task 6: 文档与全量验证

**Files:**
- Modify: `AGENTS.md`（删除"已知缺口（未修）：宿主 subagent 驱动……bot 会话发起的委派子会话看不到基础工具行"一句；bots 组装描述同步为 preset 优先 joiner）
- Modify: `docs/superpowers/specs/2026-09-07-bot-delegation-preset-mount-design.md`（状态：待评审 → 已实施）
- Check: `docs/usage/` 全文 grep "委派"/"子会话"/"team_delegate"，如有"bot 会话委派无工具"类限制描述则更新；无则不动。

- [ ] **Step 1: 文档更新**（按上方清单；AGENTS.md 中 tool-scope/bots 相关段落只改过时句，不重写）

- [ ] **Step 2: 全量验证**

Run（工作目录仓库根，逐条执行、全部通过才算完成）:
```
pnpm --filter dsh-agent-toolkit test
pnpm --filter dsh-agent-toolkit typecheck
pnpm --filter dsh-agent-toolkit bundle
```
Expected: 全部测试绿（新增用例计入）；typecheck 零错误；bundle 产出 lib/index.js + lib/client.js。

- [ ] **Step 3: 开发回路人工验证（向用户报告步骤，由用户或经用户确认后执行）**：`pnpm dsh web --patch cordis.yml` → 飞书 bot 单聊 → 让 bot 委派 general 读写文件 → 子会话实际执行 read/pwsh 成功；带白名单角色委派 → 子会话工具被正确 restrict。

- [ ] **Step 4: Commit（需用户确认）**

```bash
git add AGENTS.md docs/superpowers/specs/2026-09-07-bot-delegation-preset-mount-design.md docs/usage
git commit -m "docs(toolkit): agent-bot preset 修复文档同步"
```

---

## 自审记录

- Spec 覆盖：最小 preset 生成 → Task 2+3；Config `botsId` → Task 1；joiner + 回退 + 接线 → Task 4；真实组合守护 → Task 5；AGENTS.md 同步 → Task 6。spec 非目标（主会话/agent-team/bot 工具面变更/浏览器半）均无对应任务。
- 类型一致性：`AgentTeamPresetConfig.botsId`（Task 1 产出）= Task 3 生成与 Task 4 `BotsDeps.botPresetId` 的共同来源；`enabled=false → botPresetId: undefined → joiner 不建`（Task 4 index.ts 接线）与 Task 3 不生成对齐，避免"没生成还每次 mount 失败 warn"。
- 顺序敏感点：Task 3 依赖 Task 1（botsId 字段）与 Task 2（序列化）；Task 4 依赖 Task 1；Task 5 依赖 Task 4。Task 1 与 Task 2 互相独立。按序执行。
- 与 spec 的一处措辞偏差：spec 改动清单原写"`AgentPresetsLike` 增 mount"，实施为 `scope-joiner.ts` 内独立 `PresetMountLike` 结构类型（mount 与 roots/read 无共用处，不合并）；spec 文件已同步修正。
- 风险记录：Task 5 的真实 harness 依赖宿主 loader 在 temp 目录 import fixture 插件（Windows 路径经 file URL，mount.spec.ts 同款先例）；若 boot 期缺服务，只允许按 mount.spec.ts 补插件，不允许降级为 fake。
