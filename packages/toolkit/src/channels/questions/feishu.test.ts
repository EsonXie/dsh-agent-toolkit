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
  text: { tag: string; content: string }
  type: string
  behaviors: { type: string; value: Record<string, unknown> }[]
}

interface ElementLike {
  tag: string
  content?: string
  actions?: ButtonLike[]
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

function markdowns(card: CardLike): string[] {
  return card.body.elements.filter((e) => e.tag === 'markdown').map((e) => e.content ?? '')
}

function buttons(card: CardLike): ButtonLike[] {
  return card.body.elements.flatMap((e) => e.actions ?? [])
}

function values(card: CardLike): Record<string, unknown>[] {
  return buttons(card).map((b) => b.behaviors[0]!.value)
}

const CHOICE: QuestionItemLike = { id: 'q1', question: '选一个颜色', options: [{ label: '红' }, { label: '蓝' }] }
const OPEN: QuestionItemLike = { id: 'q2', question: '补充说明' }
const MULTI: QuestionItemLike = { id: 'q3', question: '多选', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] }

function promptOf(questions: QuestionItemLike[]): QuestionPrompt {
  return { key: 'k1', chatId: 'oc_chat1', botName: '评审', questions }
}

function viewOf(
  answers: [string, { selected: string[]; custom?: string }][] = [],
  toggled: [string, string[]][] = [],
): QuestionView {
  return { answers: new Map(answers), toggled: new Map(toggled) }
}

test('进行卡：每题一个 markdown 块；选项题按钮组取值 select；开放题提示直接回复；末尾取消按钮', () => {
  const card = cardOf(buildQuestionCardJson(promptOf([CHOICE, OPEN]), viewOf(), 20_000))
  expect(card.schema).toBe('2.0')
  expect(card.config.summary.content).toBe('Bot 提问')
  expect(card.header).toMatchObject({ title: { tag: 'plain_text', content: '提问' }, template: 'blue' })
  const md = markdowns(card)
  expect(md).toHaveLength(2)
  expect(md[0]).toContain('选一个颜色')
  expect(md[1]).toContain('补充说明')
  expect(md[1]).toContain('请直接回复消息作答')
  const vals = values(card)
  expect(vals).toContainEqual({ kind: 'question', key: 'k1', qid: 'q1', select: '红' })
  expect(vals).toContainEqual({ kind: 'question', key: 'k1', qid: 'q1', select: '蓝' })
  expect(vals.filter((v) => v['qid'] === 'q2')).toHaveLength(0)
  const cancel = buttons(card).at(-1)!
  expect(cancel).toMatchObject({ tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '取消本次提问' } })
  expect(cancel.behaviors[0]!.value).toEqual({ kind: 'question', key: 'k1', cancel: true })
})

test('multi_select：toggle 按钮 + confirm 按钮；已勾选 label 加 ✅ 前缀', () => {
  const card = cardOf(buildQuestionCardJson(promptOf([MULTI]), viewOf([], [['q3', ['甲']]]), 20_000))
  const vals = values(card)
  expect(vals).toContainEqual({ kind: 'question', key: 'k1', qid: 'q3', toggle: '甲' })
  expect(vals).toContainEqual({ kind: 'question', key: 'k1', qid: 'q3', toggle: '乙' })
  expect(vals).toContainEqual({ kind: 'question', key: 'k1', qid: 'q3', confirm: true })
  expect(vals.filter((v) => v['select'] !== undefined)).toHaveLength(0)
  const toggles = buttons(card).filter((b) => b.behaviors[0]!.value['toggle'] !== undefined)
  expect(toggles.map((b) => b.text.content)).toEqual(['✅ 甲', '乙'])
  const confirm = buttons(card).find((b) => b.behaviors[0]!.value['confirm'] === true)!
  expect(confirm).toMatchObject({ tag: 'button', type: 'primary', text: { content: '确认' } })
})

test('refresh 卡：已答题转只读（问题 + 已选/已答）且不渲染该题按钮；custom 截断 200 字', () => {
  const long = 'x'.repeat(300)
  const card = cardOf(buildQuestionCardJson(promptOf([CHOICE, OPEN]), viewOf([
    ['q1', { selected: ['蓝'] }],
    ['q2', { selected: [], custom: long }],
  ]), 20_000))
  const md = markdowns(card)
  expect(md[0]).toContain('选一个颜色')
  expect(md[0]).toContain('已选：蓝')
  expect(md[0]).not.toContain('红')
  expect(md[1]).toContain('已答')
  expect(md[1]).toContain('x'.repeat(200))
  expect(md[1]).not.toContain('x'.repeat(201))
  expect(md[1]).not.toContain('请直接回复消息作答')
  expect(values(card)).toEqual([{ kind: 'question', key: 'k1', cancel: true }])
})

test('plan-review：detail 渲染进卡片；超 maxBytes 预算截断并标注「完整计划见会话」', () => {
  const detail = `计划开始\n${'P'.repeat(5000)}`
  const prompt = promptOf([{ id: 'q1', question: '退出计划模式？', detail, options: [{ label: '批准' }, { label: '继续规划' }] }])
  const full = markdowns(cardOf(buildQuestionCardJson(prompt, viewOf(), 20_000)))[0]!
  expect(full).toContain('计划开始')
  expect(full).toContain('P'.repeat(5000))
  expect(full).not.toContain('完整计划见会话')
  const smallJson = buildQuestionCardJson(prompt, viewOf(), 3000)
  const small = markdowns(cardOf(smallJson))[0]!
  expect(small).toContain('计划开始')
  expect(small).toContain('P'.repeat(900))
  expect(small).not.toContain('P'.repeat(1000))
  expect(small).toContain('完整计划见会话')
  expect(values(cardOf(smallJson))).toContainEqual({ kind: 'question', key: 'k1', qid: 'q1', select: '批准' })
})

