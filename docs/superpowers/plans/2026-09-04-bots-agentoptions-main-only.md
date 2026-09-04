# bot 级 agentOptions 恢复（仅绑 main 可配）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bot 自带 `agentOptions`（provider/model）以「仅绑 main 可配」形式恢复：绑 main 时表单显示并必填、会话用 bot 自配模型；绑角色时表单隐藏、保存清除记录残留、会话用 `role.model ?? 宿主默认`。

**Architecture:** 大量内容为 v1 移除代码的逐字恢复（pre-v1 参考 = commit `164d985f90`，即 master 分支头）：存储 schema / API schema 与端点 / index.ts 接线逐字恢复；新增部分只有三处条件化——router main 分支 `bot.agentOptions ?? this.defaultModel()`、BotForm 的 `agentRef === 'main'` 条件渲染与条件提交、编辑模式绑角色提交 `agentOptions: null`。

**Tech Stack:** TypeScript / React（客户端半）/ vitest + @testing-library/react / zod / pnpm workspace（`packages/toolkit`，npm 包名 `dsh-agent-toolkit`）。

**Spec:** `docs/superpowers/specs/2026-09-04-bots-delete-and-remove-agentoptions-design.md`（v2）

**前置状态：** 当前分支 `feat/bots-delete-remove-agentoptions` 已完成 v1（agentOptions 全链路移除 + 列表删除功能）。本计划在 v1 之上做 v2 增量。pre-v1 代码可用 `git show 164d985f90:packages/toolkit/<路径>` 查看。

## Global Constraints

- 工作目录：`packages/toolkit`（下述相对路径均以此为根，手册任务除外）；**不得修改** `deepseek-harness/` 下任何文件。
- 每个 Task 结束时：`pnpm --filter dsh-agent-toolkit test` 全绿 + `pnpm --filter dsh-agent-toolkit typecheck` 零错误后才 commit；只 stage 本任务文件。
- Shell 为 Windows PowerShell 5.1：链式命令用 `; if ($?) { ... }`，不用 `&&`。
- 单文件测试命令模板：`pnpm --filter dsh-agent-toolkit exec vitest run <相对 src 的测试文件路径>`（已知小坑：`pnpm --filter <pkg> exec vitest` 会在 workspace 根先报一次 `exec vitest` not found 再跑对，看最终 vitest 结果即可；也可在 packages/toolkit 目录直接 `pnpm exec vitest run <路径>`）。
- commit message 用仓库既有风格：`type(toolkit): 中文描述`。
- 所有面向用户的文案为简体中文；文件注释沿用各文件现状（恢复代码用 pre-v1 原注释）。
- 不新增任何 npm 依赖。
- 客户端测试点击一律用 `fireEvent.click`（RTL 自动包 act，同步 flush）；**禁止**使用原生 `.click()` 与 `await act(async () => {})` flush（v1 已裁决）。

---

### Task 1: Node 半——agentOptions 恢复（schema/API/端点/接线）+ router main 分支条件化

**Files:**
- Modify: `src/bots/store.ts`
- Modify: `src/bots/api.ts`
- Modify: `src/bots/index.ts`
- Modify: `src/channels/router.ts`
- Modify: `src/channels/ports.ts`（仅注释）
- Modify: `src/channels/runtime.ts`（仅注释）
- Test: `src/bots/store.test.ts`、`src/bots/api.test.ts`、`src/channels/router.test.ts`

**Interfaces:**
- Consumes: 无（v1 完成态）。
- Produces: `BotRecord.agentOptions?: { provider?: string; model?: string }`（Task 2 客户端表单回显依赖）；`UpdateBodySchema.agentOptions` 支持 `null` 清除（Task 2 编辑模式绑角色提交 `agentOptions: null` 依赖）；`GET /dsh-agent-toolkit/api/bots/providers` 与 `GET /dsh-agent-toolkit/api/bots/models?provider=` 端点恢复（Task 2 表单下拉数据源）；`Router.resolveSession` main 分支 = `bot.agentOptions ?? defaultModel()`。

- [ ] **Step 1: 更新 `src/bots/store.test.ts`（先写失败测试）**

1. `validBot` fixture 在 `tools: ['bash', 'fs_read'],` 行后加回：

