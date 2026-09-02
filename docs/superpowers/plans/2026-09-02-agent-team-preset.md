# Agent 团队 preset 自动生成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** toolkit 启动时自动生成/刷新用户 preset `agent-team`（派生 shipped standard、禁用 subagent 工具族 4 行），使「Agent 团队」模式下委派唯一入口是 `team_delegate`。

**Architecture:** 新增 `src/agents/team-preset.ts` 模块：纯文本锚点改写函数 `disableSubagentRows`（无副作用、可单测）+ 编排函数 `setupAgentTeamPreset`（可选服务 `agentPresets` 经 `ctx.get` 读取、写首个 trust=user root）。`src/index.ts` 加 `agentTeamPreset` Config 段并在 `apply()` 末尾接线。standard 模式零改动。

**Tech Stack:** TypeScript / schemastery（Config schema）/ js-yaml（preset.yml 渲染）/ node:fs/promises / vitest。

**Spec:** `docs/superpowers/specs/2026-09-02-agent-team-preset-design.md`

## Global Constraints

- 不在 standard 模式屏蔽任何原生工具；`agent-team` 是独立用户 preset，用户在模式选择器显式选用。
- `team_delegate` 与团队名册段维持 host 平面全局注册，不做平面迁移。
- 不设为默认 preset、不改 `agent-presets` settings、卸载不删目录、不提供 preset 删除/编辑 UI。
- `agentPresets` 是**可选服务**：用 `ctx.get('agentPresets', false)`，**不进 `inject`**；缺席（rc2 等旧宿主）整个功能静默关闭，零行为变化。
- 文件名契约（镜像宿主 `@deepseek-ai/dsh-agent-presets` 的 `COMPOSITION_FILE`/`METADATA_FILE`）：composition = `agent.cordis.yml`，元数据 = `preset.yml`，生成标记 = `.generated-by`（内容 `dsh-agent-toolkit`）。
- 锚点匹配 = 整行精确匹配 `- id: <行id>`（忽略首尾空白），防 `tool-subagent` 误中 `tool-subagent-fork` 前缀。
- 禁用目标行固定 4 个：`tool-subagent`、`tool-subagent-fork`、`tool-subagent-control`、`tool-subagent-list-agents`（覆盖 5 个竞争工具 subagent / subagent_fork / send_message / list_agents / interrupt_agent）。
- 一切失败路径（读源失败 / 锚点缺失 / 无 user root / 同名用户目录 / 写失败）只 `logger.warn` 降级，插件其余功能不受影响。
- preset id 合法性镜像宿主 `PRESET_ID` = `/^[a-z0-9][a-z0-9-]*$/`（id 即目录名，是路径逃逸的 containment 边界）。
- 测试/构建命令：`pnpm --filter dsh-agent-toolkit test` / `pnpm --filter dsh-agent-toolkit typecheck` / `pnpm --filter dsh-agent-toolkit bundle`（均在仓库根执行）。
- 本任务不改 `packages/usage`，无需重建 usage lib。

---

### Task 1: 锚点改写纯函数 `disableSubagentRows`

**Files:**
- Create: `packages/toolkit/src/agents/team-preset.ts`（本任务只含常量 + 纯函数）
- Test: `packages/toolkit/src/agents/team-preset.test.ts`（本任务只含 transform 测试）

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces:
  - `TEAM_PRESET_DISABLED_ROWS: readonly ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents']`
  - `disableSubagentRows(source: string, warn: (msg: string) => void): string` — 返回改写后文本；锚点缺失 warn 并跳过该锚点；块内已有 `disabled:` 键则跳过；其余文本逐字节不变。
  - `AgentTeamPresetConfig` 接口（本任务先定义，Task 2/3 消费）：
    `{ enabled: boolean; id: string; source: string; name: string; description: string }`

- [ ] **Step 1: 写失败测试**

