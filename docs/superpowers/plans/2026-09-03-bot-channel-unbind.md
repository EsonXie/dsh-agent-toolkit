# 消息机器人发送渠道解绑/重绑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bot 的飞书渠道绑定支持解绑（保留配置与历史会话、删密钥）与重新绑定，列表与编辑表单呈现未绑定态。

**Architecture:** `BotRecordSchema` 的 `channel`/`feishu` 放宽为可选（加同有或同无 refine，零迁移）；解绑走 PUT `feishu: null`（与现有 nullable 清空语义一致），重绑走 PUT `feishu: { appId, appSecret | appSecretRef }`；runtime 新增 `unbindBot`（停渠道 + 取消在飞会话，保留绑定表）与 `'unbound'` 状态；UI 在编辑表单第 2 步内解绑（两段确认）/重绑（复用创建的扫码/手动区块）。

**Tech Stack:** TypeScript、zod、cordis、vitest（Node 半 + jsdom 客户端半）、React（@deepseek-ai/dsh-client-ui-primitives）。

**Spec:** `docs/superpowers/specs/2026-09-03-bot-channel-unbind-design.md`

## Global Constraints

- 所有命令从仓库根 `D:\work\github\dsh\dsh-agent-toolkit` 跑，聚焦单文件测试用 `pnpm exec vitest run <file>`（workdir `packages/toolkit`）
- 全量测试 `pnpm --filter dsh-agent-toolkit test`；类型检查 `pnpm --filter dsh-agent-toolkit typecheck`；构建 `pnpm --filter dsh-agent-toolkit bundle`（最后任务跑）
- schema 单一来源 `packages/toolkit/src/bots/store.ts`；domain version 保持 1，不做迁移
- 解绑语义（用户定案）：删密钥凭据、**保留** bindings 表与持久会话；换绑 = 先解绑再重绑，不做一步换绑
- 每任务一个 commit，conventional commits 中文描述；不修改 `deepseek-harness/` 下任何文件
- 注释风格沿仓库惯例：文件顶 doc comment + 关键分支中文行注释；不做无关重构

---

### Task 1: BotRecordSchema 放宽为未绑定态 + 渠道类型修正

**Files:**
- Modify: `packages/toolkit/src/bots/store.ts:18-38`（BotRecordSchema）
- Modify: `packages/toolkit/src/channels/feishu/index.ts:12`（解构加非空断言）
- Test: `packages/toolkit/src/bots/store.test.ts`

**Interfaces:**
- Produces: `BotRecord.channel?: 'feishu'`、`BotRecord.feishu?: FeishuConfig`（后续 runtime/API/UI 任务依赖此可选性）；`BotRecordSchema` 变为 ZodEffects（refine 后），调用方只用 `safeParse`/`parse` 不受影响
- 消费方约束：渠道 `start(bot: ResolvedBot)` 只会收到已绑定记录（runtime Task 2 的 guard 保证），故 `feishu/index.ts` 解构用 `!`

- [ ] **Step 1: 写失败测试（store.test.ts 的 BotRecordSchema describe 内追加）**

```ts
  test('未绑定记录：channel 与 feishu 双缺省通过', () => {
    const unbound = {
      id: 'ops', name: '运维', project: '/tmp/x', createdAt: 0, updatedAt: 0,
    }
    expect(BotRecordSchema.safeParse(unbound).success).toBe(true)
  })

  test('半绑定态拒绝：只有 channel 或只有 feishu 均不通过', () => {
    expect(BotRecordSchema.safeParse({ ...validBot, channel: undefined }).success).toBe(false)
    expect(BotRecordSchema.safeParse({ ...validBot, feishu: undefined }).success).toBe(false)
  })
```

同时把现有 `'拒绝非法 appId / 非法 id / 空工具白名单'` 测试里的 `{ ...validBot.feishu, appId: 'bad' }` 改为字面量（`validBot.feishu` 变为可空类型，避免 TS 报错）：

```ts
    expect(BotRecordSchema.safeParse({ ...validBot, feishu: { appId: 'bad', appSecretRef: 'project_bot_reviewer' } }).success).toBe(false)
```

- [ ] **Step 2: 跑测试确认失败**

Run（workdir `packages/toolkit`）: `pnpm exec vitest run src/bots/store.test.ts`
Expected: FAIL——只有「未绑定记录」用例失败（channel/feishu 必填拒绝）；两条半绑定用例在改造前就断言 `success === false` 而误通过（保留它们，改造后由 refine 真正把关）

- [ ] **Step 3: 实现放宽（store.ts）**

