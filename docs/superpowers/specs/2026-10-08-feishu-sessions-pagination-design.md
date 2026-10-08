# 飞书 /sessions 分页设计

日期：2026-10-08
状态：设计已确认（待写实施计划）

## 背景

`/sessions` 目前将项目下全部可切换会话一次性列出（`packages/toolkit/src/channels/inbound.ts` `listSessions`），会话多时消息过长。需求：增加分页能力。

## 设计

### 指令解析（`src/channels/directive.ts`）

`/sessions` 从「精确指令」改为「首词指令」（与 `/switch`/`/ls` 同风格）：

- `/sessions`（无参数）→ 第 1 页
- `/sessions <页码>` → 指定页
- 非数字参数（如 `/sessions abc`）→ 用法提示，不再被当普通消息吃掉
- 页码大小写无关；arg 取自 `t`（lower 后串）切片，数字不受大小写影响

### 页大小配置

新增可调参数 `sessionsPageSize`（进 Config schema，仓库约定可调参数不硬编码），接线沿用 `docMaxBytes` 链：

`src/index.ts` Config schema（`z.number().default(10)`）→ `src/bots/index.ts` `BotsModuleConfig` → `src/channels/runtime.ts` deps → `src/channels/inbound.ts` `InboundDeps`

默认值 10 条/页。

### 分页行为（`listSessions`）

- 目录条目仍一次 `catalog.list()` 取全量（内存切片分页，无游标存储）
- **全局编号**：第 N 页条目编号从 `(N-1)*pageSize + 1` 起
- 页脚提示：`共 X 个会话，第 P/Q 页（/sessions <页码> 翻页）`（仅一页时省略页脚）
- 页码越界：提示「只有 Q 页」，不输出列表
- 空列表 / catalog 缺席：降级文案不变

### `/switch` 兼容

`lastLists` 缓存保持**全量** id 数组（每次 `/sessions` 任意页都刷新为全量），序号语义 = 全表全局编号，翻页与 `/switch <序号>` 天然一致；`/switch <id前缀>` 路径不受影响。

### `/help`

更新一行：`/sessions [页码] 列出本项目可切换的会话（分页）`

### 测试（`src/channels/inbound.test.ts`、`directive.test.ts`）

- `/sessions <页码>` 解析（数字 / 非数字 / 大小写）
- 分页输出：编号连续性、页脚、仅一页时无页脚
- 越界页提示
- `/switch` 跨页按全局序号切换
- config 链路：schema 默认值 10 与传递

## 非目标

- 卡片按钮翻页（纯文本渠道，YAGNI）
- 关键字搜索会话
- 会话排序规则变更（沿用 catalog 现有顺序）
