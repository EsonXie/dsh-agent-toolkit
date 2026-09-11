# 飞书会话切换指令（/sessions · /switch · /help）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 飞书 bot 支持 `/sessions`（列出项目 workspace 候选会话）、`/switch <序号|id前缀>`（切换绑定，旧会话保留不取消）、`/help`（指令帮助）。

**Architecture:** 候选源复用宿主 `workspaceRegistry` 的 `workspace.sessionIds`（新增 `SessionCatalogPort` 端口 + `channels/session-catalog.ts` 真实适配器，组合 `sessions`/`sessionTitle` 可选服务取标题）；`Router` 新增 `switchTo`/`boundSessionId`，切走的旧 runtime 不 retire、未绑定 idle 后摘除；`parseDirective` 返回值扩展为 `{ name, arg? }`。Spec：`docs/superpowers/specs/2026-09-11-feishu-session-switch-design.md`。

**Tech Stack:** TypeScript ESM / vitest / cordis 可选服务 `ctx.get(name, false)` 惰性解析。

## Global Constraints

- 本特性不加 Config 字段（spec §6）。
- 精确指令 `/new` `/stop` `/status` 语义不变：整条消息 trim+lowercase 精确匹配才命中，带参数一律按普通消息处理。
- 宿主可选服务一律 `ctx.get(name, false)` 消息时惰性解析（attachments 教训：apply 期一次性捕获不可靠），不为新服务加 `inject`。
- 切走的旧 runtime **不 cancel、不 retire**：在飞 turn 卡片在本 chat 照常收尾；闲置落定后仍未重新绑定才摘出 sessions map。
- binding 覆盖用 `bindings.set`（put），不用 `delete` + `set`；resume 失败时 binding 必须不变。
- 测试命令：`pnpm --filter dsh-agent-toolkit test`；类型检查：`pnpm --filter dsh-agent-toolkit typecheck`。
- 每个 Task 完成后提交一次 git commit（提交前确认用户允许）。

---

### Task 1: directive.ts 扩展带参指令

**Files:**
- Modify: `packages/toolkit/src/channels/directive.ts`
- Test: `packages/toolkit/src/channels/directive.test.ts`

**Interfaces:**
- Produces（后续 Task 依赖）:
  ```ts
  export type Directive = 'new' | 'stop' | 'status' | 'sessions' | 'switch' | 'help'
  export interface ParsedDirective { name: Directive; arg?: string }
  export function parseDirective(text: string): ParsedDirective | null
  ```
  `arg` 仅 `/switch` 可能携带（首词后 trim 的余串；无参时缺省）。`stripMentionPlaceholders` 签名不变。

- [x] **Step 1: 改写测试（先写失败测试）**

把 `packages/toolkit/src/channels/directive.test.ts` 的 `describe('parseDirective')` 整块替换为：

```ts
describe('parseDirective', () => {
  test('识别三个原指令（忽略大小写与首尾空白）', () => {
    expect(parseDirective('/new')).toEqual({ name: 'new' })
    expect(parseDirective('  /Stop ')).toEqual({ name: 'stop' })
    expect(parseDirective('/STATUS')).toEqual({ name: 'status' })
  })

  test('识别新指令 /sessions 与 /help（整条精确匹配）', () => {
    expect(parseDirective('/sessions')).toEqual({ name: 'sessions' })
    expect(parseDirective('  /Help ')).toEqual({ name: 'help' })
  })

  test('/switch 带参：首词判定，余串为 arg', () => {
    expect(parseDirective('/switch 2')).toEqual({ name: 'switch', arg: '2' })
    expect(parseDirective('/switch  a1b2c3d4 ')).toEqual({ name: 'switch', arg: 'a1b2c3d4' })
  })

  test('/switch 无参：命中且 arg 缺省（由 Inbound 提示用法）', () => {
    expect(parseDirective('/switch')).toEqual({ name: 'switch' })
  })

  test('普通文本与带参数的精确指令都不算', () => {
    expect(parseDirective('你好')).toBeNull()
    expect(parseDirective('/new 请重来')).toBeNull()
    expect(parseDirective('/sessions 请')).toBeNull()
    expect(parseDirective('/unknown')).toBeNull()
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- directive`
Expected: FAIL（`parseDirective('/new')` 返回 `'new'` 而非 `{ name: 'new' }`，`/sessions` 返回 `null`）

- [x] **Step 3: 实现**

把 `packages/toolkit/src/channels/directive.ts` 顶部到 `parseDirective` 结束替换为（`stripMentionPlaceholders` 保持原样不动）：

