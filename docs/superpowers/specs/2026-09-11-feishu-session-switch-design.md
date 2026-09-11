# 飞书会话切换指令设计（/sessions · /switch · /help）

日期：2026-09-11
状态：已与需求方逐节确认

## 背景与问题

飞书 bot 目前只有一个运维指令面：`/new`（丢弃旧会话重建）、`/stop`（取消当前任务）、`/status`（汇报状态）。绑定模型是一个 chat 固定绑一个会话（`bindings` 表 `(botId, chatId) → sessionId`），`/new` 之后旧会话从绑定上摘除，飞书侧再也回不去——尽管旧会话本体仍在宿主里（持久化 + 挂在 bot 项目 workspace 下）。

需求：一个 chat 内多个会话来回切换，候选范围为**该 bot 项目 workspace 下的全部宿主会话**（含 web UI 创建的会话）。

同期讨论的「以文件预览方式输出会话产生的结果文件」需求，需求方决定在另一对话中另行讨论，本 spec 不涉及。

## 决策记录（需求方已拍板）

1. 场景：一个 chat 多个会话来回切；旧会话保留不销毁。
2. 候选范围：项目 workspace 下所有会话都可切（含 web UI 建的）。
3. 交互形式：纯文本指令（`/sessions` 列表 + `/switch <arg>`），不引入交互卡片。
4. 切走时旧会话有进行中任务：**不取消**，其卡片在本 chat 照常收尾，两会话任务可并行。
5. `/help`：需要，列出全部指令。

## 第 1 节：指令面

`parseDirective`（`packages/toolkit/src/channels/directive.ts`）扩展：

- 命中规则分两类：
  - 精确指令（现状不变）：`/new` `/stop` `/status` 仍要求整条消息 trim + lowercase 后精确匹配，带参数/前后文一律按普通消息处理（防误触）。
  - 带参指令（新增）：`/switch <arg>` 取首词判定，`arg` 为首词后 trim 的余串；`/switch` 无参数 → 提示用法。
  - `/sessions` `/help` 为无参指令，同样要求整条精确匹配。
- 返回值从 `Directive | null` 改为 `{ name: Directive; arg?: string } | null`（或等价判别联合），`Directive` 扩为 `'new' | 'stop' | 'status' | 'sessions' | 'switch' | 'help'`。
- 群消息 `@` 占位符剥离（`stripMentionPlaceholders`）在指令解析前执行，现状不变。

`/help` 输出全部指令及一句话说明（含 `/new` `/stop` `/status` `/sessions` `/switch`）。

## 第 2 节：候选列表（/sessions）

候选来源：复用 `bots/index.ts` 已有的宿主 `workspaceRegistry` 可选服务（现为 `WorkspacePort.attach` 使用）：

1. `workspaceRegistry.create(bot.project)` → `workspace.sessionIds`（`deepseek-harness/packages/workspace/workspace/src/types.ts` L59）：header 校验过的有序候选（新 attach 在最前），天然按项目过滤、含 web UI 会话。
2. 标题：逐项 `ctx.get('sessions')?.get(id)` 取 live Session → `ctx.get('sessionTitle')?.get(session)`（`session-title/src/index.ts` L385）；会话未加载或无标题 → 显示 `(无标题)`。**不为了列标题去 resume 未加载会话**。
3. 当前绑定项打 `✓`（bindings 表读当前绑定比对）。

输出形如：

```
会话列表（/switch <序号|id前缀> 切换）：
1. ✓ 修复登录闪退（a1b2c3d4）
2. (无标题)（e5f6a7b8）
```

id 前缀取 sessionId 前 8 位。空列表时提示「当前项目下还没有可切换的会话（发消息即创建）」。

新增端口（`channels/ports.ts`）：`SessionCatalogPort { list(project: string): Promise<readonly { sessionId: string; title?: string }[]> }`，真实适配器在 `bots/index.ts` 装配（组合 workspaceRegistry / sessions / sessionTitle 三个可选服务），缺席时返回 `undefined` 触发降级文案。

## 3. 切换语义（/switch）

`Router` 新增 `switchTo(bot, chatId, targetSessionId, reply, userId)`：

1. 目标 = 当前绑定 → 提示「已是当前会话」，无副作用。
2. 目标不在候选清单 → 报错文案，binding 不变。
3. 目标已在内存 `sessions` map 且非 retiring → 直接 `bindings.put` 覆盖绑定 + 刷新 reply（复用现有 adopt 语义）。
4. 否则 `agents.resume`（走现有 `resolveSession` 装配：bot persona/tools/sender 段照常注入）+ `attach`（宿主侧幂等）+ `adopt`，然后 `bindings.put` 覆盖绑定。

