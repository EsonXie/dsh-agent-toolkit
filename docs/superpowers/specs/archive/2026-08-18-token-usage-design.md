# token-usage 插件设计（spec）

> 日期：2026-08-18
> 状态：设计已获用户确认，待实现计划
> 前置文档：`docs/2026-08-18-插件组技术可行性评估.md` 第三节（数据源/存储/命令的源码验证）

## 1. 目标与范围

dsh 插件 `token-usage`：统计本机所有会话的模型 token 消耗，按日聚合持久化，在 Web UI 以模态框展示**指定日期**的用量——24 小时柱状图（空小时也渲染）+ 当日总量（K/M/B 自动换算）+ 模型/项目/会话三维细分。另提供 `/token-usage` 斜杠命令（文本摘要，兼作弹窗触发）。

**非目标**：不统计插件启用前的历史（seed 事件不回放，见可行性报告 3.2）；不做任意日期范围查询；不做费用折算（没有价格表）；不做 Typert @Remote 数据通道（v2 候选）。

## 2. 已确认决策（用户逐项拍板）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 历史数据 | 只统计插件启用后，纯 `session/event` 监听器 |
| 2 | usage 缺失 | `tokenMeter.estimateMessage()` 估算回退，记录中标注 |
| 3 | compaction/summary 用量 | 并入对话消耗总量，同时保留单列字段便于展示细分 |
| 4 | 命令查询形态 | 固定视图：无参数=今日+近 7 日摘要；`/token-usage <日期>`=指定日 |
| 5 | 日期时区 | 默认系统本地时区，Config `timezone` 可覆盖（IANA 名） |
| 6 | 按钮位置 | 会话头按钮带 `conversation.session.header.actions` |
| 7 | 模态框内容 | 日期翻页 + 柱状图 + 当日总量 + 维度细分表 |
| 8 | 数据通道 | `ctx.webServer` 注册 JSON GET 端点，浏览器同源 fetch |

## 3. 架构：双半侧单包

```
packages/token-usage/
├─ package.json            ← exports["."]=Node 半（ESM lib），exports["./client"]=lib/client.js
│                             （lazy-CJS bundle）；dsh.client 声明 platform/inject
├─ tsdown.config.ts        ← 复刻 clientBundle 预设
├─ src/
│   ├─ index.ts            ← Node 半：name/inject/Config/apply
│   ├─ aggregate.ts        ← 纯函数：事件→增量、增量→日记录合并、时区日期换算、K/M/B 格式化
│   ├─ store.ts            ← domain spec（zod schema）+ 打开/关闭生命周期
│   └─ client/
│       ├─ index.ts        ← 浏览器半 apply：slot 注册 + CommandNode 观察
│       ├─ UsageButton.tsx       ← 会话头按钮（conversation.session.header.actions）
│       ├─ UsageModal.tsx        ← 模态框：翻页头 + 柱状图 + 总量 + 细分表
│       └─ UsageModal.module.css ← CSS Modules，--dsw-alias-* 语义 token
```

形态依据：`packages/client/ui-theme`、`packages/client/ui-commands` 即"同包双半侧"先例；cordis.yml 挂载插件后 client-modules 扫描 `dsh.client` 声明自动上图，无需重建 Web 应用（`docs/refer/reference/subsystems/client-modules.md`）。

## 4. 数据模型

```ts
// src/store.ts
defineDomain({
  name: 'token_usage', version: 1,   // UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/，不允许连字符
  tables: { daily: domainTable<string, DailyRecord>(DailyRecordSchema) },
})

interface Bucket {           // zod schema 声明，z.infer 出类型
  input: number; output: number
  cacheRead: number; cacheWrite: number
  calls: number              // 样本条数（assistant/message 条数）
  estimated: number          // 其中估算样本的 token 量（计费口径）
}

interface DailyRecord {
  date: string                                // 'YYYY-MM-DD'，同时是记录 key
  totals: Bucket & { estimatedCalls: number }
  hours: Bucket[24]                           // 空小时 = 全零桶，天然满足"空小时也显示"
  byModel:   Record<string, Bucket>                       // key 'provider/model'
  bySession: Record<string, Bucket & { cwd: string }>     // key sessionId
  byProject: Record<string, Bucket>                       // key cwd
  compaction: Bucket                          // 单列；数值同时并入 totals/hours
}
```