```ts
/** 飞书内的运维文本指令（不走模型）。 */
export type Directive = 'new' | 'stop' | 'status' | 'sessions' | 'switch' | 'help'

export interface ParsedDirective {
  name: Directive
  /** 带参指令的参数（/switch 首词后的余串；无参时缺省，由 Inbound 提示用法）。 */
  arg?: string
}

/**
 * 精确指令（/new /stop /status /sessions /help）要求整条消息 trim+lowercase 精确匹配，
 * 带参数/前后文按普通消息处理；/switch 为首词判定的带参指令。
 */
export function parseDirective(text: string): ParsedDirective | null {
  const t = text.trim().toLowerCase()
  if (t === '/new') return { name: 'new' }
  if (t === '/stop') return { name: 'stop' }
  if (t === '/status') return { name: 'status' }
  if (t === '/sessions') return { name: 'sessions' }
  if (t === '/help') return { name: 'help' }
  if (t === '/switch') return { name: 'switch' }
  if (t.startsWith('/switch ')) return { name: 'switch', arg: t.slice('/switch '.length).trim() }
  return null
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- directive`
Expected: PASS（inbound 等其他文件会因 `parseDirective` 返回形态变化而编译错/断言错，下一 Task 前的过渡状态——先跑 `pnpm --filter dsh-agent-toolkit typecheck` 确认 inbound.ts 报 `directive === 'new'` 类型错，属预期，Task 4 修复）