```ts
  agentOptions: { provider: 'deepseek', model: 'deepseek-v4' },
```

2. 删除测试「agentOptions 字段移除后：旧数据携带 agentOptions 仍可加载（未知键剥离，不拒绝）」（现 66-71 行），原位替换为：

```ts
  test('agentOptions 恢复为合法可选字段：携带解析后保留；缺省正常解析', () => {
    expect(BotRecordSchema.parse(validBot).agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
    const minimal = { ...validBot } as Record<string, unknown>
    delete minimal.agentOptions
    const parsed = BotRecordSchema.safeParse(minimal)
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data : {}).not.toHaveProperty('agentOptions')
  })
```

- [ ] **Step 2: 更新 `src/bots/api.test.ts`（先写失败测试）**

1. harness 的 `deps` 在 `listTools: () => ['bash', 'fs_read', 'fs_write'],`（现 73 行）后加回两行：

```ts
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
```

2. 测试「请求体携带 agentOptions 被忽略（bot 模型改由绑定 Agent 决定，不落表）」（现 155-165 行）整体替换为：

```ts
  test('请求体携带 agentOptions 正常落表（绑 main 的 bot 自配模型）', async () => {
    const { handler, bots } = harness()
    const res = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/bots/bots', {
      id: 'ops', name: '运维', project: 'D:\\work\\ops',
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
      feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' },
    }), res)
    expect(res.status).toBe(200)
    expect(bots.get('ops')).toMatchObject({ agentOptions: { provider: 'deepseek', model: 'deepseek-chat' } })
  })
```

3. `describe('PUT /bots')` 内「agentRef：创建落表、更新覆盖、null 清除（回主 Agent）」测试之后新增：

```ts
  test('agentOptions：创建落表、更新覆盖、null 清除（绑角色时表单清除残留模型配置）', async () => {
    const { handler, bots } = harness()
    const create = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/bots/bots', {
      id: 'ops', name: '运维', project: 'D:\\work\\ops',
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
      feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' },
    }), create)
    expect(create.status).toBe(200)
    expect(bots.get('ops')).toMatchObject({ agentOptions: { provider: 'deepseek', model: 'deepseek-chat' } })

    const update = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=ops', { agentOptions: { provider: 'openai', model: 'gpt-x' } }), update)
    expect(update.status).toBe(200)
    expect(bots.get('ops')).toMatchObject({ agentOptions: { provider: 'openai', model: 'gpt-x' } })

    const clear = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=ops', { agentOptions: null }), clear)
    expect(clear.status).toBe(200)
    expect(bots.get('ops')).not.toHaveProperty('agentOptions')
  })
```

4. 在 `test('未知路径 404；已知路径错误方法 405', ...)` 之前恢复 pre-v1 的端点用例（逐字）：

```ts
describe('GET /providers 与 GET /models', () => {
  test('/providers 返回 provider 列表', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/bots/providers'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] })
  })

  test('/models 按 provider 返回模型列表', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/bots/models?provider=deepseek'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] })
  })

  test('listModels 失败 → 200 空数组降级（不报错）', async () => {
    const { handler } = harness({ listModels: async () => { throw new Error('network down') } })
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/bots/models?provider=deepseek'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ models: [] })
  })
})
```

- [ ] **Step 3: 更新 `src/channels/router.test.ts`（先写失败测试）**

1. 「resume 恢复路径：同样取宿主默认模型」（现 115-121 行）之后新增：

```ts
  test('bot 有 agentOptions：原样透传（绑 main 的 bot 自配模型优先于宿主默认）', async () => {
    const { router, created, defaultModel } = setup()
    await router.ensure(fakeBot({ agentOptions: { provider: 'acme', model: 'acme-x' } }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).not.toHaveBeenCalled()
    expect(created[0].input.agentOptions).toEqual({ provider: 'acme', model: 'acme-x' })
  })
```

2. 「agentRef 指向角色：注册单 persona section + tools.restrict({ allow }) + agentOptions=role.model」（现 186-198 行）之后新增：

```ts
  test('agentRef 指向角色：记录残留的 agentOptions 不读（角色模型优先）', async () => {
    const { router, created, defaultModel } = setup(undefined, fakeRegistry([MAIN_ROLE, REVIEWER_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'reviewer', agentOptions: { provider: 'acme', model: 'acme-x' } }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).not.toHaveBeenCalled()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  })
```

