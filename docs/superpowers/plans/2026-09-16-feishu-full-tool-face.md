# 飞书 bot 会话工具面对齐 web 端 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飞书 bot 会话统一挂 `agent-team` preset（与 web 端团队用户同面），新增飞书 user-questions 应答端打通 `ask_user_question` 与 plan-mode 评审，bot 聊天会话放开 cron_* 工具。

**Architecture:** ① joiner 的 preset id 从 `agentTeamPreset.botsId`（agent-bot）改为 `agentTeamPreset.id`（agent-team），删除 agent-bot 生成并清理存量标记目录；② ownedSessions 更名为 cronExcludedSessions，bots 侧停止登记；③ IM 引导句从 BASIC_TOOLS persona 挪到渠道段；④ 新增 `channels/questions/`（渠道无关 QuestionCenter + 飞书 presenter），镜像 `channels/approval/` 架构；⑤ ReplyHandle 新增 `breakCard?()` 供作答后开新卡续写。

**Tech Stack:** TypeScript（.ts 后缀导入）、vitest、schemastery、飞书 cardkit 2.0（callback 按钮 + WS 应答帧）。

**Spec:** `docs/superpowers/specs/2026-09-16-feishu-full-tool-face-design.md`

## Global Constraints

- 测试：`pnpm --filter dsh-agent-toolkit test`；类型：`pnpm --filter dsh-agent-toolkit typecheck`；构建：`pnpm --filter dsh-agent-toolkit bundle`。本计划不动 `packages/usage`，无需重建 usage lib。
- 提交风格照 git log：`type(scope): 中文摘要`（如 `feat(feishu): ...`）。
- 不修改 `deepseek-harness/` 内任何文件。
- TDD：先写失败测试，再实现。
- 宿主错误还原机制：`userQuestions.ask` 的 catch 经 `restoreUserQuestionError` 按结构（`name==='UserQuestionError'` + string `message`/`code`）重建错误实例——toolkit 侧只需抛**结构兼容**的 Error，禁止运行时导入 `@deepseek-ai/dsh-user-questions` 的类（防双实例；type-only 导入激活声明合并是既有先例，允许）。
- 卡片按钮回调 value 加 `kind` 字段路由：`kind: 'question'` → QuestionCenter；无 `kind` → ApprovalCenter（存量审批卡兼容）。

---

### Task 1: 统一挂 agent-team，删除 agent-bot preset

**Files:**
- Modify: `packages/toolkit/src/agents/team-preset.ts`（删 agent-bot 生成块 + 加存量清理）
- Modify: `packages/toolkit/src/agents/team-preset.test.ts`
- Delete: `packages/toolkit/src/agents/bot-preset.ts`、`packages/toolkit/src/agents/bot-preset.test.ts`
- Modify: `packages/toolkit/src/index.ts`（Config schema 删 botsId + 两处调用改 id 来源）
- Modify: `packages/toolkit/src/bots/index.ts:72-78,103-108`（BotsDeps.botPresetId → presetId）
- Modify: `packages/toolkit/src/schedule/index.ts:40-57`（deps botPresetId → presetId）

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: `AgentTeamPresetConfig` 不再含 `botsId`；`setupBots(ctx, config, { registry, presetId, ... })`、`setupSchedule(ctx, config, { registry, presetId, cronExcludedSessions })` 的 deps 键名 `presetId`；`LEGACY_BOT_PRESET_ID = 'agent-bot'`（team-preset.ts 导出，仅清理用）。

- [ ] **Step 1: 写失败测试——team-preset 不再生成 agent-bot、清理存量标记目录**

在 `team-preset.test.ts` 追加（照现有测试的 fake agentPresets/root 目录惯例）：

```ts
test('启动时删除带 .generated-by 标记的存量 agent-bot 目录，无标记目录保留', async () => {
  // 在 fake user root 下预置两个 agent-bot 目录场景各跑一次：
  // 1) 含 .generated-by 文件（内容 'dsh-agent-toolkit'）→ setupAgentTeamPreset 后目录不存在
  // 2) 无标记 → 目录保留，且 warn 包含「保留用户手工 preset」语义
})
test('生成结果只有 agent-team：不再写 agent-bot composition', async () => {
  // setupAgentTeamPreset 后，user root 下存在 agent-team/ 而不存在 agent-bot/
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- team-preset`
Expected: FAIL（agent-bot 仍被生成 / 清理逻辑不存在）

- [ ] **Step 3: 实现 team-preset.ts 修改**

- 删 `import { botPresetComposition, BOT_PRESET_NAME, BOT_PRESET_DESCRIPTION } from './bot-preset.ts'`。
- `AgentTeamPresetConfig` 删 `botsId` 字段及其 JSDoc。
- 删「agent-bot：bot 会话挂载的最小组合」整个 else 块（含 `config.id === config.botsId` 告警分支）。
- 新增清理逻辑（放在 agent-team 块之后，独立 try/catch）：

```ts
/** 2026-09-16 前本插件生成的 bot 最小 preset id（现已废弃）：存量标记目录启动时清理。 */
export const LEGACY_BOT_PRESET_ID = 'agent-bot'

// 在 setupAgentTeamPreset 内、root 解析之后：
try {
  const legacyDir = presetDir(LEGACY_BOT_PRESET_ID)
  const marked = await readFile(join(legacyDir, MARKER_FILE), 'utf8').then((t) => t.trim() === MARKER_CONTENT).catch(() => false)
  if (marked) {
    await rm(legacyDir, { recursive: true, force: true })
  } else {
    // access 探测：存在但无标记 = 用户手工同名目录，保留并告警
    await access(legacyDir)
    warn(`dsh-agent-toolkit: ${legacyDir} 为用户手工 preset（无生成标记），保留不清理`)
  }
} catch {
  // 目录不存在或读取失败：无需清理
}
```

