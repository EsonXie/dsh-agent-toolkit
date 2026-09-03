# 飞书扫码创建应用申请必要权限 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扫码一键创建飞书应用时，通过 `addons` 显式申请消息/卡片/通讯录权限与收消息事件，并配套手动绑定 UI 提示与使用文档。

**Architecture:** `register-app.ts` 定义并导出常量 `FEISHU_REGISTER_APP_ADDONS`，`RegisterAppService.start()` 把 `addons` 传入 `registerApp`；`RegisterAppFn` 类型补 `addons` 字段。UI 手动填写 tab 加权限提示文案，`docs/usage/feishu-bots.md` 补「所需权限」小节。

**Tech Stack:** TypeScript、@larksuiteoapi/node-sdk `registerApp`/`AppAddons`、vitest、React（client 半）。

## Global Constraints

- 权限集（硬编码常量，不进 Config schema，不加 `createOnly`）：
  - scopes.tenant: `im:message`、`im:message:send_as_bot`、`cardkit:card:write`、`contact:user.base:readonly`
  - events.items.tenant: `im.message.receive_v1`
- `addons.preset` 不显式传（沿用平台默认模板 + 增量）
- 不改 `bots/index.ts` 的 `registerApp` 接线（`(options) => lark.registerApp(options)` 原样透传 options）
- 每任务跑 `pnpm --filter dsh-agent-toolkit test`（+ 目标文件）；全部完成后跑 `typecheck` + `bundle`

---

### Task 1: addons 常量 + 状态机传参

**Files:**
- Modify: `packages/toolkit/src/bots/register-app.ts`
- Test: `packages/toolkit/src/bots/register-app.test.ts`

**Interfaces:**
- Consumes: 无（本任务自包含）
- Produces: `FEISHU_REGISTER_APP_ADDONS`（`as const` 对象）；`RegisterAppFn` 的 options 增加必填 `addons: typeof FEISHU_REGISTER_APP_ADDONS`；`start()` 调用 `this.deps.registerApp` 时传入 `addons`

- [ ] **Step 1: 写失败测试**

在 `register-app.test.ts` 末尾追加测试；把现有 import（第 2 行 `RegisterAppService, type RegisterAppFn`）改为：

```ts
import { FEISHU_REGISTER_APP_ADDONS, RegisterAppService, type RegisterAppFn } from './register-app.ts'
```

并追加：

```ts
test('扫码创建带 addons：申请的权限/事件完整且原样透传', async () => {
  let receivedAddons: unknown
  const registerApp: RegisterAppFn = async (options) => {
    receivedAddons = options.addons
    options.onQRCodeReady({ url: 'https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH', expireIn: 600 })
    return { client_id: 'cli_a1b2c3d4e5f60718', client_secret: 's3cret' }
  }
  const { svc } = harness(registerApp)
  const id = svc.start()
  await vi.waitFor(() => { expect(svc.get(id)?.status).toBe('done') })
  expect(receivedAddons).toEqual(FEISHU_REGISTER_APP_ADDONS)
  expect(receivedAddons).toMatchObject({
    scopes: { tenant: expect.arrayContaining(['im:message', 'im:message:send_as_bot', 'cardkit:card:write', 'contact:user.base:readonly']) },
    events: { items: { tenant: expect.arrayContaining(['im.message.receive_v1']) } },
  })
  svc.dispose()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run（从 `packages/toolkit` 目录）: `pnpm exec vitest run src/bots/register-app.test.ts`
Expected: FAIL（`FEISHU_REGISTER_APP_ADDONS` 未定义 / `addons` 类型缺失）

- [ ] **Step 3: 实现**

在 `register-app.ts` 顶部（`export interface QRInfo` 之前）加常量，并给 `RegisterAppFn` 的 options 补 `addons`：

```ts
/** 扫码创建应用时申请的权限/事件（流式卡片 + 收发消息 + 表情 + 通讯录基础信息）。 */
export const FEISHU_REGISTER_APP_ADDONS = {
  scopes: {
    tenant: [
      'im:message',
      'im:message:send_as_bot',
      'cardkit:card:write',
      'contact:user.base:readonly',
    ],
  },
  events: {
    items: { tenant: ['im.message.receive_v1'] },
  },
}
```

`RegisterAppFn` 改为：

```ts
export type RegisterAppFn = (options: {
  signal: AbortSignal
  addons: typeof FEISHU_REGISTER_APP_ADDONS
  onQRCodeReady(info: QRInfo): void
}) => Promise<{ client_id: string; client_secret: string }>
```

`start()` 内的 `registerApp` 调用（现第 47-52 行）补 `addons`：

```ts
void this.deps.registerApp({
  signal: controller.signal,
  addons: FEISHU_REGISTER_APP_ADDONS,
  onQRCodeReady: (info) => {
    entry.state = { status: 'pending', url: info.url, expireIn: info.expireIn }
  },
}).then(async (result) => {
```

- [ ] **Step 4: 跑测试确认通过**

Run（从 `packages/toolkit` 目录）: `pnpm exec vitest run src/bots/register-app.test.ts`
Expected: PASS（新旧 5 个用例全过）

- [ ] **Step 5: 提交**

```bash
git add packages/toolkit/src/bots/register-app.ts packages/toolkit/src/bots/register-app.test.ts
git commit -m "feat(toolkit): 飞书扫码创建经 addons 申请消息/卡片/通讯录权限与收消息事件"
```

---

### Task 2: 手动填写 tab 权限提示

**Files:**
- Modify: `packages/toolkit/src/client/bots/BotForm.tsx`（手动 tab 区块）
- Modify: `packages/toolkit/src/client/bots/bots.module.css`（新增 `.hint`）
- Test: `packages/toolkit/src/client/bots/bot-form.client.spec.tsx`

**Interfaces:**
- Consumes: Task 1 的权限集（提示文案与之一致）
- Produces: 手动 tab 下出现提示文案；CSS 类 `.hint`

- [ ] **Step 1: 写失败测试**

在 `bot-form.client.spec.tsx` 末尾追加：

```ts
test('手动填写 tab：展示所需权限提示文案', async () => {
  stubFetch({
    '/dsh-agent-toolkit/api/bots/providers': () => ({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] }),
    '/dsh-agent-toolkit/api/bots/models?provider=deepseek': () => ({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }),
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bot: {} }),
  })
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={() => undefined} onCancel={() => undefined} />)

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '权限提示' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('tab', { name: '手动填写' }))

  expect(await screen.findByText(/im:message/)).toBeTruthy()
  expect(screen.getByText(/cardkit:card:write/)).toBeTruthy()
  expect(screen.getByText(/im.message.receive_v1/)).toBeTruthy()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run（从 `packages/toolkit` 目录）: `pnpm exec vitest run src/client/bots/bot-form.client.spec.tsx`