创建 `packages/toolkit/src/agents/team-preset.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest'
import { disableSubagentRows } from './team-preset.ts'

// 镜像宿主 shipped standard 的 delegation 块（缩进 4 空格的列表行）。
const SOURCE = [
  '# demo composition',
  '- id: delegation',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: tool-subagent-control',
  "      name: '@deepseek-ai/dsh-tool-subagent-control'",
  '',
  '    - id: tool-subagent-list-agents',
  "      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
  '',
  '    - id: tool-subagent',
  "      name: '@deepseek-ai/dsh-tool-subagent'",
  '      config:',
  '        provider: spawn',
  '        toolName: subagent',
  '',
  '    - id: tool-subagent-fork',
  "      name: '@deepseek-ai/dsh-tool-subagent'",
  '      config:',
  '        provider: fork',
  '        toolName: subagent_fork',
  '',
  '    - id: tool-workflow',
  "      name: '@deepseek-ai/dsh-tool-workflow'",
  '',
].join('\n')

const EXPECTED = [
  '# demo composition',
  '- id: delegation',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: tool-subagent-control',
  '      disabled: true',
  "      name: '@deepseek-ai/dsh-tool-subagent-control'",
  '',
  '    - id: tool-subagent-list-agents',
  '      disabled: true',
  "      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'",
  '',
  '    - id: tool-subagent',
  '      disabled: true',
  "      name: '@deepseek-ai/dsh-tool-subagent'",
  '      config:',
  '        provider: spawn',
  '        toolName: subagent',
  '',
  '    - id: tool-subagent-fork',
  '      disabled: true',
  "      name: '@deepseek-ai/dsh-tool-subagent'",
  '      config:',
  '        provider: fork',
  '        toolName: subagent_fork',
  '',
  '    - id: tool-workflow',
  "      name: '@deepseek-ai/dsh-tool-workflow'",
  '',
].join('\n')

describe('disableSubagentRows', () => {
  test('4 个目标行各插入 disabled: true（缩进 = 锚点 + 2），其余文本逐字节不变；tool-subagent 不误中 tool-subagent-fork', () => {
    const warn = vi.fn()
    expect(disableSubagentRows(SOURCE, warn)).toBe(EXPECTED)
    expect(warn).not.toHaveBeenCalled()
  })

  test('幂等：对生成结果再生成 = 不变', () => {
    const once = disableSubagentRows(SOURCE, vi.fn())
    const warn = vi.fn()
    expect(disableSubagentRows(once, warn)).toBe(once)
    expect(warn).not.toHaveBeenCalled()
  })

  test('锚点缺失：warn + 跳过该锚点，其余锚点照常插入', () => {
    const source = SOURCE.replace(
      "    - id: tool-subagent-list-agents\n      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'\n\n",
      '',
    )
    const warn = vi.fn()
    const result = disableSubagentRows(source, warn)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('- id: tool-subagent-list-agents'))
    expect(result.match(/disabled: true/g)).toHaveLength(3)
    expect(result).toContain('    - id: tool-subagent\n      disabled: true\n')
  })

  test('块内已有 disabled 键（含 !!js 形式）则跳过该行，不产生 YAML 重复键', () => {
    const source = SOURCE.replace(
      "    - id: tool-subagent\n",
      "    - id: tool-subagent\n      disabled: !!js process.platform === 'win32'\n",
    )
    const warn = vi.fn()
    const result = disableSubagentRows(source, warn)
    expect(warn).not.toHaveBeenCalled()
    // tool-subagent 块保持原样（只有原有那一行 disabled），其余 3 行各插入一行。
    expect(result).toContain("    - id: tool-subagent\n      disabled: !!js process.platform === 'win32'\n      name:")
    expect(result.match(/^\s*disabled\s*:/gm)).toHaveLength(4)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/team-preset.test.ts`
Expected: FAIL，报错 `Cannot find module './team-preset.ts'` 或 `disableSubagentRows is not a function`。

- [ ] **Step 3: 写最小实现**

创建 `packages/toolkit/src/agents/team-preset.ts`：