test('终态卡：无 action 元素；仅问题 + 答案；cancelled 题标「已取消」；header answered→green / cancelled→grey', () => {
  const answered = viewOf([['q1', { selected: ['蓝'] }], ['q2', { selected: [], custom: '就这样' }]])
  const green = cardOf(buildQuestionFinalCardJson(promptOf([CHOICE, OPEN]), answered, 'answered', 20_000))
  expect(green.header.template).toBe('green')
  expect(green.body.elements.some((e) => e.tag === 'action')).toBe(false)
  expect(JSON.stringify(green)).not.toContain('"button"')
  const md = markdowns(green)
  expect(md).toHaveLength(2)
  expect(md[0]).toContain('已选：蓝')
  expect(md[1]).toContain('已答：就这样')
  const grey = cardOf(buildQuestionFinalCardJson(promptOf([CHOICE, OPEN]), viewOf(), 'cancelled', 20_000))
  expect(grey.header.template).toBe('grey')
  expect(grey.body.elements.some((e) => e.tag === 'action')).toBe(false)
  expect(markdowns(grey)[0]).toContain('已取消')
})

function fakeApi() {
  const createCard = vi.fn<(cardJson: string) => Promise<string>>(async () => 'card_1')
  const sendCardMessage = vi.fn<(chatId: string, cardId: string) => Promise<void>>(async () => undefined)
  const replaceCard = vi.fn<(cardId: string, cardJson: string, sequence: number) => Promise<void>>(async () => undefined)
  return { api: { createCard, sendCardMessage, replaceCard } as unknown as FeishuApi, createCard, sendCardMessage, replaceCard }
}

test('presenter：present = createCard + sendCardMessage；refresh/finalize = replaceCard 且 sequence 从 1 递增', async () => {
  const { api, createCard, sendCardMessage, replaceCard } = fakeApi()
  const logs: string[] = []
  const presenter = new FeishuQuestionPresenter(api, 20_000, (m) => logs.push(m))
  const presentation = await presenter.present(promptOf([CHOICE, OPEN]), viewOf())
  expect(createCard).toHaveBeenCalledTimes(1)
  expect(JSON.parse(createCard.mock.calls[0]![0])).toMatchObject({ schema: '2.0' })
  expect(sendCardMessage).toHaveBeenCalledWith('oc_chat1', 'card_1')
  await presentation.refresh(promptOf([CHOICE, OPEN]), viewOf([['q1', { selected: ['红'] }]]))
  await presentation.finalize(promptOf([CHOICE, OPEN]), viewOf([['q1', { selected: ['红'] }]]), 'answered')
  expect(replaceCard.mock.calls.map((c) => c[2])).toEqual([1, 2])
  expect(replaceCard.mock.calls[0]![0]).toBe('card_1')
  expect(JSON.parse(replaceCard.mock.calls[0]![1])).toMatchObject({ header: { template: 'blue' } })
  expect(JSON.parse(replaceCard.mock.calls[1]![1])).toMatchObject({ header: { template: 'green' } })
  expect(logs).toEqual([])
})

test('refresh/finalize 失败被吞（仅告警），不向调用方抛', async () => {
  const { api, replaceCard } = fakeApi()
  replaceCard.mockRejectedValue(new Error('replace boom'))
  const logs: string[] = []
  const presenter = new FeishuQuestionPresenter(api, 20_000, (m) => logs.push(m))
  const presentation = await presenter.present(promptOf([CHOICE]), viewOf())
  await expect(presentation.refresh(promptOf([CHOICE]), viewOf())).resolves.toBeUndefined()
  await expect(presentation.finalize(promptOf([CHOICE]), viewOf(), 'cancelled')).resolves.toBeUndefined()
  expect(logs).toHaveLength(2)
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

test('卡片按钮 value 与 QuestionCenter.handleCardAction 对接：select/toggle/confirm/cancel 均被识别', async () => {
  let captured: QuestionPrompt | undefined
  const presentation: QuestionPresentation = { refresh: async () => undefined, finalize: async () => undefined }
  const sessions = new Map<string, SessionRuntime>()
  const center = new QuestionCenter(
    sessions,
    () => ({ botName: '评审', presenter: { present: async (p) => { captured = p; return presentation } } }),
    () => undefined,
  )
  sessions.set('s1', fakeRt('s1'))
  const pending = center.handleRequest({ agent: { session: { id: 's1' } }, questions: [CHOICE, MULTI] })
  await vi.waitFor(() => { expect(captured).toBeDefined() })
  const card = cardOf(buildQuestionCardJson(captured!, viewOf(), 20_000))
  const acks = values(card).map((value) => center.handleCardAction({ chatId: 'oc_chat1', operatorOpenId: 'ou_initiator', value }))
  expect(acks.filter((ack) => ack === undefined)).toEqual([])
  await expect(pending).resolves.toMatchObject({ answers: expect.any(Array) })
})
