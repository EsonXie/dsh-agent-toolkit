# token-usage 模态框 tab 化改造设计

> 修订 `2026-08-21-token-usage-charts-design.md` 的 §2/§3 交互部分：双视图从"点击格子跳转 + 返回按钮"改为"双 tab 完全独立"。其余（数据口径、端点、主题令牌、打包）不变。

**日期：** 2026-08-21　**状态：** 已批准

## §1 交互模型

- Modal 顶部固定 tab 栏：**活动** / **单日**两个标签。
- 两 tab 完全独立：点击热力图格子**不**跳转 tab（格子纯展示）；单日 tab 的日期只能靠 pager（前一天/后一天）改变。
- 打开时默认 tab：
  - `initialDate === null`（UsageEntry 入口）→ 活动 tab。
  - `initialDate` 非 null（外部直达链接等既有用法）→ 单日 tab，日期 = initialDate。
- 单日 tab 初始日期 = `initialDate ?? today`（today 来自 range/day payload）。
- tab 切换不触发数据重取；两视图 state 各自保留（range 打开时取一次并缓存；daily 按 date 缓存最后一次结果）。

## §2 组件改动

### UsageModal.tsx（修改）

- state 从 `date: string | null`（视图路由语义）改为：
  - `tab: 'activity' | 'day'`（初始按 §1 规则）
  - `date: string`（单日 tab 当前日期；打开时初始化，pager 修改）
- 顶部渲染 tab 栏：两个 `<button role="tab">`，`aria-selected` 标记激活项。
- 删除"返回活动视图"按钮（`.backButton` 及其用法）。
- 单日视图保留 pager、堆叠柱状图、总量行、按模型/按项目、compaction 行，均不变。

### ActivityHeatmap.tsx（修改）

- 格子从 `<button>` 改为 `<div>`：纯展示，保留 `title` tooltip（`YYYY-MM-DD  N tokens · M 次`）。
- props 从 `{ today, days, onSelect }` 改为 `{ today, days }`——删除 `onSelect`。
- 未来格带 `aria-disabled="true"`（测试与可访问性据此识别），样式降透明度保留。

### CSS（修改）

- `UsageModal.module.css`：删除 `.backButton`；新增 `.tabs`（tab 栏容器）、`.tab`、`.tabActive`。
- `ActivityHeatmap.module.css`：删除 cursor/hover/disabled 交互样式。

### 主题令牌（不新增白名单外令牌）

- tab 栏容器背景：`--dsw-alias-bg-skeleton`
- 激活 tab 背景：`--dsw-alias-bg-overlay`
- 激活 tab 文字：`--dsw-alias-label-primary`
- 未激活 tab 文字：`--dsw-alias-label-secondary`；hover 背景 `--dsw-alias-interactive-bg-hover`

## §3 数据流

不变。`/token-usage/api/range?days=91` 打开时取一次；`/token-usage/api/daily?date=<date>` 按 date 取。Node 半端点零改动。

## §4 测试改动

- `activity-heatmap.client.spec.tsx`：格子查询从 `getAllByRole('button')` 改为 container 查询（格子 div）；删除"点击格子回调"测试；保留 91 格总数、月份标签测试；未来格断言改为统计 `[aria-disabled="true"]` 的数量（4 个）。
- `usage-modal.client.spec.tsx`：
  - 保留：加宽类、默认活动视图（`近 13 周活动`）、无按会话、命中率 80%。
  - 删除：`点击热力图格子进入该日单日视图`、`单日视图可返回活动视图`。
  - 新增：`点击"单日" tab 进入单日视图`（出现"按模型"）；`initialDate 非 null 时默认打开单日 tab`；tab 来回切换视图内容正确。
- `usage-entry.client.spec.tsx`：不变（入口仍默认活动视图）。

## §5 YAGNI 与门禁

- 不做 tab 内容 keep-alive/懒加载优化：两视图 DOM 都小，条件渲染即可。
- 不自绘 Tabs 之外引入新依赖；宿主 ui-primitives 无 Tabs 组件（2026-08-21 核实其 src 无 Tabs），自绘 ~20 行 CSS。
- 纯净度门禁、令牌白名单、`feat(token-usage):` 提交信息风格、bundle 硬规则同前。
