# 渠道发起人提示段 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bot 会话创建/恢复/重置时，向系统提示词注入静态提示段，声明会话来源渠道（feishu 等）与发起人 open_id，供 Agent 写多维表格"人员"字段使用。

**Architecture:** 入站消息已携带 `userId`（`InboundMessage.userId`），将其沿 `Inbound.handle → Router.ensure/reset → resolveSession → hooks.sections → setupAgentScope` 传递，复用现有创作期注入机制注册提示段；开关 `feishu.injectSender`（默认 true）经 `Config → setupBots → RuntimeDeps → Router` 接线。

**Tech Stack:** TypeScript / vitest / schemastery（z）/ cordis。

**Spec:** `docs/superpowers/specs/2026-09-03-channel-sender-section-design.md`

## Global Constraints

- 仓库根：`D:\work\github\dsh\dsh-agent-toolkit`；包：`packages/toolkit`（npm 名 `dsh-agent-toolkit`）。
- 提示段契约（spec 定案，逐字）：name = `dsh-agent-toolkit:channel:sender`，order = 20，text 模板 =
  ``本会话由 ${channel} 渠道的单聊会话发起。发起人 ID（${channel} open_id）：`${userId}`。``
- 仅单聊语义；不改绑定表 schema；不做姓名解析。
- 单测命令：`pnpm --filter dsh-agent-toolkit test`；类型检查：`pnpm --filter dsh-agent-toolkit typecheck`；构建：`pnpm --filter dsh-agent-toolkit bundle`（src 改动后必须跑）。
- 所有 `git commit` 步骤仅在用户当场确认后执行；执行者不得自行提交。

---

### Task 1: Config 增加 `feishu.injectSender` 开关

**Files:**
- Modify: `packages/toolkit/src/bots/index.ts:30-43`（`BotsModuleConfig` 接口）
- Modify: `packages/toolkit/src/index.ts:81-95`（feishu schema 与默认值字面量）
- Test: `packages/toolkit/src/index.test.ts`（`Config({})` 全量默认值断言，约 line 131）

**Interfaces:**
- Produces: `BotsModuleConfig.injectSender: boolean`（Config 默认 `true`）；供 Task 4 经 `setupBots(ctx, config, deps)` 消费。

- [ ] **Step 1: 改失败测试** — `index.test.ts` 中 `Config({}) 产出全量默认值` 用例的 `expect(config.feishu).toEqual({...})` 对象字面量里增加一行 `injectSender: true,`；再在该 describe 内新增用例：

```ts
test('feishu.injectSender=false 原样保留', () => {
  const config = Config({ feishu: { injectSender: false } })
  expect(config.feishu.injectSender).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/index.test.ts`
Expected: FAIL（`toEqual` 多出/缺少 `injectSender` 键）

- [ ] **Step 3: 实现** — `bots/index.ts` 的 `BotsModuleConfig` 接口末尾追加：

```ts
  /** 会话创建/恢复时注入「渠道 + 发起人 open_id」提示段（dsh-agent-toolkit:channel:sender）。 */
  injectSender: boolean
```

`index.ts` feishu schema 对象中 `errorDetailMaxChars` 行后加 `injectSender: z.boolean().default(true),`，下方 `.default({...})` 字面量同步加 `injectSender: true,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/index.ts packages/toolkit/src/bots/index.ts packages/toolkit/src/index.test.ts
git commit -m "feat(toolkit): feishu.injectSender 配置开关"
```

---

### Task 2: Router 注入发起人提示段

**Files:**
- Modify: `packages/toolkit/src/channels/router.ts`
- Test: `packages/toolkit/src/channels/router.test.ts`

**Interfaces:**
- Consumes: Task 1 无直接依赖（本任务 Router 自持 `injectSender` 布尔，Task 4 才接线）。
- Produces:
  - `export const SENDER_SECTION_NAME = 'dsh-agent-toolkit:channel:sender'`
  - `export function senderSectionText(channel: string, userId: string): string`
  - `Router` 构造函数末位新增可选参数 `injectSender = true`
  - `ensure(bot: BotRecord, chatId: string, reply: ReplyHandle, userId: string): Promise<SessionRuntime>`
  - `reset(bot: BotRecord, chatId: string, reply: ReplyHandle, userId: string): Promise<SessionRuntime>`
  - 主 Agent 形态与角色形态的 `hooks.sections` 末尾均追加 sender 段（`injectSender=false` 时不追加）

