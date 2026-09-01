# token-usage 启动回填设计（一次性补齐缺失日统计）

日期：2026-09-01
状态：已确认（用户批准策略与设计）

## 背景

2026-08-31 一次非正常退出导致 `token_usage` 域 meta 表残留 `meter_owner` 占位键，旧守卫只认键存在、不认主身份，后续所有启动自我锁死、计量恒零（daily 表记录止于 2026-08-25）。同名主接管修复已落地（`usage/index.ts` 守卫按 `existing.value !== owner` 区分他包占用与自身残留），本设计解决其留下的历史缺口：08-26 起整日缺失的统计需要补回。

## 数据源可行性（已核实）

- 宿主 `ctx.sessionPersistence` 服务（`@deepseek-ai/dsh-session-persistence`，Service Definition）后端无关：`list()` 返回全部已持久化会话 header（轻量、不解析日志），`readFrom(id, fromSeq)` 从指定 seq 读事件（为水位续读设计的原语）。jsonl / sqlite 后端均走此层，插件不接触 zstd 帧、不探测会话目录。
- 事件内 `usage`（input/output/cacheRead/cacheWrite）、`time`、`message.source`（provider+model）完整持久化；session header 含 `id`/`cwd`。
- 聚合逻辑 `sampleFromEvent` / `addSample` / `emptyDaily`（`usage/aggregate.ts`）为纯函数，直接复用；无 usage 的消息走已注入的 `ctx.tokenMeter.estimateMessage` 估算路径（与实时采集一致）。

## 合并策略（用户已拍板：策略 A）

**只补整日缺失**：回填只写入 daily 表完全无记录的日期；已有记录的日期原样保留（视为权威）。

- 天然幂等：补过的日期下次扫描自动跳过。
- 零双计：不回放已被实时采集覆盖的日期。
- 文档化局限：半天级缺口（某日已有部分记录、当日后续采集中断）不补。同名主接管修复后该场景已极罕见，不值得为此引入按事件水位机制。

## 架构与数据流

```
setupUsage（仅计量主：ownsMeter 成功后；双装停用方/后到实例不回填）
  └─ meta 表 backfill_done 标记存在？ → 跳过（一次性标记，模式同 roles_yaml_imported）
     └─ 不存在 → 异步触发 backfill（不阻塞插件加载/命令/路由注册）：
        ctx.get('sessionPersistence')   ← 可选服务，按仓库规则走 ctx.get（不进 inject）
          ├─ 缺失 → logger.warn 后跳过，不落地标记（下次启动重试）
          └─ 存在 → list() 全部 header
              → 逐会话 readFrom(id, 0)（单会话失败 warn 跳过，不中断其余）
              → 逐事件 sampleFromEvent(sessionStub, event, timezone, estimate)
                  sessionStub = 仅含 header.id/header.cwd 的最小会话形态
              → 按配置时区归日，emptyDaily + addSample 逐日聚合
              → 对每个聚合出的日期：daily.get(date) 为 undefined 才 put
              → 全部完成后 meta.put('backfill_done', { value: 完成时间 ISO })
```

### 写串行化

回填的所有 daily/meta 写排进 `setupUsage` 现有 `tail` 串行链，与实时采集写不交错（KvTable 不串行化并发读改写，沿用既有不变式）。回填读完日志、准备写 daily 时若目标日期已被实时采集创建（如今日），`daily.get(date)` 非空 → 跳过，天然防双计。

### 时序安全

`readFrom` 只返回已落盘的有效连续前缀（torn 尾帧不到达调用方），与进行中的实时会话写无交叠；回填是只读消费会话日志，绝不写会话介质。

## 改动清单

| 文件 | 改动 |
|---|---|
| `packages/usage/src/usage/backfill.ts` | 新模块 ~100 行：导出一个回填函数，由 `index.ts` 注入 timezone/daily/meta/tail 等依赖；纯增量 |
| `packages/usage/src/usage/index.ts` | 接线 ~20 行：meteringReady 为真后检查标记、触发回填、复用 tail 链 |
| `packages/usage/src/usage/backfill.test.ts` | 新增测试 ~100 行 |

不改 `aggregate.ts` / `store.ts` / 浏览器半 / Config schema / inject（sessionPersistence 为可选服务，ctx.get 惰性）。

## 边界与失败处理

- 整体尽力而为：任何异常 warn 收尾，不产生 unhandled rejection，不崩宿主（沿用本模块既定不变式）。
- 单个会话读取失败：warn 并跳过该会话，继续其余。
- 会话事件中 `session.header.cwd` 缺失时 bySession 不落记录（与实时路径行为一致）。
- compaction/summary 事件由 `sampleFromEvent` 既有分支处理，行为与实时一致。

## 性能

一次性全量扫描：当前 76 个会话秒级完成；标记落地后每次启动只读一次 meta 键，零扫描开销。

## 测试计划（TDD）

`backfill.test.ts` 用 fake sessionPersistence（list/readFrom 返回内存事件）+ Map 假存储表（meter-owner.test.ts 同款套路）：

1. 缺失日期被补齐（事件聚合进 daily，含 byModel/bySession/byProject/hours）
2. 已有记录的日期跳过（不被覆盖）
3. 全部完成后落地 `backfill_done` 标记
4. 标记已存在 → 不调用 sessionPersistence，直接跳过
5. sessionPersistence 缺失 → warn 跳过且不落地标记
6. 无 usage 的 assistant/message 走 estimate 路径（estimatedCalls 计入）
7. 单会话 readFrom 失败 → warn 跳过，其余会话仍补齐，标记仍落地

## 验收

- 两包测试全绿（usage 59+N / toolkit 349）、typecheck 通过
- usage bundle 刷新后 toolkit bundle 刷新（node_modules lib 链）
- 下次 dsh 重启后：08-26 至今日的历史统计出现在面板/命令输出，且与实时采集不双计
