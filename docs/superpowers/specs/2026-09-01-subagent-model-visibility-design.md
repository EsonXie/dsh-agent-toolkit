# 子 Agent 模型/Provider 可见性设计

日期：2026-09-01
状态：已批准（2026-09-01）

## 背景与目标

`team_delegate` 委派的子 Agent 当前在任何界面上都看不到它使用的 LLM provider/model。用户要求：**子 Agent 执行时，能在委派卡和子会话视图两处看到模型与 provider**。

已核实的宿主事实（均对照 `deepseek-harness/` 源码）：

- 子 Agent 路由解析（`subagent/src/child-agent.ts` `resolveChildAgentOptions`）：`role.model` 覆盖 ?? `parent.options.{provider,model}`；再缺则请求期 `agent/request` waterfall 兜底（web 部署下父 Agent options 恒有值，见 `apiproxy/src/api-proxy.ts:1081`）。
- 一次性 descriptor（one-shot）**不**记录模型（`subagent/src/descriptor.ts:60-68`，只有 continuable 记录 `agentProvider/agentModel`）。
- 宿主 `ctx.modelDirectories` 对子会话**显式禁用**（`ui-model-selection/src/client/directory.ts:149-153` `assertAvailable`：addressed subagent 会话抛错），不能作为子会话 chip 数据源。
- 委派卡数据通道 `presentationMeta` 随 tool/result 事件持久化（回放可重建），但仅结束后存在；tool-call 阶段无 meta 通道。

## 语义

**委派时解析的值，全程一致。** 显示值 = team_delegate 执行时解析的路由，与 spawn driver 实际传给子 Agent 的值同源：

```
route = role.model ?? { provider: parent.options.provider, model: parent.options.model }
```

`provider` 或 `model` 任一缺失（角色无覆盖且父 options 不完整）则**整体省略**：不渲染 chip、不写 meta、不写存储。不猜部署默认（`agentDefaultModel` 只是显示层推测，与 waterfall 实际结果可能不一致）。

## Node 半改动

### 1. 路由解析（`delegate/tool.ts`）

`execute` 内按上式解析 `route`。解析成功（两项俱全）时写入三个出口：

1. **在途表**（见下）——`startRun` 前写入
2. **持久路由表**（见下）——`startRun` 返回后（拿到 childSessionId）写入
3. **`presentationMeta`**——新增可选字段 `provider`/`model`（现有 `role`/`runId`/`childSessionId` 不变；旧事件无新字段 → 卡片不渲染 chip，天然兼容）

### 2. 在途表（新文件 `delegate/active.ts`）

进程内 `Map<"{parentSessionId}:{roleId}", { provider, model }>`：

- `execute` 内 `startRun` 前 `set`；`try/finally` 包住 `startRun` + `settleForegroundRun`，finally 中 `delete`（startRun 抛错、settle 成功、settle 出错都删）
- 同角色并发委派：后写覆盖。纯展示场景，可接受
- 插件 HMR/重载中在途条目丢失：运行中的卡片 chip 消失直至 settle（meta 兜底）。可接受

### 3. 持久路由表（`delegate/routes.ts`）

新存储域（不改 `agentToolkitDomain` v1 的布局——domain version 是格式版本，改表结构会 `version-mismatch` 拒绝存量介质，且无迁移）：

```ts
defineDomain({
  name: 'dsh_agent_toolkit_routes',
  version: 1,
  tables: {
    // key = childSessionId
    routes: domainTable<string, { provider: string; model: string; at: number }>(
      z.object({ provider: z.string(), model: z.string(), at: z.number() }),
    ),
  },
})
```

经共享层 `openDomainSafely` 打开。`at` = 写入时间戳（预留清理依据）。行增长不设上限（每行约百字节；列为已知限制，不设自动清理）。

### 4. HTTP 端点（`delegate/api.ts`）

经 `registerOptionalRoutes` 注册 `prefix /dsh-agent-toolkit/api/delegate`（与 agents/providers/bots 同模式，先于 `/api` 兜底前缀命中）：

- `GET /delegate/active?session=<parentSessionId>&role=<roleId>` → 200 `{ provider, model }` | 404（无在途条目）
- `GET /delegate/route?session=<childSessionId>` → 200 `{ provider, model }` | 404（无记录：非 toolkit 委派的子会话、旧版本委派）

webServer 缺席（headless/CLI）时惰性不注册，不抛错。

### 5. 装配（`delegate/index.ts`）

