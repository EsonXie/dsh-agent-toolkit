# 飞书 bot 会话权限预设（permissionPreset）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `feishu.permissionPreset` 配置项：飞书 bot 会话建账（create/resume/接管）即应用宿主权限预设（典型 `danger-full-access` = 完全权限不审批），web 会话不受影响。

**Architecture:** `createAgentsPort` 增加可选第 4 参 `applyPreset`，在 adaptAgent/adaptLive 拿到 `agent` 后调用（渠道层唯一能拿到 `agent.session` 的位置；schedule 共用该工厂但不传此参）。应用器本体是独立工厂 `createPresetApplier`（`src/bots/permission-preset.ts`），经 `ctx.get('permissionPresets')` 可选服务惰性解析，服务缺席/非法预设名 warn 跳过。spec：`docs/superpowers/specs/2026-09-15-feishu-permission-preset-design.md`。

**Tech Stack:** TypeScript ESM + vitest + schemastery（`z.string()` 不加 `.required()` 即可选键，仓库内无 `.optional()` API）；宿主服务 `@deepseek-ai/dsh-permission-presets`（`ctx.permissionPresets`，`names: readonly string[]` getter + `set(session, name)` 幂等写会话日志事件）。

## Global Constraints

- 工作目录：`D:\work\github\dsh\dsh-agent-toolkit`；包目录 `packages/toolkit`。
- 测试：`pnpm --filter dsh-agent-toolkit test`（vitest run；单文件 `pnpm --filter dsh-agent-toolkit exec vitest run src/<path>`）。
- 类型检查：`pnpm --filter dsh-agent-toolkit typecheck`。
- 构建：`pnpm --filter dsh-agent-toolkit bundle`（任何 src 改动后必须跑）。
- **不得修改 `deepseek-harness/` 内任何文件**（只读宿主 checkout）。
- schemastery 没有 `.optional()`：可选键 = `z.string()` 不加 `.required()`/`.default()`（先例：`src/index.ts` Rule schema 的 `append`）。
- `BotsModuleConfig` 的可选字段读取处注意收窄：先取局部 const 再进闭包（exactOptionalPropertyTypes 风格先例）。
- 宿主包 type-only 导入走 devDependencies `link:` 先例（照 `@deepseek-ai/dsh-user-approval`，`packages/toolkit/package.json:91`），不进 dependencies/peerDependencies。
- 每个 Task 末尾单独 commit；commit message 照仓库风格（`feat(feishu): ...` / `test(...)` / `docs(...)`）。

---

### Task 1: `createAgentsPort` 增加可选 `applyPreset` 参数

**Files:**
- Modify: `packages/toolkit/src/channels/agents-port.ts`
- Test: `packages/toolkit/src/channels/agents-port.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `ScopeJoiner`（`{ join(agentCtx): Promise<unknown> }`）、宿主 `AgentHandle`/`Agent`（`agent.session` 为 `@deepseek-ai/dsh-session` 的 `Session`）。
- Produces: `createAgentsPort(ctx, joiner, ownedSessions?, applyPreset?: (session: Session) => void)` —— Task 3 的 bots/index.ts 以第 4 参传入应用器；schedule/index.ts 不传（行为不变）。

- [x] **Step 1: 写失败测试**

新建 `packages/toolkit/src/channels/agents-port.test.ts`：

```ts
/** createAgentsPort applyPreset：create/resume/get 三路径均以 agent.session 调用；未传不调用。 */
import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { createAgentsPort } from './agents-port.ts'
import type { ScopeJoiner } from './scope-joiner.ts'

const joiner: ScopeJoiner = { join: async () => undefined }
const hooks = {}

function fakeAgent(id: string, session: Session) {
  return { id, session, followup: vi.fn(), cancel: vi.fn(), whenIdle: vi.fn(async () => undefined) }
}

function fakeCtx(agent: ReturnType<typeof fakeAgent>): Context {
  const handle = { agent, dispose: vi.fn(async () => undefined) }
  return {
    agents: {
      create: vi.fn(async () => handle),
      resume: vi.fn(async () => handle),
      get: vi.fn(() => agent),
    },
  } as unknown as Context
}