（`fakeBot` 接受 `Partial<BotRecord>`，Step 5 的 schema 恢复后 `agentOptions` 自动可传。）

- [ ] **Step 4: 运行测试验证失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/bots/store.test.ts src/bots/api.test.ts src/channels/router.test.ts`
Expected: FAIL——store 的 `agentOptions` 断言失败（schema 无此字段，parse 后被剥离）；api 的「正常落表」失败（不落表）、PUT agentOptions 用例失败（body schema 不收）；router 两个新用例失败（fakeBot 类型不接受 agentOptions / main 分支不读 bot.agentOptions）。

- [ ] **Step 5: 实现 Node 半改动**

1. `src/bots/store.ts`：`BotRecordSchema` 在 `tools` 行（现 31 行）后恢复：

```ts
  agentOptions: z.object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }).optional(),
```

2. `src/bots/api.ts`：
   - 在 import 块之后、`ApiDeps` 之前恢复：

```ts
/** 一个可选的 provider 路由（id = agentOptions.provider 的值）。 */
export interface ProviderOption { id: string; name: string }
/** 一个可选的模型条目（id = agentOptions.model 的值）。 */
export interface ModelOption { id: string; name: string }
```

   - `ApiDeps` 在 `listTools(): string[]` 行后恢复：

```ts
  listProviders(): ProviderOption[]
  /** 失败由调用方（路由）兜底为空数组，不抛错。 */
  listModels(provider: string): Promise<ModelOption[]>
```

   - `CreateBodySchema` 在 `tools` 行后恢复：

```ts
  agentOptions: z.object({ provider: z.string().min(1).optional(), model: z.string().min(1).optional() }).optional(),
```

   - `UpdateBodySchema` 在 `tools` 行后恢复：

```ts
  agentOptions: z.object({ provider: z.string().min(1).optional(), model: z.string().min(1).optional() }).nullable().optional(),
```

   - POST 处理器 record 组装处，在 `...(input.tools !== undefined ? { tools: input.tools } : {}),` 行后恢复：

```ts
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
```

   - PUT 处理器在 `tools` 合并两行后恢复：

```ts
      if (input.agentOptions === null) delete merged.agentOptions
      else if (input.agentOptions !== undefined) merged.agentOptions = input.agentOptions
```

   - `/tools` 端点分支之后恢复两个端点（逐字，含注释）：

```ts
    if (sub === '/providers' && method === 'GET') {
      json(res, 200, { providers: deps.listProviders() })
      return
    }

    if (sub === '/models' && method === 'GET') {
      // 模型列举可能走网络（adapter 探测），失败静默降级为空数组。
      let models: ModelOption[] = []
      try {
        models = await deps.listModels(url.searchParams.get('provider') ?? '')
      } catch {
        models = []
      }
      json(res, 200, { models })
      return
    }