`BotRecordSchema` 改为（channel/feishu 可选 + refine）：

```ts
export const BotRecordSchema = z.object({
  id: z.string().regex(BOT_ID_RE),
  name: z.string().min(1).max(64),
  /** 渠道类型；与 feishu 同有或同无（未绑定为双双缺省）。 */
  channel: z.literal('feishu').optional(),
  feishu: FeishuConfigSchema.optional(),
  /** 绑定项目（agent 的 cwd，绝对路径）。一 bot 一项目。 */
  project: z.string().min(1),
  /** 透传到 agent 创作期的 persona 提示段。 */
  persona: z.string().max(8000).optional(),
  /** 绑定的 Agent（'main' 或注册表角色 id，缺省 = 'main'）。 */
  agentRef: z.string().min(1).optional(),
  /** 可用工具白名单（缺省 = 不限制）；空数组无意义，直接拒绝。 */
  tools: z.array(z.string().min(1)).min(1).optional(),
  agentOptions: z.object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).refine(
  (r) => (r.channel === undefined) === (r.feishu === undefined),
  { message: 'channel 与 feishu 必须同有或同无' },
)
```

- [ ] **Step 4: 修渠道解构类型（feishu/index.ts:12）**

```ts
    // runtime 仅对已绑定记录启动渠道（reconcile 的 feishu guard），此处安全。
    const { appId } = bot.record.feishu!
```

- [ ] **Step 5: 跑测试确认通过**

Run（workdir `packages/toolkit`）: `pnpm exec vitest run src/bots/store.test.ts`
Expected: PASS（含新增两条）

注意：本任务后仓库暂不过 typecheck（`api.ts`、`runtime.ts`、`BotForm.tsx` 对 `feishu` 的既有访问变为 possibly-undefined）——这是已知中间态，分别由 Task 2/3/5 的真实逻辑修复；vitest 不做类型检查，各任务测试不受影响。typecheck 门槛统一在 Task 6 把守。

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/bots/store.ts packages/toolkit/src/bots/store.test.ts packages/toolkit/src/channels/feishu/index.ts
git commit -m "feat(toolkit): bot 记录支持未绑定态（channel/feishu 可选 + 一致性 refine）"
```

---

### Task 2: Runtime 的 unbound 状态与 unbindBot

**Files:**
- Modify: `packages/toolkit/src/channels/runtime.ts`（`BotStatus` 联合类型 :30、`reconcile` :51-80、`statusOf` :94-96、新增 `unbindBot`）
- Test: `packages/toolkit/src/channels/runtime.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `BotRecord.feishu?: FeishuConfig`
- Produces: `BotStatus = ChannelStatus | 'not-running' | 'unbound'`；`BotRuntime.unbindBot(botId: string): Promise<void>`（停渠道 + cancel 并移除进程内该 bot 会话；**不动** bindings 表与持久会话）——Task 3 的 `ApiDeps.runtime` 依赖此方法

- [ ] **Step 1: 写失败测试（runtime.test.ts 顶部常量区后追加）**

