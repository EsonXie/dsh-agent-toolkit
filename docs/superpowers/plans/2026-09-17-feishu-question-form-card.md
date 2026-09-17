# 飞书问答卡改表单容器统一提交 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 问答卡从「按钮逐题即答」重构为 form 容器「全部填完统一提交」：单选 select_static / 多选 multi_select_static / 每题可选自定义输入 / 提交+跳过常驻卡底 / 服务端校验全答才放行 / 提交后整卡定格只读。

**Architecture:** 卡片进行态改为单个 `form` 容器（选择缓存在客户端，提交一次回调 `action.form_value`）+ form 外常驻「跳过」按钮；`toCardActionInput` 透传 SDK 丢弃的 `form_value`；QuestionCenter 删 toggle/refresh 中间态，新增 submit 聚合与全答校验。

**Tech Stack:** TypeScript（.ts 后缀导入）、vitest、飞书 cardkit 2.0 form 容器（form_value 回调 + WS 应答帧 toast）。

**Spec:** `docs/superpowers/specs/2026-09-17-feishu-question-form-card-design.md`

## Global Constraints

- 测试：`pnpm --filter dsh-agent-toolkit test`；类型：`pnpm --filter dsh-agent-toolkit typecheck`；构建：`pnpm --filter dsh-agent-toolkit bundle`。不动 `packages/usage`。
- 提交风格照 git log：`type(scope): 中文摘要`。
- 不修改 `deepseek-harness/` 内任何文件。
- TDD：先写失败测试，再实现。
- card JSON 2.0 **禁用 `tag: 'action'` 容器**（建卡报 200861）；按钮/选择器/输入框作为 form 或 body 的直接子元素。
- form 内交互组件一律不设 `required`、不挂 `behaviors`；`name` 用位置序号（`q{i}` / `q{i}__custom` / `btn_submit`），不用模型生成的 q.id（飞书 form name 有字符约束）。
- 2026-09-17 已加的 debugLog 事件（question-request/fallback/presented）保持不变。

---

### Task 1: CardActionInput 透传 formValue

**Files:**
- Modify: `packages/toolkit/src/channels/approval/center.ts:42-47`（CardActionInput 加可选字段）
- Modify: `packages/toolkit/src/channels/feishu/card-action.ts`（raw.action.form_value 透传）
- Test: `packages/toolkit/src/channels/feishu/card-action.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: `CardActionInput.formValue?: Record<string, unknown>`（Task 3 的 submit 聚合消费）。

- [ ] **Step 1: 写失败测试**

`card-action.test.ts` 追加：

```ts
test('form 提交回调：raw.action.form_value 透传为 formValue（SDK normalize 丢弃该字段）', () => {
  const raw = {
    context: { open_message_id: 'om_1', open_chat_id: 'oc_chat1' },
    operator: { open_id: 'ou_initiator' },
    action: {
      tag: 'button', name: 'btn_submit',
      value: { kind: 'question', key: 'k1', submit: true },
      form_value: { q0: '红', q1: ['甲', '乙'], q2: '自由文本' },
    },
  }
  expect(toCardActionInput(raw)).toEqual({
    chatId: 'oc_chat1', operatorOpenId: 'ou_initiator',
    value: { kind: 'question', key: 'k1', submit: true },
    formValue: { q0: '红', q1: ['甲', '乙'], q2: '自由文本' },
  })
})