（`rm` 从 `node:fs/promises` 补进现有 import。）

- [ ] **Step 4: 删除 bot-preset.ts 与 bot-preset.test.ts，改 index.ts / bots/index.ts / schedule/index.ts**

- `git rm`（或删除）两个 bot-preset 文件。
- `index.ts`：Config schema `agentTeamPreset` 的 z.object 与 `.default({...})` 字面量都删 `botsId` 行；两处调用改为：
  ```ts
  if (config.modules.feishu) setupBots(ctx, config.feishu, { registry, presetId: config.agentTeamPreset.enabled ? config.agentTeamPreset.id : undefined, ownedSessions })
  // setupSchedule 的 botPresetId 同样改为 presetId: config.agentTeamPreset.enabled ? config.agentTeamPreset.id : undefined
  ```
  （ownedSessions 在 Task 2 才从 setupBots 摘掉，本步保持原样。）
- `bots/index.ts`：`BotsDeps.botPresetId` → `presetId`（JSDoc 改为「bot 会话挂载的 preset id（agent-team；agentTeamPreset 开启时下达；undefined = 直接 toolsScope）」），`setupBots` 内 `deps.botPresetId` 引用同步改名，注释里「agent-bot 组合」改为「agent-team 组合」。
- `schedule/index.ts`：deps 接口与引用同款改名（行内注释「agent-bot」→「agent-team」）。

- [ ] **Step 5: 修受牵连的存量测试**

Run: `pnpm --filter dsh-agent-toolkit test`
预期失败点逐一修：`index.test.ts`（Config 默认值断言若含 botsId）、`bots/index` 相关测试（deps 键名）、`schedule` 测试同款。原则：只改键名与默认值断言，不断言行为变化。

- [ ] **Step 6: 全量测试 + typecheck 通过后提交**

Run: `pnpm --filter dsh-agent-toolkit test`; `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 全绿

```bash
git add packages/toolkit
git commit -m "feat(agents): bot 会话统一挂 agent-team preset——删除 agent-bot 生成并清理存量标记目录"
```

---

### Task 2: cron_* 门控——bot 聊天会话不再排除

**Files:**
- Modify: `packages/toolkit/src/index.ts:209-217`（ownedSessions 只传 schedule）
- Modify: `packages/toolkit/src/bots/index.ts`（BotsDeps 删 ownedSessions、createAgentsPort 调用摘参）
- Modify: `packages/toolkit/src/schedule/index.ts`（deps ownedSessions → cronExcludedSessions）
- Modify: `packages/toolkit/src/channels/agents-port.ts`（参数更名 + 注释）
- Test: `packages/toolkit/src/channels/agents-port.test.ts`、`packages/toolkit/src/index.test.ts`、`packages/toolkit/src/schedule/*.test.ts` 中引用处

**Interfaces:**
- Consumes: Task 1 的 `presetId` 改名。
- Produces: `createAgentsPort(ctx, joiner, cronExcludedSessions?, applyPreset?)` 第三参数名 `cronExcludedSessions`；`ScheduleDeps.cronExcludedSessions: Set<string>`；`BotsDeps` 不再有会话排除集。

- [ ] **Step 1: 写失败测试**

`agents-port.test.ts` 调整语义并改名：登记进排除集的会话仍被 setupCronTools 跳过（schedule 路径），而**不带排除集创建的 agentsPort（bots 路径）不向任何集合登记**。新增/改写断言：

```ts
test('未传 cronExcludedSessions 时 create/resume 不登记任何排除集', async () => {
  // 构造不传第三参的 createAgentsPort，create 后断言外部传入的 Set 保持为空（或根本不持有引用）
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- agents-port`
Expected: FAIL

- [ ] **Step 3: 实现改名与摘除**

- `agents-port.ts`：第三参 `ownedSessions?` → `cronExcludedSessions?`，JSDoc 改为「cron_* 工具注册门控排除集（仅 schedule 执行会话登记；bot 聊天会话自 2026-09-16 起与 web 主会话对齐，可建定时任务）」。
- `bots/index.ts`：`BotsDeps` 删 `ownedSessions` 字段；`createAgentsPort(ctx, scopeJoiner, deps.ownedSessions, applyPreset)` → `createAgentsPort(ctx, scopeJoiner, undefined, applyPreset)`——**若第三参仅用于登记则直接省略实参**（保持签名顺序）。
- `schedule/index.ts`：deps 字段与 `setupCronTools` 调用处更名 `cronExcludedSessions`。
- `index.ts`：`const ownedSessions = new Set<string>()` → `const cronExcludedSessions = new Set<string>()`；setupBots 调用删 `ownedSessions`；setupSchedule 传 `cronExcludedSessions`。

- [ ] **Step 4: 全量测试 + typecheck + 提交**

Run: `pnpm --filter dsh-agent-toolkit test`; `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 全绿

```bash
git add packages/toolkit
git commit -m "feat(schedule): cron_* 门控收窄为仅排除执行会话——bot 聊天会话对齐 web 主会话可建定时任务"
```

---

### Task 3: IM 引导句从 BASIC_TOOLS persona 挪到渠道段

**Files:**
- Modify: `packages/toolkit/src/channels/basic-tools.ts:16-25`（persona prefix 回落 standard 文案）
- Modify: `packages/toolkit/src/channels/router.ts`（withSenderSection → 追加 guidance 段）
- Test: `packages/toolkit/src/channels/basic-tools.test.ts`、`packages/toolkit/src/channels/router.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `GUIDANCE_SECTION_NAME = 'dsh-agent-toolkit:channel:guidance'`、`guidanceSectionText(channel: string): string`（router.ts 导出）；bot 会话 hooks.sections 恒含 guidance（order 15）+ sender（order 20）两段。

- [ ] **Step 1: 写失败测试**

router.test.ts 追加：

```ts
test('bot 会话 hooks.sections 含 IM 引导段（order 15）与 sender 段（order 20）', async () => {
  // ensure 建会话后捕获的 hooks.sections：含 name 'dsh-agent-toolkit:channel:guidance'，
  // 文本含 'ask_user_question'；sender 段仍在（现状断言保留）
})
```

basic-tools.test.ts 改断言：persona prefix 不再含「ask directly in your reply」。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- channels`
Expected: FAIL（guidance 段不存在 / persona 文案旧）

- [ ] **Step 3: 实现**

`basic-tools.ts` persona 行 config 改为与 standard 同源：

```ts
config: {
  prefix: 'You are a coding agent powered by the {{model}} model.',
  suffix: 'Your working directory is {{cwd}}.',
},
```

`router.ts`：

```ts
/** IM 引导段名：bot 会话恒注入（原 BASIC_TOOLS persona prefix 句，2026-09-16 挪入渠道段）。 */
export const GUIDANCE_SECTION_NAME = 'dsh-agent-toolkit:channel:guidance'