- [ ] **Step 1: 写失败测试** — `router.test.ts`：

`setup()` 的 Router 构造调用保持 7 参不变（`injectSender` 走默认 true）。所有既有 `router.ensure(fakeBot(), 'oc_1', reply)` / `router.reset(...)` 调用点补第 4 参 `'ou_u1'`（含 `bindings.set` 后 resume 的用例；`lookup` 用例的 ensure 同样补）。新增 describe：

```ts
describe('Router 发起人提示段', () => {
  const SENDER = { name: 'dsh-agent-toolkit:channel:sender', order: 20, text: '本会话由 feishu 渠道的单聊会话发起。发起人 ID（feishu open_id）：`ou_u1`。' }

  test('create（主 Agent 形态）：hooks.sections 末尾追加 sender 段', async () => {
    const { router, created } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(created[0].input.hooks).toEqual({ persona: '你是评审助手', tools: ['bash'], sections: [SENDER] })
  })

  test('resume 路径同样注入', async () => {
    const { router, bindings, resumed } = setup()
    await bindings.set('reviewer', 'oc_1', 'sess-old')
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(resumed[0].input.hooks).toMatchObject({ sections: [SENDER] })
  })

  test('角色形态：sender 段追加在角色 persona 段之后', async () => {
    const { router, created } = setup(undefined, fakeRegistry([MAIN_ROLE, REVIEWER_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'reviewer' }), 'oc_1', reply, 'ou_u1')
    expect(created[0].input.hooks).toEqual({
      sections: [
        { name: 'dsh-agent-toolkit:agent:persona', order: 0, text: '你是团队的评审成员。\n只审查 diff，不修改代码。' },
        SENDER,
      ],
      tools: ['bash', 'fs_read'],
    })
  })

  test('injectSender=false：不追加 sender 段', async () => {
    const { agents, bindings, sessions, workspace, onWarn, defaultModel, created } = setup()
    const router = new Router(agents, bindings, sessions, defaultModel, workspace, onWarn, fakeRegistry().registry, false)
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(created[0].input.hooks).toEqual({ persona: '你是评审助手', tools: ['bash'] })
    expect(created[0].input.hooks).not.toHaveProperty('sections')
  })

  test('/new 重置后新会话仍注入（发起人取当前消息发送人）', async () => {
    const { router, created } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    await router.reset(fakeBot(), 'oc_1', reply, 'ou_u2')
    expect(created[1].input.hooks).toMatchObject({
      sections: [{ name: SENDER.name, order: 20, text: '本会话由 feishu 渠道的单聊会话发起。发起人 ID（feishu open_id）：`ou_u2`。' }],
    })
  })
})
```

注意：既有用例中 `expect(created[0].input.hooks).toEqual({ persona: '你是评审助手', tools: ['bash'] })`（line 81、188、226）与 `expect(created[0].input.hooks).not.toHaveProperty('sections')`（line 189、228）在默认开启注入后会失败，需同步更新为含 `sections: [SENDER]` 的断言（SENDER 常量提升到文件顶部共用）。`fakeRegistry`/`MAIN_ROLE`/`REVIEWER_ROLE` 名称沿用既有文件，勿重复定义。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/router.test.ts`
Expected: FAIL（hooks 无 sections / ensure 参数数量不匹配）

- [ ] **Step 3: 实现** — `router.ts`：

文件顶部（import 之后）加：

```ts
/** 发起人提示段名：bot 会话声明来源渠道与发起人 open_id。 */
export const SENDER_SECTION_NAME = 'dsh-agent-toolkit:channel:sender'

/** sender 段文本（单聊语义；channel 取 BotRecord.channel，未来新渠道零改动透传）。 */
export function senderSectionText(channel: string, userId: string): string {
  return `本会话由 ${channel} 渠道的单聊会话发起。发起人 ID（${channel} open_id）：\`${userId}\`。`
}
```

import 行补 `type AgentSection`（来自 `./ports.ts`）。构造函数签名改为：

```ts
  constructor(
    private readonly agents: AgentsPort,
    private readonly bindings: BindingStore,
    private readonly sessions: Map<string, SessionRuntime>,
    private readonly defaultModel: DefaultModelAccessor,
    private readonly workspace: WorkspacePort,
    private readonly onWarn: (message: string) => void,
    private readonly registry: AgentRegistry,
    private readonly injectSender = true,
  ) {}
