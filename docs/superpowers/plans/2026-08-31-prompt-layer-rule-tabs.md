# 模型层 / model-notes 规则内容 tab 查看 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分层提示词面板的「模型层」与「model-notes」只读行各增加规则 tab 栏，只读文本框按 tab 切换显示对应规则内容。

**Architecture:** 纯浏览器半改动：`PromptLayersModal` 从已有 `PromptLayersPayload.rules` 派生 tab 列表（模型层 = 内置默认 + 含 `overrides.base` 的规则；model-notes = 含 `append` 的规则），新增文件内小组件 `RuleTabs` 渲染 tab 栏 + 只读 textarea，样式复用 UsageModal 的手写 tab 模式。零后端 / API / 存储改动。

**Tech Stack:** React + CSS Modules（`prompt.module.css`）、clsx、vitest + @testing-library/react（jsdom）。

**设计依据:** `docs/superpowers/specs/2026-08-31-prompt-layer-rule-tabs-design.md`（已提交，commit 458a8103a3）

## Global Constraints

- 测试命令：`pnpm --filter dsh-agent-toolkit test`（vitest run；可按文件过滤 `pnpm --filter dsh-agent-toolkit test -- src/client/prompt/prompt-layers.spec.tsx`）
- src 改动后必须跑：`pnpm --filter dsh-agent-toolkit typecheck` 和 `pnpm --filter dsh-agent-toolkit bundle`
- 代码注释、commit message、UI 文案用中文；commit 风格参照 git log（如 `feat: identity 段可编辑（…）`）
- tab 交互沿用现有手写模式：`role="tablist"` + `button role="tab" aria-selected`，不引第三方组件、不抽共享 Tabs 组件
- 只读能力：不引入任何规则编辑入口；保存/重置逻辑不变
- 每次 git commit 前只 stage 本任务涉及的文件

---

### Task 1: RuleTabs 组件 + 模型层规则 tab

**Files:**
- Modify: `packages/toolkit/src/client/prompt/PromptLayersModal.tsx`
- Modify: `packages/toolkit/src/client/prompt/prompt.module.css`
- Test: `packages/toolkit/src/client/prompt/prompt-layers.spec.tsx`

**Interfaces:**
- Produces（Task 2 复用）:
  - `interface RuleTabItem { label: string; text: string }`（文件内，不导出）
  - `function formatMatch(match: RuleMatch): string` — `provider` → `provider: X`，`model` → `model: X`，`modelPattern` → 原样，多字段 ` + ` 连接
  - `function RuleTabs({ tabs }: { tabs: RuleTabItem[] }): ReactNode` — 渲染 `role="tablist"` tab 栏 + `aria-label="只读段文本"` 的 readOnly textarea；内部自持选中 index（默认 0）
  - CSS 类：`prompt.module.css` 新增 `.tabs` / `.tab` / `.tabActive`

- [ ] **Step 1: 写失败测试**

在 `prompt-layers.spec.tsx` 的 `PAYLOAD` 定义后追加多规则 payload，文件末尾追加三个测试：

```tsx
const RULES_PAYLOAD = {
  ...PAYLOAD,
  rules: [
    { match: { modelPattern: 'claude*' }, overrides: { base: 'CLAUDE-BASE' } },
    { match: { provider: 'moonshotai' }, overrides: { base: 'KIMI-BASE' } },
    { match: { provider: 'p', model: 'm', modelPattern: 'x*' }, overrides: { base: 'MULTI-BASE' } },
    { match: { modelPattern: 'deepseek*' }, append: 'V4-NOTES' },
  ],
}
```

