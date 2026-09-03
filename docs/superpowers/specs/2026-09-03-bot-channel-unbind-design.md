# 消息机器人发送渠道解绑/重绑设计

日期：2026-09-03
状态：已获用户批准（定稿）

## 背景与问题

bot 记录的发送渠道绑定（`channel: 'feishu'` + `feishu.appId/appSecretRef`，schema 见 `packages/toolkit/src/bots/store.ts:18-37`）是必填字段，且编辑表单第 2 步只显示「当前应用：{appId}（如需换绑请删除后重建）」（`packages/toolkit/src/client/bots/BotForm.tsx:303`）——既不能解绑也不能换绑，用户想断开渠道或换应用只能删除整个 bot 重建，名称/项目/Agent/模型等配置全部丢失。

## 定案方向（用户裁定）

- **解绑语义**：bot 记录完整保留（名称/项目/Agent/模型等），仅渠道断开，之后可重新绑定
- **清理语义**：解绑删除密钥凭据，但**保留**会话绑定（`(botId, chatId) → sessionId`）——重绑同一应用时老群聊可继续原会话；重绑不同应用时旧绑定成为无害垃圾（chatId 不匹配永不命中）
- **入口**：编辑表单第 2 步内解绑 + 重绑；换绑 = 先解绑再重绑，不做一步换绑
- **方案**：schema 放宽 + 复用 PUT nullable 语义（方案 A），不新增专用端点

## 方案

### 1. 数据模型（`src/bots/store.ts`）

`BotRecordSchema` 两字段改可选并加一致性 refine（拒绝半绑定态）：

```ts
export const BotRecordSchema = z.object({
  // ...
  channel: z.literal('feishu').optional(),
  feishu: FeishuConfigSchema.optional(),
  // ...
}).refine(
  (r) => (r.channel === undefined) === (r.feishu === undefined),
  { message: 'channel 与 feishu 必须同有或同无' },
)
```

存量记录两字段都在 → 天然兼容；domain version 保持 1，零迁移。

### 2. API（`src/bots/api.ts`，PUT `/bots?id=`）

- `UpdateBodySchema.feishu` 改为 `z.object({ appId, appSecret?, appSecretRef? }).nullable().optional()`（补齐扫码路径的 `appSecretRef`，与 create 对齐；`appSecret`/`appSecretRef` 至少其一）
- **解绑**（`feishu: null`）：
  1. `runtime.unbindBot(id)`（见第 3 节）
  2. `deleteSecret(旧 appSecretRef)`（原 feishu 存在时）
  3. merged 记录摘除 `channel` + `feishu` 两字段
- **重绑**（`feishu: { appId, ... }`）：
  1. appId 被其他 bot 占用 → 409（同 create 的遍历检查）
  2. `appSecret` 路径 `storeSecret` 入 credentials；`appSecretRef` 路径直接引用（扫码已入库）
  3. 写入 `channel: 'feishu'` + 新 `appSecretRef` → `reconcile(id)` 重启渠道
  4. 旧 secretRef ≠ 新 ref 时清理旧凭据
- DELETE bot 补 guard：未绑定记录无 `feishu`，跳过删密钥

### 3. Runtime（`src/channels/runtime.ts`）

- `reconcile`：`record.feishu === undefined` → 直接返回（不启动渠道、不告警）；原 `record.feishu.appSecretRef` 访问加 guard
- `BotStatus` 联合类型加 `'unbound'`；`statusOf` 对「记录存在但无 feishu」返回 `'unbound'`（优先于 handles 查询）
- 新增 `unbindBot(botId)`：`stopChannel` + cancel 并移除进程内 sessions（同 `stopBot` 的会话清理），但**不删** bindings 表、不删持久会话——重绑后 resume 接续

### 4. 浏览器半 UI

**列表（`src/client/bots/BotsModal.tsx`）**
- `STATUS_LABEL`/`STATUS_DOT` 加 `unbound: '未绑定'` / `'warning'`（琥珀点）
- 未绑定 bot 不显示「飞书」Pill（有绑定才显示渠道徽标）

**编辑表单（`src/client/bots/BotForm.tsx` 第 2 步）**
- **已绑定**（`bot.feishu` 存在）：维持「当前应用：{appId}」，旁加「解绑」按钮（两段式确认：首点变「确认解绑？」再点执行，不引入新确认组件）。解绑 = 立即 `updateBot(bot.id, { feishu: null })`，成功后 `onSaved()` 回列表刷新
- **未绑定**：显示与创建模式一致的绑定区块（扫码/手动两个 tab）；保存不强制绑定——完成绑定则 payload 带 `feishu`，未完成也允许只改名称/项目等保存（bot 维持未绑定）
- 创建模式流程不变

### 5. 测试

- `api.test.ts`：`feishu: null` 解绑（停渠道/删密钥/摘字段/绑定保留）；重绑两条路径（`appSecret` / `appSecretRef`）+ appId 409 冲突 + 旧凭据清理；DELETE 未绑定 bot
- `runtime.test.ts`：无 `feishu` 记录 reconcile 跳过；`statusOf` 返回 `unbound`；`unbindBot` 保留绑定表
- `store.test.ts`：半绑定态（只有 channel 或只有 feishu）被 refine 拒绝
- 客户端 specs：编辑绑定态出「解绑」；未绑定态出绑定区块、保存可不带 feishu；列表未绑定徽标

### 6. 文档

`docs/usage/feishu-bots.md` 编辑段落改为「支持解绑与重新绑定」，删除「换绑需删除后重建」说明。

## 明确不做

- 一步换绑（解绑+重绑合并操作）——两步足够，避免表单内多状态切换
- 重绑时选择性继承旧会话——绑定表按 chatId 命中，无需用户选择
- 未绑定 bot 的快捷重绑入口（列表行）——编辑表单内完成即可
