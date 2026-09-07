# 消息机器人删除功能 + 移除 bot 自带 provider/model 实施计划

> ⚠️ **已于 2026-09-04 执行完毕，请勿再次执行。** 其中「彻底移除 agentOptions」部分（Task 1/2）随后按人工验收被 v2 spec 取代——恢复为「仅绑 main 可配」（spec 同目录 `2026-09-04-bots-delete-and-remove-agentoptions-design.md` 已就地修订为 v2；恢复实施见 `2026-09-04-bots-agentoptions-main-only.md`）。Task 3 行内删除功能维持有效，随 `dsh-agent-toolkit@0.2.8` 发布。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消息机器人列表增加行内删除（两段确认）；彻底移除 bot 自带 `agentOptions`（provider/model），会话模型改由绑定 Agent 决定。

**Architecture:** 后端 `DELETE /bots` 端点与客户端 `deleteBot()` RPC 已存在，删除只补 UI（列表行重排为 div 容器 + 主按钮 + 删除按钮）。agentOptions 全链路移除（存储 schema → API schema/端点 → 路由解析 → 表单 UI），模型解析收敛为：main → 宿主默认模型；角色 → `role.model ?? 宿主默认`。存量记录经 zod 未知键剥离零迁移。

**Tech Stack:** TypeScript / React（客户端半）/ vitest + @testing-library/react / zod / pnpm workspace（`packages/toolkit`，npm 包名 `dsh-agent-toolkit`）。

**Spec:** `docs/superpowers/specs/2026-09-04-bots-delete-and-remove-agentoptions-design.md`

## Global Constraints

- 工作目录：`packages/toolkit`（下述相对路径均以此为根）；**不得修改** `deepseek-harness/` 下任何文件。
- 每个 Task 结束时：`pnpm --filter dsh-agent-toolkit test` 全绿 + `pnpm --filter dsh-agent-toolkit typecheck` 零错误后才 commit；只 stage 本任务文件。
- Shell 为 Windows PowerShell 5.1：链式命令用 `; if ($?) { ... }`，不用 `&&`。
- 单文件测试命令模板：`pnpm --filter dsh-agent-toolkit exec vitest run <相对 src 的测试文件路径>`。
- commit message 用仓库既有风格：`type(toolkit): 中文描述`。
- 所有面向用户的文案为简体中文；文件头注释风格沿用各文件现状。
- 不新增任何 npm 依赖。

---

### Task 1: 客户端表单——移除 Provider/模型选择 + client api 清理

bot 会话模型改由绑定 Agent 决定，表单不再收集 provider/model。本任务只动客户端半（`src/client/bots/`），后端 `/providers`、`/models` 端点与 `BotRecord.agentOptions` 暂时保留（下个任务删），保证每步类型绿。

**Files:**
- Modify: `src/client/bots/api.ts`
- Modify: `src/client/bots/BotForm.tsx`
- Test: `src/client/bots/bot-form.client.spec.tsx`

**Interfaces:**
- Consumes: 现有 `createBot/updateBot`（不变）；`BotListItem`（= `BotRecord & { status: string }`，本任务不改其定义）。
- Produces: `BotInput` 不含 `agentOptions`（后续任务的后端清理依赖此契约）；`fetchProviders`/`fetchModels`/`ProviderOption`/`ModelOption` 从 `src/client/bots/api.ts` 消失（不再有消费方）。

- [ ] **Step 1: 重写 `bot-form.client.spec.tsx`（先写失败测试）**

对 `src/client/bots/bot-form.client.spec.tsx` 做如下修改（逐条列出，全部落盘后运行）：

1. 删除第一个测试 `手动填写创建：名称/项目 + Provider/模型默认选中第一项 + 密钥；不携带 id/tools/persona` 的 providers/models 路由 stub（`'/dsh-agent-toolkit/api/bots/providers'` 与 `'/dsh-agent-toolkit/api/bots/models?provider=deepseek'` 两行）与 Provider/模型断言（`await screen.findByRole('option', { name: 'DeepSeek' })` 至 `toHaveProperty('value', 'deepseek-chat')` 共 4 行），改名为：

