import { expect, test, vi } from 'vitest'
import { buildQuestionCardJson, buildQuestionFinalCardJson, FeishuQuestionPresenter } from './feishu.ts'
import {
  QuestionCenter,
  type QuestionItemLike,
  type QuestionPresentation,
  type QuestionPrompt,
  type QuestionView,
} from './center.ts'
import type { FeishuApi } from '../feishu/api.ts'
import type { SessionRuntime } from '../ports.ts'

interface ButtonLike {
  tag: string
  type?: string
  text: { tag: string; content: string }
  form_action_type?: string
  name?: string
  behaviors: { type: string; value: Record<string, unknown> }[]
}

interface ElementLike {
  tag: string
  content?: string
  name?: string
  options?: { text: { tag: string; content: string }; value: string }[]
  form_action_type?: string
  elements?: ElementLike[]
  columns?: { tag: string; width?: string; elements: ElementLike[] }[]
}

interface CardLike {
  schema: string
  config: { summary: { content: string } }
  header: { title: { tag: string; content: string }; template: string }
  body: { elements: ElementLike[] }
}

function cardOf(json: string): CardLike {
  return JSON.parse(json) as CardLike
}

/** 进行卡的 form 容器（card JSON 2.0 禁 action 容器，一律单 form）。 */
function formOf(card: CardLike): ElementLike {
  const form = card.body.elements.find((e) => e.tag === 'form')
  if (form === undefined) throw new Error('卡片无 form 容器')
  return form
}

/** markdown 文本：进行卡取 form 内，终态卡（无 form）取 body 直排。 */
function markdowns(card: CardLike): string[] {
  const source = card.body.elements.find((e) => e.tag === 'form')?.elements ?? card.body.elements
  return source.filter((e) => e.tag === 'markdown').map((e) => e.content ?? '')
}

const FIELD_TAGS = new Set(['select_static', 'multi_select_static', 'input'])

/** form 内交互组件（选择器/输入框）序列。 */
function fields(card: CardLike): ElementLike[] {
  return (formOf(card).elements ?? []).filter((e) => FIELD_TAGS.has(e.tag))
}

function collectButtons(elements: ElementLike[]): ButtonLike[] {
  const out: ButtonLike[] = []
  for (const e of elements) {
    if (e.tag === 'button') out.push(e as ElementLike & ButtonLike)
    if (e.elements !== undefined) out.push(...collectButtons(e.elements))
    if (e.columns !== undefined) for (const c of e.columns) out.push(...collectButtons(c.elements))
  }
  return out
}

/** 整卡递归收集按钮（含 column_set 内与 body 末尾跳过）。 */
function buttons(card: CardLike): ButtonLike[] {
  return collectButtons(card.body.elements)
}

const CHOICE: QuestionItemLike = { id: 'q1', question: '选一个颜色', options: [{ label: '红' }, { label: '蓝' }] }
const OPEN: QuestionItemLike = { id: 'q2', question: '补充说明' }
const MULTI: QuestionItemLike = { id: 'q3', question: '多选', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] }

function promptOf(questions: QuestionItemLike[]): QuestionPrompt {
  return { key: 'k1', chatId: 'oc_chat1', botName: '评审', questions }
}

function viewOf(answers: [string, { selected: string[]; custom?: string }][] = []): QuestionView {
  return { answers: new Map(answers) }
}

