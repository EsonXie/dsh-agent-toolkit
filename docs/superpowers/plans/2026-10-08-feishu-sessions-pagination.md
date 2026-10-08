# 飞书 /sessions 分页实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飞书 `/sessions` 指令支持分页（`/sessions [页码]`），页大小进 Config schema（`sessionsPageSize`，默认 10），`/switch <序号>` 保持全表全局编号语义不变。

**Architecture:** `/sessions` 从精确指令改首词带参指令（`directive.ts`）；目录条目仍一次取全量、内存切片分页，编号全局连续；`lastLists` 缓存保持全量 id 数组；新增参数沿 `docMaxBytes` 既有链接线：`src/index.ts` Config → `BotsModuleConfig` → `RuntimeDeps` → `InboundDeps`。

**Tech Stack:** TypeScript、vitest、schemastery（Config schema）。

**Spec:** `docs/superpowers/specs/2026-10-08-feishu-sessions-pagination-design.md`

## Global Constraints

- 单测：`pnpm --filter dsh-agent-toolkit test`；类型检查：`pnpm --filter dsh-agent-toolkit typecheck`（改动 src 后另需 `pnpm --filter dsh-agent-toolkit bundle` 才进开发回路，本计划门禁只跑 test + typecheck）
- 测试文件与被测文件同目录（`*.test.ts`），vitest；异步断言用 `vi.waitFor`
- 仓库约定：可调参数进 Config schema，不硬编码；不写无关注释以外的代码注释风格与邻代码一致（中文注释）
- `docs/domains/feishu.md` 是飞书域现行事实权威文档，行为变更必须同步
- commit message 风格：`feat(toolkit): ...`（中文描述）

---

### Task 1: directive.ts — /sessions 改首词带参指令

**Files:**
- Modify: `packages/toolkit/src/channels/directive.ts`
- Test: `packages/toolkit/src/channels/directive.test.ts`

**Interfaces:**
- Consumes: 现有 `ParsedDirective { name: Directive; arg?: string }`
- Produces: `parseDirective('/sessions 2') === { name: 'sessions', arg: '2' }`；Task 3 的 `handle` 分支把 `directive.arg` 传给 `listSessions`

- [ ] **Step 1: 改测试（先写失败测试）**

`directive.test.ts` 中：

把 `识别新指令 /sessions 与 /help（整条精确匹配）` 测试改名为 `识别新指令 /sessions 与 /help`（`/sessions` 无参仍精确命中，断言不变）。

在 `/switch 带参` 测试后新增：

```ts
  test('/sessions 带参：首词判定，余串为 arg（页码）', () => {
    expect(parseDirective('/sessions 2')).toEqual({ name: 'sessions', arg: '2' })
    expect(parseDirective('/SESSIONS  3 ')).toEqual({ name: 'sessions', arg: '3' })
    expect(parseDirective('/sessions abc')).toEqual({ name: 'sessions', arg: 'abc' })
  })

  test('/sessions 前缀不误伤：/sessionsx 不是指令', () => {
    expect(parseDirective('/sessionsx')).toBeNull()
  })
```

修改 `普通文本与带参数的精确指令都不算` 测试：删除 `expect(parseDirective('/sessions 请')).toBeNull()` 一行（`/sessions 请` 现解析为 `{ name: 'sessions', arg: '请' }`，非数字参数由 Inbound 提示用法——Task 3）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/directive.test.ts`
Expected: FAIL（`/sessions 2` 返回 `null`）

- [ ] **Step 3: 实现**

`directive.ts`：把 `if (t === '/sessions') return { name: 'sessions' }` 一行替换为：

```ts
  if (t === '/sessions') return { name: 'sessions' }
  if (t.startsWith('/sessions ')) return { name: 'sessions', arg: t.slice('/sessions '.length).trim() }
```

（位置保持在 `/help` 判定之前；arg 取自 `t`——页码是数字，大小写无影响。）

函数 doc 注释第一行改为：

```ts
 * 精确指令（/new /stop /status /help）要求整条消息 trim+lowercase 精确匹配，
 * 带参数/前后文按普通消息处理；/sessions /switch /doc /ls 为首词判定的带参指令。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/directive.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/directive.ts packages/toolkit/src/channels/directive.test.ts