```tsx
test('模型层：tab 栏 = 内置默认 + 各 base 规则匹配条件，默认选中内置默认', async () => {
  stubFetch(RULES_PAYLOAD)
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.click(screen.getByText('模型层', { selector: 'button > span' }))
  expect(screen.getByRole('tab', { name: '内置默认' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tab', { name: 'claude*' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: 'provider: moonshotai' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: 'provider: p + model: m + x*' })).toBeTruthy()
  // append-only 规则不进模型层 tab
  expect(screen.queryByRole('tab', { name: 'deepseek*' })).toBeNull()
  expect(screen.getByLabelText('只读段文本')).toHaveProperty('value', 'FALLBACK-BASE')
})

test('模型层：点击规则 tab → 只读框显示该规则 overrides.base', async () => {
  stubFetch(RULES_PAYLOAD)
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.click(screen.getByText('模型层', { selector: 'button > span' }))
  fireEvent.click(screen.getByRole('tab', { name: 'claude*' }))
  const textarea = screen.getByLabelText('只读段文本')
  expect(textarea).toHaveProperty('value', 'CLAUDE-BASE')
  expect(textarea).toHaveProperty('readOnly', true)
  fireEvent.click(screen.getByRole('tab', { name: 'provider: moonshotai' }))
  expect(textarea).toHaveProperty('value', 'KIMI-BASE')
})

test('模型层：切到其他层再切回 → tab 复位到内置默认', async () => {
  stubFetch(RULES_PAYLOAD)
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.click(screen.getByText('模型层', { selector: 'button > span' }))
  fireEvent.click(screen.getByRole('tab', { name: 'claude*' }))
  fireEvent.click(screen.getByText('persona', { selector: 'button > span' }))
  fireEvent.click(screen.getByText('模型层', { selector: 'button > span' }))
  expect(screen.getByRole('tab', { name: '内置默认' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByLabelText('只读段文本')).toHaveProperty('value', 'FALLBACK-BASE')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client/prompt/prompt-layers.spec.tsx`
Expected: 三个新测试 FAIL（`Unable to find role "tab"`）；既有测试全部 PASS

- [ ] **Step 3: 加 tab 样式**

`prompt.module.css` 末尾追加（参照 `usage/UsageModal.module.css:26-51`，规则多时允许换行）：

```css
/* tab 栏：规则切换（分段控件观感，同 UsageModal）；规则多时可换行。 */
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-skeleton);
}
.tab {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
}
.tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
/* 激活项：与 .tab 叠加使用；置后以压过 .tab:hover。 */
.tabActive { background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); }
.tabActive:hover { background: var(--dsw-alias-bg-overlay); }
```

- [ ] **Step 4: 实现 formatMatch + RuleTabs + 模型层接线**

`PromptLayersModal.tsx` 改动三处：

① 类型导入行改为：

```tsx
import type { LayerConfig, RuleMatch } from '../../prompt/types.ts'
```

② `nativeText` 函数之后、`PromptLayersBody` 之前插入：

```tsx
/** 规则匹配条件 → tab 标签（provider/model 带字段前缀，modelPattern 原样；多字段 ' + ' 连接）。 */
function formatMatch(match: RuleMatch): string {
  const parts: string[] = []
  if (match.provider !== undefined) parts.push(`provider: ${match.provider}`)
  if (match.model !== undefined) parts.push(`model: ${match.model}`)
  if (match.modelPattern !== undefined) parts.push(match.modelPattern)
  return parts.join(' + ')
}

/** 规则查看 tab 项：标签（匹配条件或「内置默认」）+ 只读文本。 */
interface RuleTabItem { label: string; text: string }

/** 只读规则 tab 栏 + 文本框：内部自持选中态（默认第一项），随 key 重挂载复位。 */
function RuleTabs({ tabs }: { tabs: RuleTabItem[] }): ReactNode {
  const [index, setIndex] = useState(0)
  const current = tabs[index] ?? tabs[0]
  return (
    <>
      <div className={css.tabs} role="tablist">
        {tabs.map((t, i) => (
          <button key={`${i}:${t.label}`} type="button" role="tab" aria-selected={i === index}
            className={clsx(css.tab, i === index && css.tabActive)}
            onClick={() => { setIndex(i) }}>{t.label}</button>
        ))}
      </div>
      <textarea className={css.textarea} readOnly aria-label="只读段文本" rows={8}
        value={current?.text ?? ''} />
    </>
  )
}
```

③ `PromptLayersBody` 内，`const ordered = sortedLayers(layers)` 之后追加派生：