```tsx
test('手动填写创建：名称/项目 + 密钥；不携带 id/tools/persona/agentOptions', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  // Provider/模型 UI 已移除：bot 会话模型改由绑定 Agent 决定
  expect(screen.queryByLabelText('Provider')).toBeNull()
  expect(screen.queryByLabelText('模型')).toBeNull()

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
    feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' },
  })
  expect(create?.body).not.toHaveProperty('id')
  expect(create?.body).not.toHaveProperty('tools')
  expect(create?.body).not.toHaveProperty('persona')
  expect(create?.body).not.toHaveProperty('agentOptions')
})
```

2. 测试 `扫码创建：...`（原 72-112 行）：删除 providers/models 两条 stub 路由；payload 断言改为（去掉 `agentOptions` 行、新增 not 断言）：

```tsx
  const create = calls.find((c) => c.url === '/dsh-agent-toolkit/api/bots/bots' && c.method === 'POST')
  expect(create?.body).toMatchObject({
    feishu: { appId: 'cli_ffffffffffffffff', appSecretRef: 'project_bot_ffffffff' },
  })
  expect(create?.body).not.toHaveProperty('agentOptions')
  expect(create?.body).not.toHaveProperty('id')
```

3. 测试 `必填校验：...`（原 114-133 行）：改名为 `必填校验：第一步缺名称不放行；第二步缺 App ID/Secret 不提交`；删除 providers stub 路由与 Provider 禁用/提示断言（原 118-120 行的 `await screen.findByText(/未发现可用 Provider/)` 与 `expect(screen.getByLabelText('Provider')).toHaveProperty('disabled', true)`）。其余（缺名称不放行、第二步缺 feishu 不提交）保持不变。

4. 整体删除测试 `模型必填：models 清单为空回退手填，留空保存被拦且不提交`（原 135-154 行）。

5. 测试 `绑定 Agent 下拉：...`（原 156-181 行）：删除 providers/models 两条 stub 路由，其余不变。

6. 测试 `编辑模式：agentRef 回显角色；...`（原 183-210 行）：删除 providers/models 两条 stub 路由；fixture（原 191-197 行）删除 `agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },` 一行。

7. 测试 `Agent 名册不可用：...`（原 212-234 行）：删除 providers/models 两条 stub 路由；删除 `await screen.findByRole('option', { name: 'DeepSeek' })`（原 221 行）——改为直接断言（main 缺省值是同步初始 state，无需等待）：

```tsx
  expect(screen.getByLabelText('绑定 Agent')).toHaveProperty('value', 'main')
```

8. 测试 `手动填写 tab：展示所需权限提示文案`（原 236-251 行）：删除 providers/models 两条 stub 路由。

9. 测试 `编辑绑定态：第 2 步显示当前应用与解绑...`（原 253-289 行）：删除 providers/models 两条 stub 路由；fixture（原 260-266 行）删除 `agentOptions: ...` 行。

10. 测试 `编辑未绑定态：第 2 步显示绑定区块...`（原 291-317 行）与 `编辑未绑定态：不绑定也能保存...`（原 319-341 行）：各删除 providers/models 两条 stub 路由；各 fixture（原 300-304、328-332 行）删除 `agentOptions: ...` 行。

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/bots/bot-form.client.spec.tsx`
Expected: FAIL——`queryByLabelText('Provider')` 仍能找到（UI 还在）等断言不通过。

- [ ] **Step 3: 修改 `src/client/bots/api.ts`**

1. `BotInput` 接口删除 `agentOptions?: { provider?: string; model?: string }` 一行。
2. 删除 `ProviderOption`/`ModelOption` 两个 interface（原 36-37 行）。
3. 删除 `fetchProviders`（原 41-42 行）与 `fetchModels`（原 47-48 行）。

- [ ] **Step 4: 修改 `src/client/bots/BotForm.tsx`**

1. 导入（原 8-11 行）改为：

```tsx
import {
  createBot, fetchAgents, pollRegisterApp, startRegisterApp, updateBot,
  type BotListItem,
} from './api.ts'
```

2. 删除 state（原 41-45 行）：

```tsx
  const [provider, setProvider] = useState(bot?.agentOptions?.provider ?? '')
  const [model, setModel] = useState(bot?.agentOptions?.model ?? '')
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])
  const [providersLoaded, setProvidersLoaded] = useState(false)
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
```

3. 删除两个 useEffect：providers 加载（原 71-83 行）与 models 随 provider 变更（原 85-102 行）。保留 agents useEffect 与 pollTimer 清理 effect。
4. `save()` 删除 provider/model 校验与组装（原 170-180 行的 `const providerValue = ...` 至 `const agentOptions = { provider: providerValue, model: modelValue }`），payload 对象删除 `agentOptions,` 一行（原 192 行）。
5. 删除 `const showModelSelect = ...`（原 239 行）。
6. JSX 删除 Provider 字段、「未发现可用 Provider」提示、模型字段（原 269-286 行，即两个 `<label className={css.field}>` 块与其间的 `<p role="alert">`）。

- [ ] **Step 5: 运行测试与类型检查验证通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/bots/bot-form.client.spec.tsx ; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }`
Expected: 表单测试 PASS；typecheck 零错误（`BotRecord.agentOptions` 仍在，编辑模式 fixture 不再携带即可）。