export function guidanceSectionText(channel: string): string {
  return `本会话经 ${channel} 渠道进行。如需用户补充信息或做出决策，优先使用 ask_user_question 工具；该工具不可用时，直接在回复中提问并等待用户下一条消息。`
}

// withSenderSection 改名为 withChannelSections，依次追加 guidance（order 15）与 sender（order 20）：
private withChannelSections(hooks: AgentHooks, bot: BotRecord, userId: string): AgentHooks {
  const guidance: AgentSection = { name: GUIDANCE_SECTION_NAME, order: 15, text: guidanceSectionText(bot.channel ?? 'unknown') }
  if (!this.injectSender) return { ...hooks, sections: [...(hooks.sections ?? []), guidance] }
  const sender: AgentSection = { name: SENDER_SECTION_NAME, order: 20, text: senderSectionText(bot.channel ?? 'unknown', userId) }
  return { ...hooks, sections: [...(hooks.sections ?? []), guidance, sender] }
}
```

（`resolveSession` 两处调用点同步改名；`injectSender=false` 时 guidance 仍注入——它与 sender 段是不同语义。）

- [ ] **Step 4: 全量测试 + typecheck + 提交**

Run: `pnpm --filter dsh-agent-toolkit test`; `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 全绿

```bash
git add packages/toolkit
git commit -m "refactor(feishu): IM 引导句从 BASIC_TOOLS persona 挪入渠道段——persona 回落 standard 同源文案"
```

---

### Task 4: QuestionCenter 渠道无关核心 + answerer

**Files:**
- Create: `packages/toolkit/src/channels/questions/center.ts`
- Create: `packages/toolkit/src/channels/questions/answerer.ts`
- Test: `packages/toolkit/src/channels/questions/center.test.ts`、`answerer.test.ts`

**Interfaces:**
- Consumes: `SessionRuntime`（`channels/ports.ts`）；`CardActionInput` / `CardActionAck`（`channels/approval/center.ts`，复用不另起类型）。
- Produces（Task 5/7/8 依赖）：
  - `QuestionItemLike { id: string; question: string; detail?: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }`
  - `QuestionRequestLike { agent?: { session: { id: unknown } }; questions: QuestionItemLike[]; signal?: AbortSignal }`
  - `QuestionAnswerLike { answers: { id: string; selected: string[]; custom?: string }[] }`
  - `QuestionView { answers: ReadonlyMap<string, { selected: string[]; custom?: string }>; toggled: ReadonlyMap<string, readonly string[]> }`
  - `QuestionPrompt { key: string; chatId: string; botName: string; questions: readonly QuestionItemLike[] }`
  - `QuestionPresentation { refresh(prompt, view): Promise<void>; finalize(prompt, view, status: 'answered'|'cancelled'): Promise<void> }`
  - `QuestionPresenter { present(prompt, view): Promise<QuestionPresentation> }`
  - `class QuestionCenter { handleRequest(req): Promise<QuestionAnswerLike|undefined>; handleCardAction(action: CardActionInput): CardActionAck|undefined; tryConsumeText(botId, chatId, userId, text): boolean; dispose(): void }`
  - `createQuestionAnswerer(centerOf: () => QuestionCenter | undefined)`

- [ ] **Step 1: 写失败测试（center.test.ts 全场景）**

fake presenter（记录 present/refresh/finalize 调用）、fake sessions map（含 `initiatorOpenId`、fake reply 带 `breakCard` spy）。用例如下（每个一个 test）：

```ts
// 1. 非自有会话（sessions 无此 sessionId）→ handleRequest 返回 undefined
// 2. 渠道无 questions presenter → 返回 undefined 且 warn
// 3. signal 已 aborted → 抛 name 'UserQuestionError'、code 'ASK_ABORTED'
// 4. 单选题点击 → resolve { answers: [{ id, selected: [label] }] }；
//    finalize(status 'answered') 被调；rt.reply.breakCard 被调
// 5. 多问题：答完第一题不 resolve（refresh 被调），全部收齐才 resolve
// 6. multi_select：toggle 两次 → refresh 携带 toggled；confirm 后才记入 answers
// 7. 取消按钮（value { kind:'question', key, cancel:true }）→ reject code 'ASK_CANCELLED'，
//    finalize(status 'cancelled')
// 8. pending 中 signal abort → reject code 'ASK_ABORTED'
// 9. 非发起人点击 → 返回 { toast: '仅会话发起人可作答' }，pending 不动
// 10. 未知 key → { toast: '该问题已作答或已失效' }
// 11. value 畸形（无 key / kind 非 'question'）→ undefined
// 12. tryConsumeText：开放题归属该 chat 最早 pending key；答完最后一题即 settle；
//     非发起人 / 无开放题 / 无 pending → false
// 13. dispose → 全部 pending 以 ASK_CANCELLED reject，卡片 finalize 'cancelled'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- questions`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 center.ts**