- [x] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/directive.ts packages/toolkit/src/channels/directive.test.ts
git commit -m "feat(toolkit): parseDirective 扩展带参指令（/sessions /switch /help）"
```

---

### Task 2: Router.switchTo / boundSessionId / releaseUnbound

**Files:**
- Modify: `packages/toolkit/src/channels/router.ts`
- Test: `packages/toolkit/src/channels/router.test.ts`

**Interfaces:**
- Consumes: 现有 `Router` 构造与私有方法（`resolveSession`/`attach`/`adopt`/`retire`）。
- Produces（Task 4 的 Inbound 依赖）:
  ```ts
  Router.boundSessionId(botId: string, chatId: string): string | undefined
  Router.switchTo(bot: BotRecord, chatId: string, sessionId: string, reply: ReplyHandle, userId: string): Promise<SessionRuntime>
  ```
  `switchTo` 契约：目标已在内存且非 retiring → 复用（initiator 不变）；否则 resume + adopt（切换人成为发起人）；binding 在 resume 成功后才覆盖；旧 runtime 不 cancel，releaseUnbound 闲置后摘除。

- [x] **Step 1: 写失败测试**

在 `packages/toolkit/src/channels/router.test.ts` 末尾追加：

```ts
describe('Router.switchTo（/switch）', () => {
  test('boundSessionId：读绑定表（不要求进程内有 runtime）', async () => {
    const { router, bindings } = setup()
    expect(router.boundSessionId('reviewer', 'oc_1')).toBeUndefined()
    await bindings.set('reviewer', 'oc_1', 'sess-x')
    expect(router.boundSessionId('reviewer', 'oc_1')).toBe('sess-x')
  })

  test('切到不在内存的会话：resume 接管（装配照常）+ 绑定覆盖不 delete', async () => {
    const { router, bindings, resumed, defaultModel } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const rt = await router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u2')
    expect(resumed).toHaveLength(1)
    expect(resumed[0].input.sessionId).toBe('sess-target')
    expect(defaultModel).toHaveBeenCalledTimes(2)   // create + resume 各一次
    expect(rt.sessionId).toBe('sess-target')
    expect(rt.initiatorOpenId).toBe('ou_u2')         // 切换人成为发起人（审批校验用）
    expect(bindings.get('reviewer', 'oc_1')).toBe('sess-target')
    expect(old.agent.cancel).not.toHaveBeenCalled()  // 旧会话不取消
  })

  test('切到已在内存的会话：直接复用 runtime，不 resume、initiator 不变', async () => {
    const { router, bindings, sessions, resumed } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    await router.switchTo(fakeBot(), 'oc_1', 'sess-b', reply, 'ou_u1')
    const rtB = sessions.get('sess-b')!
    const back = await router.switchTo(fakeBot(), 'oc_1', 'sess-b', reply, 'ou_u2')
    expect(back).toBe(rtB)
    expect(back.initiatorOpenId).toBe('ou_u1')
    expect(resumed).toHaveLength(1)                  // 仅第一次切 sess-b 时 resume
    expect(bindings.get('reviewer', 'oc_1')).toBe('sess-b')
  })

  test('切走的旧 runtime 不 retire：idle 落定且未重新绑定后摘出 sessions', async () => {
    const { router, sessions } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const oldId = old.sessionId
    await router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u1')
    await new Promise((r) => setTimeout(r, 0))        // releaseUnbound 落定
    expect(sessions.has(oldId)).toBe(false)
    expect(old.agent.cancel).not.toHaveBeenCalled()
  })

  test('旧会话有在飞 turn：等 whenIdle 落定后才摘除（卡片照常收尾）', async () => {
    const { router, sessions } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const oldId = old.sessionId
    let idle!: () => void
    old.agent.whenIdle = () => new Promise<void>((resolve) => { idle = resolve })
    await router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u1')
    await new Promise((r) => setTimeout(r, 0))
    expect(sessions.has(oldId)).toBe(true)            // turn 未落定不摘
    idle()
    await new Promise((r) => setTimeout(r, 0))
    expect(sessions.has(oldId)).toBe(false)
  })

  test('摘除窗口内被切回：runtime 保留不误删', async () => {
    const { router, sessions } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const oldId = old.sessionId
    let idle!: () => void
    old.agent.whenIdle = () => new Promise<void>((resolve) => { idle = resolve })
    await router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u1')
    await router.switchTo(fakeBot(), 'oc_1', oldId, reply, 'ou_u1')   // 切回（内存复用）
    idle()
    await new Promise((r) => setTimeout(r, 0))
    expect(sessions.get(oldId)).toBe(old)             // 重新绑定后不摘
  })

  test('resume 失败：binding 不变，旧 runtime 不动', async () => {
    const { router, bindings, sessions, agents } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const oldId = old.sessionId
    agents.resume = async () => { throw new Error('session corrupted') }
    await expect(router.switchTo(fakeBot(), 'oc_1', 'sess-bad', reply, 'ou_u1')).rejects.toThrow('session corrupted')
    expect(bindings.get('reviewer', 'oc_1')).toBe(oldId)
    expect(sessions.get(oldId)).toBe(old)
  })

  test('switchTo 后 attach 目标会话到 bot 项目 workspace（幂等兜底归组）', async () => {
    const { router, workspace } = setup()
    await router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u1')
    expect(workspace.attach).toHaveBeenCalledWith('D:\\work\\demo', 'sess-target')
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- router`
Expected: FAIL / 编译错（`boundSessionId`/`switchTo` 不存在）

- [x] **Step 3: 实现**

在 `packages/toolkit/src/channels/router.ts` 的 `lookup` 方法后追加（类内）：

```ts
  /** 当前绑定 sessionId（不要求进程内有 runtime；/sessions ✓ 标记与 /switch 已是当前判定用）。 */
  boundSessionId(botId: string, chatId: string): string | undefined {
    return this.bindings.get(botId, chatId)
  }

  /**
   * /switch：把 chat 的绑定覆盖到目标会话。
   * 目标已在内存且非 retiring → 直接复用（initiator 不变）；否则 resume + adopt（切换人成为发起人）。
   * binding 在 resume 成功后才覆盖（resume 失败绑定不变）。
   * 切走的旧 runtime 不 retire（在飞 turn 卡片在本 chat 照常收尾），闲置落定后仍未重新绑定才摘除。
   */
  async switchTo(bot: BotRecord, chatId: string, sessionId: string, reply: ReplyHandle, userId: string): Promise<SessionRuntime> {
    const oldBound = this.bindings.get(bot.id, chatId)
    const existing = this.sessions.get(sessionId)
    let rt: SessionRuntime
    if (existing !== undefined && !existing.retiring) {
      rt = existing
    } else {
      const agent = await this.agents.resume({ sessionId, ...this.resolveSession(bot, userId) })
      await this.attach(bot.project, sessionId)
      rt = this.adopt(bot.id, chatId, userId, sessionId, agent, reply)
    }
    await this.bindings.set(bot.id, chatId, sessionId)
    if (oldBound !== undefined && oldBound !== sessionId) {
      const old = this.sessions.get(oldBound)
      if (old !== undefined && old !== rt && !old.retiring) this.releaseUnbound(bot.id, chatId, oldBound, old)
    }
    return rt
  }

  /** 未绑定会话闲置落定（在飞 turn 卡片收尾）后，仍未被重新绑定才摘出 sessions（摘除窗口内被切回不误删）。 */
  private releaseUnbound(botId: string, chatId: string, sessionId: string, rt: SessionRuntime): void {
    void (async () => {
      await rt.agent.whenIdle().catch(() => undefined)
      await rt.tail.catch(() => undefined)
      if (this.sessions.get(sessionId) === rt && this.bindings.get(botId, chatId) !== sessionId) {
        this.sessions.delete(sessionId)
      }
    })()
  }
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- router`
Expected: PASS（全部 router 测试含旧用例）

- [x] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/router.ts packages/toolkit/src/channels/router.test.ts
git commit -m "feat(toolkit): Router.switchTo 切换会话绑定（旧会话保留，idle 后摘除）"
```

> **实施修正（2026-09-11，本 Task 合入后）：** `switchTo` 后续经两个 fix 演进，上文代码与测试为初版快照——fix `8aa42d1250` 增加 binding 覆盖失败摘除本次 adopt 的孤儿 runtime；fix `99be3825c4` 改为 live 接管优先（`agents.get(sessionId) ?? resume(...)`，`AgentsPort.get`/`AgentPort.dispose` 新增）、摘除三路径（retire/releaseUnbound/覆盖失败清理）一律 dispose 释放宿主写句柄。详见 spec「实施修正记录」节与 `docs/domains/feishu.md`。

---

### Task 3: SessionCatalogPort 端口 + 真实适配器

**Files:**
- Modify: `packages/toolkit/src/channels/ports.ts`
- Create: `packages/toolkit/src/channels/session-catalog.ts`
- Test: `packages/toolkit/src/channels/session-catalog.test.ts`（新建）

**Interfaces:**
- Consumes: 宿主可选服务 `workspaceRegistry`（`create(path)` → `{ sessionIds: readonly SessionId[] }`，见 `deepseek-harness/packages/workspace/workspace/src/types.ts` L59）、`sessions`（`get(id)` → live Session | undefined）、`sessionTitle`（`get(session)` → `{ title } | undefined`，见 `session-title/src/index.ts` L385）。
- Produces（Task 4、Task 5 依赖）:
  ```ts
  // ports.ts
  export interface SessionCatalogEntry { sessionId: string; title?: string }
  export interface SessionCatalogPort { list(project: string): Promise<readonly SessionCatalogEntry[]> }
  // session-catalog.ts
  export interface CatalogServices { workspaceRegistry: ...; sessions: ...; sessionTitle: ... }
  export function createSessionCatalog(resolve: () => CatalogServices): SessionCatalogPort | undefined
  ```

- [x] **Step 1: 写失败测试**

新建 `packages/toolkit/src/channels/session-catalog.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createSessionCatalog, type CatalogServices } from './session-catalog.ts'

function services(overrides: Partial<CatalogServices> = {}): CatalogServices {
  return {
    workspaceRegistry: {
      create: async () => ({ sessionIds: ['sess-1', 'sess-2'] as unknown as SessionId[] }),
    },
    sessions: { get: (id) => (id === ('sess-1' as unknown as SessionId) ? { id } : undefined) },
    sessionTitle: { get: () => ({ title: '修复登录闪退' }) },
    ...overrides,
  }
}

describe('createSessionCatalog', () => {
  test('workspaceRegistry 缺席：返回 undefined（环境不支持会话切换）', () => {
    expect(createSessionCatalog(() => services({ workspaceRegistry: undefined }))).toBeUndefined()
  })

  test('list：workspace 候选 + live 会话标题', async () => {
    const catalog = createSessionCatalog(() => services())!
    const entries = await catalog.list('D:\\work\\demo')
    expect(entries).toEqual([
      { sessionId: 'sess-1', title: '修复登录闪退' },
      { sessionId: 'sess-2' },                    // 非 live：无 title 键
    ])
  })

  test('sessionTitle 缺席：标题全部降级（列表照常）', async () => {
    const catalog = createSessionCatalog(() => services({ sessionTitle: undefined }))!
    const entries = await catalog.list('p')
    expect(entries).toEqual([{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }])
  })

  test('sessions 缺席：取不到 live 会话，标题全部降级', async () => {
    const catalog = createSessionCatalog(() => services({ sessions: undefined }))!
    const entries = await catalog.list('p')
    expect(entries).toEqual([{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }])
  })

  test('标题服务返回 undefined：该条无 title 键', async () => {
    const catalog = createSessionCatalog(() => services({ sessionTitle: { get: () => undefined } }))!
    const entries = await catalog.list('p')
    expect(entries).toEqual([{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }])
  })

  test('服务按 list 调用时惰性解析（apply 期不捕获）', async () => {
    let current = services({ workspaceRegistry: undefined })
    // 首次缺席 → undefined；之后服务就绪 → 同一取用器返回可用 catalog
    expect(createSessionCatalog(() => current)).toBeUndefined()
    current = services()
    const catalog = createSessionCatalog(() => current)!
    expect(await catalog.list('p')).toHaveLength(2)
  })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- session-catalog`
Expected: FAIL（模块不存在）

- [x] **Step 3: 实现**

先在 `packages/toolkit/src/channels/ports.ts` 的 `BindingStore` 接口后追加：

```ts
/** /sessions 候选会话项（title 取不到时缺省，渲染层显示 (无标题)）。 */
export interface SessionCatalogEntry {
  sessionId: string
  title?: string
}

/** 候选会话目录端口：列出 bot 项目 workspace 下的可切换会话（真实适配器在 session-catalog.ts）。 */
export interface SessionCatalogPort {
  list(project: string): Promise<readonly SessionCatalogEntry[]>
}
```

再新建 `packages/toolkit/src/channels/session-catalog.ts`：

```ts
/** /sessions 候选目录真实适配器：workspaceRegistry 候选 + live 会话标题（三服务均为可选，惰性解析）。 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionCatalogEntry, SessionCatalogPort } from './ports.ts'

/** 结构化窄接口：只声明用到的成员（与 bots/index.ts 的 WorkspaceRegistryLike 同款模式）。 */
export interface CatalogWorkspaceRegistry {
  create(path: string): Promise<{ sessionIds: readonly SessionId[] }>
}

/** 宿主 sessions 服务窄化：只取 live 会话（不 resume 未加载会话——仅为列表标题太贵）。 */
export interface CatalogSessions {
  get(id: SessionId): unknown | undefined
}

/** 宿主 sessionTitle 服务窄化。 */
export interface CatalogSessionTitle {
  get(session: unknown): { title: string } | undefined
}

export interface CatalogServices {
  workspaceRegistry: CatalogWorkspaceRegistry | undefined
  sessions: CatalogSessions | undefined
  sessionTitle: CatalogSessionTitle | undefined
}

/**
 * workspaceRegistry 缺席 = 环境不支持会话切换，返回 undefined（Inbound 降级文案）。
 * resolve 在取用与每次 list 时调用（attachments 同款"消息时解析"，apply 期不捕获服务实例）。
 */
export function createSessionCatalog(resolve: () => CatalogServices): SessionCatalogPort | undefined {
  if (resolve().workspaceRegistry === undefined) return undefined
  return {
    async list(project: string): Promise<readonly SessionCatalogEntry[]> {
      const { workspaceRegistry, sessions, sessionTitle } = resolve()
      if (workspaceRegistry === undefined) throw new Error('workspaceRegistry 服务不可用')
      const workspace = await workspaceRegistry.create(project)
      return workspace.sessionIds.map((id) => {
        const session = sessions?.get(id)
        const title = session !== undefined ? sessionTitle?.get(session)?.title : undefined
        return title !== undefined
          ? { sessionId: String(id), title }
          : { sessionId: String(id) }
      })
    },
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- session-catalog`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/ports.ts packages/toolkit/src/channels/session-catalog.ts packages/toolkit/src/channels/session-catalog.test.ts
git commit -m "feat(toolkit): SessionCatalogPort 与 workspace 候选会话适配器"
```

---

### Task 4: Inbound 三指令（/sessions /switch /help）

**Files:**
- Modify: `packages/toolkit/src/channels/inbound.ts`
- Test: `packages/toolkit/src/channels/inbound.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ParsedDirective`；Task 2 的 `router.switchTo`/`router.boundSessionId`；Task 3 的 `SessionCatalogPort`/`SessionCatalogEntry`。
- Produces（Task 5 装配依赖）:`InboundDeps` 新增可选字段
  ```ts
  catalog?: () => SessionCatalogPort | undefined
  ```

- [x] **Step 1: 写失败测试**

在 `packages/toolkit/src/channels/inbound.test.ts` 中：

a) `harness` 的 `opts` 与 `Inbound` 构造扩展 catalog fake——把 harness 函数签名与 inbound 构造改为：

```ts
function harness(opts: {
  createError?: unknown
  attachments?: () => AttachmentsPort | undefined
  catalog?: () => SessionCatalogPort | undefined
} = {}) {
  // ……（原有内容不变）……
  const inbound = new Inbound({
    router,
    bots: { get: (id) => (id === BOT.id ? BOT : undefined) },
    maxErrorDetailChars: 200,
    ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
    ...(opts.catalog !== undefined ? { catalog: opts.catalog } : {}),
    onError: () => undefined,
  })
```

并在文件顶部 import 区追加 `import type { SessionCatalogPort } from './ports.ts'`（与既有 ports 类型 import 合并或独立一行，随文件现有风格）。

b) 追加 fixture 与测试：

```ts
const CATALOG_ENTRIES = [
  { sessionId: 'aaaa1111-0000-0000-0000-000000000000', title: '修复登录闪退' },
  { sessionId: 'bbbb2222-0000-0000-0000-000000000000' },
]

function catalogHarness(entries = CATALOG_ENTRIES) {
  return harness({ catalog: () => ({ list: async () => entries }) })
}

test('/help：列出全部指令', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('/help'))
  await vi.waitFor(() => { expect(rec.notices).toHaveLength(1) })
  for (const cmd of ['/new', '/stop', '/status', '/sessions', '/switch', '/help']) {
    expect(rec.notices[0]).toContain(cmd)
  }
})

test('/sessions：列表含标题、id 前缀与当前绑定 ✓ 标记', async () => {
  // catalog 内容可变：先建会话拿到真实绑定 id，再让列表包含它
  let entries: { sessionId: string; title?: string }[] = [...CATALOG_ENTRIES]
  const { rec, inbound, router, msg } = harness({ catalog: () => ({ list: async () => entries }) })
  inbound.onMessage(msg('先建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const current = router.boundSessionId('reviewer', 'oc_1')!
  entries = [CATALOG_ENTRIES[0], { sessionId: current, title: '当前这个' }, CATALOG_ENTRIES[1]]
  inbound.onMessage(msg('/sessions'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('会话列表'))).toBe(true) })
  const list = rec.notices.find((n) => n.includes('会话列表'))!
  expect(list).toContain('1. 修复登录闪退（aaaa1111）')
  expect(list).toContain(`2. ✓ 当前这个（${current.slice(0, 8)}）`)
  expect(list).toContain(`3. (无标题)（bbbb2222）`)
})

test('/sessions：无标题会话显示 (无标题)，catalog 缺席降级文案', async () => {
  const { rec, inbound, msg } = catalogHarness([{ sessionId: 'cccc3333-0000-0000-0000-000000000000' }])
  inbound.onMessage(msg('/sessions'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('(无标题)') && n.includes('cccc3333'))).toBe(true) })

  const degraded = harness() // 不传 catalog
  degraded.inbound.onMessage(degraded.msg('/sessions'))
  await vi.waitFor(() => { expect(degraded.rec.notices).toContain('会话切换在当前环境不可用') })
})

test('/sessions：空列表提示', async () => {
  const { rec, inbound, msg } = catalogHarness([])
  inbound.onMessage(msg('/sessions'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('还没有可切换的会话'))).toBe(true) })
})