```tsx
  const rules = state.kind === 'ok' ? state.data.rules : []
  const modelTabs: RuleTabItem[] = [
    { label: '内置默认', text: modelFallbackText },
    ...rules.flatMap(r => r.overrides?.base === undefined ? [] : [{ label: formatMatch(r.match), text: r.overrides.base }]),
  ]
```

④ 编辑器面板只读行分支（原 `isReadonlyRow` 分支）改为：

```tsx
        ) : state.kind === 'ok' && isReadonlyRow ? (
          <div className={css.editor}>
            {selectedKey === MODEL_SECTION ? (
              <>
                <p className={css.hint}>模型层是内置提示词：运行时按当前模型命中规则整份覆盖，不可编辑。</p>
                <RuleTabs key={MODEL_SECTION} tabs={modelTabs} />
              </>
            ) : (
              <>
                <p className={css.hint}>model-notes 是保留层：规则命中时以其 append 文本渲染，不可直接编辑。</p>
                <textarea className={css.textarea} readOnly aria-label="只读段文本" rows={8}
                  value={nativeText(native, MODEL_NOTES_SECTION)} />
              </>
            )}
          </div>
        ) : ...
```

（model-notes 分支本任务保持现状不动，Task 2 再改；模型层原来直接用 `modelFallbackText` 的 textarea 由 RuleTabs 取代。）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client/prompt/prompt-layers.spec.tsx`
Expected: 全部 PASS（含既有 6 个测试；既有「选中模型层只读行 → 展示其兜底文本」因默认 tab = 内置默认而不变）

- [ ] **Step 6: typecheck + bundle**

Run: `pnpm --filter dsh-agent-toolkit typecheck; if ($?) { pnpm --filter dsh-agent-toolkit bundle }`
Expected: 均无错误

- [ ] **Step 7: Commit**

```bash
git add packages/toolkit/src/client/prompt/PromptLayersModal.tsx packages/toolkit/src/client/prompt/prompt.module.css packages/toolkit/src/client/prompt/prompt-layers.spec.tsx
git commit -m "feat: 模型层规则内容 tab 查看（内置默认 + 各 base 规则）"
```

---

### Task 2: model-notes append 规则 tab + 空态

**Files:**
- Modify: `packages/toolkit/src/client/prompt/PromptLayersModal.tsx`
- Test: `packages/toolkit/src/client/prompt/prompt-layers.spec.tsx`

**Interfaces:**
- Consumes: Task 1 的 `RuleTabs` / `RuleTabItem` / `formatMatch`
- Produces: 无新接口

- [ ] **Step 1: 改既有测试 + 写空态失败测试**

① 替换既有测试「选中 model-notes 只读行 → 展示只读文本，不出现层文本编辑器」（PAYLOAD 的规则含 `append: 'V4-NOTES'`，行为已变）：

```tsx
test('选中 model-notes 只读行 → tab 栏显示 append 规则，只读框显示其文本', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.click(screen.getByText('model-notes'))
  expect(screen.queryByLabelText('层文本')).toBeNull()
  expect(screen.getByRole('tab', { name: 'deepseek*' }).getAttribute('aria-selected')).toBe('true')
  const textarea = screen.getByLabelText('只读段文本')
  expect(textarea).toHaveProperty('value', 'V4-NOTES')
  expect(textarea).toHaveProperty('readOnly', true)
})
```

② 文件末尾追加空态测试：

```tsx
test('model-notes：无 append 规则时无 tab 栏，显示空态提示', async () => {
  stubFetch({ ...PAYLOAD, rules: [{ match: { modelPattern: 'claude*' }, overrides: { base: 'CLAUDE-BASE' } }] })
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.click(screen.getByText('model-notes'))
  expect(screen.queryByRole('tablist')).toBeNull()
  expect(screen.getByText('当前配置没有 append 规则。')).toBeTruthy()
  expect(screen.getByLabelText('只读段文本')).toHaveProperty('value', '')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client/prompt/prompt-layers.spec.tsx`
Expected: 两个测试 FAIL（改后的 model-notes 测试期望 tab 不存在；空态测试期望提示文案不存在）

- [ ] **Step 3: 实现 model-notes 接线 + 空态**

`PromptLayersModal.tsx` 两处改动：

① Task 1 的 `modelTabs` 派生之后追加：

```tsx
  const notesTabs: RuleTabItem[] = rules.flatMap(r =>
    r.append === undefined ? [] : [{ label: formatMatch(r.match), text: r.append }])
```

② model-notes 分支（Task 1 留下的 `nativeText(native, MODEL_NOTES_SECTION)` textarea 分支）改为：

```tsx
            ) : notesTabs.length > 0 ? (
              <>
                <p className={css.hint}>model-notes 是保留层：规则命中时以其 append 文本渲染，不可直接编辑。</p>
                <RuleTabs key={MODEL_NOTES_SECTION} tabs={notesTabs} />
              </>
            ) : (
              <>
                <p className={css.hint}>当前配置没有 append 规则。</p>
                <textarea className={css.textarea} readOnly aria-label="只读段文本" rows={8} value="" />
              </>
            )}