参数解析：`/switch <序号|id前缀>`——序号指**最近一次 `/sessions` 输出的序号**（per-chat 内存缓存，进程重启即失效；缓存缺失或序号越界 → 提示重发 `/sessions`）；非数字参数按 sessionId 前缀匹配候选清单（唯一命中才切，多命中/零命中报错）。

**接管语义**：切到 web UI 创建的会话时，`resume` 的 setup 会把该会话的装配换成本 bot 的 persona/tools/sender 段——这是显式的「bot 接管该会话」语义，web UI 侧仍能看到同一会话的事件流（同一会话两个表面）。

**切走的旧 runtime 不 retire**（决策 4）：其 in-flight turn 的卡片在本 chat 照常收尾。生命周期收口：

- 旧 runtime 仍留在 `sessions` map（出站事件继续路由到本 chat）；
- 新增「未绑定即 idle 后摘除」清理：runtime 失去绑定后，当前 turn 落定（本就空闲则立即）即从 `sessions` map 摘除，避免只进不出；摘除后该会话再被消息触达时走 resume 重建。

## 4. 降级与错误处理

- `workspaceRegistry` 缺席（headless 等）：`/sessions`、`/switch` 回复「会话切换在当前环境不可用」；其余指令不受影响。
- `sessions`/`sessionTitle` 服务缺席：标题列降级为 `(无标题)`，列表与切换照常。
- `resume` 失败（会话数据损坏等）：走 inbound 统一错误路径（错误摘要回传渠道 + `onError` 日志），binding 不变。
- `/new` 语义不变（retire 旧会话 + 删绑定 + 建新）；被 `/new` 换下的旧会话仍在 workspace 候选中，可经 `/switch` 切回。

## 5. 测试

- `directive.test.ts`：`/switch 2`、`/switch a1b2c3d4`、`/switch` 无参（命中带空 arg）、`/new x` 不命中、`/sessions` `/help` 精确命中。
- `router.test.ts`：`switchTo` 四分支（已是当前 / 目标非法 / 内存复用 / resume 接管）、binding 覆盖不 delete、旧 runtime 不 cancel、未绑定 idle 后摘除。
- `inbound.test.ts`：`/sessions` 列表渲染（✓ 标记、`(无标题)` 降级、空列表、catalog 缺席降级文案）、`/switch` 序号缓存路径与 id 前缀路径、`/help` 输出全指令。
- 守护：现有 `/new` `/stop` `/status` 测试不因 `parseDirective` 返回值形态变化而改语义。

## 6. 配置

本特性无可调参数，不加 Config 字段（指令行为固定；候选源/降级由可选服务缺席自然驱动）。

## 7. 实施修正记录（2026-09-11，实施后合入）

以下两条修复提交改变了上文 §3/§4 的部分语义（现行事实以 `docs/domains/feishu.md` 为准，原文决策记录保留不动）：

**fix `8aa42d1250`（switchTo binding 覆盖失败清理孤儿 runtime + 跨 chat 切换限制注明）：**

- §3 补充失败分支：`bindings.set` 覆盖失败时，摘除本次 adopt 的 runtime 不留孤儿（复用路径的 runtime 先于本次调用存在，不动）；异常照常上抛，binding 不变。
- 新增已知限制（§3 未涉及）：`/switch` 目标会话若正绑定在其他 chat（其 runtime 仍在内存），当前实现直接复用该 runtime——审批卡与在飞卡片仍发往原 chat，且原 chat 的 `/new` 会取消该会话任务；请避免跨 chat 切换同一会话。

**fix `99be3825c4`（摘除会话 dispose 释放宿主写句柄 + live 会话接管复用，/switch already owned 修复）：**

- §3 第 3–4 条由两分支扩为三分支：目标在插件内存 → 直接复用（不变）；**在宿主内存存活（web 界面等持有写句柄）→ 接管复用（`AgentsPort.get`，保持其当前装配，setup 不重跑）**；冷会话才 `resume`（套用 bot 装配，原第 4 条语义）。「接管语义」段中"resume 的 setup 会把该会话的装配换成本 bot 的"仅对冷会话成立。`ensure`（绑定命中但 runtime 不在内存）同样改为 live 接管优先。
- §3 生命周期收口补充：摘除 runtime 的三条路径（retire / releaseUnbound / 覆盖失败清理）**一律 `dispose` 宿主 AgentHandle 释放写句柄**（`AgentPort` 新增 `dispose()`），否则自有会话在宿主侧永远 already owned 无法再 resume；接管来的 live 会话 dispose 为空操作（句柄归原主）。
- §4 错误处理补充：live 检查与 resume 之间的竞态（恰好被他人打开）抛 `SessionAlreadyOwnedError`，Inbound 兜底回复「该会话正被占用（可能在 web 界面打开中），请关闭后重试」，绑定不变（区别于通用「处理失败」文案）。