骨架（照 approval/center.ts 模式，完整实现）：

```ts
/** 提问中心（渠道无关）：自有 bot 会话的 user-questions ask → 渠道问答卡挂起 → 回调/文本 resolve。
 *  spec: docs/superpowers/specs/2026-09-16-feishu-full-tool-face-design.md §3（仅发起人 / 不超时 / 收齐才 resolve）。 */
import { randomUUID } from 'node:crypto'
import type { SessionRuntime } from '../ports.ts'
import type { CardActionAck, CardActionInput } from '../approval/center.ts'

// …上文 Interfaces 块的类型定义原样落地…

/** 结构兼容宿主 UserQuestionError（restoreUserQuestionError 按 name/message/code 重建实例），
 *  禁止运行时导入宿主类（双实例风险）。 */
export function questionError(message: string, code: string): Error {
  return Object.assign(new Error(message), { name: 'UserQuestionError', code })
}

interface PendingSet {
  sessionId: string
  prompt: QuestionPrompt
  presentation: QuestionPresentation
  answers: Map<string, { selected: string[]; custom?: string }>
  toggled: Map<string, string[]>
  resolve(answer: QuestionAnswerLike): void
  reject(error: unknown): void
  onAbort: () => void
}

export class QuestionCenter {
  private readonly pending = new Map<string, PendingSet>()

  constructor(
    private readonly sessions: Map<string, SessionRuntime>,
    private readonly channelFor: (botId: string) => { presenter: QuestionPresenter; botName: string } | undefined,
    private readonly warn: (message: string) => void,
    private readonly newId: () => string = randomUUID,
  ) {}

  private viewOf(entry: PendingSet): QuestionView {
    return { answers: entry.answers, toggled: entry.toggled }
  }

  private allAnswered(entry: PendingSet): boolean {
    return entry.prompt.questions.every((q) => entry.answers.has(q.id))
  }

  /** settle 公共尾：摘 pending → 定格卡片（fire-and-forget 内部自告警）→ breakCard 续接。 */
  private settle(key: string, entry: PendingSet, status: 'answered' | 'cancelled'): void {
    this.pending.delete(key)
    const rt = this.sessions.get(entry.sessionId)
    void entry.presentation.finalize(entry.prompt, this.viewOf(entry), status).catch(() => undefined)
    void rt?.reply?.breakCard?.()?.catch?.(() => undefined)
  }

  private settleAnswered(key: string, entry: PendingSet): void {
    this.settle(key, entry, 'answered')
    entry.resolve({
      answers: entry.prompt.questions.map((q) => entry.answers.get(q.id) ?? { id: q.id, selected: [] }),
    })
  }

  private settleCancelled(key: string, entry: PendingSet, code: 'ASK_CANCELLED' | 'ASK_ABORTED', message: string): void {
    this.settle(key, entry, 'cancelled')
    entry.reject(questionError(message, code))
  }

  async handleRequest(req: QuestionRequestLike): Promise<QuestionAnswerLike | undefined> {
    if (req.agent === undefined) return undefined
    const sessionId = String(req.agent.session.id)
    const rt = this.sessions.get(sessionId)
    if (rt === undefined) return undefined
    if (req.signal?.aborted === true) {
      throw questionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    }
    const channel = this.channelFor(rt.botId)
    if (channel === undefined) {
      this.warn(`[project-bot] bot "${rt.botId}" 的渠道无问答卡能力，回退其他应答通道`)
      return undefined
    }
    const key = this.newId()
    const prompt: QuestionPrompt = { key, chatId: rt.chatId, botName: channel.botName, questions: req.questions }
    const entry: Partial<PendingSet> = { sessionId, prompt, answers: new Map(), toggled: new Map() }
    let presentation: QuestionPresentation
    try {
      presentation = await channel.presenter.present(prompt, this.viewOf(entry as PendingSet))
    } catch (error) {
      this.warn(`[project-bot] 问答卡片发送失败，回退其他应答通道：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    entry.presentation = presentation
    return new Promise<QuestionAnswerLike>((resolve, reject) => {
      const full = entry as PendingSet
      full.resolve = resolve
      full.reject = reject
      full.onAbort = () => this.settleCancelled(key, full, 'ASK_ABORTED', 'ask_user_question was aborted before the user answered')
      this.pending.set(key, full)
      req.signal?.addEventListener('abort', full.onAbort, { once: true })
    })
  }

  handleCardAction(action: CardActionInput): CardActionAck | undefined {
    const value = action.value as { kind?: unknown; key?: unknown; qid?: unknown; select?: unknown; toggle?: unknown; confirm?: unknown; cancel?: unknown } | null
    if (value === null || typeof value !== 'object' || value.kind !== 'question' || typeof value.key !== 'string') return undefined
    const entry = this.pending.get(value.key)
    if (entry === undefined) return { toast: '该问题已作答或已失效' }
    const rt = this.sessions.get(entry.sessionId)
    if (rt === undefined || rt.initiatorOpenId !== action.operatorOpenId) return { toast: '仅会话发起人可作答' }
    if (value.cancel === true) {
      this.settleCancelled(value.key, entry, 'ASK_CANCELLED', 'The user dismissed the question to speak instead')
      return { toast: '已取消提问' }
    }
    if (typeof value.qid !== 'string') return undefined
    const question = entry.prompt.questions.find((q) => q.id === value.qid)
    if (question === undefined || entry.answers.has(question.id)) return { toast: '该问题已作答或已失效' }
    if (typeof value.select === 'string') {
      entry.answers.set(question.id, { selected: [value.select] })
    } else if (typeof value.toggle === 'string') {
      const current = entry.toggled.get(question.id) ?? []
      entry.toggled.set(question.id, current.includes(value.toggle) ? current.filter((l) => l !== value.toggle) : [...current, value.toggle])
      void entry.presentation.refresh(entry.prompt, this.viewOf(entry)).catch(() => undefined)
      return { toast: undefined } as CardActionAck  // 返回空 ack（无 toast）；见实现注
    } else if (value.confirm === true) {
      entry.answers.set(question.id, { selected: [...(entry.toggled.get(question.id) ?? [])] })
      entry.toggled.delete(question.id)
    } else {
      return undefined
    }
    if (this.allAnswered(entry)) {
      this.settleAnswered(value.key, entry)
      return { toast: '已提交作答' }
    }
    void entry.presentation.refresh(entry.prompt, this.viewOf(entry)).catch(() => undefined)
    return { toast: '已记录，请继续作答剩余问题' }
  }

  /** 开放题文本应答：该 chat 最早未完结且含未答开放题的 key 消费此文本（仅发起人）。 */
  tryConsumeText(botId: string, chatId: string, userId: string, text: string): boolean {
    for (const [key, entry] of this.pending) {
      if (entry.prompt.chatId !== chatId) continue
      const rt = this.sessions.get(entry.sessionId)
      if (rt === undefined || rt.botId !== botId || rt.initiatorOpenId !== userId) continue
      const open = entry.prompt.questions.find((q) => q.options === undefined && !entry.answers.has(q.id))
      if (open === undefined) continue
      entry.answers.set(open.id, { selected: [], custom: text })
      if (this.allAnswered(entry)) {
        this.settleAnswered(key, entry)
      } else {
        void entry.presentation.refresh(entry.prompt, this.viewOf(entry)).catch(() => undefined)
      }
      return true
    }
    return false
  }

  dispose(): void {
    for (const [key, entry] of [...this.pending]) {
      this.settleCancelled(key, entry, 'ASK_CANCELLED', 'question center disposed')
    }
  }
}
```

实现注：`CardActionAck.toast` 为可选键——toggle 分支返回 `{}` 即可（`toastResponse` 对无 toast 返回 undefined），上面 `as CardActionAck` 处直接写 `return {}`。

- [ ] **Step 4: 实现 answerer.ts**

```ts
/** user-questions/request waterfall answerer 工厂：自有 bot 会话走 QuestionCenter（飞书问答卡），
 *  其余 next() 透传（web 浏览器 UI）。prepend 注册与审批 answerer 同款。 */
