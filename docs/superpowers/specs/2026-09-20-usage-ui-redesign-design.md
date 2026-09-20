# Token 用量 UI 重设计（入口迁移 + 热力图美化 + 范围查询）设计 spec

日期：2026-09-20
状态：已批准（头脑风暴确认）
范围：`packages/usage`（浏览器半 + Node 半各一处小改），toolkit 浏览器半经内联 client-module 自动跟随

## 背景与目标

现行状态（`packages/usage/src/client/usage/`）：

- 入口：侧栏底栏 `sidebar.footer.action` 图标按钮（`entry.tsx`，`createSidebarEntry` 工厂），点击打开 `UsageModal`。
- 模态框两 tab：「活动」（13 周 GitHub 风格热力图 `ActivityHeatmap`，原生 `title` tooltip，纯展示）与「单日」（← → 翻页器 + 24 小时新增/缓存堆叠柱状图 `DailyBarChart` + 总量/按模型/按项目/缓存命中率明细）。
- 后端：`/dsh-agent-toolkit/api/usage/daily?date=` 与 `/dsh-agent-toolkit/api/usage/range?days=`（`days` 1..366，响应 `{ today, days: HeatmapDay[] }`，`HeatmapDay = { date, billed, calls }`）。

优化目标：

1. 入口从侧栏底栏迁到会话标题栏右上角。
2. 美化现有热力图，并支持点击某天跳到该日明细。
3. 「单日」tab 升级为范围查询：范围 = 1 天按小时统计，> 1 天按天统计，明细区按范围聚合。

## 设计

### 1. 入口迁移：sidebar.footer.action → conversation.session.header.utilities

- 删除 `entry.tsx` 中对 `createSidebarEntry` 的使用与 `sidebar.footer.action` 注册；`src/client/shared/entry.tsx` 工厂若再无消费方则一并删除（实现时确认 toolkit 是否复用——toolkit 的设置面板收编后其 `createSidebarEntry` 已删除，usage 内的是独立副本）。
- 新增 `conversation.session.header.utilities` 注册：`ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-agent-toolkit:usage', order: 100 }, UsageHeaderEntry))`。
- `UsageHeaderEntry` 组件：图标按钮（沿用 `IconDataOutline16` + `Tooltip`「Token 用量」），点击打开 `UsageModal`。utilities 是 session scope 的 additive list slot，owner props 为空 marker，组件不消费会话状态，无需新增 inject 依赖；浏览器半 `inject` 仍为 `['slots']`。
- 类型可见性：`import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'` 触发 SlotMap 声明合并。
- 双装守卫：现依赖 sidebar 入口 id 冲突抛错（`src/client/index.ts` 的 try/catch）。迁移后由 utilities 注册 id `dsh-agent-toolkit:usage` 冲突触发同一 catch，注释与文案同步更新。

### 2. 热力图美化（活动 tab）

在现有 `ActivityHeatmap` 结构（7 行 × 13 列）上升级，不改 `heatmapGrid` 纯函数：

- 视觉：格子圆角 + 间距微调，悬停描边/放大反馈（纯 CSS）。
- 自定义 tooltip 卡片替换原生 `title`：日期 + 计费总量 + 调用次数，样式复用 `chart.module.css` 的 tooltip 约定。
- 补星期标签（周一/三/五行侧）与「少 → 多」色阶图例。
- 交互：点击非 future 格子 → 切到「查询」tab 并把范围设为该单日（等价单日视图）。

### 3. 「单日」tab 升级为范围查询 tab

模态框保持两 tab：「活动」「查询」（原「单日」改名「查询」）。

- 顶部范围选择器：
  - 预设档位：近 7 天 / 近 30 天 / 近 90 天。
  - 自定义：两个原生 `<input type="date">`（起/止），与预设互斥——点预设清空手动选择态，改任一 input 进入自定义态。宿主 primitives 无现成日期组件，原生 input 避免引新依赖。
  - 校验：起 > 止或跨度 > 366 天时不发请求并显示内联错误。
