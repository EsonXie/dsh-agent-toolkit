# 飞书卡片流式输出健壮性修复设计

日期：2026-09-08
状态：已实施（2026-09-08）

## 背景与问题

飞书渠道流式卡片在生产使用中出现两类问题。根因已排查闭环（含模拟测试实证与飞书官方文档核实）：

**问题 1：消息输出不完整——正文段有时只输出少部分内容，就跳到下一个思考/工具面板。**

出站管道本身不丢内容（模拟验证：Outbound 段构建 append-only，planSync 在逐帧/节流合并/跨卡拆分下渲染结果与模型输出逐字节相等）。内容丢在卡片 API 执行环节，一个结构缺陷 + 三个触发器：

- **结构缺陷（放大器）**：`reply.ts` 的 `flush()` 乐观提交 `state`（L82-85），`enqueue()` 的 catch 只在建卡失败（`PENDING_CARD_ID`）时回卷状态（L93-102）。卡片已存在后任何 op 失败 = 仅记日志、状态不回滚、批次内剩余 ops 丢弃；已封闭段（`closedSegCount` 之前）永不再同步 → 永久缺段。失败日志走 `ctx.logger.warn`，dsh web 不展示插件 warn（已知问题）→ 用户无感。
- **触发器 A（流式 10 分钟超时）**：流式模式在最后一次激活 10 分钟后自动关闭，之后 update/insert 报 `200850`/`200510`（飞书文档；处置建议为调 settings 重设 `streaming_mode:true`，本代码从未做重激活）。超 10 分钟的 turn、或单次超 10 分钟的工具调用（期间零卡片操作）后，正文恢复时第一个 update 即失败被吞 → 缺段恰好落在「长工具调用 → 正文输出」边界。
- **触发器 B（30KB 真实 DSL 硬上限）**：飞书限制卡片 DSL ≤ 30KB（错误码 `200860`）。`cardBytes` 只记「内容字节 + 64」，未计面板结构 190B/个、正文元素 52B/个、基础 JSON 286B（均已实测）与 JSON 转义膨胀（换行/引号每个 +1B）。20 面板场景内容记到 ~26KB 时真实 DSL 已破 30KB → 超限 op 失败被吞 → 当前尾段永久定格在旧值，直到 `cardBytes` 触 28000 拆卡才恢复。
- **触发器 C（reply 句柄中途被替换）**：`inbound.ts` L64 的 `router.ensure()` 在 in-flight 检查（L65）之前执行，`router.ts` L39 无条件 `existing.reply = reply`——处理中再发普通消息，运行中 turn 的后续 update/finalize 切到新消息的新句柄，旧卡冻结；`/new` 的 `reset()`（router.ts L97-105）先删 sessions 映射再取消旧 agent，旧 turn 的 `turn/end` 到达 Outbound 时 `sessions.get()` 落空被丢弃（outbound.ts L77-78）→ 旧卡永不 finalize。

**问题 2：拆卡后旧卡状态行永远停留在「⏳ 输出中…」。**

`cards.ts` 的 `closeCard()`（L145-150）只推 `settings streaming:false`，从不更新状态行元素、不设 summary；状态行定格只在 `planFinalize()`（L252-259）里做且只作用于当前卡。模拟实证：拆 4 张卡时前 3 张状态行全部残留「输出中」，会话列表预览残留「生成中…」。

**附带视觉因素（非内容丢失）**：`print_step:1 / print_frequency_ms:70` ≈ 14 字/秒打字机；`fast` 策略只在该元素下一次 update 时冲刷未渲染存量，正文段封闭后存量缓慢爬完，视觉上像「只出了一小段就跳走」。

## 目标与保证级别

修复后达到：

| 场景 | 行为 |
|---|---|
| 拆卡 | 旧卡状态行定格 + summary 更新，零残留「输出中」 |
| op 瞬时失败（限率/网络/响应丢失） | 从最后确认点重放幂等 op，内容零丢失、零重复 |
| 内容接近 30KB | 真实 DSL 记账提前拆卡；误判时 `200860` 兜底拆卡续写 |
| 超长 turn / 长工具调用 | 流式超时报错 → 自动重激活 → 续传 |
| 处理中发消息 / `/new` | 旧卡正常 finalize 定格，输出不串卡 |

平台行为不可消除项：打字机渲染速度（只能调参缓解，不造成真实丢失）。

## 核心依据：飞书卡片 op 的幂等性（修复地基）

- `update`（元素 content）是**全量替换**（文档：传全量文本，平台自算增量）→ 重复执行无害；
- `insert` 重复 → 服务端报 `300301 Duplicate element_id` → 可精确识别为「已成功」；
- `settings` 天然幂等；
- `200850`/`200510` 有文档化恢复路径（settings 重设 `streaming_mode:true`）。

因此出站链路可改为「确认式状态机」：任何失败都变成「从重放点重放一次」，而不是「永久丢一段」。