test('无 form_value 的普通按钮回调：不带 formValue 键', () => {
  expect(toCardActionInput(RAW)).not.toHaveProperty('formValue')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- card-action`
Expected: FAIL（formValue 未透传）

- [ ] **Step 3: 实现**

`approval/center.ts` CardActionInput 加字段：

```ts
/** 渠道回调入核的卡片动作（渠道已解析成渠道无关形态）。 */
export interface CardActionInput {
  chatId: string
  operatorOpenId: string
  operatorName?: string
  value: unknown
  /** form 容器提交回调的表单值（name → 值；lark SDK normalizeCardAction 丢弃 form_value，渠道从 raw 直取）。 */
  formValue?: Record<string, unknown>
}
```

`card-action.ts` 的 `toCardActionInput` 返回对象加：

```ts
// normalizeCardAction 丢弃 form_value：form 提交回调的值从 raw 直取。
const formValue = (raw as { action?: { form_value?: unknown } }).action?.form_value
return {
  chatId: evt.chatId,
  operatorOpenId: evt.operator.openId,
  ...(evt.operator.name !== undefined ? { operatorName: evt.operator.name } : {}),
  value: evt.action.value,
  ...(formValue !== null && typeof formValue === 'object' && !Array.isArray(formValue)
    ? { formValue: formValue as Record<string, unknown> } : {}),
}
```

- [ ] **Step 4: 跑测试全绿后提交**

Run: `pnpm --filter dsh-agent-toolkit test -- card-action`
Expected: PASS

```bash
git add packages/toolkit/src/channels
git commit -m "feat(feishu): 卡片回调透传 form_value——form 容器提交的值进入 CardActionInput.formValue"
```

---

### Task 2: QuestionCenter——submit 聚合 + 全答校验 + 瘦身

**Files:**
- Modify: `packages/toolkit/src/channels/questions/center.ts`
- Test: `packages/toolkit/src/channels/questions/center.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CardActionInput.formValue`。
- Produces（Task 3/4 依赖）：
  - `QuestionView = { answers: ReadonlyMap<string, { selected: string[]; custom?: string }> }`（**删 toggled**）
  - `QuestionPresentation = { finalize(prompt, view, status): Promise<void> }`（**删 refresh**）
  - `QuestionPresenter.present(prompt: QuestionPrompt): Promise<QuestionPresentation>`（**删 view 参**）
  - `handleCardAction` 识别的 value：`{kind:'question', key, cancel:true}` / `{kind:'question', key, submit:true}`；select/toggle/confirm 分支**删除**。

- [ ] **Step 1: 改写失败测试**

`center.test.ts` 改造要点：

1. harness：`QuestionView` 快照删 toggled；`presentation` fake 删 `refresh`（只留 `finalize`）；`present` fake 签名改 `(prompt)`；删 `refreshed` 收集数组。
2. 删除/改写这些存量用例：多问题分题作答的中间态 refresh 断言、multi_select toggle/confirm 用例、「单选题点击」用例改为 submit 流。
3. 新增用例（每个一个 test）：

```ts
// ask 后取 presented[0]!.prompt.key 作为回调 key。

test('submit：单选+多选+开放+自定义混合，formValue 按位置序号聚合，全齐 resolve', async () => {
  // questions: [单选 q1(options 红/蓝), 多选 q2(multiSelect 甲/乙), 开放 q3, 单选 q4(options 对/错)]
  // formValue: { q0: '蓝', q1: ['甲','乙'], q2: '自由回答', q3: '对', 'q3__custom': '补充说明' }
  // handleCardAction({ ..., value: { kind:'question', key, submit:true }, formValue })
  // → ack { toast: '已提交作答' }；pending resolve：
  //   answers = [
  //     { id:'q1', selected:['蓝'] },
  //     { id:'q2', selected:['甲','乙'] },
  //     { id:'q3', selected:[], custom:'自由回答' },
  //     { id:'q4', selected:['对'], custom:'补充说明' },
  //   ]；finalize status 'answered'
})

test('submit 缺题：toast 指出未答数，保持 pending 不 resolve', async () => {
  // questions: [q1 单选, q2 开放]；formValue 只给 q0
  // → ack.toast 含 '1'（还有 1 道题未作答）；pending 未 settle；finalize 未被调
  // 补交第二次 submit（formValue 含 q0/q1）→ resolve
})

test('submit 与文本拦截合并：开放题先被 inbound 文本作答，submit 时其余题经 formValue 补齐', async () => {
  // questions: [q1 单选, q2 开放]；先 tryConsumeText 答 q2，再 submit formValue 只含 q0 → resolve
})

test('submit 时 formValue 对某题给空值 → 该题视为未答', async () => {
  // questions: [q1 单选]；formValue { q0: '' } 与 {} 均 → toast 未答
})

test('选项题只填自定义（不选选项）→ 视为已答', async () => {
  // questions: [q1 单选]；formValue { 'q0__custom': '都不是' } → resolve { selected: [], custom: '都不是' }
})

test('cancel 按钮 → ASK_CANCELLED reject，toast「已跳过提问」', async () => {
  // value { kind:'question', key, cancel:true } → rejects code ASK_CANCELLED；finalize 'cancelled'
})

test('旧版 select/toggle/confirm value 不再识别 → undefined', async () => {
  // value { kind:'question', key, qid:'q1', select:'红' } → handleCardAction 返回 undefined
})
```

4. 「发卡期间 abort」「signal 已 aborted」「dispose」「并发 key」「非发起人」「未知 key」「tryConsumeText」存量用例保留；`tryConsumeText` 相关断言中删 refresh 期待（现在不 refresh）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- questions/center`
Expected: FAIL（submit 分支不存在 / 接口已变）

- [ ] **Step 3: 实现 center.ts 改造**

类型与接口（替换现有定义）：

```ts
/** 卡片渲染视图：已答集合（按键 = 问题 id）。 */
export interface QuestionView {
  answers: ReadonlyMap<string, { selected: string[]; custom?: string }>
}

/** 一次已展示的问答卡：finalize 定格为只读终态（form 卡无中间态，整卡重放会抹掉用户填写态，故无 refresh）。 */
export interface QuestionPresentation {
  finalize(prompt: QuestionPrompt, view: QuestionView, status: 'answered' | 'cancelled'): Promise<void>
}

/** 渠道侧问答能力：发卡 → 返回定格句柄。 */
export interface QuestionPresenter {
  present(prompt: QuestionPrompt): Promise<QuestionPresentation>
}
```

`PendingSet` 删 `toggled`；`handleRequest` 删 `toggled` 创建与 present 的 view 实参（改 `channel.presenter.present(prompt)`）；`viewOf` 删 toggled。

`allAnswered` 改为按「有选择或有自定义文本」判定：

```ts
/** 题是否已答：有选中项或非空自定义文本。 */
private isAnswered(entry: PendingSet, qid: string): boolean {
  const answer = entry.answers.get(qid)
  return answer !== undefined && (answer.selected.length > 0 || (answer.custom !== undefined && answer.custom.trim().length > 0))
}

private allAnswered(entry: PendingSet): boolean {
  return entry.prompt.questions.every((q) => this.isAnswered(entry, q.id))
}
```

新增 formValue 聚合（私有方法）：

```ts
/** 读非空字符串（trim 后为空视为缺席）。 */
function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 读选中列表：string → 单元素；string[] → 过滤非空；其余 → 空。 */
function readSelected(value: unknown): string[] {
  if (typeof value === 'string') return value.length > 0 ? [value] : []
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return []
}

/** form_value 按位置序号聚合覆写 answers；某题 formValue 全空则保留既有答案（文本拦截先行作答）。 */
private mergeFormValue(entry: PendingSet, formValue: Record<string, unknown>): void {
  entry.prompt.questions.forEach((q, i) => {
    if (q.options === undefined) {
      const custom = readText(formValue[`q${i}`])
      if (custom !== undefined) entry.answers.set(q.id, { selected: [], custom })
      return
    }
    const selected = readSelected(formValue[`q${i}`])
    const custom = readText(formValue[`q${i}__custom`])
    if (selected.length === 0 && custom === undefined) return
    entry.answers.set(q.id, { selected, ...(custom !== undefined ? { custom } : {}) })
  })
}
```

`handleCardAction` 重写（删 qid/select/toggle/confirm 分支）：

```ts
handleCardAction(action: CardActionInput): CardActionAck | undefined {
  const value = action.value as { kind?: unknown; key?: unknown; submit?: unknown; cancel?: unknown } | null
  if (value === null || typeof value !== 'object' || value.kind !== 'question' || typeof value.key !== 'string') return undefined
  const entry = this.pending.get(value.key)
  if (entry === undefined) return { toast: '该问题已作答或已失效' }
  const rt = this.sessions.get(entry.sessionId)
  if (rt === undefined || rt.initiatorOpenId !== action.operatorOpenId) return { toast: '仅会话发起人可作答' }
  if (value.cancel === true) {
    this.settleCancelled(value.key, entry, 'ASK_CANCELLED', 'The user dismissed the question to speak instead')
    return { toast: '已跳过提问' }
  }
  if (value.submit !== true) return undefined
  this.mergeFormValue(entry, action.formValue ?? {})
  const missing = entry.prompt.questions.filter((q) => !this.isAnswered(entry, q.id)).length
  if (missing > 0) return { toast: `还有 ${missing} 道题未作答` }
  this.settleAnswered(value.key, entry)
  return { toast: '已提交作答' }
}
```

`tryConsumeText` 删 refresh 调用（form 卡整卡重放会抹掉用户正在填写的表单态）：

```ts
entry.answers.set(open.id, { selected: [], custom: text })
if (this.allAnswered(entry)) this.settleAnswered(key, entry)
return true
```

`settle`/`settleAnswered`/`settleCancelled`/`dispose` 不动。

- [ ] **Step 4: 跑测试全绿后提交**

Run: `pnpm --filter dsh-agent-toolkit test -- questions`
Expected: center 全绿（feishu.test.ts 此时红，属 Task 3 范围；运行时用 `-- center` 过滤）

```bash
git add packages/toolkit/src/channels/questions
git commit -m "feat(feishu): 问答 submit 统一提交——formValue 聚合/全答校验/删 toggle 与 refresh 中间态"
```

---

### Task 3: 问答卡渲染重写为 form 结构

**Files:**
- Modify: `packages/toolkit/src/channels/questions/feishu.ts`
- Test: `packages/toolkit/src/channels/questions/feishu.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `QuestionPresenter`/`QuestionPresentation`/`QuestionView` 新签名。
- Produces: `buildQuestionCardJson(prompt: QuestionPrompt, maxBytes: number): string`（**删 view 参**）；`buildQuestionFinalCardJson` 签名不变。

- [ ] **Step 1: 改写失败测试**

`feishu.test.ts` 改造要点：

1. `ElementLike` 扩字段（`name?: string; options?...; form_action_type?: string; elements?`），helpers：
   - `formOf(card)` = body.elements 中 `tag === 'form'` 的元素；
   - `markdowns(card)` = form.elements 里 tag markdown 的 content 数组；
   - `fields(card)` = form.elements 里 tag ∈ {select_static, multi_select_static, input} 的数组；
   - `buttons(card)` = 整卡递归收集 tag === 'button'（含 column_set 内与 body 末尾）。
2. 新断言用例：

```ts
test('进行卡：单 form 容器；每题 markdown + 对应组件；提交按钮在 form 底部；跳过按钮常驻 body 末尾', () => {
  // promptOf([CHOICE(单选 红/蓝), MULTI(多选 甲/乙), OPEN])
  const card = cardOf(buildQuestionCardJson(promptOf([CHOICE, MULTI, OPEN]), 20_000))
  expect(card.schema).toBe('2.0')
  expect(JSON.stringify(card)).not.toContain('"action"')
  const form = formOf(card)
  expect(form.name).toBe('q')
  // 组件序列：md, select_static, input(自定义), md, multi_select_static, input(自定义), md, input(开放), column_set(提交)
  const fields = fieldsOf(card)
  expect(fields.map((f) => [f.tag, f.name])).toEqual([
    ['select_static', 'q0'], ['input', 'q0__custom'],
    ['multi_select_static', 'q1'], ['input', 'q1__custom'],
    ['input', 'q2'],
  ])
  // 选项 value = label（form_value 直接回传 label）
  const single = fields[0]
  expect(single.options).toEqual([
    { text: { tag: 'plain_text', content: '红' }, value: '红' },
    { text: { tag: 'plain_text', content: '蓝' }, value: '蓝' },
  ])
  // form 内组件不带 required / behaviors
  for (const f of fields) expect(f).not.toHaveProperty('required')
  // 提交按钮：form 内、form_action_type submit、callback value 带 submit
  const submit = buttons(card).find((b) => b.form_action_type === 'submit')!
  expect(submit.behaviors[0]!.value).toEqual({ kind: 'question', key: 'k1', submit: true })
  // 跳过按钮：body 末尾（form 外）、cancel
  const skip = buttons(card).find((b) => b.behaviors[0]!.value['cancel'] === true)!
  expect(skip).toMatchObject({ tag: 'button', type: 'danger', text: { content: '跳过本次提问' } })
  expect(skip.behaviors[0]!.value).toEqual({ kind: 'question', key: 'k1', cancel: true })
})

test('进行卡：plan detail 截断与「完整计划见会话」标注保留', () => {
  // 照现有 plan-review 用例，改走 formOf(card) 的 markdown 断言
})

test('终态卡：保留全部题目与回答、无任何交互组件；cancelled 题标「已取消」', () => {
  // 照现有终态卡用例（断言不变：无 button、md 含已选/已答/已取消、header 色）
})
```

3. presenter 用例改写：`present(prompt)` 单参；删 refresh 断言（只断言 createCard+sendCardMessage、finalize=replaceCard sequence 1）；删「refresh/finalize 失败被吞」中的 refresh 半（保留 finalize 半）。
4. 末尾「卡片按钮 value 与 QuestionCenter 对接」集成用例改写：建卡后从提交按钮取 value，构造 `handleCardAction({ ..., value: submitValue, formValue: { q0: '红', q1: ['甲'], ... } })` 断言 resolve。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- questions/feishu`
Expected: FAIL（buildQuestionCardJson 签名/结构已变）

- [ ] **Step 3: 实现 feishu.ts 重写**

替换进行卡相关函数（终态卡 `buildQuestionFinalCardJson`、`answerLine`、`sliceChars`、`detailBudget`、`TRUNCATION_NOTICE` 保留；`questionMarkdown` 删已答行与开放提示分支）：

```ts
/** 单题 markdown：问题 + detail（超预算截断并标注）。form 卡无已答行/开放提示（输入框即作答入口）。 */
function questionMarkdown(q: QuestionItemLike, maxBytes: number): string {
  const lines = [`**${q.question}**`]
  if (q.detail !== undefined && q.detail.length > 0) {
    const shown = sliceByBytes(q.detail, detailBudget(maxBytes))
    lines.push(shown === q.detail ? shown : `${shown}${TRUNCATION_NOTICE}`)
  }
  return lines.join('\n')
}

/** 单题的表单组件：选项题 = 选择器 + 可选自定义输入；开放题 = 输入框。name 用位置序号（q.id 字符不受控）。 */
function questionFields(q: QuestionItemLike, index: number): Record<string, unknown>[] {
  if (q.options === undefined) {
    return [{ tag: 'input', name: `q${index}`, placeholder: { tag: 'plain_text', content: '请输入回答' }, width: 'fill' }]
  }
  const options = q.options.map((o) => ({ text: { tag: 'plain_text', content: o.label }, value: o.label }))
  const select = q.multiSelect === true
    ? { tag: 'multi_select_static', name: `q${index}`, placeholder: { tag: 'plain_text', content: '请选择（可多选）' }, width: 'fill', options }
    : { tag: 'select_static', name: `q${index}`, placeholder: { tag: 'plain_text', content: '请选择' }, width: 'fill', options }
  return [select, { tag: 'input', name: `q${index}__custom`, placeholder: { tag: 'plain_text', content: '其他（可补充自定义说明）' }, width: 'fill' }]
}

/** 提交按钮：form 容器底部（form_action_type submit 触发整表回调，value 供 dispatcher 路由）。 */
function submitButton(prompt: QuestionPrompt): Record<string, unknown> {
  return {
    tag: 'column_set',
    columns: [{
      tag: 'column', width: 'auto',
      elements: [{
        tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '提交' },
        form_action_type: 'submit', name: 'btn_submit',
        behaviors: [{ type: 'callback', value: { kind: 'question', key: prompt.key, submit: true } }],
      }],
    }],
  }
}

/** 跳过按钮：form 外 body 末尾常驻（form 内按钮必须 submit/reset，无法表达取消语义）。 */
function skipButton(prompt: QuestionPrompt): Record<string, unknown> {
  return {
    tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '跳过本次提问' },
    behaviors: [{ type: 'callback', value: { kind: 'question', key: prompt.key, cancel: true } }],
  }
}

/** 进行卡：单 form 容器（每题 markdown + 表单组件）+ 底部提交；跳过常驻卡片下方。 */
export function buildQuestionCardJson(prompt: QuestionPrompt, maxBytes: number): string {
  const formElements: Record<string, unknown>[] = []
  prompt.questions.forEach((q, i) => {
    formElements.push({ tag: 'markdown', content: questionMarkdown(q, maxBytes) })
    formElements.push(...questionFields(q, i))
  })
  formElements.push(submitButton(prompt))
  return JSON.stringify({
    schema: '2.0',
    config: { summary: { content: 'Bot 提问' } },
    header: { title: { tag: 'plain_text', content: '提问' }, template: 'blue' },
    body: { elements: [{ tag: 'form', name: 'q', elements: formElements }, skipButton(prompt)] },
  })
}
```

presenter 精简（删 refresh；sequence 只供 finalize 用，固定 1）：

```ts
/** 飞书问答能力：present = 建卡 + 发消息；finalize = replaceCard 定格只读（sequence 1，create/send 不占）。 */
export class FeishuQuestionPresenter implements QuestionPresenter {
  constructor(
    private readonly api: FeishuApi,
    private readonly maxBytes: number,
    private readonly log: (message: string) => void,
  ) {}

  async present(prompt: QuestionPrompt): Promise<QuestionPresentation> {
    const cardId = await withRetry(() => this.api.createCard(buildQuestionCardJson(prompt, this.maxBytes)))
    await withRetry(() => this.api.sendCardMessage(prompt.chatId, cardId))
    return {
      finalize: async (p, v, status) => {
        try {
          await withRetry(() => this.api.replaceCard(cardId, buildQuestionFinalCardJson(p, v, status, this.maxBytes), 1))
        } catch (error) {
          // 定格失败不吞作答结果：卡片残留可交互但回调侧已 settle（重复提交 toast 已失效）。
          this.log(`[project-bot] 问答卡片定格失败（card ${cardId}）：${error instanceof Error ? error.message : String(error)}`)
        }
      },
    }
  }
}
```

删除 `questionButton`/`optionButtons`/`cancelButton`/`OPEN_ANSWER_HINT` 与 `CUSTOM_ANSWER_MAX_CHARS` 之外不再被引用的常量（`answerLine` 仍被终态卡用，保留）。

- [ ] **Step 4: 跑测试全绿后提交**

Run: `pnpm --filter dsh-agent-toolkit test -- questions`
Expected: PASS

```bash
git add packages/toolkit/src/channels/questions
git commit -m "feat(feishu): 问答卡改 form 容器——单选下拉/多选勾选/自定义输入/提交跳过常驻卡底"
```

---

### Task 4: 受牵连修复 + 全量门禁 + 文档

**Files:**
- Modify: `packages/toolkit/src/channels/runtime.test.ts`（questionHarness presentation fake 删 refresh；问答集成用例改 submit 流）
- Modify: `docs/domains/feishu.md`（问答卡小节改写）
- Modify: `docs/superpowers/specs/2026-09-17-feishu-question-form-card-design.md`（状态 → 已实施，验收后）

**Interfaces:**
- Consumes: Task 1-3 全部产物。

- [ ] **Step 1: 修 runtime.test.ts**

- questionHarness 的 `questions.present` fake 返回 `{ finalize: async () => undefined }`（删 refresh），签名改 `(prompt)`。
- 「问答集成」用例回调改为：

```ts
const ack = ioOf()!.onCardAction!({
  chatId: 'oc_chat1', operatorOpenId: 'ou_initiator',
  value: { kind: 'question', key: presented[0]!.key, submit: true },
  formValue: { q0: '继续' },
})
expect(ack).toEqual({ toast: '已提交作答' })
await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['继续'] }] })
```

- 「onCardAction 按 value.kind 路由」用例的 question 分支 value 改 `{ kind: 'question', key: 'k', submit: true }`（qid/select 已非合法值）。

- [ ] **Step 2: 全量门禁**

Run: `pnpm --filter dsh-agent-toolkit test`; `pnpm --filter dsh-agent-toolkit typecheck`; `pnpm --filter dsh-agent-toolkit bundle`
Expected: 全绿 + bundle 成功

- [ ] **Step 3: 真实回路验收（用户配合）**

重启 `pnpm dsh web --patch ...`（lib 变更不被 HMR 监听），飞书 bot 触发 ask_user_question：
1. 问答卡出现：每题 markdown + 下拉/输入框，底部「提交」「跳过本次提问」常驻；
2. 缺答点提交 → toast「还有 N 道题未作答」，卡片不动；
3. 全部作答（含一题只填自定义）→ 提交 → toast「已提交作答」→ 整卡定格只读（保留全部题目与回答）→ 后续输出开新卡续写；
4. 「跳过本次提问」→ 定格 cancelled、模型收到取消语义。
5. 读 `~/.dsh/logs/feishu-debug/feishu-*.jsonl` 确认 `question-presented` 事件、无 `question-fallback`。

- [ ] **Step 4: 文档同步 + 提交**

`docs/domains/feishu.md` 问答卡小节改写要点：进行卡 = form 容器（单选下拉/多选勾选/每题可选自定义输入/开放题输入框）；提交统一回调 form_value（lark SDK normalize 丢弃 form_value，渠道从 raw 直取）；服务端全答校验（有选择或有自定义文本），缺答 toast 保持挂起；提交/跳过常驻卡底；提交后整卡定格只读保留全部题目与回答；开放题文本拦截保留但不 refresh 卡片（防抹掉表单态）；2026-09-17 修复 card JSON 2.0 禁用 action 容器（200861）导致的发卡失败静默回退。spec 头部状态改「已实施」。

```bash
git add packages/toolkit docs
git commit -m "docs(feishu): 问答卡 form 化现行事实同步 + runtime 集成测试改 submit 流"
```

---

## Self-Review 记录

- Spec 覆盖：§卡片结构→Task 3；§回调与聚合→Task 1+2；§center 瘦身→Task 2；§终态卡保留题目与回答→Task 3 终态卡用例断言；影响面全列。
- 类型一致性：`QuestionView`/`QuestionPresentation`/`QuestionPresenter` 在 Task 2 改签名、Task 3 消费、Task 4 修集成测试，三处一致；`buildQuestionCardJson(prompt, maxBytes)` 两参与 Task 3 presenter 调用一致。
- 无占位符；每个 Step 含可执行代码或明确断言。