```

（`RuleTabs` 以 `key={selectedKey}` 语义挂载——模型层与 model-notes 分支切换时重挂载，tab 选中态复位。`nativeText` 函数保留：identity 行 placeholder 仍在用。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client/prompt/prompt-layers.spec.tsx`
Expected: 全部 PASS

- [ ] **Step 5: 全量测试 + typecheck + bundle**

Run: `pnpm --filter dsh-agent-toolkit test; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }; if ($?) { pnpm --filter dsh-agent-toolkit bundle }`
Expected: 361+ 全部 PASS、typecheck/bundle 无错误

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/client/prompt/PromptLayersModal.tsx packages/toolkit/src/client/prompt/prompt-layers.spec.tsx
git commit -m "feat: model-notes 规则 append 内容 tab 查看 + 无规则空态"
```

---

### Task 3: 使用手册同步

**Files:**
- Modify: `docs/usage/prompt-layers.md:27,30`

**Interfaces:** 无（纯文档）

- [ ] **Step 1: 更新面板描述**

`docs/usage/prompt-layers.md` 第 27 行整行替换为：

```markdown
- 左栏固定层栈：`harness:identity`（可覆盖，无只读徽标）→ **模型层**（只读，tab 栏切换「内置默认」与各 `overrides.base` 规则查看文本）→ **persona**（可编辑层文本）→ `model-notes`（只读徽标，tab 栏切换各 `append` 规则查看文本；无 append 规则时显示空态提示）。
```

第 30 行整行替换为：

```markdown
- 规则（rules）内容由 cordis.yml 配置（见下文「规则匹配」），面板只读查看：模型层 / model-notes 行的 tab 标签为规则匹配条件（`provider: X` / `model: X` / modelPattern 原样，多条件 ` + ` 连接）；动态层（contexts）由 dsh 原生按运行时追加，不在面板展示。
```

- [ ] **Step 2: Commit**

```bash
git add docs/usage/prompt-layers.md
git commit -m "docs: 手册同步模型层/model-notes 规则 tab 查看"
```

---

## Self-Review 记录

- Spec 覆盖：第 1 节 UI → Task 1/2 Step 3-4；第 2 节数据派生（模型层 tabs / notes tabs / formatMatch / RuleTabs key 复位 / 空态）→ Task 1 ④③、Task 2 ③；第 3 节测试 5 条 → Task 1 Step 1（3 条，含默认选中与 readOnly）、Task 2 Step 1（2 条）；手册同步 → Task 3。截图补拍不在本计划（委派卡截图亦待补，统一后续人工）。
- 既有测试兼容性：「加载后展示层栈」「结构固定」「编辑 persona 保存」「identity 覆盖」「加载回显」「选中模型层展示兜底文本」6 条不受影响（模型层默认 tab = 内置默认，textarea 值不变）。
- 类型一致性：`RuleTabItem` / `formatMatch` / `RuleTabs` 在 Task 1 定义、Task 2 消费，签名一致。