test('/switch 序号：按最近一次 /sessions 列表切换并确认', async () => {
  const { rec, inbound, router, msg } = catalogHarness()
  inbound.onMessage(msg('建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const old = router.boundSessionId('reviewer', 'oc_1')!
  inbound.onMessage(msg('/sessions'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('会话列表'))).toBe(true) })
  inbound.onMessage(msg('/switch 1'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已切换到会话'))).toBe(true) })
  expect(router.boundSessionId('reviewer', 'oc_1')).toBe(CATALOG_ENTRIES[0].sessionId)
  expect(router.boundSessionId('reviewer', 'oc_1')).not.toBe(old)
  // 旧会话不取消
  expect(rec.cancels).toBe(0)
})

test('/switch id 前缀：不依赖列表缓存直接切', async () => {
  const { rec, inbound, router, msg } = catalogHarness()
  inbound.onMessage(msg('建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('/switch bbbb2222'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已切换到会话'))).toBe(true) })
  expect(router.boundSessionId('reviewer', 'oc_1')).toBe(CATALOG_ENTRIES[1].sessionId)
})

test('/switch 边界：无参 / 序号无缓存 / 已是当前 / 前缀零命中与多命中 / catalog 缺席', async () => {
  const { rec, inbound, msg } = catalogHarness()
  inbound.onMessage(msg('建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })

  inbound.onMessage(msg('/switch'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('用法：/switch'))).toBe(true) })

  inbound.onMessage(msg('/switch 9'))   // 从未 /sessions：无缓存
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('序号无效'))).toBe(true) })

  const h2entries: { sessionId: string; title?: string }[] = []
  const h2 = harness({ catalog: () => ({ list: async () => h2entries }) })
  h2.inbound.onMessage(h2.msg('建会话'))
  await vi.waitFor(() => { expect(h2.rec.followups).toHaveLength(1) })
  const h2Current = h2.router.boundSessionId('reviewer', 'oc_1')!
  h2entries.push({ sessionId: h2Current, title: '自己' })
  h2.inbound.onMessage(h2.msg(`/switch ${h2Current.slice(0, 8)}`))
  await vi.waitFor(() => { expect(h2.rec.notices).toContain('已是当前会话') })

  inbound.onMessage(msg('/switch zzzz'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('没有 id 前缀为'))).toBe(true) })

  const dup = harness({ catalog: () => ({ list: async () => [
    { sessionId: 'aaaa1111-0000-0000-0000-000000000000' },
    { sessionId: 'aaaa9999-0000-0000-0000-000000000000' },
  ] }) })
  dup.inbound.onMessage(dup.msg('/switch aaaa'))
  await vi.waitFor(() => { expect(dup.rec.notices.some((n) => n.includes('命中多个会话'))).toBe(true) })

  const degraded = harness()
  degraded.inbound.onMessage(degraded.msg('/switch 1'))
  await vi.waitFor(() => { expect(degraded.rec.notices).toContain('会话切换在当前环境不可用') })
})
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- inbound`
Expected: FAIL（新指令未实现；同时旧用例因 `parseDirective` 返回形态变化编译错）

- [x] **Step 3: 实现**

`packages/toolkit/src/channels/inbound.ts`：

a) import 区追加：

```ts
import type { SessionCatalogEntry, SessionCatalogPort } from './ports.ts'
```

b) `InboundDeps` 在 `attachments?` 后追加：

```ts
  /** 可选：候选会话目录的惰性取用器（attachments 同款"消息时解析"）；缺席 = /sessions、/switch 降级文案。 */
  catalog?: () => SessionCatalogPort | undefined
