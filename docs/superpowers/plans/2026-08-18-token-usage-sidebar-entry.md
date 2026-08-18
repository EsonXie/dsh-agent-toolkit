# token-usage 侧边栏入口迁移与样式规范化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 token-usage 的入口从会话头迁到侧边栏底栏（`sidebar.footer.action`），移除命令自动弹窗，并把浏览器半样式规范化到 dsh web-styling.md 标准。

**Architecture:** 新组件 `UsageEntry`（owner props `{wide}` + 本地 `open` state）注册进 ui-sidebar 声明的 `sidebar.footer.action` list 槽；宽栏图标+文字行、窄栏图标+Tooltip，点击打开既有 `UsageModal`。图表维持纯 CSS 柱条，仅样式精修。Node 半不动。

**Tech Stack:** React 18 + CSS Modules + clsx + `@deepseek-ai/dsh-client-ui-primitives`（Tooltip/Modal/IconDataOutline16）；vitest + @testing-library/react + jsdom 做组件测试。

**设计 spec：** `docs/superpowers/specs/2026-08-18-token-usage-sidebar-entry-design.md`（已提交 8f2ff86）

## Global Constraints

- 样式只用 `--dsw-alias-*` 语义 token；**禁止字面颜色**、禁止用 `opacity` 模拟次要文字、禁止主题选择器（明暗由 ui-theme 负责）。
- 禁止引入组件库/Tailwind/图表库；CSS Modules + clsx。
- 产品文案中文，代码注释英文（本包既有文件头注释为中文，保持现状即可，新增注释用英文）。
- UI 组合只能走 `ctx.slots.register` / `ctx.slots.inject`；组件只见 props，不见 ctx。
- client bundle 纯净门禁：`@deepseek-ai/*` 值导入仅限 tsdown.config.ts `CLIENT_EXTERNALS` 白名单；`@deepseek-ai/dsh-client-ui-sidebar` 只能 **type-only** 导入。
- 验证命令（工作目录 `packages/token-usage`）：`pnpm test`、`pnpm typecheck`、`pnpm bundle`。
- 所有 git 提交前向用户确认。

---

### Task 1: UsageEntry 组件（TDD：测试先行）

**Files:**
- Create: `packages/token-usage/tests/usage-entry.client.spec.tsx`
- Create: `packages/token-usage/src/client/UsageEntry.tsx`
- Create: `packages/token-usage/src/client/UsageEntry.module.css`
- Modify: `packages/token-usage/package.json`（dependencies 加 `clsx`；devDependencies 加 `@testing-library/react`、`jsdom`、`react-dom`、`@types/react-dom`）

**Interfaces:**
- Consumes: `UsageModal`（既有，`src/client/UsageModal.tsx`，props `{ open: boolean; onClose: () => void; initialDate: string | null }`）；ui-primitives 的 `Tooltip`（`{ label, side?, delayMs?, disabled?, children }`）、`IconDataOutline16`（`{ size?, className? }`）。
- Produces: `UsageEntry({ wide: boolean }): ReactNode`——Task 2 的 `src/client/index.ts` 把它注册进 `sidebar.footer.action`。

- [ ] **Step 1: 补测试依赖**

`package.json` dependencies 加 `"clsx": "^2.0.0"`；devDependencies 加：

```json
"@testing-library/react": "^16.1.0",
"@types/react-dom": "~18.3.0",
"jsdom": "^26.1.0",
"react-dom": "^18.2.0"
```

Run: `pnpm install`（仓库根；link: 依赖已在 workspace，新增的都是 registry 包）
Expected: 成功，lockfile 更新。

- [ ] **Step 2: 写失败的组件测试**

`packages/token-usage/tests/usage-entry.client.spec.tsx`：

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { UsageEntry } from '../src/client/UsageEntry.tsx'

const DAY_PAYLOAD = {
  today: '2026-08-18',
  record: {
    date: '2026-08-18',
    hours: Array.from({ length: 24 }, () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 })),
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 },
    byModel: {}, byProject: {}, bySession: {},
    compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 0 },
  },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(DAY_PAYLOAD), {
    status: 200, headers: { 'content-type': 'application/json' },
  })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('宽栏：图标 + 文字行', () => {
  render(<UsageEntry wide />)
  const button = screen.getByRole('button', { name: 'Token 用量' })
  expect(button.textContent).toContain('Token 用量')
})

test('窄栏：仅图标，无文字', () => {
  render(<UsageEntry wide={false} />)
  const button = screen.getByRole('button', { name: 'Token 用量' })
  expect(button.textContent).not.toContain('Token 用量')
})