git commit -m "feat(toolkit): /sessions 改首词带参指令（分页页码参数）"
```

---

### Task 2: sessionsPageSize 配置链路（Config schema → InboundDeps）

**Files:**
- Modify: `packages/toolkit/src/index.ts`（feishu schema，约 91-134 行）
- Modify: `packages/toolkit/src/bots/index.ts`（`BotsModuleConfig` 43-79 行 + `BotRuntime` 构造 200-223 行）
- Modify: `packages/toolkit/src/channels/runtime.ts`（`RuntimeDeps` 29-30 行附近 + `Inbound` 构造 62-71 行）
- Modify: `packages/toolkit/src/channels/inbound.ts`（`InboundDeps` 18-31 行）
- Test: `packages/toolkit/src/bots/smoke.test.ts`、`packages/toolkit/src/index.test.ts`（157-174 行 feishu 断言）、`packages/toolkit/src/channels/runtime.test.ts`（65 行附近 deps 字面量）、`packages/toolkit/src/channels/inbound.test.ts`（harness 28-96 行）

**Interfaces:**
- Consumes: 无（新参数）
- Produces: `BotsModuleConfig.sessionsPageSize: number`、`RuntimeDeps.sessionsPageSize: number`、`InboundDeps.sessionsPageSize: number`（必填）；Config schema 键 `feishu.sessionsPageSize` 默认 `10`；Task 3 在 `listSessions` 里消费 `this.deps.sessionsPageSize`

- [ ] **Step 1: 改测试（先写失败测试）**

`smoke.test.ts`：测试名 `十七字段` 改 `十八字段`；`config` 字面量加 `sessionsPageSize: 0`；keys 数组末尾加 `'sessionsPageSize'`（保持字典序，`'registerAppTimeoutMs'` 之后）：

```ts
  test('BotsModuleConfig 十八字段（sessionsPageSize 为 /sessions 分页新增）', () => {
    const config: BotsModuleConfig = {
      cardUpdateThrottleMs: 0, cardMaxBytes: 0, cardPrintStep: 0, processMaxBytes: 0,
      registerAppTimeoutMs: 0, processingReactionEmoji: '', errorDetailMaxChars: 0, injectSender: false, approval: false, questions: false, docMaxBytes: 0,
      debugLog: false, debugLogDir: '', debugLogRetentionDays: 0, permissionPreset: 'danger-full-access',
      questionTimeoutMs: 0, approvalTimeoutMs: 0, sessionsPageSize: 0,
    }
    expect(Object.keys(config).sort()).toEqual([
      'approval', 'approvalTimeoutMs', 'cardMaxBytes', 'cardPrintStep', 'cardUpdateThrottleMs', 'debugLog', 'debugLogDir', 'debugLogRetentionDays',
      'docMaxBytes', 'errorDetailMaxChars', 'injectSender', 'permissionPreset', 'processMaxBytes', 'processingReactionEmoji',
      'questionTimeoutMs', 'questions', 'registerAppTimeoutMs', 'sessionsPageSize',
    ])
  })
```

`index.test.ts` feishu `toEqual` 字面量（157-174 行）`docMaxBytes: 31_457_280,` 后加一行：

```ts
      sessionsPageSize: 10,
```

`runtime.test.ts` deps 字面量（65 行 `docMaxBytes: 1024,` 附近）加一行：

```ts
    sessionsPageSize: 10,
```

`inbound.test.ts` harness：opts 接口（36 行 `consumeAnswer?:` 附近）加：

```ts
  sessionsPageSize?: number
```

`new Inbound({...})`（72-81 行）`docMaxBytes: 1024 * 1024,` 后加：

```ts
    sessionsPageSize: opts.sessionsPageSize ?? 10,