```

   - 405 清单改为：

```ts
    if (['/bots', '/register-app', '/register-app/status', '/tools', '/providers', '/models'].includes(sub)) {
```

3. `src/bots/index.ts`：`createApiHandler` 依赖里在 `listTools` 行（现 216 行）后恢复：

```ts
        listProviders: () => ctx.llm.listProviders().map(({ id, name }) => ({ id, name })),
        listModels: (provider) => ctx.llm.listModels(provider).then((models) => models.map(({ id, name }) => ({ id, name }))),
```

   同时恢复顶部的 `import type {} from '@deepseek-ai/dsh-llm'`（pre-v1 在原 13 行，type-only 激活声明合并）。

4. `src/channels/router.ts`：
   - main 分支（现 82 行）改为：

```ts
      return { agentOptions: bot.agentOptions ?? this.defaultModel(), hooks: this.withSenderSection(hooksOf(bot), bot, userId) }
```

   - 构造器 `defaultModel` 参数注释（现 22 行）改为 `/** main 形态会话（bot 未自配 agentOptions 时）与未配置模型的角色的模型来源（宿主默认模型）。 */`。
   - `resolveSession` 的 doc 注释（现 69-74 行）中 main 形态描述「bot 自带 persona/tools + 宿主默认模型」改为「bot 自带 persona/tools + 模型（自配 agentOptions 优先，缺省回退宿主默认模型）」。
5. `src/channels/ports.ts`：`DefaultModelAccessor` 上注释（现 41 行）改为：

```ts
/** main 形态会话（bot 未自配 agentOptions 时）与未配置模型的角色的模型来源（取 {provider, model}）。 */
```

6. `src/channels/runtime.ts`：`RuntimeDeps.defaultModel` 注释（现 18 行）改为 `/** main 形态会话（bot 未自配 agentOptions 时）与未配置模型的角色回退宿主默认模型。 */`。

- [ ] **Step 6: 运行测试与类型检查验证通过**

Run: `pnpm --filter dsh-agent-toolkit test ; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }`
Expected: 全部测试 PASS（含三个文件的新旧用例）；typecheck 零错误（此时客户端 api.ts/BotForm 尚未恢复 agentOptions——客户端不引用该字段，类型绿）。

- [ ] **Step 7: 提交**

```powershell
git add packages/toolkit/src/bots/store.ts packages/toolkit/src/bots/store.test.ts packages/toolkit/src/bots/api.ts packages/toolkit/src/bots/api.test.ts packages/toolkit/src/bots/index.ts packages/toolkit/src/channels/router.ts packages/toolkit/src/channels/router.test.ts packages/toolkit/src/channels/ports.ts packages/toolkit/src/channels/runtime.ts
git commit -m "feat(toolkit): bot 级 agentOptions 恢复，main 形态会话模型 bot 自配优先（仅绑 main 生效）"
```

---

### Task 2: 客户端表单——Provider/模型条件化恢复（仅绑 main 显示且必填）

**Files:**
- Modify: `src/client/bots/api.ts`
- Modify: `src/client/bots/BotForm.tsx`
- Test: `src/client/bots/bot-form.client.spec.tsx`

**Interfaces:**
- Consumes: Task 1 的 `BotRecord.agentOptions`（`BotListItem` 回显依赖）、`/providers`、`/models` 端点、PUT 的 `agentOptions: null` 清除语义。
- Produces: `BotInput.agentOptions?: { provider?: string; model?: string } | null`（`null` = 清除，仅编辑模式绑角色时发送）；`fetchProviders()`/`fetchModels(provider)`/`ProviderOption`/`ModelOption` 恢复导出。

- [ ] **Step 1: 更新 `bot-form.client.spec.tsx`（先写失败测试）**

1. 第一个测试（现 36-66 行）改回绑 main 自配模型语义，整体替换为：

```tsx
test('手动填写创建（绑 main）：名称/项目 + Provider/模型默认选中第一项 + 密钥；payload 携带 agentOptions', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  // 绑 main（缺省）：Provider 与模型均默认选中第一项（无「默认」空值项）
  await screen.findByRole('option', { name: 'DeepSeek' })
  expect(screen.getByLabelText('Provider')).toHaveProperty('value', 'deepseek')
  await screen.findByRole('option', { name: 'DeepSeek Chat' })
  expect(screen.getByLabelText('模型')).toHaveProperty('value', 'deepseek-chat')

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '运维机器人' } })
  fireEvent.change(screen.getByLabelText('绑定项目'), { target: { value: 'D:\\work\\ops' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  // 第二步：默认扫码 tab，切到「手动填写」再填 feishu
  fireEvent.click(screen.getByRole('tab', { name: '手动填写' }))
  fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_000000000000000a' } })
  fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'plain-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const create = calls.find((c) => c.url === '/dsh-agent-toolkit/api/bots/bots' && c.method === 'POST')
  expect(create?.body).toMatchObject({
    name: '运维机器人', project: 'D:\\work\\ops',
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' },
  })
  expect(create?.body).not.toHaveProperty('id')
  expect(create?.body).not.toHaveProperty('tools')
  expect(create?.body).not.toHaveProperty('persona')
})
```

2. 测试「扫码创建：...」（现 68-106 行）：stubFetch 头部加回两条路由（紧跟 `let polls = 0` 后的 `stubFetch({` 内最前）：

```tsx
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
```

payload 断言段（现 101-105 行）改为：

```tsx
  expect(create?.body).toMatchObject({
    feishu: { appId: 'cli_ffffffffffffffff', appSecretRef: 'project_bot_ffffffff' },
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  })
  expect(create?.body).not.toHaveProperty('id')
```

3. 测试「必填校验：第一步缺名称不放行；第二步缺 App ID/Secret 不提交」（现 108-123 行）改名并恢复 Provider 段，整体替换为：

```tsx
test('必填校验：无 Provider 时下拉禁用并提示；第一步缺名称不放行；第二步缺 App ID/Secret 不提交', async () => {
  const calls = stubFetch({ '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [] }) })
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={() => undefined} onCancel={() => undefined} />)

  // Provider 清单为空：select 禁用 + role=alert 提示
  await screen.findByText(/未发现可用 Provider/)
  expect(screen.getByLabelText('Provider')).toHaveProperty('disabled', true)

  // 第一步：缺名称点「下一步」不放行，提示错误、不发请求
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(await screen.findByText(/请填写/)).toBeTruthy()
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)

  // 补名称后放行进第二步，缺 feishu 点「保存」不提交（自动扫码在途，仅 register-app 请求，不创建 bot）
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '测试机器人' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByText(/请填写 App ID/)).toBeTruthy()
  expect(calls.filter((c) => c.method === 'POST' && c.url === '/dsh-agent-toolkit/api/bots/bots')).toHaveLength(0)
})
```

4. 在「必填校验」测试之后恢复 pre-v1 的模型必填用例（逐字）：

```tsx
test('模型必填：models 清单为空回退手填，留空保存被拦且不提交', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [] }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={() => undefined} onCancel={() => undefined} />)

  // 等 provider 就绪并自动选中第一项（models 为空 → 模型回退为手填 Input）
  await screen.findByRole('option', { name: 'DeepSeek' })

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '模型测试' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('tab', { name: '手动填写' }))
  fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_000000000000000a' } })
  fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'plain-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByText(/请选择或填写模型/)).toBeTruthy()
  expect(calls.filter((c) => c.method === 'POST' && c.url === '/dsh-agent-toolkit/api/bots/bots')).toHaveLength(0)
})
```

5. 测试「绑定 Agent 下拉：...」（现 125-148 行）：stubFetch 加回 providers/models 两条路由（最前）；选中角色后新增「字段隐藏 + payload 不含 agentOptions」断言。整体替换为：

```tsx
test('绑定 Agent 下拉：选项来自 /agents，缺省 main；选中角色后 Provider/模型隐藏、创建携带 agentRef 且不含 agentOptions', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/agents': () => ([{ id: 'main', name: '主 Agent' }, { id: 'reviewer', name: '评审' }]),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  // 下拉含角色选项且缺省选中 main；main 形态 Provider/模型可见
  await screen.findByRole('option', { name: '评审' })
  expect(screen.getByLabelText('绑定 Agent')).toHaveProperty('value', 'main')
  expect(screen.getByLabelText('Provider')).toBeTruthy()

  // 切到角色：Provider/模型隐藏（角色模型优先，bot 级配置不生效）
  fireEvent.change(screen.getByLabelText('绑定 Agent'), { target: { value: 'reviewer' } })
  expect(screen.queryByLabelText('Provider')).toBeNull()
  expect(screen.queryByLabelText('模型')).toBeNull()

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '评审机器人' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('tab', { name: '手动填写' }))
  fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_000000000000000a' } })
  fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'plain-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const create = calls.find((c) => c.url === '/dsh-agent-toolkit/api/bots/bots' && c.method === 'POST')
  expect(create?.body).toMatchObject({ agentRef: 'reviewer' })
  expect(create?.body).not.toHaveProperty('agentOptions')
})
```

6. 测试「编辑模式：agentRef 回显角色；切回 main 提交 agentRef: null」（现 150-174 行）：stubFetch 加回 providers/models 两条路由（最前）；fixture（现 156-161 行）在 `agentRef: 'reviewer',` 后加回 `agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },`；末尾断言改为：

```tsx
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const update = calls.find((c) => c.url.startsWith('/dsh-agent-toolkit/api/bots/bots?id=') && c.method === 'PUT')
  expect(update?.body).toMatchObject({ agentRef: null, agentOptions: { provider: 'deepseek', model: 'deepseek-chat' } })
