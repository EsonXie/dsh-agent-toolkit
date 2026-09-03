# 飞书扫码创建应用申请必要权限设计

日期：2026-09-03
状态：已获用户批准（定稿）

## 背景与问题

飞书渠道的「扫码一键创建」走 `lark.registerApp`（OAuth 2.0 Device Authorization Grant）。当前 `packages/toolkit/src/bots/index.ts:131` 调用时**未传 `addons`**，创建的应用只落平台默认模板（基础消息机器人能力），而插件的核心回复路径依赖的权限不在默认模板内：

- 流式卡片（Card Kit `cardkit.v1.card.*`）需要独立权限 **`cardkit:card:write`**（官方文档确认）
- 收发消息需要 `im:message` / `im:message:send_as_bot`
- 长连接收消息需要订阅事件 **`im.message.receive_v1`**

结果：扫码创建的应用大概率只能收发基础文本，流式卡片建卡/更新直接失败（`reply.ts:87-105` 吞错只记日志，turn 末降级发纯文本）；手动绑定路径也因零权限引导而容易踩坑。

## 定案方向（用户裁定）

扫码创建时通过 `addons` **显式申请**以下权限（硬编码常量，不进 Config schema；**不加** `createOnly`，保持落地页可选已有应用）：

| 类型 | 权限标识 | 用途 |
|---|---|---|
| 应用身份权限 | `im:message` | 获取与发送单聊、群组消息（收发 + 表情回复） |
| 应用身份权限 | `im:message:send_as_bot` | 以应用身份发消息 |
| 应用身份权限 | `cardkit:card:write` | 创建和更新卡片（Card Kit 流式卡片） |
| 应用身份权限 | `contact:user.base:readonly` | 获取用户基本信息（用户指定追加） |
| 应用身份事件 | `im.message.receive_v1` | 接收消息事件（长连接） |

同时联动更新手动填写 UI 提示与使用文档（用户指定范围）。

## 方案

### 1. 常量 + 状态机传参（`src/bots/register-app.ts`）

新增导出常量 `FEISHU_REGISTER_APP_ADDONS`，`RegisterAppService.start()` 调用 `this.deps.registerApp` 时带上 `addons`；`RegisterAppFn` 的 options 类型加 `addons` 字段：

```ts
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
} as const

export type RegisterAppFn = (options: {
  signal: AbortSignal
  addons: typeof FEISHU_REGISTER_APP_ADDONS
  onQRCodeReady(info: QRInfo): void
}) => Promise<{ client_id: string; client_secret: string }>
```

`bots/index.ts` 的接线 `registerApp: (options) => lark.registerApp(options)` 不变（`options` 现含 `addons`，SDK 原样透传）。

### 2. 测试（`src/bots/register-app.test.ts`）

新增用例：fake `registerApp` 收到的 `addons` 断言含 4 权限 + 1 事件（防将来被误删）。

### 3. 手动填写 UI 提示（`src/client/bots/BotForm.tsx`）

手动填写 tab 的表单下方加一行小字提示：手动绑定需自备应用并开通「机器人能力、im:message、im:message:send_as_bot、cardkit:card:write、contact:user.base:readonly、im.message.receive_v1 事件（长连接方式）」。

### 4. 文档（`docs/usage/feishu-bots.md`）

新增「所需权限」小节：列出扫码自动申请项 + 手动绑定需自备项。

## 不做的事（YAGNI）

- 不加 `createOnly: true`（保持现状，落地页可选已有应用）
- 不进 Config schema（权限集是功能必需且稳定；`addons.preset` 不显式传，沿用默认模板 + 增量）
- 不改错误处理链路（卡片失败降级逻辑现状保留）

## 验证

- `pnpm --filter dsh-agent-toolkit test`（register-app 新增用例 + 全量回归）
- `pnpm --filter dsh-agent-toolkit typecheck`
- `pnpm --filter dsh-agent-toolkit bundle`