```

- [ ] **Step 2: 跑 typecheck 确认失败**

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: FAIL（`BotsModuleConfig` 缺 `sessionsPageSize`、`InboundDeps`/`RuntimeDeps` 未声明等类型错误）

- [ ] **Step 3: 实现**

`src/index.ts`：
- 85-87 行注释里 `17 个` 改 `18 个`（句末追加：`sessionsPageSize` 为 /sessions 分页新增）。
- schema 内 `docMaxBytes: z.number().default(30 * 1024 * 1024),` 后加：

```ts
    /** /sessions 每页条数。 */
    sessionsPageSize: z.number().default(10),
```

- `.default({...})` 字面量 `docMaxBytes: 30 * 1024 * 1024,` 后加：

```ts
    sessionsPageSize: 10,
```

`src/bots/index.ts`：
- 43 行注释 `17 个` 改 `18 个`（句末追加：`sessionsPageSize` 为 /sessions 分页新增）。
- `BotsModuleConfig` 接口 `docMaxBytes: number` 后加：

```ts
  /** /sessions 每页条数。 */
  sessionsPageSize: number
```

- `BotRuntime` 构造参数（213 行 `docMaxBytes: config.docMaxBytes,` 后）加：

```ts
      sessionsPageSize: config.sessionsPageSize,
```

`src/channels/runtime.ts`：
- `RuntimeDeps` `docMaxBytes: number`（29-30 行）后加：

```ts
  /** /sessions 每页条数。 */
  sessionsPageSize: number
```

- `new Inbound({...})`（66 行 `docMaxBytes: deps.docMaxBytes,` 后）加：

```ts
      sessionsPageSize: deps.sessionsPageSize,
```

`src/channels/inbound.ts` `InboundDeps` `docMaxBytes: number`（22-23 行）后加：

```ts
  /** /sessions 每页条数（<= 0 按 1 计）。 */
  sessionsPageSize: number
```

- [ ] **Step 4: 跑 typecheck 与相关测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/bots/smoke.test.ts src/index.test.ts src/channels/runtime.test.ts src/channels/inbound.test.ts`
Expected: PASS（inbound 行为未变，现有 /sessions 测试全绿）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/index.ts packages/toolkit/src/bots/index.ts packages/toolkit/src/channels/runtime.ts packages/toolkit/src/channels/inbound.ts packages/toolkit/src/bots/smoke.test.ts packages/toolkit/src/index.test.ts packages/toolkit/src/channels/runtime.test.ts packages/toolkit/src/channels/inbound.test.ts
git commit -m "feat(toolkit): 新增 feishu.sessionsPageSize 配置（/sessions 每页条数，默认 10）"
```

---

### Task 3: inbound.ts — listSessions 分页 + HELP_TEXT

**Files:**
- Modify: `packages/toolkit/src/channels/inbound.ts`（HELP_TEXT 40-51 行、`handle` sessions 分支 127-130 行、`listSessions` 254-270 行）
- Test: `packages/toolkit/src/channels/inbound.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `directive.arg`（`/sessions <页码>`）；Task 2 的 `this.deps.sessionsPageSize: number`
- Produces: `/sessions [页码]` 分页输出（全局编号 + 页脚 `共 X 个会话，第 P/Q 页（/sessions <页码> 翻页）`，单页省略页脚）；`lastLists` 仍缓存全量 id（`/switch <序号>` 语义不变）

- [ ] **Step 1: 改测试（先写失败测试）**

`inbound.test.ts` 在 `CATALOG_ENTRIES`（532-535 行）后加：

```ts
const MANY_ENTRIES = Array.from({ length: 25 }, (_, i) => ({
  sessionId: `cccc${String(i + 1).padStart(4, '0')}-0000-0000-0000-000000000000`,
  title: `会话${i + 1}`,
}))
```

在 `/sessions：空列表提示` 测试后新增：