Expected: FAIL（找不到 `im:message` 文本）

- [ ] **Step 3: 实现**

`bots.module.css` 末尾追加：

```css
.hint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
```

`BotForm.tsx` 手动 tab 的第二个 `</label>`（App Secret 之后）与 `</>` 之间插入：

```tsx
                    <p className={css.hint}>需自备应用并开通：机器人能力、im:message、im:message:send_as_bot、cardkit:card:write、contact:user.base:readonly，并订阅 im.message.receive_v1 事件（长连接方式）</p>
```

- [ ] **Step 4: 跑测试确认通过**

Run（从 `packages/toolkit` 目录）: `pnpm exec vitest run src/client/bots/bot-form.client.spec.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/toolkit/src/client/bots/BotForm.tsx packages/toolkit/src/client/bots/bots.module.css packages/toolkit/src/client/bots/bot-form.client.spec.tsx
git commit -m "feat(toolkit): 手动绑定 tab 展示所需飞书权限提示"
```

---

### Task 3: 使用文档补「所需权限」

**Files:**
- Modify: `docs/usage/feishu-bots.md`

**Interfaces:**
- Consumes: Task 1 的权限集
- Produces: 文档小节「所需权限」

- [ ] **Step 1: 写文档**

在 `docs/usage/feishu-bots.md` 的「创建 bot（两步向导）」小节之后、「在飞书里使用」之前插入：

```markdown
## 所需权限

**扫码一键创建**：插件会在扫码确认页自动申请以下应用权限与事件订阅，扫码确认即生效：

- 应用权限 `im:message`（获取与发送单聊、群组消息；收发消息与表情回复）
- 应用权限 `im:message:send_as_bot`（以应用身份发消息）
- 应用权限 `cardkit:card:write`（创建和更新卡片，流式回复需要）
- 应用权限 `contact:user.base:readonly`（获取用户基本信息）
- 事件订阅 `im.message.receive_v1`（接收消息事件，长连接方式）

**手动填写**：绑定的已有自建应用需自行在开放平台开通以上权限与事件订阅，并把事件订阅方式设为**长连接**。缺少任一项会导致对应能力不可用（如缺 `cardkit:card:write` 时流式卡片失败，回复降级为纯文本）。
```

- [ ] **Step 2: 校验文档**

Run: `git diff --check` 无告警即可（纯文档改动，无需跑单测）

- [ ] **Step 3: 提交**

```bash
git add docs/usage/feishu-bots.md
git commit -m "docs: 飞书 bot 使用手册补所需权限清单"
```

---

### Task 4: 全量验证

- [ ] **Step 1: 全量单测**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: 全绿（含新增用例）

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 无错误

- [ ] **Step 3: 构建**

Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 产出 `lib/index.js` 与 `lib/client.js`