```

7. 在「编辑模式：...」测试之后新增编辑模式绑角色清除用例：

```tsx
test('编辑模式绑角色：Provider/模型不渲染，保存携带 agentOptions: null 清除记录残留', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/agents': () => ([{ id: 'main', name: '主 Agent' }, { id: 'reviewer', name: '评审' }]),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  const bot = {
    id: 'ops', name: '运维', channel: 'feishu' as const,
    feishu: { appId: 'cli_a1b2c3d4e5f60719', appSecretRef: 'project_bot_ops' },
    project: 'D:\\work\\demo',
    agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    createdAt: 1, updatedAt: 1, status: 'connected',
  }
  render(<BotForm bot={bot} useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  // 缺省 main：字段渲染并回显记录值
  await screen.findByRole('option', { name: 'DeepSeek' })
  expect(screen.getByLabelText('Provider')).toHaveProperty('value', 'deepseek')

  // 切到角色：字段隐藏
  await screen.findByRole('option', { name: '评审' })
  fireEvent.change(screen.getByLabelText('绑定 Agent'), { target: { value: 'reviewer' } })
  expect(screen.queryByLabelText('Provider')).toBeNull()
  expect(screen.queryByLabelText('模型')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const update = calls.find((c) => c.url.startsWith('/dsh-agent-toolkit/api/bots/bots?id=') && c.method === 'PUT')
  expect(update?.body).toMatchObject({ agentRef: 'reviewer', agentOptions: null })
})
```

8. 测试「Agent 名册不可用：...」（现 176-196 行）：stubFetch 加回 providers/models 两条路由（最前），其余不变。
9. 测试「手动填写 tab：...」（现 198-211 行）：stubFetch 加回 providers/models 两条路由（最前），其余不变。
10. 测试「编辑绑定态：...」（现 213-246 行）：stubFetch 加回 providers/models 两条路由（最前）；fixture 在 `project: 'D:\\work\\demo',` 后加回 `agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },`。
11. 测试「编辑未绑定态：第 2 步显示绑定区块...」（现 248-271 行）与「编辑未绑定态：不绑定也能保存...」（现 273-292 行）：各 stubFetch 加回 providers/models 两条路由（最前）；各 fixture 在 `project: 'D:\\work\\demo',` 后加回 `agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },`。

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/bots/bot-form.client.spec.tsx`
Expected: FAIL——`findByRole('option', { name: 'DeepSeek' })` 超时（Provider UI 不存在）等断言不通过。