```ts
test('/sessions 分页：默认第 1 页，/sessions 2、/sessions 3 编号连续带页脚', async () => {
  const { rec, inbound, msg } = catalogHarness(MANY_ENTRIES)
  inbound.onMessage(msg('/sessions'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('会话列表'))).toBe(true) })
  const page1 = rec.notices.find((n) => n.includes('会话列表'))!
  expect(page1).toContain('1. 会话1（cccc0001）')
  expect(page1).toContain('10. 会话10（cccc0010）')
  expect(page1).not.toContain('11. 会话11')
  expect(page1).toContain('共 25 个会话，第 1/3 页')

  rec.notices.length = 0
  inbound.onMessage(msg('/sessions 2'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('会话列表'))).toBe(true) })
  const page2 = rec.notices.find((n) => n.includes('会话列表'))!
  expect(page2).toContain('11. 会话11（cccc0011）')
  expect(page2).toContain('20. 会话20（cccc0020）')
  expect(page2).toContain('共 25 个会话，第 2/3 页')

  rec.notices.length = 0
  inbound.onMessage(msg('/sessions 3'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('会话列表'))).toBe(true) })
  const page3 = rec.notices.find((n) => n.includes('会话列表'))!
  expect(page3).toContain('21. 会话21（cccc0021）')
  expect(page3).toContain('25. 会话25（cccc0025）')
  expect(page3).toContain('共 25 个会话，第 3/3 页')
})

test('/sessions 分页：单页省略页脚', async () => {
  const { rec, inbound, msg } = catalogHarness(CATALOG_ENTRIES)
  inbound.onMessage(msg('/sessions'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('会话列表'))).toBe(true) })
  const list = rec.notices.find((n) => n.includes('会话列表'))!
  expect(list).not.toContain('翻页')
})

test('/sessions 分页：页码越界与非数字参数提示', async () => {
  const { rec, inbound, msg } = catalogHarness(MANY_ENTRIES)
  inbound.onMessage(msg('/sessions 4'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('页码超出范围'))).toBe(true) })
  expect(rec.notices.find((n) => n.includes('页码超出范围'))).toContain('共 3 页')
  inbound.onMessage(msg('/sessions 0'))
  await vi.waitFor(() => { expect(rec.notices.filter((n) => n.includes('页码超出范围'))).toHaveLength(2) })
  inbound.onMessage(msg('/sessions abc'))
  await vi.waitFor(() => { expect(rec.notices).toContain('用法：/sessions [页码]') })
})

test('/switch 序号跨页：/sessions 2 后按全局序号切换第 1 页条目', async () => {
  const { rec, inbound, router, msg } = catalogHarness(MANY_ENTRIES)
  inbound.onMessage(msg('建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('/sessions 2'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('会话列表'))).toBe(true) })
  inbound.onMessage(msg('/switch 3'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已切换到会话'))).toBe(true) })
  expect(router.boundSessionId('reviewer', 'oc_1')).toBe(MANY_ENTRIES[2].sessionId)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/inbound.test.ts`
Expected: FAIL（无分页，第 1 页含全部 25 条、无页脚；`/sessions 2` 被当普通消息进 followup）

- [ ] **Step 3: 实现**

`inbound.ts`：

HELP_TEXT 中 `'/sessions 列出本项目可切换的会话',` 改为：

```ts
  '/sessions [页码] 列出本项目可切换的会话（分页）',
```

`handle` 中 sessions 分支改为传 arg：

```ts
    if (directive?.name === 'sessions') {
      await this.listSessions(bot, msg, directive.arg)
      return
    }
```

`listSessions` 整体替换为：