import type { QuestionAnswerLike, QuestionCenter, QuestionRequestLike } from './center.ts'

export function createQuestionAnswerer(
  centerOf: () => QuestionCenter | undefined,
): (req: QuestionRequestLike, next: () => Promise<QuestionAnswerLike>) => Promise<QuestionAnswerLike> {
  return async (req, next) => {
    const answer = await centerOf()?.handleRequest(req)
    return answer ?? next()
  }
}
```

answerer.test.ts：center 缺席 → next 被调；center 返回 undefined → next；center 抛错（abort）→ 不透传、错误上抛。

- [ ] **Step 5: 跑测试全绿后提交**

Run: `pnpm --filter dsh-agent-toolkit test -- questions`
Expected: PASS

```bash
git add packages/toolkit/src/channels/questions
git commit -m "feat(feishu): QuestionCenter 渠道无关核心——问答挂起/按钮与文本作答/仅发起人/取消与中断语义"
```

---

### Task 5: 飞书问答卡 presenter + 卡片 JSON

**Files:**
- Create: `packages/toolkit/src/channels/questions/feishu.ts`
- Test: `packages/toolkit/src/channels/questions/feishu.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `QuestionPrompt`/`QuestionView`/`QuestionPresenter`/`QuestionPresentation`；`FeishuApi`（`channels/feishu/api.ts`）；`withRetry`（`channels/feishu/reply.ts`）；`sliceByBytes`（`channels/feishu/cards.ts`）。
- Produces: `buildQuestionCardJson(prompt, view, maxBytes): string`、`buildQuestionFinalCardJson(prompt, view, status, maxBytes): string`、`class FeishuQuestionPresenter implements QuestionPresenter`（构造 `(api: FeishuApi, maxBytes: number, log: (m: string) => void)`）。

- [ ] **Step 1: 写失败测试（feishu.test.ts）**

JSON 断言（`JSON.parse` 后结构性断言，不做字符串快照）：

```ts
// 1. 进行卡：每题一个 markdown 块；带 options 题跟 action 组（单选按钮 value = {kind:'question',key,qid,select:label}）；
//    开放题渲染提示「请直接回复消息作答」；末尾「取消本次提问」按钮 value.cancel === true
// 2. multi_select 题：按钮 value.toggle + 一个 confirm 按钮；toggled 中的 label 前缀 ✅
// 3. 已答题在 refresh 卡中渲染为只读文本「问题 + 已选/已答」，不再渲染该题按钮
// 4. plan-review：question.detail 渲染进卡片；超出 maxBytes 预算时截断并含「完整计划见会话」
// 5. 终态卡：无任何 action 元素；仅问题 + 答案；status 'cancelled' 的题标注「已取消」；
//    header template 区分 answered（green）/ cancelled（grey）
// 6. presenter：present = createCard + sendCardMessage；refresh/finalize = replaceCard 且 sequence 递增（1 起）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- questions/feishu`
Expected: FAIL