test('点击打开用量模态框并拉取当日数据', async () => {
  render(<UsageEntry wide />)
  screen.getByRole('button', { name: 'Token 用量' }).click()
  expect(await screen.findByText('当日总量', { exact: false })).toBeTruthy()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/token-usage/api/daily')
})
```

注：`UsageModal` 的 `DailyRecord`/`Bucket` 形状见 `src/store.ts`；若上述 payload 与 `DailyRecord` 类型不符，以 `store.ts` 实际类型为准调整 payload 字段（测试里走 `as const` 或显式标注均可，但以通过 typecheck 为准）。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter token-usage test`
Expected: FAIL——`../src/client/UsageEntry.tsx` 不存在。

- [ ] **Step 4: 实现 UsageEntry**

`packages/token-usage/src/client/UsageEntry.tsx`：

```tsx
/** Sidebar footer entry: wide icon+label row vs rail icon-only; opens the usage modal. */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconDataOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { UsageModal } from './UsageModal.tsx'
import css from './UsageEntry.module.css'

export interface UsageEntryProps {
  /** Owner share from the sidebar shell: wide content vs 56px rail. */
  wide: boolean
}

export function UsageEntry({ wide }: UsageEntryProps): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* Wide rows carry their own label — tooltip only on the rail (mirrors
          the built-in New Session button's behavior). */}
      <Tooltip label="Token 用量" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-label="Token 用量"
          onClick={() => { setOpen(true) }}
        >
          <IconDataOutline16 size={wide ? 16 : 18} />
          {wide && <span className={css.triggerLabel}>Token 用量</span>}
        </button>
      </Tooltip>
      <UsageModal open={open} onClose={() => { setOpen(false) }} initialDate={null} />
    </>
  )
}
```

`packages/token-usage/src/client/UsageEntry.module.css`（42px 行 / 36px 圆形 rail 节奏照抄 SettingsRoot 触发行，见 `deepseek-harness/packages/client/ui-settings-general/src/client/SettingsRoot.module.css`）：

```css
/* Footer entry row: the 42px foot-row rhythm shared with the Settings trigger. */
.trigger {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% + 4px);
  height: 42px;
  margin: 4px -2px;
  padding: 0 10px 0 8px;
  box-sizing: border-box;
  border: none;
  border-radius: 12px;
  background: transparent;
  cursor: pointer;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
}
.trigger:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
/* Rail: the same 36x36 circle box as the other rail controls. */
.trigger.rail {
  width: 36px;
  height: 36px;
  margin: 8px 0 10px;
  justify-content: center;
  gap: 0;
  padding: 0;
  border-radius: 50%;
}
.triggerLabel {
  overflow: hidden;
  white-space: nowrap;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter token-usage test`
Expected: 3 个新用例 PASS，既有用例不回归。

- [ ] **Step 6: Commit（先向用户确认）**

```bash
git add packages/token-usage
git commit -m "feat(token-usage): UsageEntry 侧边栏底栏入口组件（宽行/窄图标 + Tooltip）"
```

---

### Task 2: 注册切换到 sidebar.footer.action，移除会话头入口

**Files:**
- Modify: `packages/token-usage/src/client/index.ts`
- Delete: `packages/token-usage/src/client/UsageButton.tsx`
- Modify: `packages/token-usage/package.json`（`dsh.client.inject` 与 devDependencies 换包）

**Interfaces:**
- Consumes: Task 1 的 `UsageEntry`。
- Produces: 浏览器半最终注册形态；`sidebar.footer.action` 的 SlotMap 合并来自 `@deepseek-ai/dsh-client-ui-sidebar/client`（type-only）。

- [ ] **Step 1: 改写注册**

`src/client/index.ts` 全量替换为：

```ts
/** token-usage 浏览器半：注册侧边栏底栏入口。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// 触发 ui-sidebar 对 SlotMap 的声明合并（sidebar.footer.action 键）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { UsageEntry } from './UsageEntry.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  // inject() 等 slot 被 ui-sidebar 声明后再注册，声明消失自动回滚。
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'token-usage', order: 0 },
      UsageEntry,
    ))
}
```

- [ ] **Step 2: 删除旧组件**

删除 `src/client/UsageButton.tsx`（含 `/token-usage` 命令自动弹窗逻辑——已与用户确认去掉；命令的文字报告输出在 Node 半，不受影响）。

- [ ] **Step 3: package.json 换依赖**

- `dsh.client.inject` 数组里 `"@deepseek-ai/dsh-client-ui-conversation"` 改为 `"@deepseek-ai/dsh-client-ui-sidebar"`（该字段仅作信息展示/HMR diff，不影响激活顺序，但保持如实）。
- devDependencies：`"@deepseek-ai/dsh-client-ui-conversation": "link:../../deepseek-harness/packages/client/ui-conversation"` 改为 `"@deepseek-ai/dsh-client-ui-sidebar": "link:../../deepseek-harness/packages/client/ui-sidebar"`。

