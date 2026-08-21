# token-usage 图表化改造设计

> 日期：2026-08-21。范围：`packages/token-usage`。目标：引入 Recharts，新增 Codex 式活动热力图，单日柱状图区分缓存/新增 token，整体样式对齐 shadcn 风格。

## 1. 决策摘要（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 图表库 | Recharts（MIT，React 组件式 API，进 dependencies 打进 client bundle） |
| shadcn 的使用方式 | 不引 Tailwind；把 shadcn chart 的样式约定（`--chart-*` CSS 变量、极简轴线、圆角柱、无边框 tooltip）平移为 CSS Modules + CSS 变量，颜色值映射宿主主题变量 |
| 活动图形态 | 模态框内双视图：默认"活动"视图（13 周格子热力图），点击格子切到"单日"视图 |
| 热力图口径 | 每格颜色 = 当日计费总量（input+output+cacheRead+cacheWrite+estimated），5 档刻度 |
| 热力图跨度 | 13 周（91 天），GitHub 式 7 行 × 13 列，最新一天在右下角 |
| 单日柱状图 | Recharts BarChart 堆叠两段：缓存段 = cacheRead；新增段 = input+output+cacheWrite+estimated；总量行加缓存命中率 |
| 热力图数据源 | 方案 A：新增轻量端点 `/token-usage/api/range?days=N`，只返回 `[{date, billed, calls}]` |

## 2. 组件拆分（浏览器半）

```
src/client/
├─ index.ts                  （不动）
├─ UsageEntry.tsx            （不动）
├─ UsageModal.tsx            改为视图容器：视图切换（活动/单日）+ 单日翻页
├─ chart-theme.ts            新增：shadcn 风格主题（CSS 变量、颜色刻度、tooltip 公共配置）
├─ ActivityHeatmap.tsx       新增：13 周格子热力图（自绘 div 网格）
├─ ActivityHeatmap.module.css
├─ DailyBarChart.tsx         新增：Recharts BarChart 封装，替换手搓 CSS 柱状图
└─ chart.module.css          新增：shadcn 风格图表共享样式（--chart-* 变量、tooltip）
```

- `chart-theme.ts` 定义：`--chart-1`（新增/主色）、`--chart-2`（缓存/对比色）等变量，值优先引用宿主主题变量（实现时核对 `dsh-client-ui-primitives`/宿主页面暴露的变量名，无合适变量时用 shadcn 默认中性色回退），保证深浅色主题跟随宿主。
- 纯净度门禁不受影响：recharts 非 `@deepseek-ai/*`；不拷入 shadcn 源码本体，只平移其样式约定（Tailwind 类 → CSS Modules 规则）。

## 3. 数据流

### Node 半

- 新增 `GET /token-usage/api/range?days=N`：
  - `days` 缺省 91，合法范围 1..366，非法 → 400 JSON 错误
  - 以 `today`（config.timezone）为终点向前数 N 天，逐日 `table.get(date)`，无记录记 0
  - 返回 `{ today, days: [{ date, billed, calls }] }`，`billed` 用 `billedOf(record.totals)` 计算
- 注册方式与现有 daily 端点相同：`ctx.inject(['webServer'])` + `ctx.effect` 接线 disposer，HMR 重挂不抛重复路由
- 现有 `/token-usage/api/daily` 不动

### 浏览器半

- `UsageModal` 打开时默认进"活动"视图，fetch range 一次（91 天）
- 点击某格 → 切"单日"视图并定位到该日期，复用现有 `fetchDay`
- 单日视图顶部保留 `←/→` 翻页，加"返回活动"入口
- 模态框标题区或顶部做视图切换（活动 / 单日两个 tab 式按钮）

## 4. 活动热力图（ActivityHeatmap）

- 布局：7 行（周日~周六）× 13 列（周），最新一天在右下角；首列日期从"today-90 天所在周的周日"起补齐
- 颜色：5 档刻度（0 档 = 零用量，muted 底色；1-4 档 = 非零 billed 按当日最大值线性均分），shadcn 式单色渐进：`color-mix(in srgb, var(--chart-1) X%, transparent)`
- 每格原生 `title` tooltip：`YYYY-MM-DD  12.3K · 8 次`；`onClick` 跳单日视图
- 月初列上方显示月份标签（如 "6月"）
- 网格布局与分档逻辑抽成纯函数放 `aggregate.ts`（或新 `heatmap.ts`）：`heatmapGrid(today, days)` 返回 91 格日期矩阵；`levelOf(billed, max)` 返回 0-4 档位

## 5. 单日柱状图（DailyBarChart）

- Recharts `<BarChart>` + `<ResponsiveContainer>` 渲染 `record.hours`
- 每根柱堆叠两段：
  - 下段「新增」= `input + output + cacheWrite + estimated`，色 `--chart-1`
  - 上段「缓存」= `cacheRead`，色 `--chart-2`
- 柱顶圆角；无纵向网格线；X 轴小时刻度保持 0/6/12/18
- 自定义 tooltip 分行：`新增 12.3K` / `缓存 45.6K` / `合计 57.9K · 8 次`
- 极简图例：两个小色块 + 文字（新增 / 缓存）
- 模态框总量行追加缓存命中率：`当日总量 57.9K · 8 次调用（缓存命中率 78%）`，命中率 = cacheRead / (input + cacheRead)，分母为 0 时不显示
- 删除 `UsageModal.tsx` 中手搓 CSS 柱状图及 `.chart/.bar/.barSlot/.hourLabels` 样式

## 6. 依赖与打包

- `pnpm --filter @dsh-agent-toolkit/token-usage add recharts`（进 dependencies）
- tsdown `alwaysBundle` 自动内联 recharts 进 `lib/client.js`；react/react-dom 已在 `CLIENT_EXTERNALS` 保持 external，recharts 的 peer 依赖指向宿主 React
- 体积预估：tree-shake 后约 150-300KB 进 client.js（按 rev 缓存，可接受）
- 改动后必须 `pnpm --filter @dsh-agent-toolkit/token-usage bundle`（AGENTS.md 硬规则）

## 7. 错误处理

- range 端点：`days` 非法 → 400；存储域打开失败 → 与 daily 端点同路径（domainReady rejection 经宿主转 500）
- 前端：range 加载失败显示"加载失败，请重试"；91 天全零仍渲染空热力图（全 0 档格子）
- 单日视图错误处理保持现状

## 8. 测试

- Node 半（vitest）：range 端点参数校验（缺省/边界/非法）、日期循环正确性（跨月/跨年）、空表全零
- 纯函数：`heatmapGrid`（91 格、起止日期、周日对齐）、`levelOf`（0 值、最大值、边界档）、缓存/新增拆分聚合
- 组件（jsdom + @testing-library/react，沿用现有模式）：ActivityHeatmap 渲染格子数与月份标签、点击格子回调日期正确；DailyBarChart 渲染不崩（ResponsiveContainer 在 jsdom 需 mock 尺寸或断言容器存在）
- 全量回归：`pnpm --filter @dsh-agent-toolkit/token-usage test` + `typecheck` 通过

## 9. 明确不做（YAGNI）

- 不做 52 周/一年视图、不做热力图横向滚动
- 单日柱状图不按模型堆叠（只分缓存/新增）
- 按模型/项目细分列表不图表化
- 不引入 Tailwind、不拷 shadcn 源码、不引 Radix 原语（tooltip 用原生 title + Recharts 自带 tooltip）