- [ ] **Step 3: 实现 feishu.ts**

```ts
/** 飞书问答卡片：cardkit 2.0 静态互动卡（按钮作答 + 取消），presenter 挂 ChannelHandle.questions。 */
import type { FeishuApi } from '../feishu/api.ts'
import { sliceByBytes } from '../feishu/cards.ts'
import { withRetry } from '../feishu/reply.ts'
import type { QuestionItemLike, QuestionPresentation, QuestionPresenter, QuestionPrompt, QuestionView } from './center.ts'

/** 单题按钮行（单选 select / 多选 toggle+confirm）；value 带 kind:'question' 供 dispatcher 路由。 */
function optionButtons(prompt: QuestionPrompt, q: QuestionItemLike, view: QuestionView): Record<string, unknown> {
  // multiSelect：toggle 按钮（toggled 中 label 加 ✅ 前缀）+ 「确认」按钮（value.confirm）
  // 单选：每个 option 一个 primary 按钮（value.select = label）
  /* … */
}

/** 卡片正文预算：maxBytes 减去结构余量（与 approval/流式卡同量级，取 2000 字节结构预留）。 */
function detailBudget(maxBytes: number): number { return Math.max(0, maxBytes - 2000) }

function questionMarkdown(q: QuestionItemLike, view: QuestionView, maxBytes: number): string {
  // 已答：`**Q**` + `> 已选：a、b` 或 `> 已答：<custom>`（custom 截断 200 字）
  // 未答：`**Q**` + detail（sliceByBytes 截断至 detailBudget，截断时追加 '\n\n…（完整计划见会话）'）+
  //        开放题追加 '\n请直接回复消息作答'
  /* … */
}

export function buildQuestionCardJson(prompt: QuestionPrompt, view: QuestionView, maxBytes: number): string {
  // header: { title: '提问', template: 'blue' }；config.summary: 'Bot 提问'
  // elements: 每题 markdown +（未答且有 options → action 组）；末尾 action 行：「取消本次提问」danger 按钮
  /* … */
}

export function buildQuestionFinalCardJson(prompt: QuestionPrompt, view: QuestionView, status: 'answered' | 'cancelled', maxBytes: number): string {
  // 无 action 元素；每题「问题 + 所选答案/回复文本」；cancelled 题标注「已取消」
  // header template answered→green / cancelled→grey
  /* … */
}

export class FeishuQuestionPresenter implements QuestionPresenter {
  constructor(
    private readonly api: FeishuApi,
    private readonly maxBytes: number,
    private readonly log: (message: string) => void,
  ) {}

  async present(prompt: QuestionPrompt, view: QuestionView): Promise<QuestionPresentation> {
    const cardId = await withRetry(() => this.api.createCard(buildQuestionCardJson(prompt, view, this.maxBytes)))
    await withRetry(() => this.api.sendCardMessage(prompt.chatId, cardId))
    let sequence = 0
    const replace = async (json: string): Promise<void> => {
      sequence += 1
      await withRetry(() => this.api.replaceCard(cardId, json, sequence))
    }
    return {
      refresh: async (p, v) => {
        try {
          await replace(buildQuestionCardJson(p, v, this.maxBytes))
        } catch (error) {
          this.log(`[project-bot] 问答卡片更新失败（card ${cardId}）：${error instanceof Error ? error.message : String(error)}`)
        }
      },
      finalize: async (p, v, status) => {
        try {
          await replace(buildQuestionFinalCardJson(p, v, status, this.maxBytes))
        } catch (error) {
          // 定格失败不吞作答结果：卡片残留按钮但回调侧已 settle（重复点击 toast 已失效）。
          this.log(`[project-bot] 问答卡片定格失败（card ${cardId}）：${error instanceof Error ? error.message : String(error)}`)
        }
      },
    }
  }
}
```

（`/* … */` 处为确定性字符串拼接/JSON 组装，照测试断言逐字段实现；approval/feishu.ts 是逐行可照抄的范本。）

- [ ] **Step 4: 跑测试全绿后提交**

Run: `pnpm --filter dsh-agent-toolkit test -- questions`
Expected: PASS

```bash
git add packages/toolkit/src/channels/questions
git commit -m "feat(feishu): 飞书问答卡 presenter——进行卡按钮组/multi_select 勾选/plan detail 截断/只读终态定格"
```

---

### Task 6: ReplyHandle.breakCard——作答后开新卡续写

**Files:**
- Modify: `packages/toolkit/src/channels/channel.ts:13-24`（ReplyHandle 加可选方法）
- Modify: `packages/toolkit/src/channels/feishu/reply.ts`（FeishuReplyHandle 实现）
- Test: `packages/toolkit/src/channels/feishu/feishu-reply.test.ts`

**Interfaces:**
- Consumes: `StreamState` / `initialStreamState` / `PENDING_CARD_ID`（`channels/feishu/cards.ts`）。
- Produces: `ReplyHandle.breakCard?(): Promise<void>`——「定格当前流式卡（不加状态行、无卡则空操作），后续 update 开新卡」。

- [ ] **Step 1: 读 `packages/toolkit/src/channels/feishu/cards.ts`，提取 StreamState 字段语义**

确认 `closedSegCount` / `cardSegs` / `carry` / `tail` 四字段在 planSync 中的作用（已完整展示段的计数方式、尾段打字机进度回卷方式），作为 Step 3 状态重置的依据。参考 `reply.ts` 的 `abandon()`（reshowTail=false 分支是最接近的先例，但 breakCard 不告警、不重置为「废弃」语义）。

- [ ] **Step 2: 写失败测试**