Run: `pnpm install`

- [ ] **Step 4: 全量验证**

Run: `pnpm --filter token-usage test; pnpm --filter token-usage typecheck; pnpm --filter token-usage bundle`
Expected: 全绿。typecheck 关键确认点：`ctx.slots.inject('sidebar.footer.action', …)` 的键能被 SlotMap 识别（若报"键不存在"，检查 ui-sidebar 是否已 build 出 `lib/types/client/index.d.ts`——未 build 则先在 `deepseek-harness/` 跑 `pnpm run build`）。

- [ ] **Step 5: Commit（先向用户确认）**

```bash
git add packages/token-usage
git commit -m "feat(token-usage): 入口迁到 sidebar.footer.action，移除会话头按钮与命令自动弹窗"
```

---

### Task 3: UsageModal 样式规范化

**Files:**
- Modify: `packages/token-usage/src/client/UsageModal.module.css`
- Modify: `packages/token-usage/src/client/UsageModal.tsx`（仅 className/结构微调，无逻辑变化）

**Interfaces:**
- Consumes: 无（纯样式任务，不改任何导出签名）。
- Produces: 无新接口。

- [ ] **Step 1: 重写样式表**

`src/client/UsageModal.module.css` 全量替换（规范点：次要文字用 label token 而非 opacity；字号配行高；pager 按钮 token 化 hover；柱条 hover 高亮；不写主题选择器、不写字面颜色）：

```css
/* Usage modal: 24h bar chart + totals + breakdowns. Bar fill uses the
   business-primary state alias (defined for both themes in ui-theme). */
.root { min-width: 560px; max-width: 720px; }
.pager { display: flex; align-items: center; gap: 8px; justify-content: center; }
.pagerButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 20px;
}
.pagerButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.pagerButton:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dateLabel {
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.chart { display: flex; align-items: flex-end; gap: 2px; height: 120px; margin-top: 12px; }
.barSlot { flex: 1; height: 100%; display: flex; align-items: flex-end; border-radius: 1px; }
.barSlot:hover { background: var(--dsw-alias-interactive-bg-hover); }
.bar {
  width: 100%;
  min-height: 1px;
  background: var(--dsw-alias-state-business-primary, currentColor);
  border-radius: 1px;
}
.hourLabels {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.total {
  margin-top: 12px;
  font-weight: 600;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.sectionTitle {
  margin: 12px 0 4px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.row {
  display: flex;
  gap: 12px;
  justify-content: space-between;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
}
.rowName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rowCalls { color: var(--dsw-alias-label-tertiary); }
.compaction {
  margin-top: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
```

- [ ] **Step 2: 微调 UsageModal.tsx**

- 两个 pager `<button>` 加 `className={css.pagerButton}`（现有 `<button type="button" disabled=… onClick=…>←</button>` 与 `→</button>` 两处）。
- 给 pager 按钮补无障碍名：`aria-label="前一天"` / `aria-label="后一天"`。
- 其余结构、fetch 逻辑、文案不动。

- [ ] **Step 3: 验证**

Run: `pnpm --filter token-usage test; pnpm --filter token-usage typecheck; pnpm --filter token-usage bundle`
Expected: 全绿（Task 1 的模态框用例覆盖到 `.total` 行渲染，可佐证样式改动未破坏结构）。

- [ ] **Step 4: 开发回路目测（告知用户手工验证步骤，不代跑常驻服务）**

向用户说明：`cd deepseek-harness && pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml`，开浏览器确认：(1) 侧边栏底栏设置按钮上方出现"Token 用量"，宽/窄栏均正常，窄栏悬停有 Tooltip；(2) 会话头不再有 📊；(3) Modal 在明/暗主题下颜色正确、柱条 hover 有高亮。

- [ ] **Step 5: Commit（先向用户确认）**

```bash
git add packages/token-usage
git commit -m "style(token-usage): UsageModal 样式规范化——dsw 语义 token、排版行高、pager/柱条 hover"
```

---

## Self-Review 记录

- **Spec 覆盖**：入口迁移→Task 1+2；自动弹窗移除→Task 2 Step 2；依赖/manifest 切换→Task 2 Step 3；样式规范化→Task 3；图表方案 A（仅精修）→Task 3；验收标准 1/2/3→Task 2 + Task 3 Step 4，4→Task 3，5→各 Task 验证步。无缺口。
- **占位符**：无；所有代码步骤含完整代码。唯一"以实际类型为准"的测试 payload 备注是故意的类型适配说明，payload 本身完整给出。
- **类型一致性**：`UsageEntry({ wide: boolean })` 在 Task 1 定义、Task 2 注册，一致；`UsageModal` props 与现状签名一致未改；slot 名 `sidebar.footer.action` 与 ui-sidebar contract 一致。