- 粒度自适应：
  - 范围 = 1 天 → 现有 24 小时新增/缓存堆叠柱状图（`DailyBarChart` 复用，数据来自 range 响应的 `hours`）。
  - 范围 > 1 天 → 按天新增/缓存堆叠柱状图（新组件 `RangeBarChart`，沿用 recharts 配置与 `--chart-1/--chart-2` 配色，X 轴稀疏刻度 MM-DD）。
- 明细区统一聚合：总量/调用次数/缓存命中率 + 按模型/按项目 breakdown + 上下文压缩行，多日时为整个范围的聚合（结构与 `DailyRecord` 同构）。
- 移除 ← → 翻页器；`UsageModalProps.initialDate` 语义改为「打开时定位到该单日」（范围 = 当天），热力图点击复用此路径。
- 前端只调 range 一个端点（单日 = `from=to`）；daily 端点保留不动（兼容）。

### 4. 后端改动（`packages/usage/src/usage/`）

- `heatmap.ts`（纯函数层，两半共用）：
  - `parseRangeParams(search: URLSearchParams)`：支持 `days`（现行）或 `from`+`to`（YYYY-MM-DD，两者互斥；同时出现按 400）。返回 `{ from, to }` 或 null（非法：格式错/起>止/跨度>366）。
  - `HeatmapDay` 补 `fresh`/`cached` 字段（`cacheSplit(rec.totals)`，缺日记 0）。
  - 新增 `aggregateRange(records: DailyRecord[])`：返回 `{ totals, byModel, byProject, compaction }`（与 `DailyRecord` 去掉 `date`/`hours` 同构），单日时 `hours` 另取。
- `index.ts` range 路由：
  - 参数解析换 `parseRangeParams`；响应扩展为 `{ today, from, to, days: HeatmapDay[], aggregate: { totals, byModel, byProject, compaction }, hours?: Bucket[] }`（`hours` 仅 from=to 时携带）。
  - daily 路由不动。

### 5. 错误处理

- 范围非法（起>止/超 366 天/格式错）：前端预校验拦下，内联提示不发请求；后端仍独立校验返回 400。
- 拉取失败：沿用 `useLoadState` error 态「加载失败，请重试」。
- 双装：后到实例 utilities id 冲突 → catch 停用（同现行语义）。

### 6. 测试

- 纯函数（`packages/usage` vitest）：
  - `parseRangeParams`：days/from+to/互斥/格式错/倒置/366 边界。
  - `rangeSummaries` 带 fresh/cached；`aggregateRange` 聚合正确性（多日记账求和、缺日跳过、estimated 计入）。
- 路由（`routes.test.ts`）：from/to 参数、400 分支、响应含 aggregate 与单日 hours。
- 客户端（`*.client.spec.tsx`）：
  - 范围 = 1 天渲染小时图、> 1 天渲染按天图（mock fetch 分流）。
  - 预设与自定义互斥、非法范围不发请求。
  - 热力图点击切 tab 并定位该日。
  - 入口：utilities 注册 + 双装停用。

## 影响面

- `packages/usage/src/usage/heatmap.ts`（纯函数扩展）、`index.ts`（range 路由）、`routes.test.ts`。
- `packages/usage/src/client/usage/`：`entry.tsx`（重写为 utilities 入口）、`UsageModal.tsx`（tab 重构）、`ActivityHeatmap.tsx` + css（美化）、新增 `RangeBarChart.tsx`、新增/更新 client spec。
- `packages/usage/src/client/shared/entry.tsx`（删除，若无其他消费方）。
- `packages/usage/src/client/index.ts`（守卫注释更新）。
- 构建顺序：改完先 `pnpm --filter @dsh-agent-toolkit/token-usage bundle`（client-module 三产物），再跑两包测试/typecheck；toolkit 浏览器半内联自动跟随。

## 非目标

- 不改动 `/token-usage` 命令、启动回填、存储格式。
- 不引入日期选择器第三方库。
- 不动 toolkit 的 Agents/Prompt/Bots/Schedule 设置面板。