```ts
// 1. 有活卡：breakCard 后当前卡收到 settings streaming:false（无状态行追加）；
//    随后 update 新段 → 建新卡，新卡只含 break 之后的段（不重播旧段）
// 2. 无卡（turn 尚无产出）：breakCard 是空操作（零 API 调用），后续 update 正常建首卡
// 3. 打字机尾段未打完时 breakCard：旧卡关流，尾段未显示部分在新卡续打（不丢字）
// 4. finalize 之后 breakCard：空操作
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-reply`
Expected: FAIL（breakCard 不存在）

- [ ] **Step 4: 实现**

channel.ts ReplyHandle 加：

```ts
/** 定格当前流式卡（纯关流，不追加状态行），后续 update 开新卡续写；无卡/已 finalize 时空操作。问答卡 settle 后调用。 */
breakCard?(): Promise<void>
```

reply.ts FeishuReplyHandle 加（字段语义以 Step 1 核实为准）：

```ts
async breakCard(): Promise<void> {
  if (this.finalized) return
  // 先落定在飞的 flush（与 finalize 同款的 timer 清理 + flush + await tail）。
  if (this.timer !== undefined) {
    clearTimeout(this.timer)
    this.timer = undefined
    this.flush()
  }
  await this.tail
  const { cardId, seq, tail } = this.state
  const live = cardId !== null && cardId !== PENDING_CARD_ID
  if (live) {
    this.enqueue(() => withRetry(() => this.api.setCardStreaming(cardId, false, seq + 1)).then(() => undefined))
    await this.tail
    this.closedCardId = cardId
  }
  // 状态重置：已完整展示的段计入 closedSegCount；尾段未打完部分经 carry 在新卡续打（abandon 同款回卷，reshowTail=false）。
  this.state = {
    ...initialStreamState(),
    closedSegCount: tail !== undefined ? tail.segIndex : /* Step 1 核实的「当前卡已完整展示段数」 */,
    ...(tail !== undefined ? { carry: { segIndex: tail.segIndex, base: tail.base + tail.shownText.length } } : {}),
  }
}
```

- [ ] **Step 5: 跑测试全绿后提交**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-reply`
Expected: PASS

```bash
git add packages/toolkit/src/channels
git commit -m "feat(feishu): ReplyHandle.breakCard——定格当前流式卡、后续输出开新卡（问答卡 settle 续接用）"
```

---

### Task 7: 接线——dispatcher 路由 / ChannelHandle.questions / BotRuntime / answerer 注册 / Config

**Files:**
- Modify: `packages/toolkit/src/channels/channel.ts:58-63`（ChannelHandle 加 `questions?`）
- Modify: `packages/toolkit/src/channels/runtime.ts`（QuestionCenter 实例 + onCardAction 路由 + stopAll dispose + Inbound consumeAnswer 预备见 Task 8）
- Modify: `packages/toolkit/src/channels/feishu/index.ts`（handle 返回 questions presenter）
- Modify: `packages/toolkit/src/bots/index.ts`（config.questions 时注册 answerer；type-only 导入激活声明合并）
- Modify: `packages/toolkit/src/index.ts`（Config feishu.questions）
- Test: `packages/toolkit/src/channels/runtime.test.ts`（或新建）、`packages/toolkit/src/index.test.ts`

**Interfaces:**
- Consumes: Task 4 `QuestionCenter`/`createQuestionAnswerer`，Task 5 `FeishuQuestionPresenter`，Task 6 breakCard。
- Produces: `ChannelHandle.questions?: QuestionPresenter`；`BotRuntime.questions: QuestionCenter`；`BotsModuleConfig.questions: boolean`（Config 默认 true）。

- [ ] **Step 1: 写失败测试**

```ts
// runtime.test.ts：
// 1. onCardAction 路由：value.kind === 'question' → questions.handleCardAction；无 kind → approval.handleCardAction
// 2. stopAll 调用 questions.dispose
// index.test.ts：
// 3. Config({}) 的 feishu.questions === true
// 4. 兼容断言：Config({ feishu: { ...默认, /* 存量多余键 */ } })——agentTeamPreset 含 botsId 的多余键不炸
//    （schemastery 对多余键宽容；若此断言失败，Task 1 删掉的 botsId 需以 deprecated 无操作键加回 schema）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- runtime`; `pnpm --filter dsh-agent-toolkit test -- index`
Expected: FAIL

- [ ] **Step 3: 实现**

- channel.ts：
  ```ts
  import type { QuestionPresenter } from './questions/center.ts'
  // ChannelHandle 加：
  /** 该渠道的问答卡能力（user-questions 应答端；缺席 = ask 回退其他应答通道）。 */
  questions?: QuestionPresenter
  ```
- runtime.ts：照 approval 同款构造：
  ```ts
  readonly questions: QuestionCenter
  // constructor 内：
  this.questions = new QuestionCenter(
    this.sessions,
    (botId) => {
      const presenter = this.handles.get(botId)?.questions
      if (presenter === undefined) return undefined
      return { presenter, botName: this.deps.bots.get(botId)?.name ?? botId }
    },
    (m) => deps.log.warn(m),
  )
  ```
  reconcile 的 io 改为按 kind 路由：
  ```ts
  onCardAction: (action) => {
    const kind = (action.value as { kind?: unknown } | null | undefined)?.kind
    return kind === 'question' ? this.questions.handleCardAction(action) : this.approval.handleCardAction(action)
  },
  ```
  stopAll 加 `this.questions.dispose()`（approval.dispose() 旁）。