- [ ] **Step 6: 提交**

```powershell
git add packages/toolkit/src/client/bots/api.ts packages/toolkit/src/client/bots/BotForm.tsx packages/toolkit/src/client/bots/bot-form.client.spec.tsx
git commit -m "refactor(toolkit): 机器人表单移除 Provider/模型选择（模型改由绑定 Agent 决定）"
```

---

### Task 2: Node 半——agentOptions 全链路移除（schema/API/端点/路由/接线）

**Files:**
- Modify: `src/bots/store.ts`
- Modify: `src/bots/api.ts`
- Modify: `src/bots/index.ts`
- Modify: `src/channels/router.ts`
- Modify: `src/channels/ports.ts`（仅注释）
- Modify: `src/channels/runtime.ts`（仅注释）
- Test: `src/bots/store.test.ts`、`src/bots/api.test.ts`、`src/channels/router.test.ts`

**Interfaces:**
- Consumes: Task 1 后客户端不再发送 `agentOptions`。
- Produces: `BotRecordSchema` 无 `agentOptions` 字段；`ApiDeps` 无 `listProviders/listModels`（`/providers`、`/models` 端点消失）；`Router.resolveSession` 语义 = main → `defaultModel()`，角色 → `role.model ?? defaultModel()`；`DefaultModelAccessor` 类型与签名不变（`create/resume` 的 `agentOptions` 形参保留，delegate 不受影响）。

- [ ] **Step 1: 更新 `src/bots/store.test.ts`（先写失败测试）**

1. `validBot` fixture 删除 `agentOptions: { provider: 'deepseek', model: 'deepseek-v4' },` 一行（原 12 行）。
2. 在 `preset 字段移除后：...` 测试之后新增零迁移回归钉：

```ts
  test('agentOptions 字段移除后：旧数据携带 agentOptions 仍可加载（未知键剥离，不拒绝）', () => {
    const legacy = { ...validBot, agentOptions: { provider: 'deepseek', model: 'deepseek-v4' } } as Record<string, unknown>
    const parsed = BotRecordSchema.safeParse(legacy)
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data : {}).not.toHaveProperty('agentOptions')
  })
```

- [ ] **Step 2: 更新 `src/bots/api.test.ts`**

1. harness 的 `deps` 删除 `listProviders` 与 `listModels` 两行（原 74-75 行）。
2. `describe('POST /bots')` 内新增回归钉：

```ts
  test('请求体携带 agentOptions 被忽略（bot 模型改由绑定 Agent 决定，不落表）', async () => {
    const { handler, bots } = harness()
    const res = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/bots/bots', {
      id: 'ops', name: '运维', project: 'D:\\work\\ops',
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
      feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' },
    }), res)
    expect(res.status).toBe(200)
    expect(bots.get('ops')).not.toHaveProperty('agentOptions')
  })
```

3. 整体删除 `describe('GET /providers 与 GET /models', ...)`（原 366-390 行，含 3 个 test）。

- [ ] **Step 3: 更新 `src/channels/router.test.ts`**

1. 替换原 108-128 行的三个测试为两个（删除「bot 有 agentOptions：原样透传」用例，`fakeBot` 不再能携带该字段）：

```ts
  test('create 会话以宿主默认模型创建（{provider, model}）', async () => {
    const { router, created, defaultModel } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).toHaveBeenCalledOnce()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
  })

  test('resume 恢复路径：同样取宿主默认模型', async () => {
    const { router, bindings, resumed, defaultModel } = setup()
    await bindings.set('reviewer', 'oc_1', 'sess-old')
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).toHaveBeenCalledOnce()
    expect(resumed[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
  })
```