```ts
  private async listSessions(bot: BotRecord, msg: InboundMessage, arg: string | undefined): Promise<void> {
    const catalog = this.deps.catalog?.()
    if (catalog === undefined) {
      await msg.reply.notice('会话切换在当前环境不可用')
      return
    }
    if (arg !== undefined && !/^\d+$/.test(arg)) {
      await msg.reply.notice('用法：/sessions [页码]')
      return
    }
    const entries = await catalog.list(bot.project)
    if (entries.length === 0) {
      await msg.reply.notice('当前项目下还没有可切换的会话（发消息即创建）')
      return
    }
    // 缓存全量 id（任意页都刷新）：/switch <序号> 的序号 = 全表全局编号，翻页不影响切换语义。
    this.lastLists.set(routeKey(bot.id, msg.chatId, msg.threadId), entries.map((e) => e.sessionId))
    const pageSize = Math.max(1, Math.floor(this.deps.sessionsPageSize))
    const totalPages = Math.ceil(entries.length / pageSize)
    const page = arg === undefined ? 1 : Number(arg)
    if (page < 1 || page > totalPages) {
      await msg.reply.notice(`页码超出范围：共 ${totalPages} 页（/sessions <页码> 翻页）`)
      return
    }
    const current = this.deps.router.boundSessionId(bot.id, msg.chatId, msg.threadId)
    const slice = entries.slice((page - 1) * pageSize, page * pageSize)
    const lines = slice.map((e, i) =>
      `${(page - 1) * pageSize + i + 1}. ${e.sessionId === current ? '✓ ' : ''}${e.title}（${e.sessionId.slice(0, 8)}）`)
    const footer = totalPages > 1 ? `\n共 ${entries.length} 个会话，第 ${page}/${totalPages} 页（/sessions <页码> 翻页）` : ''
    await msg.reply.notice(`会话列表（/switch <序号|id前缀> 切换）：\n${lines.join('\n')}${footer}`)
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/inbound.test.ts`
Expected: PASS（含既有 /sessions、/switch、/help 测试）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/inbound.ts packages/toolkit/src/channels/inbound.test.ts
git commit -m "feat(toolkit): /sessions 分页（全局编号 + 页脚，/switch 序号语义不变）"
```

---

### Task 4: 文档同步 + 全量门禁

**Files:**
- Modify: `docs/domains/feishu.md`（第 11 行「运维指令面」段）
- Modify: `docs/usage/feishu-bots.md`（70 行指令表 /sessions 行、76 行说明段）

**Interfaces:**
- Consumes: Task 1-3 已落地行为
- Produces: 域文档与使用手册反映分页现状

- [ ] **Step 1: 更新域文档**

`docs/domains/feishu.md` 第 11 行段中：

- 「`/sessions` 列出 bot 项目 workspace 候选会话，标题与 web 端完全同源（2026-09-20 对齐）」改为「`/sessions [页码]` 分页列出 bot 项目 workspace 候选会话（首词带参指令，每页条数 `feishu.sessionsPageSize` 默认 10，编号全局连续，多页时页脚「共 X 个会话，第 P/Q 页」；页码越界/非数字参数提示用法；标题与 web 端完全同源（2026-09-20 对齐）」
- 「序号指最近一次 /sessions 输出的 per-route 内存缓存」改为「序号指最近一次 /sessions 输出的 per-route 内存缓存（缓存全量 id，序号 = 全表全局编号，翻页不影响）」

- [ ] **Step 2: 更新使用手册**

`docs/usage/feishu-bots.md`：
- 70 行表格行改为：`| \`/sessions [页码]\` | 分页列出本 bot 项目下可切换的会话（含 web 界面创建的；当前绑定标 ✓；每页 10 条，可在设置里调 \`sessionsPageSize\`） |`
- 76 行段中「`/switch` 切换不打断旧会话正在执行的任务。」后追加「`/sessions` 会话多时按页显示（编号全局连续），按提示发 `/sessions <页码>` 翻页；`/switch` 的序号始终对应全表编号，不受翻页影响。」

- [ ] **Step 3: 全量门禁**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: 全部 PASS（基线 881 passed / 2 skipped，本计划净增 6 个测试）

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add docs/domains/feishu.md docs/usage/feishu-bots.md
git commit -m "docs: 同步 /sessions 分页（feishu 域文档 + 使用手册）"
```

---

## Self-Review 记录

- Spec 覆盖：指令解析（Task 1）、配置链路（Task 2）、分页行为/全局编号/页脚/越界/HELP_TEXT（Task 3）、/switch 兼容（Task 3 跨页测试 + lastLists 全量缓存）、测试项（各 Task Step 1）、文档同步（Task 4，AGENTS.md 约定）。无缺口。
- 占位符扫描：无 TBD/TODO；全部代码步骤含实际代码。
- 类型一致性：`sessionsPageSize` 链四处签名一致（schema 键 `feishu.sessionsPageSize` → `BotsModuleConfig.sessionsPageSize` → `RuntimeDeps.sessionsPageSize` → `InboundDeps.sessionsPageSize`，均 `number` 必填）；`listSessions(bot, msg, arg?: string)` 与 Task 1 `directive.arg?: string` 对齐。