## 第 1 节：拆卡定格（问题 2 直接修复）

`cards.ts` `closeCard()` 在推 `settings` 之前先推一条状态行 update：

- 新增文案常量 `STATUS_CONTINUED = '📦 内容较长，已接续到下一张卡片'`；
- closeCard ops 变为：`update(status, STATUS_CONTINUED, seq+1)` → `settings(streaming:false, seq+2, summary: STATUS_CONTINUED)`；
- 顺序约束与 `planFinalize` 一致：状态行更新在流式还开着时发出（组件 content API 需流式模式）。

`planFinalize` 不变（末卡定格文案不变）。

## 第 2 节：确认式出站状态机（结构缺陷修复）

**planSync 保持纯函数，但返回值改为携带逐 op 状态增量**：

```ts
export interface PlannedOp { op: CardOp; commit: (s: StreamState) => StreamState }
planSync(...): { ops: PlannedOp[] }   // 不再返回整体新 state
```

实现上 planSync 内部状态演进不变，每推一个 op 后快照当前局部状态生成闭包（`commit` 将 `seq/cardBytes/cardElements/segCounter/closedSegCount/tail/carry/cardId` 整体替换为快照值）。

**reply.ts 执行模型改为逐 op 确认**：

- `flush()`：`const { ops } = planSync(this.state, ...)`；**不提交 state**；`enqueue(() => this.exec(ops))`；
- `exec` 逐 op：先执行 API 调用，**成功后才 `this.state = planned.commit(this.state)`**；
- 与现状的等价性：ops 在 `this.tail` 串行执行，下一次 `flush` 的 planSync 从最后确认状态规划——在飞 exec 期间新 flush 规划出的 ops 会基于旧 state 重复规划在飞 ops。**因此增加在飞守卫**：`exec` 进行中 `flush` 只记录 `dirty` 标记不规划；exec 结束（无论成败）若 `dirty` 则立即补一次规划。规划-执行以 op 粒度交替推进，杜绝重复规划。

**失败分类处理**（`exec` 内按错误码分支，错误码从 lark SDK 抛出的 axios error `response.data.code` 提取，封装为 `feishuErrorCode(error): number | undefined`）：

1. **`300301`（insert 元素重复）**：视为成功，正常 commit（覆盖「响应丢失但服务端已执行」）。
2. **`200850`/`200510`（流式超时关闭）**：先 `setCardStreaming(cardId, true, nextSeq)` 重激活（占一个 sequence），再重放当前 op 一次；重激活本身失败则按未知失败处理。重激活后 10 分钟钟重置（文档语义）。
3. **`200860`（卡片超 30KB）**：确定性错误，不重试。废弃当前卡：尽力 `settings streaming:false`（失败忽略），state 置 `cardId=null`、尾段回卷为 `carry`（`base` = 该段最后确认位置）、`closedSegCount` 不变（已封闭段已显示在旧卡上）→ 下一次规划自动开新卡、从确认点续写。内容零丢失。
4. **未知/网络错误（可能已执行）**：sequence 递增 1 重放当前 op 一次（update 全量替换幂等；insert 命中 `300301` 走分支 1；settings 幂等）。重放仍失败 → 按分支 3 废弃当前卡续写（最坏情况：该 op 实际已执行成功，尾段在新卡从确认点重插，旧卡已显示的增量与新卡开头少量重复——可接受，优于丢失）。
5. **建卡链路失败**：保留现有 `PENDING_CARD_ID` 回卷逻辑（reply.ts L93-102），语义不变。

`withRetry` 对卡片 op 不再统一退避重试——确定性错误重试无益（200860 重试 3 次白等 900ms 的现状一并消除）；仅网络级错误（无 `response.data.code`）保留一次重放（即分支 4）。`createCard`/`sendCardMessage`/`sendText`/表情回复维持现有 `withRetry`。

## 第 3 节：真实 DSL 字节记账（触发器 B）

`cardBytes` 语义从「内容字节 + 64」改为**真实卡片 DSL 字节**：

- 新卡基础开销 = `Buffer.byteLength(buildCardJson(), 'utf8')`（实测 286B）；
- insert：记 `Buffer.byteLength(elementJson, 'utf8')`（elementJson 已是最终 JSON 串，含结构与转义，精确）；
- update：记 `escapedLen(newContent) - escapedLen(oldContent)`，其中 `escapedLen(s) = Buffer.byteLength(JSON.stringify(s), 'utf8') - 2`（去首尾引号）；
- 面板按 2 计组件数的逻辑不变（`CARD_ELEMENT_LIMIT=190` 与飞书硬上限 200 的关系已核实）。

**text 段切分改为按转义后字节**：新增 `sliceByEscapedBytes(text, maxEscapedBytes)`（二分 + 代理对保护，与 `sliceByBytes` 同构），`sliceByBytes` 保留给 process 窗口（processMaxBytes 语义不变，仍按原始字节截尾，因过程区是整窗重放）。