2. 原 `agentRef 指向 main：不注册角色 section、不 restrict，agentOptions 走默认模型回退`（185 行）改名为 `agentRef 指向 main：不注册角色 section、不 restrict，模型取宿主默认`，断言不变。
3. 在「agentRef 指向角色：...」测试之后新增角色未配模型用例：

```ts
  test('agentRef 指向角色且角色未配 model：回退宿主默认模型', async () => {
    const NO_MODEL_ROLE: AgentRecord = { id: 'scout', name: '侦察', persona: '负责侦察。' }
    const { router, created, defaultModel } = setup(undefined, fakeRegistry([MAIN_ROLE, NO_MODEL_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'scout' }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).toHaveBeenCalledOnce()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
    expect(created[0].input.hooks).toEqual({
      sections: [
        { name: 'dsh-agent-toolkit:agent:persona', order: 0, text: '负责侦察。' },
        SENDER,
      ],
    })
  })
```

（`AgentRecord` 已在文件顶部 type-import，无需新增导入。）

- [ ] **Step 4: 运行测试验证失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/bots/store.test.ts src/bots/api.test.ts`
Expected: FAIL——store 的剥离断言失败（schema 仍收 agentOptions）；api 的「请求体携带 agentOptions 被忽略」失败（当前会落表）。router.test.ts 本步可不跑（新增用例在旧实现下也已满足，属语义钉）。

- [ ] **Step 5: 实现 Node 半改动**

1. `src/bots/store.ts`：`BotRecordSchema` 删除 `agentOptions` 块（原 32-35 行）：

```ts
  agentOptions: z.object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }).optional(),
```

2. `src/bots/api.ts`：
   - 删除 `ProviderOption`/`ModelOption` 接口（原 10-13 行）。
   - `ApiDeps` 删除 `listProviders()` 与 `listModels()`（原 20-22 行）。
   - `CreateBodySchema` 删除 `agentOptions` 行（原 41 行）；`UpdateBodySchema` 删除 `agentOptions` 行（原 57 行）。
   - POST 处理器删除 `...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),`（原 156 行）。
   - PUT 处理器删除（原 226-227 行）：

```ts
      if (input.agentOptions === null) delete merged.agentOptions
      else if (input.agentOptions !== undefined) merged.agentOptions = input.agentOptions