```

c) `Inbound` 类加字段与常量（类外文件级常量）：

```ts
/** /help 输出文本。 */
const HELP_TEXT = [
  '可用指令：',
  '/new 开启新会话（旧会话保留，可用 /switch 切回）',
  '/stop 停止当前任务',
  '/status 查看项目与会话状态',
  '/sessions 列出本项目可切换的会话',
  '/switch <序号|id前缀> 切换到指定会话',
  '/help 显示本帮助',
].join('\n')
```

类内：

```ts
  /** 最近一次 /sessions 输出（per chat 序号缓存；进程重启即失效）。 */
  private readonly lastLists = new Map<string, readonly string[]>()
```

d) `handle` 中指令分流改写（替换现有 `const directive = ...` 到 status 分支结束的整段）：

```ts
    const directive = parseDirective(msg.text)
    if (directive?.name === 'new') {
      await this.deps.router.reset(bot, msg.chatId, msg.reply, msg.userId)
      await msg.reply.notice('已开启新会话')
      return
    }
    if (directive?.name === 'stop') {
      const rt = this.deps.router.lookup(bot.id, msg.chatId)
      if (rt?.inflight !== undefined) {
        rt.agent.cancel()
        await msg.reply.notice('已请求停止当前任务')
      } else {
        await msg.reply.notice('当前没有进行中的任务')
      }
      return
    }
    if (directive?.name === 'status') {
      const rt = this.deps.router.lookup(bot.id, msg.chatId)
      await msg.reply.notice(rt === undefined
        ? `项目：${bot.project}\n会话：未创建（发送消息即创建）`
        : `项目：${bot.project}\n会话：${rt.sessionId}\n状态：${rt.inflight !== undefined ? '处理中' : '空闲'}`)
      return
    }
    if (directive?.name === 'help') {
      await msg.reply.notice(HELP_TEXT)
      return
    }
    if (directive?.name === 'sessions') {
      await this.listSessions(bot, msg)
      return
    }
    if (directive?.name === 'switch') {
      await this.switchSession(bot, msg, directive.arg)
      return
    }