describe('createAgentsPort applyPreset', () => {
  test('create：以 agent.session 调用 applyPreset', async () => {
    const session = { marker: 1 } as unknown as Session
    const applyPreset = vi.fn()
    const port = createAgentsPort(fakeCtx(fakeAgent('s1', session)), joiner, undefined, applyPreset)
    await port.create({ sessionId: 's1', cwd: 'D:\\p', hooks })
    expect(applyPreset).toHaveBeenCalledTimes(1)
    expect(applyPreset).toHaveBeenCalledWith(session)
  })

  test('resume：以 agent.session 调用 applyPreset', async () => {
    const session = { marker: 2 } as unknown as Session
    const applyPreset = vi.fn()
    const port = createAgentsPort(fakeCtx(fakeAgent('s2', session)), joiner, undefined, applyPreset)
    await port.resume({ sessionId: 's2', hooks })
    expect(applyPreset).toHaveBeenCalledWith(session)
  })

  test('get（接管宿主存活 agent）：以 agent.session 调用 applyPreset', () => {
    const session = { marker: 3 } as unknown as Session
    const applyPreset = vi.fn()
    const port = createAgentsPort(fakeCtx(fakeAgent('s3', session)), joiner, undefined, applyPreset)
    expect(port.get('s3')).toBeDefined()
    expect(applyPreset).toHaveBeenCalledWith(session)
  })

  test('未传 applyPreset：三路径正常返回且不抛错（schedule 形态）', async () => {
    const port = createAgentsPort(fakeCtx(fakeAgent('s4', {} as Session)), joiner)
    await expect(port.create({ sessionId: 's4', cwd: 'D:\\p', hooks })).resolves.toBeDefined()
    await expect(port.resume({ sessionId: 's4', hooks })).resolves.toBeDefined()
    expect(port.get('s4')).toBeDefined()
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/agents-port.test.ts`
Expected: FAIL —— `createAgentsPort` 只接受 3 个参数，第 4 参类型报错/调用不生效（applyPreset 断言失败）。

- [x] **Step 3: 实现**

`packages/toolkit/src/channels/agents-port.ts` 三处改动：

1. 导入行改为带 Session 类型：

```ts
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
```

2. 签名加第 4 参：

```ts
export function createAgentsPort(
  ctx: Context,
  joiner: ScopeJoiner,
  ownedSessions?: Set<string>,
  /** 可选：会话建账（create/resume/接管）后应用宿主权限预设（bots 的 feishu.permissionPreset；schedule 不传）。 */
  applyPreset?: (session: Session) => void,
): AgentsPort {
```

3. `adaptAgent` 与 `adaptLive` 各自拿到 `agent` 后首行调用：

```ts
  function adaptAgent(handle: AgentHandle): AgentPort {
    const { agent } = handle
    applyPreset?.(agent.session)
    return {
```

```ts
  function adaptLive(agent: Agent): AgentPort {
    applyPreset?.(agent.session)
    return {
```

- [x] **Step 4: 跑测试确认通过 + 全量回归**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/agents-port.test.ts`
Expected: PASS（4 个测试）
Run: `pnpm --filter dsh-agent-toolkit test`
Expected: 全部通过（621+4）

- [x] **Step 5: Commit**

```powershell
git add packages/toolkit/src/channels/agents-port.ts packages/toolkit/src/channels/agents-port.test.ts
git commit -m "feat(feishu): createAgentsPort 可选 applyPreset 参数（建账/接管路径统一钩子）"
```

---

### Task 2: `createPresetApplier` 工厂（服务缺席/非法名降级）

**Files:**
- Create: `packages/toolkit/src/bots/permission-preset.ts`
- Test: `packages/toolkit/src/bots/permission-preset.test.ts`（新建）

**Interfaces:**
- Consumes: 无（独立工厂）。
- Produces: `createPresetApplier(serviceOf: () => PermissionPresetsLike | undefined, preset: string, warn: (message: string) => void): (session: Session) => void`；`PermissionPresetsLike = { readonly names: readonly string[]; set(session: Session, name: string): void }`。Task 3 在 bots/index.ts 消费。

- [x] **Step 1: 写失败测试**

新建 `packages/toolkit/src/bots/permission-preset.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { createPresetApplier, type PermissionPresetsLike } from './permission-preset.ts'

const session = {} as Session

describe('createPresetApplier', () => {
  test('服务缺席：warn 一次后静默，重复调用不重复 warn、不抛错', () => {
    const warn = vi.fn()
    const apply = createPresetApplier(() => undefined, 'danger-full-access', warn)
    apply(session)
    apply(session)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('permissionPresets')
  })

  test('非法预设名：warn 且不调用 set', () => {
    const set = vi.fn()
    const svc: PermissionPresetsLike = { names: ['workspace-write'], set }
    const warn = vi.fn()
    const apply = createPresetApplier(() => svc, 'bogus', warn)
    apply(session)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('bogus')
    expect(set).not.toHaveBeenCalled()
  })

  test('合法预设：调用 svc.set(session, name)，不 warn', () => {
    const set = vi.fn()
    const svc: PermissionPresetsLike = { names: ['workspace-write', 'danger-full-access'], set }
    const warn = vi.fn()
    const apply = createPresetApplier(() => svc, 'danger-full-access', warn)
    apply(session)
    expect(set).toHaveBeenCalledWith(session, 'danger-full-access')
    expect(warn).not.toHaveBeenCalled()
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/bots/permission-preset.test.ts`
Expected: FAIL —— 模块不存在（无法解析 `./permission-preset.ts`）。

- [x] **Step 3: 实现**

新建 `packages/toolkit/src/bots/permission-preset.ts`：

```ts
/** feishu.permissionPreset 应用器工厂：bot 会话建账时应用宿主权限预设
 *  （典型 danger-full-access = 完全权限不审批）。服务缺席/非法名 warn 降级，不打死聊天链路。
 *  spec: docs/superpowers/specs/2026-09-15-feishu-permission-preset-design.md。 */
import type { Session } from '@deepseek-ai/dsh-session'

/** permissionPresets 服务的结构子集（可选服务经 ctx.get 惰性读取；宿主 dsh-permission-presets）。 */
export interface PermissionPresetsLike {
  readonly names: readonly string[]
  set(session: Session, name: string): void
}

export function createPresetApplier(
  serviceOf: () => PermissionPresetsLike | undefined,
  preset: string,
  warn: (message: string) => void,
): (session: Session) => void {
  let warnedMissing = false
  return (session) => {
    const svc = serviceOf()
    if (svc === undefined) {
      if (!warnedMissing) {
        warnedMissing = true
        warn('[project-bot] 配置了 feishu.permissionPreset 但宿主无 permissionPresets 服务，跳过应用')
      }
      return
    }
    if (!svc.names.includes(preset)) {
      warn(`[project-bot] feishu.permissionPreset "${preset}" 不是合法预设（可用：${svc.names.join(', ')}），跳过应用`)
      return
    }
    // 宿主 set() 幂等：knob 值未变不追加会话事件，resume/接管重复应用无副作用。
    svc.set(session, preset)
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/bots/permission-preset.test.ts`
Expected: PASS（3 个测试）

- [x] **Step 5: Commit**

```powershell
git add packages/toolkit/src/bots/permission-preset.ts packages/toolkit/src/bots/permission-preset.test.ts
git commit -m "feat(feishu): createPresetApplier 工厂——宿主权限预设应用器（服务缺席/非法名 warn 降级）"
```

---

### Task 3: Config schema + bots 装配接线 + 宿主类型依赖

**Files:**
- Modify: `packages/toolkit/src/index.ts`（feishu schema 加键）
- Modify: `packages/toolkit/src/bots/index.ts`（BotsModuleConfig + 接线）
- Modify: `packages/toolkit/package.json`（devDependencies 加 link）
- Test: `packages/toolkit/src/index.test.ts`、`packages/toolkit/src/bots/index.test.ts`、`packages/toolkit/src/bots/smoke.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `createAgentsPort` 第 4 参；Task 2 的 `createPresetApplier`。
- Produces: `BotsModuleConfig.permissionPreset?: string`；Config 输出 `config.feishu.permissionPreset`（缺省 undefined）。

- [x] **Step 1: 写失败测试**

`packages/toolkit/src/index.test.ts` 在 `feishu.approval=false` 测试后追加：

```ts
  test('feishu.permissionPreset：缺省 undefined（维持宿主默认预设），显式配置原样保留', () => {
    expect(Config({}).feishu.permissionPreset).toBeUndefined()
    expect(Config({ feishu: { permissionPreset: 'danger-full-access' } }).feishu.permissionPreset).toBe('danger-full-access')
  })
```

`packages/toolkit/src/bots/smoke.test.ts` 键清单钉住测试改为：

```ts
    const config: BotsModuleConfig = {
      cardUpdateThrottleMs: 0, cardMaxBytes: 0, cardPrintStep: 0, processMaxBytes: 0,
      registerAppTimeoutMs: 0, processingReactionEmoji: '', errorDetailMaxChars: 0, injectSender: false, approval: false, docMaxBytes: 0,
      debugLog: false, debugLogDir: '', debugLogRetentionDays: 0, permissionPreset: 'danger-full-access',
    }
    expect(Object.keys(config).sort()).toEqual([
      'approval', 'cardMaxBytes', 'cardPrintStep', 'cardUpdateThrottleMs', 'debugLog', 'debugLogDir', 'debugLogRetentionDays',
      'docMaxBytes', 'errorDetailMaxChars', 'injectSender', 'permissionPreset', 'processMaxBytes', 'processingReactionEmoji', 'registerAppTimeoutMs',
    ])
```

`packages/toolkit/src/bots/index.test.ts` 顶部加模块 mock 捕获 createAgentsPort 实参，文件其余测试不受影响：

```ts
import { createAgentsPort } from '../channels/agents-port.ts'

vi.mock('../channels/agents-port.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../channels/agents-port.ts')>()
  return { ...original, createAgentsPort: vi.fn(original.createAgentsPort) }
})
```

makeCtx 的 `get` 改为可注入（完整替换该函数）：

```ts
function makeCtx(permissionPresets?: unknown): { ctx: Context; on: ReturnType<typeof vi.fn> } {
  const on = vi.fn(() => () => {})
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    storageDomain: {
      open: () => Promise.resolve({
        table: () => ({ keys: () => [] }),
        close: async () => {},
      }),
    },
    effect: () => {},
    on,
    credentials: { set: vi.fn(async () => {}), resolve: vi.fn(async () => undefined), unset: vi.fn(async () => {}) },
    agents: { create: vi.fn(), resume: vi.fn(), get: vi.fn(() => undefined) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'spawn', model: 'deepseek-chat' }) },
    get: vi.fn((name: string) => (name === 'permissionPresets' ? permissionPresets : undefined)),
    inject: () => {},
  } as unknown as Context
  return { ctx, on }
}
```

describe 末尾追加接线测试：

```ts
describe('setupBots permissionPreset 接线', () => {
  test('配置 permissionPreset：createAgentsPort 第 4 参为应用器，调用后落到 svc.set(session, name)', () => {
    const set = vi.fn()
    const svc = { names: ['workspace-write', 'danger-full-access'], set }
    const { ctx } = makeCtx(svc)
    setupBots(ctx, { ...makeConfig(true), permissionPreset: 'danger-full-access' }, { registry: makeRegistry() })
    const applyPreset = vi.mocked(createAgentsPort).mock.calls[0]![3]
    expect(typeof applyPreset).toBe('function')
    const session = {} as Parameters<NonNullable<typeof applyPreset>>[0]
    applyPreset!(session)
    expect(set).toHaveBeenCalledWith(session, 'danger-full-access')
  })

  test('未配置 permissionPreset：createAgentsPort 第 4 参为 undefined', () => {
    const { ctx } = makeCtx()
    setupBots(ctx, makeConfig(true), { registry: makeRegistry() })
    expect(vi.mocked(createAgentsPort).mock.calls[0]![3]).toBeUndefined()
  })
})
```

注意：两个 describe 块之间 mock 调用记录会累积，在文件顶部 `beforeEach(() => vi.mocked(createAgentsPort).mockClear())`（需 `import { beforeEach } from 'vitest'`）。

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/index.test.ts src/bots/smoke.test.ts src/bots/index.test.ts`
Expected: FAIL —— `permissionPreset` 不在 BotsModuleConfig 类型/schema 中（类型错误 + 键清单断言失败 + 接线断言失败）。

- [x] **Step 3: 实现**

(a) `packages/toolkit/package.json` devDependencies 追加（照 `dsh-user-approval` 的 link 先例，保持字母序位置按现有文件实际顺序插入）：

```json
    "@deepseek-ai/dsh-permission-presets": "link:../../deepseek-harness/packages/interaction/permission-presets",
```

随后运行 `pnpm install` 建立链接。

(b) `packages/toolkit/src/index.ts` feishu schema：`approval` 行后加（可选键 = 不加 `.required()`/`.default()`；外层 `.default({...})` 对象**不加**此键）：

```ts
    approval: z.boolean().default(true),
    /** bot 会话建账即应用的宿主权限预设名（如 danger-full-access = 完全权限不审批；缺省维持宿主默认）。
     *  警告：完全权限下任何能给 bot 发消息的人即获宿主完全文件/命令权限，建议仅私聊 bot 启用。 */
    permissionPreset: z.string(),
```

（schema 对象内其余字段与 `.default({...})` 字面量保持不动。）

(c) `packages/toolkit/src/bots/index.ts`：
- 顶部导入追加：

```ts
// type-only：激活 permissionPresets 服务在 Context 上的声明合并（ctx.get 可选服务读取）。
import type {} from '@deepseek-ai/dsh-permission-presets'
```

- `import { createApprovalAnswerer } ...` 附近追加：

```ts
import { createPresetApplier } from './permission-preset.ts'
```

- `BotsModuleConfig` 接口 `approval: boolean` 后加：

```ts
  /** bot 会话建账即应用的宿主权限预设名（缺省维持宿主默认；danger-full-access 风险见 Config 注释）。 */
  permissionPreset?: string
```

- `setupBots` 内 `const agentsPort = createAgentsPort(...)` 一行替换为：

```ts
  // 权限预设：配置后 create/resume/接管三路径统一应用（agents-port 内调用点）；
  // 活跃复用与 /switch 内存复用不经过 agents.get，天然不翻转存量会话。
  const presetName = config.permissionPreset
  const applyPreset = presetName === undefined ? undefined
    : createPresetApplier(() => ctx.get('permissionPresets'), presetName, log.warn)
  const agentsPort = createAgentsPort(ctx, scopeJoiner, deps.ownedSessions, applyPreset)
```

- [x] **Step 4: 跑测试确认通过 + 类型检查 + 全量回归**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/index.test.ts src/bots/smoke.test.ts src/bots/index.test.ts`
Expected: PASS
Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 无错误
Run: `pnpm --filter dsh-agent-toolkit test`
Expected: 全部通过

- [x] **Step 5: 构建**

Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 成功产出 lib/index.js 与 lib/client.js

- [x] **Step 6: Commit**

```powershell
git add packages/toolkit/src/index.ts packages/toolkit/src/bots/index.ts packages/toolkit/package.json packages/toolkit/src/index.test.ts packages/toolkit/src/bots/index.test.ts packages/toolkit/src/bots/smoke.test.ts pnpm-lock.yaml
git commit -m "feat(feishu): feishu.permissionPreset 配置——bot 会话建账即应用宿主权限预设"
```

---

### Task 4: 文档同步 + 真实回路验收

**Files:**
- Modify: `docs/domains/feishu.md`
- Modify: `docs/superpowers/specs/2026-09-15-feishu-permission-preset-design.md`（无变化则不动）

**Interfaces:**
- Consumes: Task 3 完成的配置项 `feishu.permissionPreset`。
- Produces: 域文档现行事实更新；真实回路验收结论。

- [x] **Step 1: 更新 docs/domains/feishu.md**

在「审批卡片与 ask_user」一节末尾追加一段（保持该文件现行事实权威风格）：

```markdown
bot 会话权限预设（0.4.2 起）：`feishu.permissionPreset` 配置宿主预设名（如 `danger-full-access`）后，
bot 会话建账（create/冷 resume/web 存活接管/switch 冷接管，统一钩子在 agents-port adaptAgent/adaptLive）
即经 `permissionPresets.set()` 应用该预设——完全权限、不再发起任何审批（审批卡路径不触发）；活跃复用与
/switch 命中插件内存会话不翻转存量状态；宿主 set() 幂等，重启 resume 重复应用无副作用；委派子会话自动
继承父会话 sandbox override（宿主行为，零代码）。服务缺席/非法名 warn 降级不影响聊天。安全警示：
`danger-full-access` 下任何能给 bot 发消息的人（含群聊 @ 它的成员）即获宿主完全文件/命令权限，建议仅
私聊 bot 启用。spec：docs/superpowers/specs/2026-09-15-feishu-permission-preset-design.md。
```

（版本号以实际发布为准，若下一个版本不是 0.4.2 则写实际版本。）

- [ ] **Step 2: 真实回路验收（需要用户配合真实飞书操作）**

1. 开发 `cordis.yml` 的 feishu 配置块追加 `permissionPreset: danger-full-access`（该文件在本地修改中，验收后由用户决定是否保留）。
2. `pnpm --filter dsh-agent-toolkit bundle` 后启动开发回路（`cd deepseek-harness && pnpm dsh web --patch ..\cordis.yml`）。
3. 飞书向 bot 发 `/new`，然后让 Agent 写一个工作区外的文件（如「在 D:\ 根目录建一个 test.txt」）。
4. 预期：不弹任何审批（web 也不弹），直接写入成功。
5. 再发一个需要委派的任务，预期子 Agent 同样不审批直接执行（宿主委派继承）。
6. 验证后**回退 cordis.yml 的该改动**（除非用户决定常驻）。

- [x] **Step 3: Commit**

```powershell
git add docs/domains/feishu.md
git commit -m "docs(feishu): permissionPreset 现行事实同步（域文档）"
```