```

   - 删除 `/providers` 与 `/models` 两个端点分支（原 270-285 行）；405 清单改为：

```ts
    if (['/bots', '/register-app', '/register-app/status', '/tools'].includes(sub)) {
```

   - 文件头注释如提及 providers/models 无需改（原本只写路由前缀）。
3. `src/bots/index.ts`：`createApiHandler` 依赖里删除（原 218-219 行）：

```ts
        listProviders: () => ctx.llm.listProviders().map(({ id, name }) => ({ id, name })),
        listModels: (provider) => ctx.llm.listModels(provider).then((models) => models.map(({ id, name }) => ({ id, name }))),
```

   同时删除顶部的 `import type {} from '@deepseek-ai/dsh-llm'`（原 13 行，type-only 激活声明合并，删除后无消费方）。
4. `src/channels/router.ts`：
   - 构造器 `defaultModel` 参数注释（原 22 行）改为 `/** main 形态会话与未配置模型的角色的模型来源（宿主默认模型）。 */`。
   - 删除 `resolveOptions` 方法（原 62-65 行）。
   - `resolveSession` main 分支（原 87 行）改为：

```ts
      return { agentOptions: this.defaultModel(), hooks: this.withSenderSection(hooksOf(bot), bot, userId) }
```

   - 角色分支（原 93 行）改为：

```ts
      agentOptions: role.model ?? this.defaultModel(),
```

   - `resolveSession` 的 doc 注释（原 74-79 行）中「默认模型回退」措辞更新为「宿主默认模型」。
5. `src/channels/ports.ts`：`DefaultModelAccessor` 上注释（原 41 行）改为：

```ts
/** main 形态会话与未配置模型的角色的模型来源（取 {provider, model}）。 */
```

6. `src/channels/runtime.ts`：`RuntimeDeps.defaultModel` 注释（原 18 行）同步改为 `/** main 形态会话与未配置模型的角色的模型来源（宿主默认模型）。 */`。

- [ ] **Step 6: 运行测试与类型检查验证通过**

Run: `pnpm --filter dsh-agent-toolkit test ; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }`
Expected: 全部测试 PASS（含 store/api/router 新旧用例）；typecheck 零错误。

- [ ] **Step 7: 提交**

```powershell
git add packages/toolkit/src/bots/store.ts packages/toolkit/src/bots/store.test.ts packages/toolkit/src/bots/api.ts packages/toolkit/src/bots/api.test.ts packages/toolkit/src/bots/index.ts packages/toolkit/src/channels/router.ts packages/toolkit/src/channels/router.test.ts packages/toolkit/src/channels/ports.ts packages/toolkit/src/channels/runtime.ts
git commit -m "refactor(toolkit): 移除 bot 自带 agentOptions，会话模型改由绑定 Agent 决定"
```

---

### Task 3: 客户端列表——行内删除按钮（两段确认）

**Files:**
- Modify: `src/client/bots/BotsModal.tsx`
- Modify: `src/client/bots/bots.module.css`
- Test: `src/client/bots/bots-modal.client.spec.tsx`

**Interfaces:**
- Consumes: 既有 `deleteBot(id)`（`src/client/bots/api.ts` 已存在，DELETE `/dsh-agent-toolkit/api/bots/bots?id=`）；既有 `useLoadState` 的 `reload()`。
- Produces: 列表行 DOM 结构 `div.botRow > button.botMain + button.botDelete`（CSS modules 类名，仅本组件消费）；组件内状态 `confirmDeleteId: string | null`、`deletingId: string | null`、`deleteError: string | null`。

- [ ] **Step 1: 在 `bots-modal.client.spec.tsx` 追加失败测试**

文件顶部导入改为 `import { cleanup, render, screen, within } from '@testing-library/react'`，并追加：

```tsx
function rowOf(name: string): HTMLElement {
  const main = screen.getByText(name).closest('button')
  if (main === null) throw new Error(`row not found: ${name}`)
  return main.parentElement as HTMLElement
}

test('删除两段确认：首点仅切确认态；再点 DELETE 并刷新列表', async () => {
  let deletes = 0
  let gets = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if ((init?.method ?? 'GET') === 'DELETE' && url.includes('id=reviewer')) {
      deletes += 1
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/bots')) gets += 1
    return new Response(JSON.stringify(BOTS), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces} />)
  expect(await screen.findByText('评审机器人')).toBeTruthy()

  // 首段：只切确认态，不发 DELETE
  within(rowOf('评审机器人')).getByRole('button', { name: '删除' }).click()
  expect(within(rowOf('评审机器人')).getByRole('button', { name: '确认删除？' })).toBeTruthy()
  expect(deletes).toBe(0)

  // 第二段：确认 → DELETE → reload（GET 计数 +1）
  const getsBefore = gets
  within(rowOf('评审机器人')).getByRole('button', { name: '确认删除？' }).click()
  await vi.waitFor(() => { expect(deletes).toBe(1) })
  await vi.waitFor(() => { expect(gets).toBe(getsBefore + 1) })
})

test('删除确认态转移：点其它行的删除按钮，原行复位', async () => {
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces} />)
  expect(await screen.findByText('评审机器人')).toBeTruthy()
  within(rowOf('评审机器人')).getByRole('button', { name: '删除' }).click()
  expect(within(rowOf('评审机器人')).getByRole('button', { name: '确认删除？' })).toBeTruthy()
  within(rowOf('运维机器人')).getByRole('button', { name: '删除' }).click()
  expect(within(rowOf('评审机器人')).getByRole('button', { name: '删除' })).toBeTruthy()
  expect(within(rowOf('运维机器人')).getByRole('button', { name: '确认删除？' })).toBeTruthy()
})

test('删除失败：DELETE 500 → role=alert 错误行', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'DELETE') return new Response('boom', { status: 500 })
    return new Response(JSON.stringify(BOTS), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces} />)
  expect(await screen.findByText('评审机器人')).toBeTruthy()
  within(rowOf('评审机器人')).getByRole('button', { name: '删除' }).click()
  within(rowOf('评审机器人')).getByRole('button', { name: '确认删除？' }).click()
  expect((await screen.findByRole('alert')).textContent).toContain('删除失败')
})
```

（既有三个测试不需改动：`getByText('评审机器人')` 命中行内 span，click 冒泡到主按钮仍触发 onEdit。）

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/bots/bots-modal.client.spec.tsx`
Expected: FAIL——新用例找不到「删除」按钮（rowOf 的 `closest('button')` 也取不到，行目前是整行一个 button）。