**Config 兼容**：`feishu.cardMaxBytes` 键名不变，语义文档化为「单卡真实 DSL 字节上限」，默认值从 28_000 降到 **26_000**（对 30KB 无论按 30000 还是 30720 解释、无论转义是否计入都留 ≥3KB 余量）。`200860` 兜底分支（第 2 节分支 3）保证即使记账与平台口径有出入也不丢内容——双层保险。

## 第 4 节：reply 句柄时序（触发器 C）

1. **忙时不替换 reply**：`router.ensure()` 的存量会话分支（router.ts L37-41）不再执行 `existing.reply = reply`；改为 `Inbound.handle`（inbound.ts L64-68）在 in-flight 准入通过**之后**赋值 `rt.reply = msg.reply`。resume 路径（不在 sessions map = 不可能有活动 turn）与新建路径仍在 `adopt` 时落 reply，语义不变。
2. **`/new` 等旧卡定格**：`router.reset()` 不再同步 `sessions.delete(bound)`；改为：记录旧 rt → `agent.cancel()` → fire-and-forget 等 `agent.whenIdle()` + `rt.tail` 落定后从 sessions map 删除（期间旧 turn 的 `turn/end` 正常到达 Outbound，旧卡在**旧 reply 句柄**上 finalize）。binding 立即重指、新会话立即创建（sessions map 按 sessionId 索引，新旧不冲突）。插件卸载 `stopAll` 遍历 sessions 的现有逻辑自然覆盖未落定的 dying 会话。

## 第 5 节：可观测与打字机缓解

- **可观测**：第 2 节各失败分支的重放/重激活成功 = 静默（正常抖动不打扰用户）；走到「废弃当前卡」或「彻底失败」时，除 `log` 外向该 chat `notice` 一条简短提示（「卡片输出异常，已在新卡片继续，如内容缺失请重发」）——绕过 dsh web 不展示插件 warn 的已知坑。
- **打字机**：`streaming_config.print_step.default` 从 1 提到 **5**（≈70 字/秒），并进 Config schema：`feishu.cardPrintStep: number`，默认 5（可调参数进 Config 的既有约定）。`print_frequency_ms:70` 与 `print_strategy:'fast'` 不变。

## 第 6 节：影响面与测试计划

**改动文件**：`channels/feishu/cards.ts`（closeCard 定格、PlannedOp/commit、DSL 记账、sliceByEscapedBytes）、`channels/feishu/reply.ts`（确认式 exec、失败分类、在飞守卫）、`channels/feishu/api.ts`（无接口变化；`feishuErrorCode` 助手可放这里）、`channels/router.ts` + `channels/inbound.ts`（reply 时序）、`index.ts`（Config 增 `cardPrintStep`，`cardMaxBytes` 默认改 26_000）。

**测试**（vitest，fake FeishuApi）：

1. cards 纯函数：closeCard 定格 op 序列（update 在 settings 前）；DSL 记账拆卡点（面板结构 + 转义计入）；`sliceByEscapedBytes` 边界（多字节/代理对/精确贴线）。
2. reply 确认式状态机：每 op 成功后 state 才推进（中途断言）；在飞期间 update 只标 dirty、exec 结束补规划（无重复 insert）；
3. 失败注入矩阵：`300301`→视为成功；`200850`→重激活+重放成功、内容完整；`200860`→拆卡续写、全量内容跨卡完整；未知失败→seq+1 重放；持续未知失败→废弃换新卡且 notice；
4. 端到端内容完整性守护：模拟 40 轮思考+正文+工具调用事件流（含拆卡 + 随机注入上述失败），断言所有卡渲染拼接 == 模型全量输出；
5. router/inbound：忙时入站不替换 reply（旧卡继续收尾）；`/new` 后旧卡收到 finalize（`cancelled` 定格）；
6. 回归：现有 `feishu-reply.test.ts`/`feishu-cards.test.ts` 按新接口适配，行为断言全部保留。

**验收**：单测全绿 + 类型检查 + bundle；真实环境（安装版 dsh + link 插件）跑一轮：长回复拆卡 → 旧卡定格；处理中发消息 → 不串卡。

**文档**：本 spec 进 `docs/superpowers/specs/`；AGENTS.md 的飞书入站/出站要点段更新（确认式状态机、DSL 记账语义、cardMaxBytes 新默认）；`docs/usage/` 手册的卡片行为说明同步。

## 第 7 节：明确不做

- 不消除打字机渲染滞后（平台行为），仅调参缓解；
- 审批卡片链路（approval/）不动；
- 不引入保活心跳（流式超时按需重激活已覆盖，保活徒增空流量）；
- 失败重放不设无限重试（彻底失败走废弃换新卡 + notice，内容连续性优先于单卡完整）。