口径规则（全部已在可行性报告源码核实）：

- 计费 token 数 = `inputTokens + (cacheReadTokens??0) + (cacheWriteTokens??0) + outputTokens`；`reasoningTokens` 已含在 outputTokens 内，**不重复加**（`token-meter/src/index.ts:44-49`）
- 数据源只消费 `assistant/message`（chunk 级样本会被同 turn/step 最终值替换，天然去重）
- provider/model 取自 `event.data.message.source`；项目维度取 `session.header.cwd`（原样存储原样展示）
- 时区换算：`event.time`（UTC 毫秒）→ `Config.timezone`（默认 `Intl.DateTimeFormat().resolvedOptions().timeZone`）得到日期串与小时序号

## 5. 采集（Node 半）

`ctx.on('session/event', (session, event) => ...)`，全局 context 注册收全部 session；post-commit fire-and-forget，listener 失败不阻塞 append。

每条 `assistant/message` → `aggregate.ts: sampleFromEvent(session, event, tz)` 产出增量（日期、小时、五字段、是否估算、source/cwd/sessionId）→ `daily.update(date, rec => merge(rec, delta))` 原子 RMW 累加。`compaction/summary` 事件同理产出增量但只进 `compaction` + `totals`/`hours`（不进三维细分）。

usage 缺失 → `ctx.tokenMeter.estimateMessage(message)`（CHARS_PER_TOKEN=4 启发式），该样本 `estimated` 累加、`totals.estimatedCalls+1`。

domain 句柄调用方拥有：`ctx.effect` 里 open，disposer 里 `close()`（样板 `message-feedback/src/index.ts:173-181`）。

## 6. 交互（浏览器半）

### 6.1 按钮 → 模态框

`ctx.slots.register({ name: 'conversation.session.header.actions', ... }, UsageButton)`（list/session scope，先例 ui-jobs `ui-jobs/src/client/index.ts:30-39`）。点击 → 组件内 `setState` 打开 `Modal`（`ui-primitives` 受控组件，Escape/遮罩关闭），初始日期 = 今日。

### 6.2 命令 → 自动弹窗 + 文本降级

Node 半 `ctx.commands.register({ name: 'token-usage', input: { hint: '日期 YYYY-MM-DD，可空' }, handler })`：

- 无参数：返回今日详情 + 近 7 日摘要（每日一行：日期、计费总量 K/M/B、调用数），`{ kind: 'success', text }`，兼作非 Web 环境的降级输出
- 带日期：返回该日文本详情
- 日期非法：`{ kind: 'error', text }`

浏览器半的 session-scope 组件用标准 kit `useSession` 观察会话流中 `CommandNode`（`command/run`/`command/done` 折叠产物，`runtime/src/client/sessions/conversation.ts:248-290`）：发现 `name === 'token-usage'` 的节点 outcome 由 null → 非 null，即打开 Modal，日期解析自该节点的命令参数。无现成后置钩子，此为调研确认的可行机制。

### 6.3 模态框内容

- **翻页头**：`←` / `2026-08-18` / `→`（日期晚于今日时 `→` 禁用）
- **柱状图**：24 根 CSS div 柱（照 `ContextMeter.tsx:127-135` 纯 CSS 百分比先例，零依赖），高度 = 该小时计费 token / 当日峰值小时；空小时渲染零高度占位柱；悬停 `Tooltip`（ui-primitives）显示精确数值
- **总量行**：当日计费 token 总量，≥1000 自动换算 K（10³）/M（10⁶）/B（10⁹），保留 1 位小数；含估算时附"（含估算 N）"标注
- **细分表**：按模型 / 按项目 / 按会话三段，每段行列出名称 + 计费 token（K/M/B）+ 调用次数；`compaction` 单独一行展示

### 6.4 数据通道