- [ ] **Step 3: 修改 `src/client/bots/BotsModal.tsx`**

1. 导入 `deleteBot`：

```tsx
import { deleteBot, fetchBots, type BotListItem } from './api.ts'
```

2. `BotsModalBody` 内、`useLoadState` 之后新增状态与删除函数：

```tsx
  /** 两段确认：记录待删行 id；点其它行转移，执行后清空。 */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  async function remove(bot: BotListItem): Promise<void> {
    if (confirmDeleteId !== bot.id) {
      setConfirmDeleteId(bot.id)
      setDeleteError(null)
      return
    }
    setDeletingId(bot.id)
    try {
      await deleteBot(bot.id)
      setConfirmDeleteId(null)
      reload()
    } catch (e) {
      setDeleteError(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeletingId(null)
    }
  }
```

3. 进编辑/新建时复位确认态（`onClick` 处加 `setConfirmDeleteId(null)`）：

```tsx
                <button key={bot.id} type="button" className={css.botMain}
                  onClick={() => { setConfirmDeleteId(null); onEdit !== undefined ? onEdit(bot) : setView({ mode: 'edit', bot }) }}>
```

（新建按钮同理：`onClick={() => { setConfirmDeleteId(null); onCreate !== undefined ? onCreate() : setView({ mode: 'create' }) }}`。）

4. 行结构重排（替换原 `<button className={css.botRow}>...</button>` 整块）：

```tsx
              {bots.map((bot) => (
                <div key={bot.id} className={css.botRow}>
                  <button type="button" className={css.botMain}
                    onClick={() => { setConfirmDeleteId(null); onEdit !== undefined ? onEdit(bot) : setView({ mode: 'edit', bot }) }}>
                    <span className={css.botName}>{bot.name}</span>
                    {/* 渠道徽标：仅已绑定（feishu 存在）的 bot 显示 */}
                    {bot.feishu !== undefined && <Pill className={css.channelBadge}>飞书</Pill>}
                    <span className={css.status}>
                      <StateDot state={STATUS_DOT[bot.status] ?? 'warning'} size={8} />
                      <span>{STATUS_LABEL[bot.status] ?? bot.status}</span>
                    </span>
                  </button>
                  <button type="button" className={css.botDelete} disabled={deletingId !== null}
                    onClick={() => { void remove(bot) }}>
                    {confirmDeleteId === bot.id ? '确认删除？' : '删除'}
                  </button>
                </div>
              ))}
```

5. 错误行插在分组列表之后、新建按钮之前：

```tsx
          {deleteError !== null && <p role="alert" className={css.error}>{deleteError}</p>}
          <Button variant="primary" className={css.createButton}
```

- [ ] **Step 4: 修改 `src/client/bots/bots.module.css`**

`.botRow` 去掉按钮残留声明（`background`/`cursor`/`font`/`color`/`text-align`），新增 `.botMain` 与 `.botDelete`：

```css
.botRow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  margin-bottom: 4px;
}
.botRow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.botMain {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
}
.botDelete {
  flex: none;
  padding: 2px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.botDelete:hover { color: var(--dsw-alias-state-error-primary); }
```