```

e) 类内追加两个私有方法：

```ts
  private async listSessions(bot: BotRecord, msg: InboundMessage): Promise<void> {
    const catalog = this.deps.catalog?.()
    if (catalog === undefined) {
      await msg.reply.notice('会话切换在当前环境不可用')
      return
    }
    const entries = await catalog.list(bot.project)
    if (entries.length === 0) {
      await msg.reply.notice('当前项目下还没有可切换的会话（发消息即创建）')
      return
    }
    const current = this.deps.router.boundSessionId(bot.id, msg.chatId)
    this.lastLists.set(`${bot.id}:${msg.chatId}`, entries.map((e) => e.sessionId))
    const lines = entries.map((e, i) =>
      `${i + 1}. ${e.sessionId === current ? '✓ ' : ''}${e.title ?? '(无标题)'}（${e.sessionId.slice(0, 8)}）`)
    await msg.reply.notice(`会话列表（/switch <序号|id前缀> 切换）：\n${lines.join('\n')}`)
  }

  private async switchSession(bot: BotRecord, msg: InboundMessage, arg: string | undefined): Promise<void> {
    const catalog = this.deps.catalog?.()
    if (catalog === undefined) {
      await msg.reply.notice('会话切换在当前环境不可用')
      return
    }
    if (arg === undefined || arg.length === 0) {
      await msg.reply.notice('用法：/switch <序号|id前缀>（序号见 /sessions）')
      return
    }
    const entries = await catalog.list(bot.project)
    let target: SessionCatalogEntry | undefined
    if (/^\d+$/.test(arg)) {
      const ids = this.lastLists.get(`${bot.id}:${msg.chatId}`)
      const id = ids?.[Number(arg) - 1]
      target = id !== undefined ? entries.find((e) => e.sessionId === id) : undefined
      if (target === undefined) {
        await msg.reply.notice('序号无效或列表已过期，请先发送 /sessions 查看最新列表')
        return
      }
    } else {
      const matches = entries.filter((e) => e.sessionId.startsWith(arg))
      if (matches.length === 0) {
        await msg.reply.notice(`没有 id 前缀为 "${arg}" 的会话`)
        return
      }
      if (matches.length > 1) {
        await msg.reply.notice(`id 前缀 "${arg}" 命中多个会话，请加长前缀`)
        return
      }
      target = matches[0]
    }
    if (target.sessionId === this.deps.router.boundSessionId(bot.id, msg.chatId)) {
      await msg.reply.notice('已是当前会话')
      return
    }
    await this.deps.router.switchTo(bot, msg.chatId, target.sessionId, msg.reply, msg.userId)
    await msg.reply.notice(`已切换到会话：${target.title ?? '(无标题)'}（${target.sessionId.slice(0, 8)}）`)
  }
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- inbound`
Expected: PASS（含旧用例）

- [x] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/inbound.ts packages/toolkit/src/channels/inbound.test.ts
git commit -m "feat(toolkit): 飞书 /sessions /switch /help 指令（入站分流 + 序号缓存）"
```