Node 半 `ctx.webServer.register({ kind: 'exact', path: '/token-usage/api/daily', handler })`：`?date=YYYY-MM-DD` 合法 → 200 + DailyRecord JSON（无记录返回全零空记录）；参数非法 → 400。浏览器半同源 `fetch`。服务器默认绑 loopback 且无认证层（与 `/api` 桥接同等姿态），不引入额外安全面。Typert `@Remote` 服务为 v2 迁移候选（需复刻构建期代码生成，v1 不引入）。

## 7. 配置

```ts
export const Config = z.object({
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),  // IANA 名
})
```

HMR 改 timezone → 插件热替换，后续样本按新时区归日；已落盘记录不动（日期串已是 key）。

## 8. 构建与依赖

- 根：`package.json`（private，devDeps：typescript/tsdown/vitest）+ `pnpm-workspace.yaml`（只含 `packages/*`）
- 包 `package.json`：`type: module`；`exports["."]` → Node ESM lib，`exports["./client"]` → `lib/client.js`；`dsh.client = { platform: 'web', inject: [...] }`；peerDeps 照 ACP 蓝本集（cordis/dsh-agent/dsh-llm/dsh-session/dsh-attachment/dsh-user-approval/dsh-invariants）+ dsh-storage-domain/dsh-commands/dsh-token-meter/dsh-host-webserver（以实际 import 收敛）
- tsdown 双产物：Node 半 ESM；浏览器半 lazy-CJS（banner `window.__ModuleLoader__.load({id, factory:(require)=>{` / footer `return module.exports; } });` / intro `var module={exports:{}};var exports=module.exports;`，external = react/react-dom/cordis/ui-slots/ui-primitives 等平台模块，CSS Modules 经 lightningcss 内联；依据 `packages/client/tsdown.client.ts:170-274`）
- 纯净度门禁复刻：`@deepseek-ai/` 值导入仅放行平台 external 白名单，跨插件协作只走 cordis 服务/slot

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| domain open 失败（version-mismatch/malformed-medium/invalid-record） | 插件 fiber 响亮 FAILED，不静默吞错 |
| 命令日期参数非法 | `{ kind: 'error', text: '用法：/token-usage [YYYY-MM-DD]' }` |
| HTTP 端点参数非法 | 400 + 错误 JSON |
| Modal fetch 失败 | 模态框内错误占位（不重试不关窗），翻页可重新触发 fetch |
| 无数据日期 | 空态文案 + 24 根零高度柱照常渲染 |

## 10. 测试

- `aggregate.ts` 纯函数 vitest 单测：五字段计费口径、估算回退标记、compaction 并入且单列、时区跨日（23:59 UTC 在东八区归入次日 07 点桶）、K/M/B 格式化边界（999/1000/999950/1e9）
- Node 半集成 + 浏览器半：开发回路手动验证（`cd deepseek-harness && pnpm dsh web --patch ..\dsh-eson-toolkit\cordis.yml`），浏览器半 bundle 变更经 client-hmr 热更

## 11. 关键源码依据（本次 UI 调研新增）

| 机制 | 位置（相对 deepseek-harness/） |
|---|---|
| slot 注册 API `ctx.slots.register/inject` | `packages/client/ui-slots/src/index.ts:741-786`；`packages/client/runtime/src/client/slots.ts:126,143-205` |
| 会话头按钮带 slot 声明 | `packages/client/ui-conversation/src/client/contract/slots.ts:63` |
| 按钮注册先例（ui-jobs） | `packages/client/ui-jobs/src/client/index.ts:30-39` |
| Modal 受控组件 | `packages/client/ui-primitives/src/Modal.tsx:30-86` |
| 纯 CSS 柱状先例（ContextMeter） | `packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx:127-135` |
| CommandNode 折叠（command/run+done） | `packages/client/runtime/src/client/sessions/conversation.ts:248-290` |
| session-scope 组件标准 kit（useSession） | `packages/client/runtime/src/client/index.ts:130-150` |
| webServer 路由注册 | `packages/host/webserver/src/index.ts:59`（`register` exact/prefix） |
| client bundle 格式与纯净度门禁 | `packages/client/tsdown.client.ts:170-274,215-225` |
| 样式规范（CSS Modules + 语义 token） | `deepseek-harness/docs/web-styling.md:15-20` |