```

`ensure`/`reset` 签名各加第 4 参 `userId: string`，内部 `resolveSession(bot)` 调用改为 `resolveSession(bot, userId)`（ensure 内两处、reset 经 ensure 间接获得）。新增私有方法并把 `resolveSession` 两个 return 包一层：

```ts
  /** injectSender 开启时向 hooks.sections 末尾追加 sender 段（主/角色形态通用）。 */
  private withSenderSection(hooks: AgentHooks, bot: BotRecord, userId: string): AgentHooks {
    if (!this.injectSender) return hooks
    const section: AgentSection = { name: SENDER_SECTION_NAME, order: 20, text: senderSectionText(bot.channel ?? 'unknown', userId) }
    return { ...hooks, sections: [...(hooks.sections ?? []), section] }
  }
```

`resolveSession(bot: BotRecord, userId: string)` 中：main 分支 `return { agentOptions: ..., hooks: this.withSenderSection(hooksOf(bot), bot, userId) }`；角色分支对组装好的 hooks 同样包一层。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/channels/router.ts packages/toolkit/src/channels/router.test.ts
git commit -m "feat(toolkit): Router 注入渠道发起人提示段"
```

---

### Task 3: Inbound 透传 userId

**Files:**
- Modify: `packages/toolkit/src/channels/inbound.ts:42,64`
- Test: `packages/toolkit/src/channels/inbound.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Router.ensure/reset` 新签名（第 4 参 `userId: string`）。
- Produces: 无新导出；行为 = 每条入站消息把 `msg.userId` 传入路由层。

- [ ] **Step 1: 写失败测试** — `inbound.test.ts` 的 `harness()` 中 `Router` 构造调用保持原样（默认 injectSender=true）；`msg()` 工厂已固定 `userId: 'ou_u1'`。新增用例（用 spy 观察路由入参，不依赖 hooks 细节）：

```ts
test('入站消息把 userId 透传给 router.ensure', async () => {
  const { inbound, msg, sessions } = harness()
  inbound.onMessage(msg('你好'))
  await vi.waitFor(() => { expect(sessions.size).toBe(1) })
  const [rt] = [...sessions.values()]
  // ensure 由 onMessage 内部触发；改从 agent 侧 hooks 取证：
  // harness 的 AgentsPort.create 收到的 hooks.sections 含 sender 段
})
```

更直接的取证方式：`harness()` 的 `agents.create` 已收 `input`；给 `Recorded` 加 `hookInputs: unknown[]`，`create`/`resume` 里 `rec.hookInputs.push(input.hooks)`；断言：

```ts
test('入站消息把 userId 透传：会话 hooks 含 sender 段（ou_u1）', async () => {
  const { inbound, msg, rec } = harness()
  inbound.onMessage(msg('你好'))
  await vi.waitFor(() => { expect(rec.hookInputs).toHaveLength(1) })
  expect(rec.hookInputs[0]).toMatchObject({
    sections: [{ name: 'dsh-agent-toolkit:channel:sender', order: 20, text: '本会话由 feishu 渠道的单聊会话发起。发起人 ID（feishu open_id）：`ou_u1`。' }],
  })
})

test('/new 指令：reset 路径同样携带 userId', async () => {
  const { inbound, msg, rec } = harness()
  inbound.onMessage(msg('/new'))
  await vi.waitFor(() => { expect(rec.hookInputs).toHaveLength(1) })
  expect(rec.hookInputs[0]).toMatchObject({ sections: [{ name: 'dsh-agent-toolkit:channel:sender' }] })
})
```