```ts
const UNBOUND: BotRecord = {
  id: 'loose', name: '未绑定', project: 'D:\\work\\demo', createdAt: 0, updatedAt: 0,
}

test('未绑定 bot：reconcile 不启动渠道、不告警，statusOf 返回 unbound', async () => {
  const { runtime, started, warns, deps } = harness()
  await deps.bots.put('loose', UNBOUND)
  await runtime.startAll()
  expect(started).toEqual(['reviewer'])
  expect(warns.filter((w) => w.includes('loose'))).toEqual([])
  expect(runtime.statusOf('loose')).toBe('unbound')
})

test('unbindBot 停渠道并取消在飞会话，但保留绑定表', async () => {
  const { runtime, closed, deps } = harness()
  await runtime.startAll()
  await deps.bindings.put('reviewer:oc_1', { sessionId: 's1' })
  const cancelled: string[] = []
  runtime.sessions.set('s1', {
    botId: 'reviewer', chatId: 'oc_1', sessionId: 's1',
    agent: { sessionId: 's1', followup: () => undefined, cancel: () => { cancelled.push('s1') }, whenIdle: async () => undefined },
    reply: undefined, inflight: undefined, tail: Promise.resolve(), turn: undefined,
  })
  await runtime.unbindBot('reviewer')
  expect(closed).toEqual(['reviewer'])
  expect(cancelled).toEqual(['s1'])
  expect(runtime.sessions.has('s1')).toBe(false)
  expect(deps.bindings.get('reviewer:oc_1')).toEqual({ sessionId: 's1' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run（workdir `packages/toolkit`）: `pnpm exec vitest run src/channels/runtime.test.ts`
Expected: FAIL——`statusOf('loose')` 实际返回 `'not-running'`；`runtime.unbindBot is not a function`

- [ ] **Step 3: 实现（runtime.ts）**

`BotStatus` 加 `'unbound'`：

```ts
export type BotStatus = ChannelStatus | 'not-running' | 'unbound'
```

`reconcile` 在取记录后加 feishu guard（替代原先直接访问 `record.feishu.appSecretRef`）：

```ts
  /** 按最新记录重建该 bot 的渠道（创建/更新后调用；记录已删或未绑定则纯停止）。 */
  async reconcile(botId: string): Promise<void> {
    await this.stopChannel(botId)
    const record = this.deps.bots.get(botId)
    if (record === undefined) return
    if (record.feishu === undefined) return
    if (!this.deps.validateProject(record.project)) {
      this.deps.log.warn(`[project-bot] bot "${botId}" 的项目路径不可用：${record.project}`)
      return
    }
    const secret = await this.deps.resolveSecret(record.feishu.appSecretRef)
    // …（余下原样不动）
```

`statusOf` 加未绑定分支：

```ts
  statusOf(botId: string): BotStatus {
    const record = this.deps.bots.get(botId)
    if (record !== undefined && record.feishu === undefined) return 'unbound'
    return this.handles.get(botId)?.status() ?? 'not-running'
  }
```

`stopBot` 旁新增 `unbindBot`：

```ts
  /** 解绑渠道：停渠道、取消在飞会话；绑定表与持久会话保留（重绑后 resume 接续）。 */
  async unbindBot(botId: string): Promise<void> {
    await this.stopChannel(botId)
    for (const [sessionId, rt] of [...this.sessions]) {
      if (rt.botId === botId) {
        rt.agent.cancel()
        this.sessions.delete(sessionId)
      }
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run（workdir `packages/toolkit`）: `pnpm exec vitest run src/channels/runtime.test.ts`
Expected: PASS（现有 7 条 + 新增 2 条全绿）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/runtime.ts packages/toolkit/src/channels/runtime.test.ts
git commit -m "feat(toolkit): BotRuntime 支持 unbound 状态与 unbindBot（保留会话绑定）"
```

---

### Task 3: API 的 PUT 解绑/重绑与 DELETE/POST guard

**Files:**
- Modify: `packages/toolkit/src/bots/api.ts`（`UpdateBodySchema` :51-60、PUT 分支 :160-204、DELETE 分支 :206-218、POST 冲突检查 :126-131）
- Test: `packages/toolkit/src/bots/api.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `runtime.unbindBot(id)`、Task 1 的可选 `existing.feishu`
- Produces: PUT body `feishu` 字段语义 = `{ appId, appSecret }` 或 `{ appId, appSecretRef }` 重绑 / `null` 解绑 / 缺省不动渠道；解绑响应 bot 无 `channel`/`feishu` 字段——Task 5 的 `updateBot(bot.id, { feishu: null })` 依赖

- [ ] **Step 1: 改造测试基座并写失败测试（api.test.ts）**

harness 的初始 bots 表加未绑定 bot 与扫码绑定 bot，runtime fake 加 `unbindBot`（`harness()` 内两处）：

```ts
const UNBOUND: BotRecord = {
  id: 'loose', name: '未绑定', project: 'D:\\work\\demo', createdAt: 1, updatedAt: 1,
}
const SCAN_BOUND: BotRecord = {
  id: 'scan-bot', name: '扫码', channel: 'feishu',
  feishu: { appId: 'cli_ffffffffffffffff', appSecretRef: 'project_bot_ffffffff' },
  project: 'D:\\work\\demo', createdAt: 1, updatedAt: 1,
}
```

```ts
  const bots = new Map<string, BotRecord>([['reviewer', BOT], ['loose', UNBOUND], ['scan-bot', SCAN_BOUND]])
  const unbound: string[] = []
```

```ts
    runtime: {
      reconcile: async (id: string) => { reconciled.push(id) },
      stopBot: async (id: string) => { stopped.push(id) },
      unbindBot: async (id: string) => { unbound.push(id) },
      statusOf: () => 'connected',
    } as unknown as ApiDeps['runtime'],
```

harness 返回对象加 `unbound`：`return { deps, bots, reconciled, stopped, unbound, deletedSecrets, storedSecrets, handler: createApiHandler(deps), registerApp }`

PUT describe 内追加（同时把既有 `'重复 appId → 409'` POST 测试里的 `BOT.feishu.appId` 改为字面量 `'cli_a1b2c3d4e5f60718'`，规避可空类型访问）：

```ts
describe('PUT /bots 渠道解绑与重绑', () => {
  test('feishu: null 解绑：unbindBot + 删密钥 + 摘字段；不删绑定（绑定表不经 API 触碰）', async () => {
    const { handler, bots, unbound, deletedSecrets, storedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=reviewer', { feishu: null }), res)
    expect(res.status).toBe(200)
    const record = bots.get('reviewer')
    expect(record).not.toHaveProperty('channel')
    expect(record).not.toHaveProperty('feishu')
    expect(record).toMatchObject({ id: 'reviewer', name: '评审' })
    expect(unbound).toEqual(['reviewer'])
    expect(deletedSecrets).toEqual(['project_bot_reviewer'])
    expect(storedSecrets).toEqual([])
  })

  test('未绑定 bot 解绑（幂等）：不再删密钥、照常返回', async () => {
    const { handler, deletedSecrets, unbound } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=loose', { feishu: null }), res)
    expect(res.status).toBe(200)
    expect(unbound).toEqual(['loose'])
    expect(deletedSecrets).toEqual([])
  })

  test('重绑（appSecret 路径）：新密钥入库、写回 channel/feishu、reconcile；旧 ref ≠ 新 ref 清理旧凭据', async () => {
    const { handler, bots, storedSecrets, deletedSecrets, reconciled } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=scan-bot', {
      feishu: { appId: 'cli_000000000000000a', appSecret: 'new-secret' },
    }), res)
    expect(res.status).toBe(200)
    expect(bots.get('scan-bot')).toMatchObject({
      channel: 'feishu',
      feishu: { appId: 'cli_000000000000000a', appSecretRef: 'project_bot_scan-bot' },
    })
    expect(storedSecrets).toEqual([{ key: 'scan-bot', secret: 'new-secret' }])
    expect(deletedSecrets).toEqual(['project_bot_ffffffff'])
    expect(reconciled).toEqual(['scan-bot'])
  })

  test('重绑（appSecretRef 扫码路径）：直接引用不再入库', async () => {
    const { handler, bots, storedSecrets, deletedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=scan-bot', {
      feishu: { appId: 'cli_000000000000000a', appSecretRef: 'project_bot_newref' },
    }), res)
    expect(res.status).toBe(200)
    expect(bots.get('scan-bot')).toMatchObject({ feishu: { appId: 'cli_000000000000000a', appSecretRef: 'project_bot_newref' } })
    expect(storedSecrets).toEqual([])
    expect(deletedSecrets).toEqual(['project_bot_ffffffff'])
  })

  test('重绑 appId 被其他 bot 占用 → 409（未绑定 bot 不占 appId）', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=scan-bot', {
      feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecret: 's' },
    }), res)
    expect(res.status).toBe(409)
  })

  test('重绑缺 appSecret 与 appSecretRef → 400', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=scan-bot', {
      feishu: { appId: 'cli_000000000000000a' },
    }), res)
    expect(res.status).toBe(400)
  })
})

test('DELETE 未绑定 bot：不删密钥、照常删除', async () => {
  const { handler, bots, stopped, deletedSecrets } = harness()
  const res = mockRes()
  await handler(mockReq('DELETE', '/dsh-agent-toolkit/api/bots/bots?id=loose'), res)
  expect(res.status).toBe(200)
  expect(stopped).toEqual(['loose'])
  expect(bots.has('loose')).toBe(false)
  expect(deletedSecrets).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run（workdir `packages/toolkit`）: `pnpm exec vitest run src/bots/api.test.ts`
Expected: FAIL——`feishu: null` 被 `UpdateBodySchema` 拒绝（400）；`appSecretRef` 重绑 400（旧 schema 只认 appSecret）；`unbindBot` 不存在于 fake 断言的调用路径之外（解绑用例 400 先挂）

- [ ] **Step 3: 实现（api.ts）**

`UpdateBodySchema.feishu` 改为：

```ts
  /** 重绑：明文新密钥（立即入 credentials）或扫码引用（已入库）；null = 解绑渠道（删密钥、保留会话绑定）。 */
  feishu: z.object({
    appId: z.string().regex(FEISHU_APP_ID_RE),
    appSecret: z.string().min(1).optional(),
    appSecretRef: z.string().min(1).optional(),
  }).refine((f) => f.appSecret !== undefined || f.appSecretRef !== undefined, { message: '缺少 appSecret 或 appSecretRef' })
    .nullable().optional(),
```

POST 创建的 appId 冲突检查改为（未绑定 bot 不占 appId）：

```ts
      for (const [, existing] of deps.bots.entries()) {
        if (existing.feishu !== undefined && existing.feishu.appId === input.feishu.appId) {
          json(res, 409, { error: `appId 已被 bot "${existing.id}" 使用` })
          return
        }
      }
```

PUT 分支整体改为（校验先行，副作用后置；渠道字段结算 + 原有 nullable 清空逻辑保留）：

```ts
      const input = parsed.data
      const project = input.project ?? existing.project
      if (!deps.validateProject(project)) {
        json(res, 400, { error: `项目路径不可用：${project}` })
        return
      }
      // 重绑路径：appId 先查冲突（未绑定 bot 不占 appId），再做任何副作用。
      if (input.feishu !== null && input.feishu !== undefined) {
        for (const [, other] of deps.bots.entries()) {
          if (other.id !== id && other.feishu?.appId === input.feishu.appId) {
            json(res, 409, { error: `appId 已被 bot "${other.id}" 使用` })
            return
          }
        }
      }
      // 渠道副作用：null 解绑（停渠道 + 删旧密钥）；对象重绑（新密钥入库或引用 + 旧 ref ≠ 新 ref 时清旧密钥）。
      let appSecretRef: string | undefined
      if (input.feishu === null) {
        await deps.runtime.unbindBot(id)
        if (existing.feishu !== undefined) await deps.deleteSecret(existing.feishu.appSecretRef)
      } else if (input.feishu !== undefined) {
        if (input.feishu.appSecret !== undefined) {
          appSecretRef = await deps.storeSecret(id, input.feishu.appSecret)
        } else {
          appSecretRef = input.feishu.appSecretRef
        }
        if (existing.feishu !== undefined && existing.feishu.appSecretRef !== appSecretRef) {
          await deps.deleteSecret(existing.feishu.appSecretRef)
        }
      }
      const merged: Record<string, unknown> = { ...existing }
      if (input.name !== undefined) merged.name = input.name
      merged.project = project
      if (input.feishu === null) {
        delete merged.channel
        delete merged.feishu
      } else if (input.feishu !== undefined && appSecretRef !== undefined) {
        merged.channel = 'feishu'
        merged.feishu = { appId: input.feishu.appId, appSecretRef }
      }
      if (input.persona === null) delete merged.persona
      else if (input.persona !== undefined) merged.persona = input.persona
      if (input.agentRef === null) delete merged.agentRef
      else if (input.agentRef !== undefined) merged.agentRef = input.agentRef
      if (input.tools === null) delete merged.tools
      else if (input.tools !== undefined) merged.tools = input.tools
      if (input.agentOptions === null) delete merged.agentOptions
      else if (input.agentOptions !== undefined) merged.agentOptions = input.agentOptions
      const record = BotRecordSchema.parse(merged)
      await deps.bots.put(id, record)
      await deps.runtime.reconcile(id)
      json(res, 200, { bot: { ...record, status: deps.runtime.statusOf(id) } })
      return
```

（原 `let feishu = existing.feishu; if (input.feishu !== undefined) {…}` 与 `const merged` 旧构造块整体被上面替换；解绑路径最终 `reconcile` 对未绑定记录是「纯停止」的 no-op，统一走一次保持路径单一。）

DELETE 分支加 guard：

```ts
      await deps.runtime.stopBot(id)
      await deps.bots.delete(id)
      if (existing.feishu !== undefined) await deps.deleteSecret(existing.feishu.appSecretRef)
      json(res, 200, { ok: true })
```

- [ ] **Step 4: 跑测试确认通过**

Run（workdir `packages/toolkit`）: `pnpm exec vitest run src/bots/api.test.ts`
Expected: PASS（既有用例全绿 + 新增用例全绿）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/bots/api.ts packages/toolkit/src/bots/api.test.ts
git commit -m "feat(toolkit): bots API 支持渠道解绑（feishu:null）与重绑（appSecret/appSecretRef）"
```

---

### Task 4: 列表未绑定态（状态标签 + 渠道徽标条件渲染）

**Files:**
- Modify: `packages/toolkit/src/client/bots/BotsModal.tsx:25-42,80`（STATUS_LABEL/STATUS_DOT/Pill）
- Test: `packages/toolkit/src/client/bots/bots-modal.client.spec.tsx`

**Interfaces:**
- Consumes: 后端 `statusOf` 返回 `'unbound'`（Task 2）经 GET /bots 的 `status` 字段
- Produces: 列表对未绑定 bot 显示「未绑定」琥珀点、不显示「飞书」Pill（`bot.feishu === undefined`）

- [ ] **Step 1: 写失败测试（bots-modal.client.spec.tsx）**

`BOTS.bots` 数组追加一条未绑定 bot：

```ts
    {
      id: 'loose', name: '未绑定机器人', project: 'D:\\work\\other', status: 'unbound', createdAt: 1, updatedAt: 1,
    },
```

`'列表按项目分组，显示渠道标记与运行状态'` 测试追加断言（`getAllByText('飞书')` 改为 `2`）：

```ts
  // 渠道标记：仅已绑定 bot 显示
  expect(screen.getAllByText('飞书').length).toBe(2)
  // 未绑定态
  expect(screen.getByText('未绑定机器人')).toBeTruthy()
  expect(screen.getByText('未绑定')).toBeTruthy()
```

- [ ] **Step 2: 跑测试确认失败**

Run（workdir `packages/toolkit`）: `pnpm exec vitest run src/client/bots/bots-modal.client.spec.tsx`
Expected: FAIL——`'未绑定'` 文案不存在（unknown status 原样显示 `'unbound'`）；`飞书` 计数是 3 不是 2

- [ ] **Step 3: 实现（BotsModal.tsx）**

```ts
const STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  idle: '空闲',
  failed: '连接失败',
  'not-running': '未运行',
  unbound: '未绑定',
}
```

```ts
const STATUS_DOT: Record<string, StateDotState> = {
  connected: 'done',
  connecting: 'ongoing',
  reconnecting: 'ongoing',
  idle: 'warning',
  failed: 'error',
  'not-running': 'warning',
  unbound: 'warning',
}
```

列表行 Pill 改条件渲染：

```tsx
                  {bot.feishu !== undefined && <Pill className={css.channelBadge}>飞书</Pill>}
```

- [ ] **Step 4: 跑测试确认通过**

Run（workdir `packages/toolkit`）: `pnpm exec vitest run src/client/bots/bots-modal.client.spec.tsx`
Expected: PASS（3 条全绿）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/client/bots/BotsModal.tsx packages/toolkit/src/client/bots/bots-modal.client.spec.tsx
git commit -m "feat(toolkit): 机器人列表呈现未绑定态（未绑定标签 + 隐藏渠道徽标）"
```

---

### Task 5: 编辑表单解绑按钮与未绑定重绑区块

**Files:**
- Modify: `packages/toolkit/src/client/bots/api.ts:16`（BotInput.feishu 允许 null）
- Modify: `packages/toolkit/src/client/bots/BotForm.tsx`（appId 初始值 :47、自动扫码 effect :146-150、save :152-202、step 2 JSX :261-312）
- Test: `packages/toolkit/src/client/bots/bot-form.client.spec.tsx`

**Interfaces:**
- Consumes: Task 3 的 PUT `feishu: null` 解绑语义与 `feishu: { appId, appSecret | appSecretRef }` 重绑语义；既有 `updateBot(id, Partial<BotInput>)`
- Produces: 编辑绑定态第 2 步「解绑」两段确认按钮（立即 PUT，不走保存）；未绑定态显示扫码/手动绑定区块，保存可不带 feishu

- [ ] **Step 1: 写失败测试（bot-form.client.spec.tsx 追加三个测试）**

```tsx
test('编辑绑定态：第 2 步显示当前应用与解绑（两段确认）；解绑 PUT feishu:null 并回列表', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  const bot = {
    id: 'reviewer', name: '评审', channel: 'feishu' as const,
    feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
    project: 'D:\\work\\demo',
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    createdAt: 1, updatedAt: 1, status: 'connected',
  }
  render(<BotForm bot={bot} useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByText(/当前应用：cli_a1b2c3d4e5f60718/)).toBeTruthy()

  // 第一段：只切确认态，不发请求
  fireEvent.click(screen.getByRole('button', { name: '解绑' }))
  expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)

  // 第二段：确认后 PUT feishu:null → onSaved
  fireEvent.click(screen.getByRole('button', { name: '确认解绑？' }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const update = calls.find((c) => c.url.includes('id=reviewer') && c.method === 'PUT')
  expect(update?.body).toMatchObject({ feishu: null })
})

test('编辑未绑定态：第 2 步显示绑定区块；手动填写后保存携带 feishu', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/bots/register-app': () => ({ id: 'reg_1' }),
    '/dsh-agent-toolkit/api/bots/register-app/status': () => ({ state: { status: 'pending', url: 'https://example/qr', expireIn: 600 } }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  const bot = {
    id: 'loose', name: '未绑定', project: 'D:\\work\\demo',
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    createdAt: 1, updatedAt: 1, status: 'not-running',
  }
  render(<BotForm bot={bot} useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  // 绑定区块出现（与创建一致的 tab 结构）；自动扫码已发起，切手动填写
  fireEvent.click(await screen.findByRole('tab', { name: '手动填写' }))
  fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_000000000000000a' } })
  fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'plain-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const update = calls.find((c) => c.url.includes('id=loose') && c.method === 'PUT')
  expect(update?.body).toMatchObject({ feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' } })
})

test('编辑未绑定态：不绑定也能保存（payload 不带 feishu，bot 维持未绑定）', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/bots/register-app': () => ({ id: 'reg_1' }),
    '/dsh-agent-toolkit/api/bots/register-app/status': () => ({ state: { status: 'pending', url: 'https://example/qr', expireIn: 600 } }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  const bot = {
    id: 'loose', name: '未绑定', project: 'D:\\work\\demo',
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    createdAt: 1, updatedAt: 1, status: 'not-running',
  }
  render(<BotForm bot={bot} useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const update = calls.find((c) => c.url.includes('id=loose') && c.method === 'PUT')
  expect(update?.body).not.toHaveProperty('feishu')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run（workdir `packages/toolkit`）: `pnpm exec vitest run src/client/bots/bot-form.client.spec.tsx`
Expected: FAIL——编辑绑定态第 2 步只有「当前应用：…（如需换绑请删除后重建）」文本、无「解绑」按钮；未绑定态编辑无绑定区块（`App ID` 输入框不存在）

- [ ] **Step 3: 实现**

**client/bots/api.ts** `BotInput.feishu` 允许 null（解绑）：

```ts
  /** 渠道绑定：null = 解绑（服务端删密钥、保留会话绑定）；扫码路径传 appSecretRef。 */
  feishu?: { appId: string; appSecret?: string; appSecretRef?: string } | null
```

**BotForm.tsx** 四处：

1. appId 初始值与新增确认态（:47-51 区域）：

```ts
  const [appId, setAppId] = useState(bot?.feishu?.appId ?? '')
```

```ts
  const [confirmUnbind, setConfirmUnbind] = useState(false)
```

2. 自动扫码 effect 放宽到「未绑定编辑态」（:146-150）：

```ts
  // 创建模式与未绑定编辑态进入第二步自动发起扫码：仅当尚未发起（idle）时触发，避免重复 beginScan。
  // 不用 `!editing || bot.feishu === undefined`：别名条件收窄在负分支会把 bot 收窄成 undefined，访问 .feishu 报错。
  const bindable = bot === undefined || bot.feishu === undefined
  useEffect(() => {
    if (step === 2 && bindable && scan.status === 'idle') {
      void beginScan()
    }
  }, [step, scan.status, bindable])
```

3. `save()` 的 feishu 计算与校验（:152-166 替换）——绑定区块可见时才收集 feishu；创建必填、编辑未绑定可空：

```ts
  async function save(): Promise<void> {
    setError(null)
    const feishu = bindable
      ? tab === 'scan'
        ? scan.status === 'done'
          ? { appId: scan.appId, appSecretRef: scan.credentialRef }
          : undefined
        : appId.trim().length > 0 && appSecret.trim().length > 0
          ? { appId: appId.trim(), appSecret: appSecret.trim() }
          : undefined
      : undefined
    if (!editing && feishu === undefined) {
      setError('请填写 App ID 与 App Secret，或先完成扫码创建')
      return
    }
```

（`save()` 余下部分不变；payload 组装处 `createBot({ ...payload, feishu: feishu! })` 保持——创建路径已由上面的必填校验保证非空。）

4. step 2 JSX（:261-312）——三处手术：

   a. :263 的 `{!editing && (` 改为 `{bindable && (`，区块内部（tabs、扫码、手动、权限提示）一行不动，闭合 `)}` 不变；
   b. :303 的整行 `{editing && <p>当前应用：{bot.feishu.appId}（如需换绑请删除后重建）</p>}` 删除，替换为「当前应用 + 解绑按钮」块；
   c. 错误提示与按钮区原样保留。改完后 step 2 整体形如：

```tsx
      {step === 2 && (
        <>
          {bindable && (
            <section className={css.scanSection}>
              {/* a) 原样保留：tabs + 扫码/手动区块 + 权限提示（原 :264-301 内容不动） */}
            </section>
          )}
          {editing && bot.feishu !== undefined && (
            <>
              <p>当前应用：{bot.feishu.appId}</p>
              <Button variant="outline" disabled={saving}
                onClick={() => { void unbind() }}>
                {confirmUnbind ? '确认解绑？' : '解绑'}
              </Button>
              <p className={css.hint}>解绑后密钥立即删除，历史会话保留；重新绑定同一应用可继续原会话。</p>
            </>
          )}

          {error !== null && <p role="alert" className={css.error}>{error}</p>}
          <div className={css.formActions}>
            <Button variant="outline" onClick={() => { setError(null); setStep(1) }}>上一步</Button>
            <Button variant="outline" onClick={onCancel}>取消</Button>
            <Button variant="primary" disabled={saving} onClick={() => { void save() }}>保存</Button>
          </div>
        </>
      )}
```

组件内新增 `unbind()`（放在 `save()` 之后）：

```ts
  /** 解绑渠道：两段确认后立即 PUT feishu:null（不经保存），成功回列表刷新。 */
  async function unbind(): Promise<void> {
    if (!confirmUnbind) {
      setConfirmUnbind(true)
      return
    }
    setError(null)
    setSaving(true)
    try {
      await updateBot(bot!.id, { feishu: null })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }
```

（`bot!` 仅解绑路径用到且该按钮只在 `bot.feishu !== undefined` 分支渲染，安全；如 typecheck 对 `bot!` 报错可改用 `editing && bot ? bot.id : ''` 收窄。）

- [ ] **Step 4: 跑测试确认通过**

Run（workdir `packages/toolkit`）: `pnpm exec vitest run src/client/bots/bot-form.client.spec.tsx`
Expected: PASS（既有 8 条 + 新增 3 条全绿；既有「编辑模式：agentRef 回显角色」用例不受影响——绑定态编辑保存仍不带 feishu）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/client/bots/api.ts packages/toolkit/src/client/bots/BotForm.tsx packages/toolkit/src/client/bots/bot-form.client.spec.tsx
git commit -m "feat(toolkit): 编辑表单支持渠道解绑（两段确认）与未绑定重绑区块"
```

---

### Task 6: 文档更新 + 全量验证与构建

**Files:**
- Modify: `docs/usage/feishu-bots.md`（:9 状态清单、:31 编辑说明、:78-81 存储小节）

**Interfaces:**
- Consumes: Task 2-5 的全部行为（unbound 状态、解绑/重绑语义）
- Produces: 使用手册与实现一致

- [ ] **Step 1: 更新文档**

:9 面板说明的状态枚举加「未绑定」：

```markdown
点击侧边栏底栏的「消息机器人」，模态框按项目分组展示全部 bot：名称、飞书徽标、连接状态点（已连接 / 连接中 / 重连中 / 空闲 / 连接失败 / 未运行 / 未绑定）。
```

:31 编辑说明整段替换：

```markdown
编辑已有 bot 可改名称/项目/Agent/模型；第 2 步支持渠道**解绑**与**重新绑定**：

- **解绑**：点击「解绑」并二次确认后立即生效——渠道断开、密钥凭据删除，bot 的名称/项目/Agent 等配置与历史会话**全部保留**，列表状态变为「未绑定」。
- **重新绑定**：未绑定的 bot 在编辑向导第 2 步按创建时相同的方式（扫码一键创建 / 手动填写）绑定新应用；重新绑定**同一应用**时，原群聊会继续此前的会话上下文。
- **换绑到新应用** = 先解绑、再重绑（两步操作）。
```

:80 存储小节补一行：

```markdown
- 解绑只删密钥凭据；`bindings` 表的 (bot, 群聊) → 会话绑定保留，重绑同一应用后继续生效
```

- [ ] **Step 2: 全量测试**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: 全部 PASS（原 349 条 + 新增 14 条：Task 1 两条、Task 2 两条、Task 3 七条、Task 5 三条）

- [ ] **Step 3: 类型检查**

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS

- [ ] **Step 4: 构建（进开发回路前必跑）**

Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 产出 `lib/index.js` 与 `lib/client.js` 无报错

- [ ] **Step 5: Commit**

```bash
git add docs/usage/feishu-bots.md
git commit -m "docs: 飞书 bot 使用手册补解绑/重绑说明"
```

- [ ] **Step 6: 手工验收（可选，需开发回路）**

`pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml` 启动后：消息机器人面板 → 编辑已绑定 bot → 解绑 → 列表显示「未绑定」无飞书徽标 → 重新绑定 → 状态恢复；老群聊发消息确认会话接续。
