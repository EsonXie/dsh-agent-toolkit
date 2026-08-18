# token-usage 侧边栏入口迁移与样式规范化设计

日期：2026-08-18
状态：已确认（入口位置、折叠态呈现、图表方案、自动弹窗取舍均已与用户确认）

## 背景与目标

token-usage 插件目前的入口是对话会话头（`conversation.session.header.actions`）里的 📊 按钮，点击打开用量模态框。本次改造：

1. 入口迁移到侧边栏左下角底栏（`sidebar.footer.action` list 槽，位于设置按钮上方）。
2. 浏览器半样式全面符合 dsh `docs/web-styling.md` 规范（语义 token、排版、焦点/动效行为）。
3. 条形图维持现有"纯 CSS 柱条"方案，仅精修样式（方案 A，已与 SVG / 图表库路线对比后确认）。

非目标：不改 Node 半的采集/聚合/持久化逻辑；不改 `/token-usage` 命令的文字输出；不为图表引入任何依赖。

## 入口迁移

### Slot 注册

`sidebar.footer.action` 是 ui-sidebar 声明的 list 槽（`scope: 'root'`，owner props 仅 `{ wide: boolean }`），当前无内置占用者。注册采用声明顺序无关的 `slots.inject`：

```ts
ctx.slots.inject('sidebar.footer.action', () =>
  ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'token-usage', order: 0 },
    UsageEntry,
  ))
```

渲染位置：侧边栏底栏、设置按钮上方（`SidebarRoot.tsx` 的 `footerActions` 区）。

### UsageEntry 组件（新，替代 UsageButton）

- props：仅 owner share `{ wide: boolean }` + 本地 state（`open`）。无 store、无 inject face。
- 宽栏（wide=true）：图标 + "Token 用量"文字的行按钮，视觉仿 `SettingsRoot` 触发行（`clsx(css.trigger, !wide && css.rail)` 模式）。
- 窄栏（56px rail）：纯图标按钮，悬停出 `Tooltip`（`delayMs: 500`，与内置 `New Session` 按钮一致；宽栏下 Tooltip 禁用，因按钮自带文字）。
- 图标：复用 ui-primitives 的 `IconDataOutline16`（数据语义，不新增 SVG 资产）。
- 点击打开现有 `UsageModal`（`initialDate: null`，即今天）。

### 移除项

- 删除 `conversation.session.header.actions` 注册及 `UsageButton.tsx`。
- 删除 `/token-usage` 命令执行后自动弹窗的行为（原靠会话头按钮监听 session 节点实现；root 作用域拿不到 `useSession`，且命令本身已向对话输出今日+近7日文字报告，已与用户确认去掉）。
- `package.json` 的 `dsh.client.inject` 由 `@deepseek-ai/dsh-client-ui-conversation` 改为 `@deepseek-ai/dsh-client-ui-sidebar`；devDependencies 同步替换（类型来源）。

### 包结构变化

```
src/client/
  index.ts               # 注册 sidebar.footer.action（原注册会话头）
  UsageEntry.tsx         # 新：底栏入口按钮（宽/窄两态）+ 持有 Modal
  UsageEntry.module.css  # 新：入口按钮样式
  UsageModal.tsx         # 不变（仅样式精修）
  UsageModal.module.css  # 精修
```

Node 半（`src/index.ts`、`aggregate.ts`、`store.ts`、`render.ts`）不动；`cordis.yml` 不动。

## 样式规范化（web-styling.md 合规）

### UsageModal.module.css 精修

| 现状 | 改为 |
|---|---|
| `opacity: 0.6/0.7` 模拟次要文字 | `--dsw-alias-label-secondary` / `--dsw-alias-label-tertiary` |
| 裸 `font-size: 11px/12px` 无行高 | 字号配对行高；有匹配角色时用主题排版变量 |
| 柱色 `--dsw-alias-state-business-primary`（已合规） | 保留 |
| pager 的 `<button>` 无样式 | 用 ui-primitives `Button` 或 token 化 hover（`--dsw-alias-interactive-bg-hover`） |
| 柱条仅 `title` 提示 | 增加 hover 高亮（`--dsw-alias-interactive-bg-hover` 或柱色加深经 token 表达）；保键盘焦点可见 |

其余规则核验：不写字面颜色、不引入主题选择器（明暗由 ui-theme 负责）、表现全在 CSS（柱条高度的 inline `style` 属"组件局部自定义属性值"范畴，合规）、中文文案/英文注释保持不变。

### UsageEntry.module.css 新增

- 触发行：宽栏整行 hover `--dsw-alias-interactive-bg-hover`，文字 `--dsw-alias-label-primary`；窄栏 56px 居中图标。
- 焦点环保留（不覆盖 outline）；过渡动效尊重 reduced-motion（不动画或跟随主题变量）。

## 条形图方案（已定：方案 A）

维持现有 flexbox + 高度百分比 `<div>` 柱条（24 根，小时粒度），零依赖、符合"禁组件库"纪律。精修仅限上表样式项，不改数据结构与交互。SVG / recharts 路线已评估并放弃（24 柱规模无收益；图表库违反样式纪律且膨胀 bundle）。

## 数据流与错误处理

不变：Modal 打开时 fetch `/token-usage/api/daily[?date=]`，loading/error/ok 三态，日期翻页受 `today` 约束。入口组件无数据获取。

## 测试

- 现有 `tests/render.test.ts`（render.ts 文字输出）不受影响。
- `tests/` 中涉及 UsageButton 的用例改为覆盖 `UsageEntry`：直接喂 props（`wide` true/false）断言宽/窄两态渲染与点击开 Modal 行为；组件测试不经过渲染机制（照 dsh 组件测试惯例）。
- 验证命令：`pnpm --filter token-usage test`、`pnpm --filter token-usage typecheck`、`pnpm --filter token-usage bundle`。

## 验收标准

1. 侧边栏底栏出现"Token 用量"入口，宽/窄栏均可用，窄栏有 Tooltip。
2. 会话头不再显示 📊 按钮。
3. `/token-usage` 命令仍在对话中输出文字报告，不再自动弹窗。
4. Modal 视觉：无字面颜色、无裸 opacity 灰阶文字、柱图颜色随明暗主题正确切换。
5. test / typecheck / bundle 全绿。