- feishu/index.ts：handle 返回加 `questions: new FeishuQuestionPresenter(api, tunables.cardMaxBytes, log)`。
- bots/index.ts：顶部加 type-only 导入（照 dsh-user-approval 注释先例）：
  ```ts
  // type-only：激活 user-questions/request waterfall 的声明合并（approval/request 同款先例）。
  import type {} from '@deepseek-ai/dsh-user-questions'
  ```
  并在 approval answerer 注册旁加：
  ```ts
  // 问答 answerer：prepend 与审批同款；runtime 未启动/非自有会话/发卡失败时 next() 透传。
  if (config.questions) {
    ctx.on('user-questions/request', createQuestionAnswerer(() => runtime?.questions), { prepend: true })
  }
  ```
  `BotsModuleConfig` 加 `questions: boolean`（JSDoc：「飞书问答卡：bot 会话的 ask_user_question / plan 评审改由飞书卡片作答（仅会话发起人可答）」）。
- index.ts Config feishu 块：`questions: z.boolean().default(true)` 加进 z.object 与 `.default` 字面量。

- [ ] **Step 4: 全量测试 + typecheck + 提交**

Run: `pnpm --filter dsh-agent-toolkit test`; `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 全绿

```bash
git add packages/toolkit
git commit -m "feat(feishu): user-questions 应答端接线——ChannelHandle.questions/回调按 kind 路由/feishu.questions 开关默认开"
```

---

### Task 8: inbound 开放题文本拦截

**Files:**
- Modify: `packages/toolkit/src/channels/inbound.ts`（handle() 指令分流后、router.ensure 前拦截）
- Modify: `packages/toolkit/src/channels/runtime.ts`（Inbound deps 接 consumeAnswer）
- Test: `packages/toolkit/src/channels/inbound.test.ts`

**Interfaces:**
- Consumes: Task 4 `QuestionCenter.tryConsumeText(botId, chatId, userId, text): boolean`。
- Produces: `InboundDeps.consumeAnswer?: (botId: string, chatId: string, userId: string, text: string) => boolean`。

- [ ] **Step 1: 写失败测试**

```ts
// 1. pending 开放题 + 发起人纯文本消息 → consumeAnswer 返回 true：不建/复用会话（router.ensure 未被调）、
//    不进队列、不发排队 notice、不 followup
// 2. 非发起人消息 → consumeAnswer false → 走正常流程
// 3. 带图片消息（loadImages 在场）不拦截，走正常流程
// 4. 指令（/stop 等）优先于拦截（pending 中 /stop 仍生效）
// 5. consumeAnswer 缺省（deps 未传）→ 行为与现状一致
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- inbound`
Expected: FAIL

- [ ] **Step 3: 实现**

inbound.ts `handle()` 内，全部指令分支之后、`router.ensure` 之前插入：

```ts
// 开放题作答拦截：该 chat 有 pending 问答且为发起人纯文本 → 作为答案消费，
// 不进队列、不触发新 turn（拦截点必须在排队逻辑之前）。
if (msg.loadImages === undefined && msg.text.length > 0
  && this.deps.consumeAnswer?.(msg.botId, msg.chatId, msg.userId, msg.text) === true) {
  return
}
```

runtime.ts Inbound 构造 deps 加：

```ts
consumeAnswer: (botId, chatId, userId, text) => this.questions.tryConsumeText(botId, chatId, userId, text),
```

- [ ] **Step 4: 全量测试 + typecheck + 提交**

Run: `pnpm --filter dsh-agent-toolkit test`; `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 全绿

```bash
git add packages/toolkit
git commit -m "feat(feishu): inbound 开放题文本拦截——发起人下一条文本直接作答，不排队不触发新 turn"
```

---

### Task 9: 文档同步与最终门禁

**Files:**
- Modify: `docs/domains/agents.md`（内置 preset 段删 agent-bot；会话工具面段改为「bot 会话挂 agent-team，fallback 为 BASIC_TOOLS standing scope」）
- Modify: `docs/domains/feishu.md`（审批卡小节删「工具面不含 ask_user」句，新增问答卡小节：按钮/文本作答、仅发起人、取消按钮、定格只读、breakCard 续接、feishu.questions 开关）
- Modify: `docs/domains/delegation.md`（子会话继承面 agent-bot → agent-team 表述）
- Modify: `docs/superpowers/specs/2026-09-16-feishu-full-tool-face-design.md`（头部状态「待实施」→「已实施」）

- [ ] **Step 1: 改三份域文档 + spec 状态**

要点（逐文档对照现行表述改，不整篇重写）：
- agents.md：「内置 preset 自动生成」段删 agent-bot 句；「会话创建与工具面」段 bot 会话例外改为「挂 agent-team（agentTeamPreset.id）；mount 失败回退 BASIC_TOOLS standing scope」；白名单求交底面表述同步。
- feishu.md：§审批卡片段末「bot 会话工具面不含 ask_user（守护测试钉住）…」句删除，替换为问答卡小节（参照本计划 Task 4-8 行为）；运维指令面不动。
- delegation.md：bot 会话委派子会话继承面表述 agent-bot → agent-team。

- [ ] **Step 2: 全量门禁**

Run: `pnpm --filter dsh-agent-toolkit test`; `pnpm --filter dsh-agent-toolkit typecheck`; `pnpm --filter dsh-agent-toolkit bundle`
Expected: 全绿 + bundle 成功

- [ ] **Step 3: 真实回路验收（用户配合）**

`pnpm dsh web --patch ...` 起开发回路：飞书 bot 发消息 → 确认工具面含 web_search/todo_write/ask_user_question/cron_*；让模型调 ask_user_question → 问答卡作答 → 确认定格只读 + 新卡续写；`/new` 重建会话确认 preset mount 无 warn。

- [ ] **Step 4: 提交**

```bash
git add docs
git commit -m "docs(feishu): 工具面对齐现行事实同步（agents/feishu/delegation 域文档 + spec 状态）"
```