---

### Task 5: 装配（runtime.ts + bots/index.ts）

**Files:**
- Modify: `packages/toolkit/src/channels/runtime.ts`
- Modify: `packages/toolkit/src/bots/index.ts`

**Interfaces:**
- Consumes: Task 3 的 `createSessionCatalog`/`CatalogServices`/`SessionCatalogPort`；Task 4 的 `InboundDeps.catalog`。
- Produces: 无新接口（纯接线）。

- [x] **Step 1: 接线 runtime.ts**

`packages/toolkit/src/channels/runtime.ts`：

a) import 行把 `SessionCatalogPort` 加入 ports 类型导入：

```ts
import type { AgentsPort, BindingStore, DefaultModelAccessor, SessionCatalogPort, SessionRuntime, WorkspacePort } from './ports.ts'
```

b) `RuntimeDeps` 在 `attachments?` 后追加：

```ts
  /** 可选：候选会话目录的惰性取用器（/sessions、/switch；缺席时两指令降级文案）。 */
  catalog?: () => SessionCatalogPort | undefined
```

c) 构造器里 `this.inbound = new Inbound({...})` 在 attachments 透传行后追加：

```ts
      ...(deps.catalog !== undefined ? { catalog: deps.catalog } : {}),
```

- [x] **Step 2: 接线 bots/index.ts**

`packages/toolkit/src/bots/index.ts`：

a) import 区追加：

```ts
import type { SessionCatalogPort } from '../channels/ports.ts'
import { createSessionCatalog, type CatalogSessionTitle, type CatalogSessions, type CatalogWorkspaceRegistry } from '../channels/session-catalog.ts'
```