test('进行卡：单 form 容器；每题 markdown + 对应组件；提交按钮在 form 底部；跳过按钮常驻 body 末尾', () => {
  const card = cardOf(buildQuestionCardJson(promptOf([CHOICE, MULTI, OPEN]), 20_000))
  expect(card.schema).toBe('2.0')
  expect(card.config.summary.content).toBe('Bot 提问')
  expect(card.header).toMatchObject({ title: { tag: 'plain_text', content: '提问' }, template: 'blue' })
  expect(JSON.stringify(card)).not.toContain('"action"')
  const form = formOf(card)
  expect(form.name).toBe('q')
  // 组件序列：select_static + input、multi_select_static + input、input（开放）
  const elements = fields(card)
  expect(elements.map((f) => [f.tag, f.name])).toEqual([
    ['select_static', 'q0'], ['input', 'q0__custom'],
    ['multi_select_static', 'q1'], ['input', 'q1__custom'],
    ['input', 'q2'],
  ])
  // 选项 value = label（form_value 直接回传 label）
  const single = elements[0]!
  expect(single.options).toEqual([
    { text: { tag: 'plain_text', content: '红' }, value: '红' },
    { text: { tag: 'plain_text', content: '蓝' }, value: '蓝' },
  ])
  // form 内组件不带 required / behaviors
  for (const f of elements) {
    expect(f).not.toHaveProperty('required')
    expect(f).not.toHaveProperty('behaviors')
  }
  // 提交按钮：form 内、form_action_type submit、callback value 带 submit
  const submit = buttons(card).find((b) => b.form_action_type === 'submit')!
  expect(submit.name).toBe('btn_submit')
  expect(submit.behaviors[0]!.value).toEqual({ kind: 'question', key: 'k1', submit: true })
  // 跳过按钮：body 末尾（form 外）、cancel
  const skip = buttons(card).find((b) => b.behaviors[0]!.value['cancel'] === true)!
  expect(skip).toMatchObject({ tag: 'button', type: 'danger', text: { content: '跳过本次提问' } })
  expect(skip.behaviors[0]!.value).toEqual({ kind: 'question', key: 'k1', cancel: true })
  // 提交在 form 内、跳过在 form 外末尾
  expect(form.elements!).toContainEqual(expect.objectContaining({ tag: 'column_set' }))
  expect(card.body.elements.at(-1)).toBe(skip)
})

test('进行卡：plan detail 截断与「完整计划见会话」标注保留', () => {
  const detail = `计划开始\n${'P'.repeat(5000)}`
  const prompt = promptOf([{ id: 'q1', question: '退出计划模式？', detail, options: [{ label: '批准' }, { label: '继续规划' }] }])
  const full = markdowns(cardOf(buildQuestionCardJson(prompt, 20_000)))[0]!
  expect(full).toContain('计划开始')
  expect(full).toContain('P'.repeat(5000))
  expect(full).not.toContain('完整计划见会话')
  const smallJson = buildQuestionCardJson(prompt, 3000)
  const small = markdowns(cardOf(smallJson))[0]!
  expect(small).toContain('计划开始')
  expect(small).toContain('P'.repeat(900))
  expect(small).not.toContain('P'.repeat(1000))
  expect(small).toContain('完整计划见会话')
  expect(fields(cardOf(smallJson))[0]!.options).toContainEqual({ text: { tag: 'plain_text', content: '批准' }, value: '批准' })
})

test('终态卡：保留全部题目与回答、无任何交互组件；cancelled 题标「已取消」', () => {
  const answered = viewOf([['q1', { selected: ['蓝'] }], ['q2', { selected: [], custom: '就这样' }]])
  const green = cardOf(buildQuestionFinalCardJson(promptOf([CHOICE, OPEN]), answered, 'answered', 20_000))
  expect(green.header.template).toBe('green')
  expect(buttons(green)).toHaveLength(0)
  expect(JSON.stringify(green)).not.toContain('"button"')
  const md = markdowns(green)
  expect(md).toHaveLength(2)
  expect(md[0]).toContain('已选：蓝')
  expect(md[1]).toContain('已答：就这样')
  // selected + custom 并存：定格卡同时呈现所选选项与自定义文本（mergeFormValue 会产出两者并存）
  const mixed = cardOf(buildQuestionFinalCardJson(promptOf([CHOICE]), viewOf([['q1', { selected: ['红'], custom: '别选蓝' }]]), 'answered', 20_000))
  expect(markdowns(mixed)[0]).toContain('已选：红')
  expect(markdowns(mixed)[0]).toContain('补充：别选蓝')
  const grey = cardOf(buildQuestionFinalCardJson(promptOf([CHOICE, OPEN]), viewOf(), 'cancelled', 20_000))
  expect(grey.header.template).toBe('grey')
  expect(buttons(grey)).toHaveLength(0)
  expect(markdowns(grey)[0]).toContain('已取消')
})