工具、在途表、路由表、端点在同一模块装配；在途表与路由表句柄经闭包注入 `createDelegateTool` 的新增可选 dep（测试注入假实现，与现有 `roster`/`startRun` 注法一致）。

## 浏览器半改动

### 6. 委派卡 chip（`client/delegate/delegate-card.tsx`）

role chip 旁加模型 chip（复用 `css.chip` 样式，文本 `provider / model`）：

- **未 settled**：挂载后轮询 `GET /delegate/active`（间隔约 1.5s，命中/卡片 settled/卸载即停）；404 或 fetch 失败不渲染 chip
- **settled 且非 error**：读 `meta.provider`/`meta.model`；字段缺失（旧事件）不渲染
- **error 结果**：`presentResult` 对 error 返回 undefined，无 meta → 不渲染 chip（在途条目此时已删）

aria-label 文案进 `client/delegate/locales.ts`（NS `agent-team`）。

### 7. 子会话头部 chip（新模块 `client/subagent-model/`）

`ctx.slots.inject('conversation.session.header.utilities', …)` 注册 keyed 组件（`key: 'subagent-model'`，locale NS 复用 `agent-team`）：

- 门控：`useSession(s => s.subagent)` 非空（子会话）才继续，否则渲染 null
- 数据：`useEffect` 按 `sessionId` fetch `GET /delegate/route?session=<id>` 一次；200 渲染 `provider / model` chip，404/失败渲染 null
- 组件只经 props 四件套拿数据；fetch 结果为本组件私有 → local state
- 浏览器半 `inject` 不变（`['sessions', 'slots', 'locale']`，fetch 为自由函数，无需新增服务依赖）

### 8. 客户端 fetch 助手

按 `client/agents/api.ts` 等现有模式新增 `client/delegate/api.ts`（薄封装两个 GET，返回解析后 JSON 或 null）。

## 错误与边界

| 场景 | 行为 |
| --- | --- |
| 角色无 model 覆盖且父 options 不完整 | 全链路省略（无 chip/无 meta/无存储行） |
| `startRun` 抛错（provider 拒绝等） | 在途条目 finally 删除；无存储行（无 childSessionId） |
| 委派出错（stopReason 非 completed） | 在途条目删除；meta 不写（error 无 presentationMeta）→ 卡片无 chip；存储行已写（子会话确曾以该路由运行）→ 子会话 chip 正常 |
| 回放旧事件（meta 无新字段） | 卡片不渲染 chip |
| 非 toolkit 委派的子会话（原生 subagent 工具等） | 头部 chip 404 → 渲染 null |
| 插件 HMR | 在途表清空（运行中卡片 chip 暂缺，settle 后 meta 兜底）；持久表与端点随域重开恢复 |
| webServer 缺席 | 端点不注册；卡片运行中无 chip（meta 路径不受影响） |

## 测试

Node 半（vitest）：

- `tool.test.ts`：`role.model` 覆盖 / 继承父 options / 缺失省略 三分支的 `presentationMeta` 与 `startRun` 请求断言；在途条目写入与 finally 删除（含 settle 抛错路径）
- `routes.test.ts`（新）：域 schema 校验、put/get 往返
- `active.test.ts`（新）：set/delete/同 key 覆盖
- `api.test.ts`（新）：两端点 200/404；webServer 缺席不抛错

浏览器半（jsdom，照现有 client 测试模式）：

- 委派卡：运行中轮询命中渲染 chip / 404 不渲染 / settled 读 meta / 旧事件无字段不渲染
- 头部 chip：非子会话渲染 null；子会话 200 渲染、404 渲染 null

验证回路：`pnpm --filter dsh-agent-toolkit test` + `typecheck` + `bundle`，随后开发回路实机验证（委派卡运行中/结束后、子会话头部、回放）。

## 明确不做

- 不加 Config 开关（固定行为，无可调参数）
- 不碰 `deepseek-harness/` 宿主源码
- 不显示 subagent provider 名（spawn/fork）——本特性只显示 LLM provider/model
- 不做路由表自动清理/容量上限
- 不动模型可见输出（工具 result 对主 Agent 的文本不变；meta 是用户向通道）

## 已知限制

- 路由表行数随委派次数单调增长（行约百字节，暂不清理）
- 同角色并发委派时在途条目后写覆盖，运行中卡片 chip 可能短暂显示另一条同角色委派的路由（同角色路由相同，实际无差异）