（第一个测试的注释草稿以最终代码为准，不留注释废稿。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/inbound.test.ts`
Expected: FAIL（hooks 无 sections）

- [ ] **Step 3: 实现** — `inbound.ts`：

- `handle` 中 `await this.deps.router.reset(bot, msg.chatId, msg.reply)` 改为 `await this.deps.router.reset(bot, msg.chatId, msg.reply, msg.userId)`（约 line 42）；
- `const rt = await this.deps.router.ensure(bot, msg.chatId, msg.reply)` 改为 `await this.deps.router.ensure(bot, msg.chatId, msg.reply, msg.userId)`（约 line 64）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/inbound.test.ts`
Expected: PASS

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/channels/inbound.ts packages/toolkit/src/channels/inbound.test.ts
git commit -m "feat(toolkit): 入站消息透传发起人 userId 至路由层"
```

---

### Task 4: Runtime 与 bots 模块接线

**Files:**
- Modify: `packages/toolkit/src/channels/runtime.ts`（`RuntimeDeps` + Router 构造调用，line 12-31、44）
- Modify: `packages/toolkit/src/bots/index.ts`（BotRuntime deps 字面量，line 165-182）
- Test: `packages/toolkit/src/channels/runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `BotsModuleConfig.injectSender`；Task 2 的 Router 末位构造参数。
- Produces: `RuntimeDeps.injectSender?: boolean`（缺省视为 true，存量测试零改动）。

- [ ] **Step 1: 写失败测试** — `runtime.test.ts` 既有 harness 不传 `injectSender`（走默认 true）。新增用例：构造 `RuntimeDeps` 时显式 `injectSender: false`，经 `runtime.inbound.onMessage(...)` 发一条消息，断言 agents fake 收到的 `input.hooks` 无 `sections` 属性。参照该文件既有"入站 → 会话创建"用例的 fake 写法（`RuntimeDeps` 各字段 fake 已齐备，仅 deps 字面量加 `injectSender: false`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/runtime.test.ts`
Expected: FAIL（hooks 仍含 sender 段）

- [ ] **Step 3: 实现**

`runtime.ts` `RuntimeDeps` 接口加：

```ts
  /** 发起人提示段开关（缺省 true；见 Config feishu.injectSender）。 */
  injectSender?: boolean
```

构造函数中 Router 调用改为：

```ts
    this.router = new Router(deps.agents, bindingStore, this.sessions, deps.defaultModel, deps.workspace, (m) => deps.log.warn(m), deps.registry, deps.injectSender ?? true)
```

`bots/index.ts` BotRuntime deps 字面量加一行 `injectSender: config.injectSender,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/runtime.test.ts`
Expected: PASS

- [ ] **Step 5: Commit（需用户确认）**

```bash
git add packages/toolkit/src/channels/runtime.ts packages/toolkit/src/channels/runtime.test.ts packages/toolkit/src/bots/index.ts
git commit -m "feat(toolkit): injectSender 经 RuntimeDeps 接线至 Router"
```

---

### Task 5: 文档与全量验证

**Files:**
- Modify: `docs/usage/config-reference.md`（feishu 配置表，line 54-59 附近 + 上方示例片段 line 24-29）

- [ ] **Step 1: 更新使用手册** — 配置示例片段加 `injectSender: true`；参数表加一行：

```markdown
| `feishu.injectSender` | boolean | `true` | 会话创建时注入「渠道 + 发起人 open_id」提示段（`dsh-agent-toolkit:channel:sender`），供 Agent 写多维表格人员字段等场景使用 |
```

- [ ] **Step 2: 全量验证**

Run（工作目录仓库根，逐条执行、全部通过才算完成）:
```
pnpm --filter dsh-agent-toolkit test
pnpm --filter dsh-agent-toolkit typecheck
pnpm --filter dsh-agent-toolkit bundle
```
Expected: 374+ 测试全绿（新增用例计入）；typecheck 零错误；bundle 产出 lib/index.js + lib/client.js。

- [ ] **Step 3: Commit（需用户确认）**

```bash
git add docs/usage/config-reference.md
git commit -m "docs(toolkit): config-reference 补 feishu.injectSender"
```

---

## 自审记录

- Spec 覆盖：提示段契约 → Task 2；Config 开关 → Task 1 + Task 4 接线；create/resume//new 三路径 → Task 2/3 测试；文档 → Task 5。绑定表/姓名解析/群聊均为 spec 明确的非目标，无对应任务。
- 类型一致性：`ensure/reset` 第 4 参 `userId: string`（Task 2 产出）与 Task 3 调用一致；`injectSender` 在 Config（必填 boolean）→ BotsModuleConfig（必填）→ RuntimeDeps（可选，缺省 true）的收敛有意为之（存量 runtime/inbound 测试零改动）。
- 已知顺序敏感点：Task 3 依赖 Task 2 的签名；Task 4 依赖 Task 1+2。按序执行。