```ts
/**
 * Agent 团队 preset 自动生成：派生宿主当前 shipped standard composition，
 * 文本级禁用 subagent 工具族 4 个行，写入首个 trust=user 的 preset root。
 * 设计：docs/superpowers/specs/2026-09-02-agent-team-preset-design.md
 */

/** 本功能的可调配置（Config schema 在 ../index.ts）。 */
export interface AgentTeamPresetConfig {
  /** 总开关：false 时启动不生成/刷新 preset。 */
  enabled: boolean
  /** 生成的 preset id（即目录名）。 */
  id: string
  /** 源 preset id，读其 composition 做派生。 */
  source: string
  /** preset.yml 的显示名。 */
  name: string
  /** preset.yml 的描述。 */
  description: string
}

/** 禁用目标行：覆盖与 team_delegate 竞争/配套的 5 个模型可见工具所属的 4 个行。 */
export const TEAM_PRESET_DISABLED_ROWS = [
  'tool-subagent',
  'tool-subagent-fork',
  'tool-subagent-control',
  'tool-subagent-list-agents',
] as const

/**
 * 文本级锚点改写：对 4 个目标行各插入一行 `disabled: true`（缩进 = 锚点缩进 + 2 空格）。
 * 锚点是整行精确匹配 `- id: <行id>`（忽略首尾空白），防 tool-subagent 误中
 * tool-subagent-fork / tool-subagent-control 前缀；锚点所属块内（锚点行之后、
 * 首个缩进 <= 锚点缩进的非空行之前）已有 `disabled:` 键则跳过——既幂等，也避免
 * 与宿主已有的 `disabled: !!js ...` 撞出 YAML 重复键。锚点缺失 warn 并跳过该锚点，
 * 其余照常。除插入行外文本逐字节不变。
 */
export function disableSubagentRows(source: string, warn: (msg: string) => void): string {
  const lines = source.split('\n')
  for (const row of TEAM_PRESET_DISABLED_ROWS) {
    const anchor = `- id: ${row}`
    const index = lines.findIndex((line) => line.trim() === anchor)
    if (index === -1) {
      warn(`dsh-agent-toolkit: agent-team preset 锚点行 "${anchor}" 在源 composition 中缺失，已跳过`)
      continue
    }
    const indent = lines[index].length - lines[index].trimStart().length
    let hasDisabled = false
    for (let i = index + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (line.trim() === '') continue
      if (line.length - line.trimStart().length <= indent) break
      if (/^\s*disabled\s*:/.test(line)) {
        hasDisabled = true
        break
      }
    }
    if (hasDisabled) continue
    lines.splice(index + 1, 0, `${' '.repeat(indent + 2)}disabled: true`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/team-preset.test.ts`