function fakeApi() {
  const createCard = vi.fn<(cardJson: string) => Promise<string>>(async () => 'card_1')
  const sendCardMessage = vi.fn<(chatId: string, cardId: string) => Promise<void>>(async () => undefined)
  const replaceCard = vi.fn<(cardId: string, cardJson: string, sequence: number) => Promise<void>>(async () => undefined)
  return { api: { createCard, sendCardMessage, replaceCard } as unknown as FeishuApi, createCard, sendCardMessage, replaceCard }
}

test('presenter：present = createCard + sendCardMessage；finalize = replaceCard 定格（sequence 1）', async () => {
  const { api, createCard, sendCardMessage, replaceCard } = fakeApi()
  const logs: string[] = []
  const presenter = new FeishuQuestionPresenter(api, 20_000, (m) => logs.push(m))
  const presentation = await presenter.present(promptOf([CHOICE, OPEN]))
  expect(createCard).toHaveBeenCalledTimes(1)
  expect(JSON.parse(createCard.mock.calls[0]![0])).toMatchObject({ schema: '2.0' })
  expect(sendCardMessage).toHaveBeenCalledWith('oc_chat1', 'card_1')
  await presentation.finalize(promptOf([CHOICE, OPEN]), viewOf([['q1', { selected: ['红'] }]]), 'answered')
  expect(replaceCard.mock.calls.map((c) => c[2])).toEqual([1])
  expect(replaceCard.mock.calls[0]![0]).toBe('card_1')
  expect(JSON.parse(replaceCard.mock.calls[0]![1])).toMatchObject({ header: { template: 'green' } })
  expect(logs).toEqual([])
})

test('finalize 失败被吞（仅告警），不向调用方抛', async () => {
  const { api, replaceCard } = fakeApi()
  replaceCard.mockRejectedValue(new Error('replace boom'))
  const logs: string[] = []
  const presenter = new FeishuQuestionPresenter(api, 20_000, (m) => logs.push(m))
  const presentation = await presenter.present(promptOf([CHOICE]))
  await expect(presentation.finalize(promptOf([CHOICE]), viewOf(), 'cancelled')).resolves.toBeUndefined()
  expect(logs).toHaveLength(1)
  expect(logs[0]).toContain('replace boom')
})

function fakeRt(sessionId: string): SessionRuntime {
  return {
    botId: 'reviewer',
    chatId: 'oc_chat1',
    sessionId,
    initiatorOpenId: 'ou_initiator',
    agent: { sessionId, followup: () => undefined, cancel: () => undefined, whenIdle: async () => undefined, dispose: async () => undefined },
    reply: { beginTurn: async () => undefined, update: async () => undefined, finalize: async () => undefined, notice: async () => undefined },
    inflight: undefined,
    tail: Promise.resolve(),
    turn: undefined,
    retiring: false,
  }
}

test('卡片提交按钮 value 与 QuestionCenter.handleCardAction 对接：form_value 聚合 resolve', async () => {
  let captured: QuestionPrompt | undefined
  const presentation: QuestionPresentation = { finalize: async () => undefined }
  const sessions = new Map<string, SessionRuntime>()
  const center = new QuestionCenter(
    sessions,
    () => ({ botName: '评审', presenter: { present: async (p) => { captured = p; return presentation } } }),
    () => undefined,
  )
  sessions.set('s1', fakeRt('s1'))
  const pending = center.handleRequest({ agent: { session: { id: 's1' } }, questions: [CHOICE, MULTI] })
  await vi.waitFor(() => { expect(captured).toBeDefined() })
  const card = cardOf(buildQuestionCardJson(captured!, 20_000))
  const submitValue = buttons(card).find((b) => b.form_action_type === 'submit')!.behaviors[0]!.value
  const ack = center.handleCardAction({
    chatId: 'oc_chat1',
    operatorOpenId: 'ou_initiator',
    value: submitValue,
    formValue: { q0: '红', q1: ['甲'] },
  })
  expect(ack).toEqual({ toast: '已提交作答' })
  await expect(pending).resolves.toMatchObject({ answers: expect.any(Array) })
})