- [ ] **Step 5: 运行测试与类型检查验证通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/client/bots/bots-modal.client.spec.tsx ; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }`
Expected: 模态测试（含新增 3 个）PASS；typecheck 零错误。

- [ ] **Step 6: 提交**

```powershell
git add packages/toolkit/src/client/bots/BotsModal.tsx packages/toolkit/src/client/bots/bots.module.css packages/toolkit/src/client/bots/bots-modal.client.spec.tsx
git commit -m "feat(toolkit): 消息机器人列表支持行内删除（两段确认）"
```

---

### Task 4: 使用手册同步（docs/usage/feishu-bots.md）

**Files:**
- Modify: `docs/usage/feishu-bots.md`（仓库根相对路径）

**Interfaces:**
- Consumes: Task 1-3 已落地的行为（无 Provider/模型字段、列表行删除、模型语义）。
- Produces: 无代码接口；手册与新行为一致。

- [ ] **Step 1: 更新创建向导一节**

1. 第 1 步截图说明（原 15 行）改为：

```markdown
![创建向导第 1 步：名称、绑定项目、绑定 Agent](images/bots-form.png)
```

（截图内容尚含模型下拉，待真实环境重拍后替换图片文件。）

2. 字段表（原 17-22 行）：删除 `| Provider / 模型 | bot 会话使用的模型；不选则回退到当前默认模型 |` 行；「绑定 Agent」行改为：

```markdown
| 绑定 Agent | `main` 或注册表中的角色。bot 会话使用该 Agent 的 persona / 模型 / 工具白名单——绑角色用角色配置的模型（未配置则用宿主默认模型），绑 `main` 用宿主默认模型 |
```

3. 原第 31 行「编辑已有 bot 可改名称/项目/Agent/模型；...」改为「编辑已有 bot 可改名称/项目/Agent；...」。

- [ ] **Step 2: 新增删除说明**

在「换绑到新应用」条目（原 35 行）之后追加：

```markdown
- **删除**：在列表行尾点击「删除」并二次确认（按钮变为「确认删除？」后再点一次）后立即生效——渠道断开、在飞会话取消、会话绑定清除、密钥凭据删除、bot 记录删除。历史会话保留，但不再归属该 bot（会话列表中降级为未分组）。
```

- [ ] **Step 3: 更新 API 表**

原 96-97 行删除两行：

```markdown
| `/dsh-agent-toolkit/api/bots/providers` | GET | provider 列表 |
| `/dsh-agent-toolkit/api/bots/models?provider=` | GET | 模型列表 |
```

- [ ] **Step 4: 提交**

```powershell
git add docs/usage/feishu-bots.md
git commit -m "docs(usage): feishu-bots 同步删除功能与模型语义（去 Provider/模型选择）"
```

---

### Task 5: 全量验证

**Files:**
- 无新改动（验证 + 需要时修缺陷）

**Interfaces:**
- Consumes: Task 1-4 全部产物。
- Produces: 两包测试/类型/构建全绿的可交付状态。

- [ ] **Step 1: toolkit 包全量**

Run: `pnpm --filter dsh-agent-toolkit test ; if ($?) { pnpm --filter dsh-agent-toolkit typecheck } ; if ($?) { pnpm --filter dsh-agent-toolkit bundle }`
Expected: 374+ 用例全 PASS（数量随新增/删除用例浮动）、typecheck 零错误、bundle 产出 `lib/index.js` + `lib/client.js` 无报错。

- [ ] **Step 2: usage 包回归**

Run: `pnpm --filter @dsh-agent-toolkit/token-usage test ; if ($?) { pnpm --filter @dsh-agent-toolkit/token-usage typecheck }`
Expected: 78 用例 PASS、typecheck 零错误（本任务不触及 usage 包，纯回归确认）。

- [ ] **Step 3:（仅当有缺陷修复时）提交修复**

若 Step 1/2 暴露问题：修复后重跑至全绿，再 `git add <涉及文件>` + commit（message 按性质选 `fix(toolkit): ...`）。无缺陷则本任务无 commit。

---

## Self-Review 记录

- **Spec 覆盖**：spec「删除交互」→ Task 3；「模型解析语义」→ Task 2（Step 5.4）；「文件改动清单」逐行核对——client api/BotForm → Task 1，bots api/store/index/router/ports/runtime → Task 2，BotsModal/CSS → Task 3，`docs/usage/feishu-bots.md` → Task 4（spec 未单列但属手册一致性义务）；「测试影响」表 → 各任务 Step 1；「验收标准 6」→ Task 5。
- **占位符扫描**：无 TBD/TODO；所有代码步骤给出完整代码。
- **类型一致性**：`confirmDeleteId/deletingId/deleteError` 命名在 Step 3 各处一致；`rowOf` 辅助函数在 3 个新用例中一致；`role.model ?? this.defaultModel()` 与 router.test 新用例断言一致。
- **任务间类型绿**：Task 1 只动客户端（`BotRecord.agentOptions` 尚存，编辑态不读即可绿）；Task 2 动 Node 半时 bot-form spec 已无 agentOptions 引用；Task 3 与前两者无类型耦合。