Expected: 4 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/agents/team-preset.ts packages/toolkit/src/agents/team-preset.test.ts
git commit -m "feat(toolkit): agent-team preset 锚点改写纯函数"
```

---

### Task 2: 编排函数 `setupAgentTeamPreset`（可选服务读取 + 文件写入）

**Files:**
- Modify: `packages/toolkit/src/agents/team-preset.ts`（追加 setup 函数与私有常量/类型）
- Test: `packages/toolkit/src/agents/team-preset.test.ts`（追加 setup 测试 describe）

**Interfaces:**
- Consumes: Task 1 的 `disableSubagentRows`、`AgentTeamPresetConfig`。
- Produces: `setupAgentTeamPreset(ctx: Context, config: AgentTeamPresetConfig): Promise<void>` — Task 3 在 `apply()` 中调用。行为契约：
  - `enabled === false` → 直接返回（不读服务、不写文件）
  - `ctx.get('agentPresets', false)` 返回 undefined → 静默返回
  - `config.id` 不匹配 `/^[a-z0-9][a-z0-9-]*$/` → warn 返回（在 read 之前检查）
  - `agentPresets.read(config.source)`  rejects → warn 返回
  - roots 无 trust=user → warn 返回
  - 目标目录已存在且无 `.generated-by` 标记（或标记内容不符）→ warn 返回、不覆盖
  - 否则写入 3 个文件（`agent.cordis.yml` = 头部注释 + 改写文本；`preset.yml` = js-yaml dump `{name, description}`；`.generated-by` = `dsh-agent-toolkit`），写失败 warn 不抛

- [ ] **Step 1: 写失败测试**

在 `packages/toolkit/src/agents/team-preset.test.ts` 顶部 import 区追加：

```ts
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { afterEach, beforeEach } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { setupAgentTeamPreset, type AgentTeamPresetConfig } from './team-preset.ts'
```

文件末尾追加：

```ts
describe('setupAgentTeamPreset', () => {
  const CONFIG: AgentTeamPresetConfig = {
    enabled: true,
    id: 'agent-team',
    source: 'standard',
    name: 'Agent 团队',
    description: 'Agent 团队模式：禁用原生 subagent 工具族，委派统一走 team_delegate 团队角色',
  }

  let tempDir: string
  let userRoot: string
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-toolkit-team-preset-'))
    userRoot = join(tempDir, 'presets')
  })
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  function makeCtx(agentPresets: unknown): { ctx: Context; warn: ReturnType<typeof vi.fn> } {
    const warn = vi.fn()
    const ctx = { logger: { warn }, get: vi.fn(() => agentPresets) } as unknown as Context
    return { ctx, warn }
  }

  function makeAgentPresets(overrides: {
    roots?: { path: string; trust: 'system' | 'user' }[]
    read?: (id: string) => Promise<string>
  } = {}) {
    return {
      roots: overrides.roots ?? [{ path: userRoot, trust: 'user' as const }],
      read: vi.fn(overrides.read ?? (() => Promise.resolve(SOURCE))),
    }
  }

  const targetDir = () => join(userRoot, 'agent-team')

  test('enabled=false：不读服务、不写任何文件', async () => {
    const agentPresets = makeAgentPresets()
    const { ctx } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, { ...CONFIG, enabled: false })
    expect(agentPresets.read).not.toHaveBeenCalled()
    await expect(readdir(userRoot)).rejects.toThrow()
  })

  test('agentPresets 服务缺席（rc2 旧宿主）：静默跳过，不 warn 不抛错不写文件', async () => {
    const { ctx, warn } = makeCtx(undefined)
    await expect(setupAgentTeamPreset(ctx, CONFIG)).resolves.toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    await expect(readdir(userRoot)).rejects.toThrow()
  })

  test('非法 id（路径逃逸）：read 之前 warn 返回', async () => {
    const agentPresets = makeAgentPresets()
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, { ...CONFIG, id: '../evil' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不是合法 preset id'))
    expect(agentPresets.read).not.toHaveBeenCalled()
  })

  test('read 失败（未知/损坏源 preset）：warn 降级，不写文件', async () => {
    const agentPresets = makeAgentPresets({ read: () => Promise.reject(new Error('preset "standard" not found')) })
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('preset "standard" not found'))
    await expect(readdir(userRoot)).rejects.toThrow()
  })

  test('roots 无 trust=user：warn 降级，不写文件', async () => {
    const agentPresets = makeAgentPresets({ roots: [{ path: join(tempDir, 'sys'), trust: 'system' }] })
    const { ctx, warn } = makeCtx(agentPresets)
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('trust=user'))
    await expect(readdir(userRoot)).rejects.toThrow()
  })

  test('同名用户 preset 保护：无 .generated-by 标记的已存在目录不覆盖', async () => {
    await mkdir(targetDir(), { recursive: true })
    await writeFile(join(targetDir(), 'keep.txt'), 'user data', 'utf8')
    const { ctx, warn } = makeCtx(makeAgentPresets())
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不覆盖'))
    expect(await readFile(join(targetDir(), 'keep.txt'), 'utf8')).toBe('user data')
    await expect(readFile(join(targetDir(), 'agent.cordis.yml'), 'utf8')).rejects.toThrow()
  })

  test('正常路径：写入 3 个文件，composition 带头部注释 + 4 个 disabled；重复运行（带标记）重写', async () => {
    const { ctx, warn } = makeCtx(makeAgentPresets())
    await setupAgentTeamPreset(ctx, CONFIG)
    expect(warn).not.toHaveBeenCalled()
    const composition = await readFile(join(targetDir(), 'agent.cordis.yml'), 'utf8')
    expect(composition.startsWith('# 本文件由 dsh-agent-toolkit 自动生成')).toBe(true)
    expect(composition.match(/disabled: true/g)).toHaveLength(4)
    const metadata = yaml.load(await readFile(join(targetDir(), 'preset.yml'), 'utf8'))
    expect(metadata).toEqual({ name: 'Agent 团队', description: CONFIG.description })
    expect((await readFile(join(targetDir(), '.generated-by'), 'utf8')).trim()).toBe('dsh-agent-toolkit')
    // 重复运行：目录已有标记 → 重写（name 改了要生效），不 warn。
    await setupAgentTeamPreset(ctx, { ...CONFIG, name: '团队模式' })
    expect(warn).not.toHaveBeenCalled()
    expect(yaml.load(await readFile(join(targetDir(), 'preset.yml'), 'utf8'))).toEqual({ name: '团队模式', description: CONFIG.description })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/team-preset.test.ts`
Expected: setup describe 的 7 个测试 FAIL（`setupAgentTeamPreset is not a function`），Task 1 的 4 个仍 PASS。

- [ ] **Step 3: 写实现**

在 `packages/toolkit/src/agents/team-preset.ts` 顶部（`disableSubagentRows` 之前）追加 import 与常量，文件末尾追加 setup 函数：

```ts
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
```

```ts
// 三个文件名镜像宿主 @deepseek-ai/dsh-agent-presets 的 COMPOSITION_FILE / METADATA_FILE
// 契约（文件名即 discovery 协议）；不 import 宿主常量，避免新增运行时耦合。
const COMPOSITION_FILE = 'agent.cordis.yml'
const METADATA_FILE = 'preset.yml'
/** 生成目录的归属标记：无此标记的同名目录视为用户手工 preset，不覆盖。 */
const MARKER_FILE = '.generated-by'
const MARKER_CONTENT = 'dsh-agent-toolkit'
/** 镜像宿主 PRESET_ID：preset id 即目录名，正则白名单是路径逃逸的 containment 边界。 */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

const GENERATED_HEADER = '# 本文件由 dsh-agent-toolkit 自动生成，勿手改（每次启动重写）。\n'

/**
 * agentPresets 服务的结构类型。可选服务经 ctx.get 读取（宿主约定：可选服务用
 * ctx.get，不进 inject），结构类型避免对 @deepseek-ai/dsh-agent-presets 的依赖
 *（bots/index.ts 的 WorkspaceRegistryLike 先例）。
 */
interface AgentPresetsLike {
  readonly roots: readonly { path: string; trust: 'system' | 'user' }[]
  read(id: string): Promise<string>
}

/**
 * 启动时生成/刷新 agent-team preset。所有失败路径 warn 降级，不影响插件其余功能。
 * 不设为默认 preset、卸载不删目录（可能有会话在用；composition 不引用 toolkit 行，
 * 残留 preset 自身仍可用）。每次启动重写：standing mount 按文件代际，重写只影响新会话。
 */
export async function setupAgentTeamPreset(ctx: Context, config: AgentTeamPresetConfig): Promise<void> {
  if (!config.enabled) return
  const warn = (msg: string): void => { ctx.logger.warn(msg) }
  // rc2 等无 presets 的旧宿主：静默跳过（旧宿主无 subagent/team_delegate 工具竞争问题）。
  const agentPresets = ctx.get('agentPresets', false) as AgentPresetsLike | undefined
  if (agentPresets === undefined) return
  if (!PRESET_ID.test(config.id)) {
    warn(`dsh-agent-toolkit: agentTeamPreset.id "${config.id}" 不是合法 preset id，跳过 agent-team 生成`)
    return
  }
  let source: string
  try {
    source = await agentPresets.read(config.source)
  } catch (error) {
    warn(`dsh-agent-toolkit: 读取源 preset "${config.source}" 失败，跳过 agent-team 生成：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const root = agentPresets.roots.find((r) => r.trust === 'user')
  if (root === undefined) {
    warn('dsh-agent-toolkit: preset roots 中无 trust=user 的目录，跳过 agent-team 生成')
    return
  }
  const composition = GENERATED_HEADER + disableSubagentRows(source, warn)
  const dir = join(expandHomePath(root.path), config.id)
  try {
    const markerPath = join(dir, MARKER_FILE)
    let dirExists = true
    try {
      await access(dir)
    } catch {
      dirExists = false
    }
    if (dirExists) {
      let marked = false
      try {
        marked = (await readFile(markerPath, 'utf8')).trim() === MARKER_CONTENT
      } catch {
        // 无标记文件 = 用户手工同名 preset。
      }
      if (!marked) {
        warn(`dsh-agent-toolkit: ${dir} 已存在且非本插件生成，不覆盖，跳过 agent-team 生成`)
        return
      }
    }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, COMPOSITION_FILE), composition, 'utf8')
    await writeFile(join(dir, METADATA_FILE), yaml.dump({ name: config.name, description: config.description }, { lineWidth: -1 }), 'utf8')
    await writeFile(markerPath, `${MARKER_CONTENT}\n`, 'utf8')
  } catch (error) {
    warn(`dsh-agent-toolkit: 写入 agent-team preset 失败（${dir}）：${error instanceof Error ? error.message : String(error)}`)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/agents/team-preset.test.ts`
Expected: 11 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/agents/team-preset.ts packages/toolkit/src/agents/team-preset.test.ts
git commit -m "feat(toolkit): agent-team preset 生成编排（可选服务 + user root 写入 + 同名保护）"
```

---

### Task 3: Config schema 接线 + apply() 调用

**Files:**
- Modify: `packages/toolkit/src/index.ts`（import、Config 接口、schema、apply 各一处）
- Test: `packages/toolkit/src/index.test.ts`（Config 默认值断言补 `agentTeamPreset`）

**Interfaces:**
- Consumes: Task 2 的 `setupAgentTeamPreset(ctx, config)` 与 `AgentTeamPresetConfig`。
- Produces: `Config.agentTeamPreset: AgentTeamPresetConfig`（schema 默认值：`enabled: true, id: 'agent-team', source: 'standard', name: 'Agent 团队', description: 'Agent 团队模式：禁用原生 subagent 工具族，委派统一走 team_delegate 团队角色'`）。

- [ ] **Step 1: 写失败测试**

修改 `packages/toolkit/src/index.test.ts` 的 `Config 默认值` 测试，在 `expect(config.feishu).toEqual({...})` 之后追加：

```ts
    expect(config.agentTeamPreset).toEqual({
      enabled: true,
      id: 'agent-team',
      source: 'standard',
      name: 'Agent 团队',
      description: 'Agent 团队模式：禁用原生 subagent 工具族，委派统一走 team_delegate 团队角色',
    })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/index.test.ts`
Expected: `Config 默认值` 测试 FAIL（`agentTeamPreset` 为 undefined）。

- [ ] **Step 3: 接线实现**

修改 `packages/toolkit/src/index.ts`：

1. import 区追加：

```ts
import { setupAgentTeamPreset, type AgentTeamPresetConfig } from './agents/team-preset.ts'
```

2. `Config` 接口（`feishu: BotsModuleConfig` 行之后）追加字段：

```ts
  agentTeamPreset: AgentTeamPresetConfig
```

3. schema（`feishu: z.object({...}).default({...}),` 之后、`}) as z<unknown, Config>` 之前）追加：

```ts
  // agent-team preset 自动生成：派生 shipped standard、禁用 subagent 工具族 4 行，
  // 写入首个 trust=user root（spec: docs/superpowers/specs/2026-09-02-agent-team-preset-design.md）。
  agentTeamPreset: z.object({
    enabled: z.boolean().default(true),
    id: z.string().default('agent-team'),
    source: z.string().default('standard'),
    name: z.string().default('Agent 团队'),
    description: z.string().default('Agent 团队模式：禁用原生 subagent 工具族，委派统一走 team_delegate 团队角色'),
  }).default({
    enabled: true,
    id: 'agent-team',
    source: 'standard',
    name: 'Agent 团队',
    description: 'Agent 团队模式：禁用原生 subagent 工具族，委派统一走 team_delegate 团队角色',
  }),
```

4. `apply()` 中 `setupPromptLayersApi(ctx, {...})` 调用之后、`if (config.modules.feishu)` 之前追加：

```ts
  // agentPresets 为可选服务（rc2 旧宿主缺席时内部静默跳过），不进 inject。
  await setupAgentTeamPreset(ctx, config.agentTeamPreset)
```

注意：**不要**把 `agentPresets` 加进 `inject` 数组。

- [ ] **Step 4: 跑全量测试 + 类型检查 + 构建**

Run（仓库根，依次）:
```
pnpm --filter dsh-agent-toolkit test
pnpm --filter dsh-agent-toolkit typecheck
pnpm --filter dsh-agent-toolkit bundle
```
Expected: 全量测试 PASS（含既有 index.test.ts 的 apply 测试——其 fake ctx 的 `get: () => undefined` 使命能静默跳过，零行为变化）；typecheck 无错误；bundle 成功产出 `lib/index.js` + `lib/client.js`。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/index.ts packages/toolkit/src/index.test.ts
git commit -m "feat(toolkit): agentTeamPreset config 段 + apply 接线"
```

---

### Task 4: 开发回路端到端验证（手工）

**Files:** 无代码改动。

**Interfaces:** 消费 Task 3 构建产物。

前置：Task 3 的 bundle 已跑（`lib/` 是最新的）。

- [ ] **Step 1: 确认插件已 link 进 web profile（已装则跳过）**

```bash
cd deepseek-harness
pnpm dsh plugin --profile web add link:D:\work\github\dsh\dsh-agent-toolkit\packages\toolkit
```

- [ ] **Step 2: 启动 web 宿主**

```bash
cd deepseek-harness
pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml
```

- [ ] **Step 3: 验证文件生成与 roster**

Expected:
- `$DSH_HOME/.agent-presets/agent-team/` 下存在 `agent.cordis.yml`（头部注释 + 4 行 `disabled: true`，其余与 shipped standard 逐字节一致）、`preset.yml`（name: Agent 团队）、`.generated-by`
- 界面模式选择器 roster 出现「Agent 团队」；standard 等原 preset 原样在

- [ ] **Step 4: agent-team 模式抓包验证（对照 spec 测试清单）**

选用（或 settings 设 `agent-presets.default: agent-team`）后新会话抓包。Expected:
- subagent / subagent_fork / send_message / list_agents / interrupt_agent 5 个工具全部消失
- `tool:subagent` 强引导段消失
- `team_delegate` 在、团队名册段在

- [ ] **Step 5: 委派与对照组**

Expected:
- 强制 `team_delegate` 委派 explorer：子 Agent 收到角色 persona + 只读白名单，正常完成
- 对照组 standard 模式会话：原生 subagent 工具族原样在（standard 零行为变化）

- [ ] **Step 6: 记录结果**

把验证结论（含任何偏差）追加到本计划 Task 4 末尾或回复给用户。若抓包项不满足，回到 Task 1/2 排查锚点匹配（对照宿主当时版本的 `apps/cli/config/agent-presets/standard/agent.cordis.yml` 行 id）。

---

### Task 5: 文档更新

**Files:**
- Modify: `AGENTS.md`
- Create: `docs/usage/agent-team-preset.md`
- Modify: `docs/usage/README.md`（功能表加一行）
- Modify: `docs/usage/config-reference.md`（补 `agentTeamPreset` 配置段）

- [ ] **Step 1: AGENTS.md 补一句**

在 `AGENTS.md`「dsh 插件开发要点」的「Agent 注册表：」条目末尾追加：

```markdown
启动时自动生成/刷新用户 preset `agent-team`（派生 shipped standard、文本级禁用 subagent 工具族 4 行，写入首个 trust=user root；`.generated-by` 标记保护用户同名目录；`agentPresets` 为可选服务经 ctx.get 读取，缺席静默跳过），实现与测试在 `src/agents/team-preset.ts`。
```

- [ ] **Step 2: 新建 `docs/usage/agent-team-preset.md`**

内容要点（照 spec 与实现写，风格对齐 agents.md 等现有手册页）：

```markdown
# Agent 团队模式（agent-team preset）

dsh 0.1.2-alpha.4 起，原生 `subagent` 工具族带强引导段，模型在委派意图下会优先选它而不是 `team_delegate`，导致 Agent 团队的角色配置（persona / 模型路由 / 工具白名单）不生效。「Agent 团队」模式为此而生：该模式下原生 subagent 工具族不存在，委派唯一入口是 `team_delegate`。

## 原理

插件启动时自动生成（每次启动重写）一个用户 preset `agent-team`：派生自宿主当前 shipped `standard` 的 composition，仅禁用 4 个行（`tool-subagent` / `tool-subagent-fork` / `tool-subagent-control` / `tool-subagent-list-agents`，覆盖 subagent、subagent_fork、send_message、list_agents、interrupt_agent 共 5 个工具及其引导段）。其余与 standard 完全一致。standard 模式本身不受任何影响。

生成位置：`$DSH_HOME/.agent-presets/agent-team/`（或配置的首个 trust=user root 下同名目录），含 `agent.cordis.yml` / `preset.yml` / `.generated-by` 三个文件。**勿手改，每次启动重写**；想自定义可复制为另一个 preset id。同名目录若非本插件生成（无 `.generated-by` 标记），插件不覆盖并记 warn。

## 使用

1. 启动后打开会话的模式选择器，选用「Agent 团队」（ roster 与 standard 并列）。
2. 或把 settings 的 `agent-presets.default` 设为 `agent-team` 作为默认模式。
3. 之后新会话中委派统一走 `team_delegate` + Agents 面板配置的团队角色。

插件**不会**把它设为默认 preset，也不改任何 settings；卸载插件不删目录（可能有会话在用），残留的 agent-team preset 自身仍可用（团队工具随插件卸载消失）。旧宿主（无 presets 架构，如 rc2）下本功能自动静默关闭。

## 配置（cordis.yml）

```yaml
- id: dsh-agent-toolkit
  config:
    agentTeamPreset:
      enabled: true        # 总开关
      id: agent-team       # 生成的 preset id
      source: standard     # 派生源 preset
      name: Agent 团队      # roster 显示名
      description: ...     # roster 描述
```
```

- [ ] **Step 3: `docs/usage/README.md` 功能表加行**

在功能表 `| 分层提示词 | ... |` 行之后追加：

```markdown
| Agent 团队模式 | 模式选择器选用「Agent 团队」 | [agent-team-preset.md](agent-team-preset.md) |
```

- [ ] **Step 4: `docs/usage/config-reference.md` 补配置段**

参照该文件现有字段文档格式，补 `agentTeamPreset` 对象段（5 个字段、默认值与 Task 3 schema 一致）。

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/usage/
git commit -m "docs: agent-team preset 使用说明 + AGENTS.md 条目"
```

---

## Self-Review 结论

- **Spec 覆盖**：数据流 6 步 → Task 1（锚点改写）+ Task 2（编排全部降级路径）；Config schema → Task 3；禁用行选择依据/边界保护/YAGNI → Global Constraints + Task 2 实现注释；vitest 6 项测试 → Task 1/2 共 11 测（spec 第 1 项的「缩进正确 + 逐字节不变」由 EXPECTED 字面量断言覆盖，前缀安全并入其中）；端到端验证 → Task 4；文档更新 → Task 5。spec「测试」节第 4 项（同名用户 preset 保护）与第 5/6 项均在 Task 2。
- **占位符扫描**：无 TBD/TODO；每个代码步骤含完整可运行代码。
- **类型一致性**：`disableSubagentRows` / `setupAgentTeamPreset` / `AgentTeamPresetConfig` / `TEAM_PRESET_DISABLED_ROWS` 在 Task 1 定义、Task 2/3 同名消费；测试中的 import 与实现签名一致。
- **已核实的宿主事实**（2026-09-02 对照源码）：`agentPresets.read(id)` 返回 composition 文本（`packages/preset/agent-presets/src/index.ts:361`）；`roots` getter 返回 `readonly PresetRoot[]` 含 trust（同文件 :346）；`COMPOSITION_FILE = 'agent.cordis.yml'`、`METADATA_FILE = 'preset.yml'`；shipped standard 的 4 个锚点行实际存在于 `apps/cli/config/agent-presets/standard/agent.cordis.yml:180-198`；`expandHomePath` 由 `@deepseek-ai/dsh-home-paths` 导出且 toolkit 已有该包的 host-provided 运行时 import 先例（`src/agents/import-yaml.ts:6`）；`ctx.get(name, false)` 可选服务先例见 `src/bots/index.ts:100`。
