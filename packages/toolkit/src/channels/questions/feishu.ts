/** 飞书问答卡片：cardkit 2.0 单 form 容器（下拉/勾选/输入 + 统一提交 + 常驻跳过），presenter 挂 ChannelHandle.questions。 */
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

/** 卡片正文预算：maxBytes 减去结构余量（与 approval/流式卡同量级，取 2000 字节结构预留）。 */
function detailBudget(maxBytes: number): number { return Math.max(0, maxBytes - STRUCTURE_RESERVE_BYTES) }

/** 按码点截头（不劈开代理对）。 */
function sliceChars(text: string, maxChars: number): string {
  const chars = [...text]
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('')
}

/** 答案只读行：文本作答 → 已答；选项作答 → 已选；两者并存 → 单行并列（自定义文本同受 200 字与卡片预算双重约束）。 */
function answerLine(answer: { selected: string[]; custom?: string }, maxBytes: number): string {
  if (answer.custom !== undefined) {
    const budget = Math.min(CUSTOM_ANSWER_MAX_CHARS, detailBudget(maxBytes))
    const custom = sliceChars(answer.custom, budget)
    return answer.selected.length > 0
      ? `> 已选：${answer.selected.join('、')} ｜ 补充：${custom}`
      : `> 已答：${custom}`
  }
  return `> 已选：${answer.selected.join('、')}`
}

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
