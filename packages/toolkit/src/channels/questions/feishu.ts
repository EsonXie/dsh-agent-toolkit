/** 飞书问答卡片：cardkit 2.0 静态互动卡（按钮作答 + 取消），presenter 挂 ChannelHandle.questions。 */
import type { FeishuApi } from '../feishu/api.ts'
import { sliceByBytes } from '../feishu/cards.ts'
import { withRetry } from '../feishu/reply.ts'
import type { QuestionItemLike, QuestionPresentation, QuestionPresenter, QuestionPrompt, QuestionView } from './center.ts'

/** maxBytes 中留给 JSON 骨架与按钮行的结构余量（与 approval/流式卡同量级）。 */
const STRUCTURE_RESERVE_BYTES = 2000

/** 自定义答案展示上限（按码点计）。 */
const CUSTOM_ANSWER_MAX_CHARS = 200

/** plan detail 被预算截断时的去向标注。 */
const TRUNCATION_NOTICE = '\n\n…（完整计划见会话）'

/** 开放题作答指引（inbound 文本拦截语义）。 */
const OPEN_ANSWER_HINT = '请直接回复消息作答'

/** 卡片正文预算：maxBytes 减去结构余量（与 approval/流式卡同量级，取 2000 字节结构预留）。 */
function detailBudget(maxBytes: number): number { return Math.max(0, maxBytes - STRUCTURE_RESERVE_BYTES) }

/** 按码点截头（不劈开代理对）。 */
function sliceChars(text: string, maxChars: number): string {
  const chars = [...text]
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('')
}

/** 答案只读行：文本作答 → 已答（受 200 字与卡片预算双重约束）；选项作答 → 已选。 */
function answerLine(answer: { selected: string[]; custom?: string }, maxBytes: number): string {
  if (answer.custom !== undefined) {
    const budget = Math.min(CUSTOM_ANSWER_MAX_CHARS, detailBudget(maxBytes))
    return `> 已答：${sliceChars(answer.custom, budget)}`
  }
  return `> 已选：${answer.selected.join('、')}`
}

/** 单题 markdown：已答转只读；未答渲染 detail（超预算截断并标注）与开放题作答指引。 */
function questionMarkdown(q: QuestionItemLike, view: QuestionView, maxBytes: number): string {
  const lines = [`**${q.question}**`]
  const answer = view.answers.get(q.id)
  if (answer !== undefined) {
    lines.push(answerLine(answer, maxBytes))
    return lines.join('\n')
  }
  if (q.detail !== undefined && q.detail.length > 0) {
    const shown = sliceByBytes(q.detail, detailBudget(maxBytes))
    lines.push(shown === q.detail ? shown : `${shown}${TRUNCATION_NOTICE}`)
  }
  if (q.options === undefined) lines.push(OPEN_ANSWER_HINT)
  return lines.join('\n')
}

/** 回调按钮：value 带 kind:'question' 供 dispatcher 路由，其余字段由 QuestionCenter.handleCardAction 消费。 */
function questionButton(
  prompt: QuestionPrompt,
  q: QuestionItemLike,
  text: string,
  type: 'primary' | 'danger' | 'default',
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value: { kind: 'question', key: prompt.key, qid: q.id, ...extra } }],
  }
}

/** 单题按钮行（单选 select / 多选 toggle+confirm）；开放题或已答题返回 undefined（不渲染按钮）。 */
function optionButtons(prompt: QuestionPrompt, q: QuestionItemLike, view: QuestionView): Record<string, unknown> | undefined {
  if (q.options === undefined || view.answers.has(q.id)) return undefined
  if (q.multiSelect === true) {
    const toggled = view.toggled.get(q.id) ?? []
    const actions = q.options.map((option) => toggled.includes(option.label)
      ? questionButton(prompt, q, `✅ ${option.label}`, 'primary', { toggle: option.label })
      : questionButton(prompt, q, option.label, 'default', { toggle: option.label }))
    actions.push(questionButton(prompt, q, '确认', 'primary', { confirm: true }))
    return { tag: 'action', actions }
  }
  return { tag: 'action', actions: q.options.map((option) => questionButton(prompt, q, option.label, 'primary', { select: option.label })) }
}

/** 整次提问的取消按钮（整卡重渲染不产生客户端状态）。 */
function cancelButton(prompt: QuestionPrompt): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '取消本次提问' },
    type: 'danger',
    behaviors: [{ type: 'callback', value: { kind: 'question', key: prompt.key, cancel: true } }],
  }
}

/** 进行卡：每题 markdown +（未答有 options → 按钮组）；末尾取消按钮。 */
export function buildQuestionCardJson(prompt: QuestionPrompt, view: QuestionView, maxBytes: number): string {
  const elements: Record<string, unknown>[] = []
  for (const q of prompt.questions) {
    elements.push({ tag: 'markdown', content: questionMarkdown(q, view, maxBytes) })
    const action = optionButtons(prompt, q, view)
    if (action !== undefined) elements.push(action)
  }
  elements.push({ tag: 'action', actions: [cancelButton(prompt)] })
  return JSON.stringify({
    schema: '2.0',
    config: { summary: { content: 'Bot 提问' } },
    header: { title: { tag: 'plain_text', content: '提问' }, template: 'blue' },
    body: { elements },
  })
}

/** 终态卡：无任何按钮，仅问题 + 答案；未作答题在取消语义下标注「已取消」。 */
export function buildQuestionFinalCardJson(
  prompt: QuestionPrompt,
  view: QuestionView,
  status: 'answered' | 'cancelled',
  maxBytes: number,
): string {
  const elements = prompt.questions.map((q) => {
    const answer = view.answers.get(q.id)
    const lines = [`**${q.question}**`]
    lines.push(answer !== undefined ? answerLine(answer, maxBytes) : status === 'cancelled' ? '> 已取消' : '> 未作答')
    return { tag: 'markdown', content: lines.join('\n') }
  })
  const statusLine = status === 'answered' ? '✅ 已作答' : '⏹ 已取消'
  return JSON.stringify({
    schema: '2.0',
    config: { summary: { content: `提问 · ${statusLine}` } },
    header: { title: { tag: 'plain_text', content: `提问 · ${statusLine}` }, template: status === 'answered' ? 'green' : 'grey' },
    body: { elements },
  })
}

/** 飞书问答能力：present = 建卡 + 发消息；refresh/finalize = replaceCard（sequence 从 1 起，create/send 不占）。 */
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
