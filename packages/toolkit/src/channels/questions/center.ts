/** 提问中心（渠道无关）：自有 bot 会话的 user-questions ask → 渠道问答卡挂起 → 回调/文本 resolve。
 *  spec: docs/superpowers/specs/2026-09-16-feishu-full-tool-face-design.md §3（仅发起人 / 不超时 / 收齐才 resolve）。 */
import { randomUUID } from 'node:crypto'
import type { DebugSink } from '../channel.ts'
import type { SessionRuntime } from '../ports.ts'
import type { CardActionAck, CardActionInput } from '../approval/center.ts'

/** 单个问题的结构子集（宿主 user-questions 的 question 形态，不依赖宿主包类型）。 */
export interface QuestionItemLike {
  id: string
  question: string
  detail?: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

/** waterfall answerer 收到的请求结构（结构子集化，不依赖宿主包类型）。 */
export interface QuestionRequestLike {
  agent?: { session: { id: unknown } }
  questions: QuestionItemLike[]
  signal?: AbortSignal
}

/** 作答结果（与宿主 ask 的 answers 形态结构兼容）。 */
export interface QuestionAnswerLike {
  answers: { id: string; selected: string[]; custom?: string }[]
}

/** 卡片渲染视图：已答集合（按键 = 问题 id）。 */
export interface QuestionView {
  answers: ReadonlyMap<string, { selected: string[]; custom?: string }>
}

/** 发给渠道的问答卡内容。 */
export interface QuestionPrompt {
  key: string
  chatId: string
  botName: string
  questions: readonly QuestionItemLike[]
  /** 话题锚点：发卡时回复到触发本 turn 的入站消息；replyAnchor 缺席则不带此键。 */
  replyToMessageId?: string
}

/** 一次已展示的问答卡：finalize 定格为只读终态（form 卡无中间态，整卡重放会抹掉用户填写态，故无 refresh）。 */
export interface QuestionPresentation {
  finalize(prompt: QuestionPrompt, view: QuestionView, status: 'answered' | 'cancelled'): Promise<void>
}

/** 渠道侧问答能力：发卡 → 返回定格句柄。 */
export interface QuestionPresenter {
  present(prompt: QuestionPrompt): Promise<QuestionPresentation>
}

/** channelFor 的返回：该 bot 的问答能力 + 展示名。 */
export interface QuestionChannel {
  presenter: QuestionPresenter
  botName: string
}

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
  signal: AbortSignal | undefined
  resolve(answer: QuestionAnswerLike): void
  reject(error: unknown): void
  onAbort: () => void
}

type AnswerMap = Map<string, { selected: string[]; custom?: string }>

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

export class QuestionCenter {
  private readonly pending = new Map<string, PendingSet>()

  constructor(
    private readonly sessions: Map<string, SessionRuntime>,
    private readonly channelFor: (botId: string) => QuestionChannel | undefined,
    private readonly warn: (message: string) => void,
    private readonly newId: () => string = randomUUID,
    // 生产排障（2026-09-17）：fall-through 分支的 warn 在 dsh web 不可见，回退原因只能靠 debugLog 分辨。
    private readonly debug?: DebugSink,
  ) {}

  private viewOf(entry: PendingSet): QuestionView {
    return { answers: entry.answers }
  }

  /** 题是否已答：有选中项或非空自定义文本。 */
  private isAnswered(entry: PendingSet, qid: string): boolean {
    const answer = entry.answers.get(qid)
    return answer !== undefined && (answer.selected.length > 0 || (answer.custom !== undefined && answer.custom.trim().length > 0))
  }

  private allAnswered(entry: PendingSet): boolean {
    return entry.prompt.questions.every((q) => this.isAnswered(entry, q.id))
  }

  /** form_value 按位置序号聚合覆写 answers；某题 formValue 全空则保留既有答案（文本拦截先行作答）。 */
  private mergeFormValue(entry: PendingSet, formValue: Record<string, unknown>): void {
    entry.prompt.questions.forEach((q, i) => {
      if (q.options === undefined) {
        const custom = readText(formValue[`q${i}`])
        if (custom !== undefined) entry.answers.set(q.id, { selected: [], custom })
        return
      }
      const selected = q.multiSelect === true
        // 多选 checker 行：form_value 按 q{i}__opt{j} 回传布尔（true / 'true' 均视为勾选）。
        ? q.options.filter((_, j) => { const v = formValue[`q${i}__opt${j}`]; return v === true || v === 'true' }).map((o) => o.label)
        : readSelected(formValue[`q${i}`])
      const custom = readText(formValue[`q${i}__custom`])
      if (selected.length === 0 && custom === undefined) return
      entry.answers.set(q.id, { selected, ...(custom !== undefined ? { custom } : {}) })
    })
  }