- [ ] **Step 3: 修改 `src/client/bots/api.ts`**

1. `BotInput` 在 `tools?: string[]` 行后加回（注意带 `| null`，编辑模式绑角色清除用）：

```ts
  /** 绑 main 时自配模型（必填）；null = 清除（编辑模式绑角色时提交）。 */
  agentOptions?: { provider?: string; model?: string } | null
```

2. 在 `fetchBots` 之后、`AgentOption` 注释之前恢复：

```ts
export interface ProviderOption { id: string; name: string }
export interface ModelOption { id: string; name: string }
```

3. 在 `fetchProviders` 原位（`fetchAgents` 之前）恢复两个 fetcher：

```ts
export const fetchProviders = () =>
  request<{ providers: ProviderOption[] }>('/dsh-agent-toolkit/api/bots/providers').then((r) => r.providers)

export const fetchModels = (provider: string) =>
  request<{ models: ModelOption[] }>(`/dsh-agent-toolkit/api/bots/models?provider=${encodeURIComponent(provider)}`).then((r) => r.models)
```

（`fetchAgents` 保持在两者之间——即顺序为 fetchProviders → fetchAgents → fetchModels，与 pre-v1 一致。）

- [ ] **Step 4: 修改 `src/client/bots/BotForm.tsx`**

1. 导入（现 8-11 行）改为：

```tsx
import {
  createBot, fetchAgents, fetchModels, fetchProviders, pollRegisterApp, startRegisterApp, updateBot,
  type BotListItem,
} from './api.ts'
```

2. 在 `agents` state（现 40 行）之后恢复五个 state：

```tsx
  const [provider, setProvider] = useState(bot?.agentOptions?.provider ?? '')
  const [model, setModel] = useState(bot?.agentOptions?.model ?? '')
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])
  const [providersLoaded, setProvidersLoaded] = useState(false)
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
```

