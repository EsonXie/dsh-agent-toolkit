# token-usage 用量刷新命令设计

> 日期：2026-09-01。关联：`2026-09-01-usage-backfill-design.md`（启动回填，策略 A）。本文新增手动刷新能力，修复策略 A 的结构性盲区。

## 背景与问题

启动回填（策略 A）只补 daily 表**整日无记录**的日期。实测（2026-09-01 验收）发现存在"已有记录但不完整"的日期，策略 A 永久跳过它们：

| 日期 | 会话日志实际 | daily 已记录 | 缺口 |
|---|---|---|---|
| 2026-08-18 | 2 calls（27053/916） | 1 call（13872/653） | 同会话内漏记 1 次 |
| 2026-09-01 | 47 calls（102645/17689，22 会话） | 1 call（5436/271） | 漏记 46 次 |

成因：并行 dsh 实例 already-open 停用计量、老进程未加载插件等导致实时采集缺失；回填只补"零记录日"，部分记录日永远残缺。

## 目标

新增 `/token-usage refresh [天数]` 子命令：以会话日志为权威，对最近 N 天（默认 30）逐日**整体重建** daily 记录并替换。重建后范围内日期的统计与会话日志完全一致。

非目标：不改启动回填语义（策略 A 保留，零扫描开销不变）；不改浏览器半；不动 `backfill_done` 标记；不重建范围外日期。

## 核心语义：整日重建，日志为权威

- 范围内每一天：从会话日志重算整日 `DailyRecord`，**直接替换** daily 表对应行（不是增量合并）。这能同时修复"整日缺失"与"部分记录"两类缺口，也只有替换语义能纠正 08-18 那种同会话内漏记。
- 范围内日志无事件的日期：该日 daily 行若存在则**删除**（日志即事实——对应会话已被删除时用量随之消失）；不存在则无操作。
- 已知边界（命令输出与文档注明）：扫描期间在途未落盘的今日调用可能被替换覆盖，再刷一次即可收敛。

## 架构

重构 `packages/usage/src/usage/backfill.ts`，抽出共享聚合核，两个功能共用：

```ts
/** 扫描全部会话日志聚合成按日记录。单会话读失败 warn 跳过并置 readFailed=true；永不 reject。 */
export async function aggregateLogs(
  persistence: BackfillPersistence,
  timezone: string,
  estimate: (message: Message) => number,
  warn: (msg: string) => void,
): Promise<{ byDate: Map<string, DailyRecord>; readFailed: boolean } | undefined>
// undefined = 整体扫描失败（list 抛错）；readFailed = 存在单会话读失败（聚合不完整）
```

- `backfillMissingDays` 改为：`aggregateLogs` → 缺失日 enqueue put（策略 A 不变，readFailed 不影响只补缺失的语义）→ 落地 `backfill_done`。
- 新增 `refreshUsageRange(deps)`：`aggregateLogs` → 过滤出 `今天-N+1 .. 今天` 范围内的日期 → 每日一次 enqueue **put 替换**；范围内有 daily 行但日志无事件的日期 enqueue **delete**——**仅当 `readFailed === false`**（有会话读失败时跳过整个删除 pass，避免把读不出的日期误判为"无事件"整删；重建 pass 保持尽力而为，`failed` 仍为 false）。

```ts
export interface RefreshDeps {
  persistence: BackfillPersistence
  timezone: string
  daily: KvTable<string, DailyRecord>
  enqueue: (job: () => Promise<unknown>) => Promise<unknown>
  warn: (msg: string) => void
  estimate: (message: Message) => number
}
/** 重建最近 days 天。返回逐日对照（date → {before, after} calls）供命令渲染；永不 reject。 */
export async function refreshUsageRange(
  deps: RefreshDeps,
  days: number,
  today: string, // 注入今日日期，便于测试
): Promise<{ changed: { date: string; before: number; after: number }[]; failed: boolean }>
```

`today` 由调用方用 `dayParts(Date.now(), timezone).date` 注入，范围下界 = today 往前推 days-1 天（字符串日期经 Date 推算后格式化为 YYYY-MM-DD）。

## 命令接线（`usage/index.ts`）

既有 `/token-usage` 命令的 rawInput 解析扩展（其余分支不变）：

- `refresh` / `refresh <days>`：进入刷新流程。days 省略默认 30；非法值复用 `parseDaysParam` 的错误文案。
- 刷新前置守卫（顺序即文案优先级）：
  1. 非计量主（`ownsMeter === false`）→ 错误文案：`token 计量由其他实例挂载，无法刷新`。
  2. `ctx.get('sessionPersistence') === undefined` → 错误文案：`sessionPersistence 服务缺失，无法刷新用量`。
- 写全部经与实时采集共享的 `tail` 串行链 enqueue（沿用既有不变式）；`enqueue` 闭包与回填接线块同款。
- 输出文本：只逐日列出**有变化**的日期，一行 `YYYY-MM-DD: before → after calls`（before 为替换前 calls，无记录显示 0；被 delete 的行 after 显示 0），结尾一行汇总 `刷新完成：M 天有变化，K 天无变化`（M+K = 范围内有日志事件或已有记录的去重日期数）。扫描整体失败（`failed`）→ 错误文案 `刷新失败（详见日志），部分日期可能已更新`（逐日 await 写、中途失败时此前日期已写入，故文案不承诺"数据未变"）。
- 命令注册位置不变（openSucceeded 分支）；`ownsMeter` 是模块内既有变量，handler 闭包直接读。

## 约束（沿用回填计划的全局约束）

- `sessionPersistence` 仍为可选服务：只 `ctx.get`，不进 inject / dependencies / peerDependencies。
- 不改 `aggregate.ts` / `store.ts` / 浏览器半 / Config schema / `inject`。
- 尽力而为：任何异常 warn / 错误文案收尾，`refreshUsageRange` 永不 reject。
- 所有 daily 写必须排进 `tail` 串行链。
- 不执行任何 git mutation。

## 测试

`backfill.test.ts` 追加用例：

单元级（`refreshUsageRange`）：
1. 重建替换：已有 1 call 的日期被日志的 2 calls 记录替换（byModel/hours/bySession 一并替换）。
2. 范围过滤：范围外日期的日志事件不写入、范围外已有 daily 行不动。
3. 范围内日志无事件 + daily 有记录 → 该日行被 delete。
4. 单会话 readFrom 失败：warn 跳过，其余照常替换；`failed=false`。
5. list 整体失败：warn，`failed=true`，无任何写。
6. 永不 reject（deps 任意抛错路径）。

组合级（setupUsage 命令端到端）：
7. happy path：命令返回逐日对照文本，daily 表被替换，回填标记不受影响。
8. 缺 sessionPersistence → 对应错误文案，无写。
9. 非计量主（already-open 假 ctx 场景无命令注册——用"他包占用"场景：meter_owner 为他包）→ 拒绝文案，无写。

## 文档同步

`docs/usage/` 手册的 token 用量章节补充 refresh 子命令用法与"整日重建"语义边界。