  /** settle 公共尾：摘 pending → 注销 abort 监听 → 定格卡片（fire-and-forget，失败由 presenter 自告警）→ breakCard 续接输出。 */
  private settle(key: string, entry: PendingSet, status: 'answered' | 'cancelled'): void {
    this.pending.delete(key)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    void entry.presentation.finalize(entry.prompt, this.viewOf(entry), status).catch(() => undefined)
    const reply = this.sessions.get(entry.sessionId)?.reply
    void reply?.breakCard?.()?.catch?.(() => undefined)
  }

  private settleAnswered(key: string, entry: PendingSet): void {
    this.settle(key, entry, 'answered')
    entry.resolve({
      answers: entry.prompt.questions.map((q) => {
        const answer = entry.answers.get(q.id)
        return answer === undefined ? { id: q.id, selected: [] } : { id: q.id, ...answer }
      }),
    })
  }

  private settleCancelled(key: string, entry: PendingSet, code: 'ASK_CANCELLED' | 'ASK_ABORTED', message: string): void {
    this.settle(key, entry, 'cancelled')
    entry.reject(questionError(message, code))
  }

  async handleRequest(req: QuestionRequestLike): Promise<QuestionAnswerLike | undefined> {
    if (req.agent === undefined) {
      this.debug?.({ event: 'question-fallback', reason: 'no-agent', qCount: req.questions.length })
      return undefined
    }
    const sessionId = String(req.agent.session.id)
    const rt = this.sessions.get(sessionId)
    if (rt === undefined) {
      this.debug?.({ event: 'question-fallback', reason: 'session-not-found', sessionId, qCount: req.questions.length })
      return undefined
    }
    // 已取消的 ask 不发卡不回退：直接抛（plan-mode 的 catch 依赖该错误类型翻译「用户取消」）。
    if (req.signal?.aborted === true) {
      throw questionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    }
    const channel = this.channelFor(rt.botId)
    if (channel === undefined) {
      this.debug?.({ event: 'question-fallback', reason: 'no-channel', sessionId, botId: rt.botId, qCount: req.questions.length })
      this.warn(`[project-bot] bot "${rt.botId}" 的渠道无问答卡能力，回退其他应答通道`)
      return undefined
    }
    const key = this.newId()
    const prompt: QuestionPrompt = {
      key, chatId: rt.chatId, botName: channel.botName, questions: req.questions,
      // 话题锚点：rt.replyAnchor 由入站在 dispatch 时写入；缺席时不带键，行为零变化。
      ...(rt.replyAnchor !== undefined ? { replyToMessageId: rt.replyAnchor } : {}),
    }
    const answers: AnswerMap = new Map()
    let presentation: QuestionPresentation
    try {
      presentation = await channel.presenter.present(prompt)
    } catch (error) {
      this.debug?.({
        event: 'question-fallback', reason: 'present-failed', sessionId, botId: rt.botId, qCount: req.questions.length,
        error: error instanceof Error ? error.message : String(error),
      })
      this.warn(`[project-bot] 问答卡片发送失败，回退其他应答通道：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    this.debug?.({ event: 'question-presented', key, sessionId, botId: rt.botId, chatId: rt.chatId, qCount: req.questions.length })
    return new Promise<QuestionAnswerLike>((resolve, reject) => {
      const entry: PendingSet = {
        sessionId, prompt, presentation, answers, signal: req.signal, resolve, reject,
        onAbort: () => this.settleCancelled(key, entry, 'ASK_ABORTED', 'ask_user_question was aborted before the user answered'),
      }
      this.pending.set(key, entry)
      // 发卡期间 abort 的竞态兜底：已 aborted 的 signal 不会触发后注册的监听，
      // 若不再查一次，ask 将永不 settle（spec §3.2：abort → ASK_ABORTED reject + 卡片定格取消）。
      if (req.signal?.aborted === true) {
        this.settleCancelled(key, entry, 'ASK_ABORTED', 'ask_user_question was aborted before the user answered')
        return
      }
      req.signal?.addEventListener('abort', entry.onAbort, { once: true })
    })
  }

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

  /** 开放题文本应答：该 chat 最早未完结且含未答开放题的 key 消费此文本（仅发起人）。
   *  话题隔离：rt.threadId 须与入站 threadId 一致（同 chat 的不同话题 / 非话题互不串答）。 */
  tryConsumeText(botId: string, chatId: string, threadId: string | undefined, userId: string, text: string): boolean {
    for (const [key, entry] of this.pending) {
      if (entry.prompt.chatId !== chatId) continue
      const rt = this.sessions.get(entry.sessionId)
      if (rt === undefined || rt.botId !== botId || rt.threadId !== threadId || rt.initiatorOpenId !== userId) continue
      const open = entry.prompt.questions.find((q) => q.options === undefined && !entry.answers.has(q.id))
      if (open === undefined) continue
      entry.answers.set(open.id, { selected: [], custom: text })
      if (this.allAnswered(entry)) this.settleAnswered(key, entry)
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