b) 在 `attachmentsOf` 定义之后追加：

```ts
  // 候选会话目录（/sessions、/switch）：三服务均为可选，取用与 list 时惰性解析（attachments 同款）。
  const catalogOf = (): SessionCatalogPort | undefined =>
    createSessionCatalog(() => ({
      workspaceRegistry: ctx.get('workspaceRegistry', false) as CatalogWorkspaceRegistry | undefined,
      sessions: ctx.get('sessions', false) as CatalogSessions | undefined,
      sessionTitle: ctx.get('sessionTitle', false) as CatalogSessionTitle | undefined,
    }))
```

c) `new BotRuntime({...})` 的入参在 `attachments: attachmentsOf,` 后追加：

```ts
      catalog: catalogOf,
```

- [x] **Step 3: 类型检查 + 全量测试**

Run: `pnpm --filter dsh-agent-toolkit typecheck`; `pnpm --filter dsh-agent-toolkit test`
Expected: typecheck 无错；全部测试 PASS（现有 runtime.test.ts 不受影响——catalog 为可选字段）

- [x] **Step 4: Commit**

```bash
git add packages/toolkit/src/channels/runtime.ts packages/toolkit/src/bots/index.ts
git commit -m "feat(toolkit): 装配会话切换候选目录（runtime + bots 接线）"
```

---

### Task 6: 文档同步 + 最终验证

**Files:**
- Modify: `docs/domains/feishu.md`
- Modify: `docs/usage/feishu-bots.md`

**Interfaces:**
- Consumes: 前 5 个 Task 的全部行为事实。
- Produces: 无代码接口。

- [x] **Step 1: 更新 docs/domains/feishu.md**

在「入站、出站与发起人提示段」一节末尾（同段后续）追加一句（保持该文件一段一行的现行风格，单段落追加）：

```markdown
运维指令面（0.3.1 起）：`/new` `/stop` `/status` 为整条精确匹配指令；`/sessions` 列出 bot 项目 workspace 候选会话（workspaceRegistry 候选 + live 会话标题，标题取不到显示 (无标题)，三服务缺席降级）；`/switch <序号|id前缀>` 把 chat 绑定覆盖到目标会话（序号指最近一次 /sessions 输出的 per-chat 内存缓存；目标在内存直接复用、否则 resume 接管装配照常；binding 在 resume 成功后才覆盖；切走的旧 runtime 不 retire，在飞 turn 卡片照常收尾，闲置落定且未重新绑定后摘出 sessions）；`/help` 列出全部指令；workspaceRegistry 缺席时 /sessions 与 /switch 回复「会话切换在当前环境不可用」。
```

（当前 `packages/toolkit/package.json` 版本 0.3.0，本特性按惯例随下一版本 0.3.1 发布，故写 0.3.1；若执行时版本已推进，以当时 package.json 的下一版本号为准。）

- [x] **Step 2: 更新 docs/usage/feishu-bots.md**

「运维指令」表（L62-66）替换为：

```markdown
| 指令 | 作用 |
|---|---|
| `/new` | 取消当前会话任务、清除绑定、开新会话（清空上下文重新开始；旧会话保留，可用 `/switch` 切回） |
| `/stop` | 取消当前正在执行的任务（无任务时提示空闲） |
| `/status` | 显示绑定项目、会话 id、当前处理中/空闲状态 |
| `/sessions` | 列出本 bot 项目下可切换的会话（含 web 界面创建的；当前绑定标 ✓） |
| `/switch <序号\|id前缀>` | 切换到指定会话：序号取最近一次 `/sessions` 列表，或直接给会话 id 前缀；切走的会话任务不中断，卡片照常收尾 |
| `/help` | 显示全部指令 |
```

表下补一段：

```markdown
切换到 web 界面创建的会话时，该会话由本 bot 接管（套用 bot 的人设/工具/模型装配），web 界面仍能看到同一会话的消息流。`/switch` 切换不打断旧会话正在执行的任务。`/sessions`、`/switch` 依赖宿主 workspace 服务，环境不支持时会提示「会话切换在当前环境不可用」。
```

注意表格内 `/switch <序号|id前缀>` 的竖线要转义为 `\|`。

- [x] **Step 3: 最终全量验证**

Run: `pnpm --filter dsh-agent-toolkit test`; `pnpm --filter dsh-agent-toolkit typecheck`; `pnpm --filter dsh-agent-toolkit bundle`
Expected: 全部测试 PASS、typecheck 无错、bundle 成功（进开发回路前必须 bundle）

- [x] **Step 4: Commit**

```bash
git add docs/domains/feishu.md docs/usage/feishu-bots.md
git commit -m "docs(toolkit): 飞书会话切换指令（域文档 + 使用手册）"
```

- [x] **Step 5: 真实环境冒烟（手动，开发回路）**

```bash
pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml
```

在飞书里验证：`/help` → 建会话 → `/sessions`（✓ 标记）→ `/switch 1` → 发消息确认走新会话 → 切回 → `/new` 后 `/sessions` 里旧会话可切回。