3. 在 agents useEffect（现 52-63 行）之后恢复两个 useEffect（逐字，pre-v1 原逻辑；注释合并为一行）：

```tsx
  // providers 挂载时取一次：初始选中第一项（编辑模式若 bot 的 provider 在清单内则保留）；models 随 provider 变更重取，失败静默降级为手填。
  useEffect(() => {
    let stale = false
    fetchProviders().then((ps) => {
      if (stale) return
      setProviders(ps)
      setProvidersLoaded(true)
      setProvider((current) => {
        if (editing && current !== '' && ps.some((p) => p.id === current)) return current
        return ps[0]?.id ?? ''
      })
    }).catch(() => { if (!stale) setProvidersLoaded(true) })
    return () => { stale = true }
  }, [editing])

  useEffect(() => {
    let stale = false
    if (provider.trim().length === 0) {
      setModels([])
      return () => { stale = true }
    }
    fetchModels(provider.trim())
      .then((ms) => {
        if (stale) return
        setModels(ms)
        setModel((current) => {
          if (editing && current !== '' && ms.some((m) => m.id === current)) return current
          return ms[0]?.id ?? current
        })
      })
      .catch(() => { if (!stale) setModels([]) })
    return () => { stale = true }
  }, [provider, editing])
```

4. `save()`：在 feishu 缺省校验块（现 127-130 行）之后、`setSaving(true)` 之前插入：

```tsx
    // agentOptions 仅绑 main 可配：必填校验 + 提交；编辑模式绑角色提交 null 清除记录残留。
    let agentOptions: { provider: string; model: string } | null | undefined
    if (agentRef === 'main') {
      const providerValue = provider.trim()
      const modelValue = model.trim()
      if (providerValue.length === 0) {
        setError('请选择 Provider')
        return
      }
      if (modelValue.length === 0) {
        setError('请选择或填写模型')
        return
      }
      agentOptions = { provider: providerValue, model: modelValue }
    } else if (editing) {
      agentOptions = null
    }
```

   payload 对象在 agentRef 展开块之后加一行：

```tsx
        ...(agentOptions !== undefined ? { agentOptions } : {}),
```

5. `cancel()` 之后、`return (` 之前恢复：

```tsx
  const showModelSelect = provider.trim().length > 0 && models.length > 0
```

6. JSX：在「绑定 Agent」label 块（现 208-215 行）之后插入条件块（绑角色时整段隐藏）：

```tsx
          {agentRef === 'main' && (
            <>
              <label className={css.field}>
                Provider
                <select className={css.select} value={provider} aria-label="Provider" disabled={providers.length === 0}
                  onChange={(e) => { setProvider(e.target.value); setModel(''); setModels([]) }}>
                  {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              {providersLoaded && providers.length === 0 && <p role="alert" className={css.error}>未发现可用 Provider</p>}
              <label className={css.field}>
                模型
                {showModelSelect ? (
                  <select className={css.select} value={model} aria-label="模型" onChange={(e) => { setModel(e.target.value) }}>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                ) : (
                  <Input value={model} onChange={(e) => { setModel(e.target.value) }} aria-label="模型" className={css.input} />
                )}
              </label>
            </>
          )}
```

- [ ] **Step 5: 运行测试与类型检查验证通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/bots/bot-form.client.spec.tsx ; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }`
Expected: 表单测试（12 个）PASS；typecheck 零错误。

- [ ] **Step 6: 提交**

```powershell
git add packages/toolkit/src/client/bots/api.ts packages/toolkit/src/client/bots/BotForm.tsx packages/toolkit/src/client/bots/bot-form.client.spec.tsx
git commit -m "feat(toolkit): 机器人表单恢复 Provider/模型选择（仅绑定 main 时显示且必填，绑角色保存清除残留）"
```

---

### Task 3: 使用手册同步（docs/usage/feishu-bots.md）

**Files:**
- Modify: `docs/usage/feishu-bots.md`（仓库根相对路径）

**Interfaces:**
- Consumes: Task 1/2 已落地的行为。
- Produces: 无代码接口；手册与新行为一致。

- [ ] **Step 1: 更新创建向导一节**

1. 第 1 步截图说明（现 15 行）改为：

```markdown
![创建向导第 1 步：名称、绑定项目、绑定 Agent、Provider 与模型（绑 main 时）](images/bots-form.png)
```

（现有截图含 Provider/模型下拉，与绑 main 的表单形态一致，无需重拍。）

2. 字段表（现 17-21 行）：「绑定 Agent」行替换为两行：

```markdown
| 绑定 Agent | `main` 或注册表中的角色。绑角色：会话使用角色的 persona / 模型 / 工具白名单（角色未配模型回退宿主默认模型）；绑 `main`：使用下方自配的 Provider/模型 |
| Provider / 模型 | 仅绑定 `main` 时显示且必填。bot 会话固定使用该模型，不随宿主默认模型切换 |
```

3. 「编辑已有 bot 可改名称/项目/Agent；」（现 30 行）改为「编辑已有 bot 可改名称/项目/Agent/模型（模型仅绑 `main` 时可改；改绑角色会清除已配置的模型）；」。

- [ ] **Step 2: 更新 API 表**

在「`/dsh-agent-toolkit/api/bots/tools`」行（现 95 行）之后加回两行：

```markdown
| `/dsh-agent-toolkit/api/bots/providers` | GET | provider 列表 |
| `/dsh-agent-toolkit/api/bots/models?provider=` | GET | 模型列表 |
```

- [ ] **Step 3: 提交**

```powershell
git add docs/usage/feishu-bots.md
git commit -m "docs(usage): feishu-bots 同步 agentOptions 仅绑 main 可配语义"
```

---

### Task 4: 全量验证

**Files:**
- 无新改动（验证 + 需要时修缺陷）

**Interfaces:**
- Consumes: Task 1-3 全部产物。
- Produces: 两包测试/类型/构建全绿的可交付状态。

- [ ] **Step 1: toolkit 包全量**

Run: `pnpm --filter dsh-agent-toolkit test ; if ($?) { pnpm --filter dsh-agent-toolkit typecheck } ; if ($?) { pnpm --filter dsh-agent-toolkit bundle }`
Expected: 全部用例 PASS（数量随恢复/新增用例浮动）、typecheck 零错误、bundle 产出 `lib/index.js` + `lib/client.js` 无报错。

- [ ] **Step 2: usage 包回归**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test ; if ($?) { pnpm --filter @dsh-agent-toolkit/token-usage typecheck }`
Expected: 78 用例 PASS、typecheck 零错误（本计划不触及 usage 包，纯回归确认）。

- [ ] **Step 3:（仅当有缺陷修复时）提交修复**

若 Step 1/2 暴露问题：修复后重跑至全绿，再 `git add <涉及文件>` + commit（message 按性质选 `fix(toolkit): ...`）。无缺陷则本任务无 commit。

---

## Self-Review 记录

- **Spec 覆盖**：spec 需求 2「模型解析语义」→ Task 1（Step 5.4）；「文件改动清单」逐行核对——store/api/index/router/ports/runtime → Task 1，client api/BotForm → Task 2，`docs/usage/feishu-bots.md` → Task 3；「表单交互细则」（回显/切换/校验条件）→ Task 2 Step 4；「测试影响」表 → 各任务 Step 1；「存量数据」→ store.test 恢复钉 + router 兜底钉；验收标准 3/4/5 → Task 1/2 用例 + Task 4。需求 1（删除）v1 已实现，本计划不触及（bots-modal spec 不动）。
- **占位符扫描**：无 TBD/TODO；所有代码步骤给出完整代码。
- **类型一致性**：`BotInput.agentOptions` 带 `| null` ↔ `UpdateBodySchema.agentOptions` `.nullable()` ↔ PUT `agentOptions === null` 清除分支 ↔ 表单 `agentOptions = null`（仅 editing 且绑角色）一致；`BotRecord.agentOptions`（可选、无 null）↔ router `bot.agentOptions ?? this.defaultModel()` 一致；`fetchProviders/fetchModels` 命名 client/Node 两侧与 pre-v1 一致。
- **任务间类型绿**：Task 1 完成后客户端不引用 agentOptions（表单尚未恢复），类型绿；Task 2 恢复客户端引用时 store schema 已就位。
- **已裁决约束落入 Global Constraints**：fireEvent.click 规则（v1 Task 3 裁决）写入本计划，防止实现者重蹈原生 click。
