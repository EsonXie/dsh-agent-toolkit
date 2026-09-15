import { describe, expect, test } from 'vitest'
import {
  buildCardJson, buildClosedCardJson, buildSegmentJson, escapedLen, initialStreamState, PENDING_CARD_ID,
  planFinalize, planSync, PROCESS_OMITTED, STATUS_CONTINUED, STATUS_ELEMENT_ID,
  sliceByBytes, sliceByEscapedBytes, sliceTailByBytes, type PlannedOp, type StreamState, type TurnSegment,
} from './cards.ts'

// sliceByBytes / sliceTailByBytes 五个测试原样保留（见现文件，不重复列出）
const text = (content: string): TurnSegment => ({ kind: 'text', content })
const proc = (content: string): TurnSegment => ({ kind: 'process', content })

/** 测试辅助：依次应用全部 commit 得到末态（执行侧的 fold）。 */
const applyOps = (state: StreamState, ops: readonly PlannedOp[]): StreamState =>
  ops.reduce((s, p) => p.commit(s), state)

// 拆卡预算基准：基础卡 JSON 全字节 / 空正文元素开销（结构 JSON 全字节，均为真实 DSL 字节）
const BASE = Buffer.byteLength(buildCardJson(5), 'utf8')
const EL = Buffer.byteLength(buildSegmentJson('text', 'seg_1', ''), 'utf8')

describe('sliceByBytes', () => {
  test('短文本原样返回', () => {
    expect(sliceByBytes('abc', 10)).toBe('abc')
  })

  test('按 UTF-8 字节截断且不劈开多字节字符', () => {
    expect(sliceByBytes('中中', 4)).toBe('中')
    expect(sliceByBytes('中中', 6)).toBe('中中')
  })

  test('不劈开代理对（emoji）', () => {
    const s = 'ab😀cd'
    expect(sliceByBytes(s, 6)).toBe('ab😀')
    expect(sliceByBytes(s, 5)).toBe('ab')
  })
})

describe('sliceTailByBytes', () => {
  test('短文本原样返回', () => {
    expect(sliceTailByBytes('abc', 100)).toBe('abc')
  })

  test('截尾保留尾部并加省略标记', () => {
    const markerBytes = Buffer.byteLength(PROCESS_OMITTED, 'utf8')
    const result = sliceTailByBytes('a'.repeat(100), markerBytes + 10)
    expect(result).toBe(PROCESS_OMITTED + 'a'.repeat(10))
  })

  test('不劈开多字节字符', () => {
    const markerBytes = Buffer.byteLength(PROCESS_OMITTED, 'utf8')
    // 预算 5 字节：'中'=3 字节，只能留 1 个；输入 11 个 '中'（33 字节）> maxBytes=30 才触发截尾
    expect(sliceTailByBytes('中'.repeat(11), markerBytes + 5)).toBe(PROCESS_OMITTED + '中')
  })

  test('不劈开代理对（低位代理落在切点：整对移除）', () => {
    const markerBytes = Buffer.byteLength(PROCESS_OMITTED, 'utf8')
    const text = `${'a'.repeat(96)}😀zz`   // 切点预算 5 字节 → tail 起点恰为 😀 的低位代理
    expect(sliceTailByBytes(text, markerBytes + 5)).toBe(PROCESS_OMITTED + 'zz')
  })

  test('maxBytes 小于省略标记：抛错', () => {
    expect(() => sliceTailByBytes('x'.repeat(100), 4)).toThrow()
  })
})

describe('buildCardJson / buildSegmentJson', () => {
  test('新卡：无 header，仅状态行，流式配置保留', () => {
    const json = JSON.parse(buildCardJson(5))
    expect(json.header).toBeUndefined()
    expect(json.config.streaming_mode).toBe(true)
    expect(json.body.elements).toEqual([
      { tag: 'markdown', content: '⏳ 输出中…', element_id: STATUS_ELEMENT_ID },
    ])
  })

  test('text → 纯 markdown；process → 默认收起折叠面板', () => {
    expect(JSON.parse(buildSegmentJson('text', 'seg_1', '正文'))).toEqual(
      { tag: 'markdown', content: '正文', element_id: 'seg_1' })
    expect(JSON.parse(buildSegmentJson('process', 'seg_2', '思考'))).toEqual({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: '思考与工具调用过程' } },
      elements: [{ tag: 'markdown', content: '思考', element_id: 'seg_2' }],
    })
  })

  test('print_step 取配置值', () => {
    const json = JSON.parse(buildCardJson(5))
    expect(json.config.streaming_config.print_step).toEqual({ default: 5 })
    expect(json.config.streaming_config.print_strategy).toBe('fast')
  })
})

describe('planSync', () => {
  test('首段 text：create + send + insert（锚定状态行之前）', () => {
    const { ops } = planSync(initialStreamState(), [text('你好')], 28_000, 8_000, 5)
    const state = applyOps(initialStreamState(), ops)
    expect(ops.map((p) => p.op).filter((op) => op.type !== 'noop')).toEqual([
      { type: 'create', cardJson: buildCardJson(5) },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('text', 'seg_1', '你好'), sequence: 1 },
    ])
    expect(state.cardId).toBe(PENDING_CARD_ID)
    expect(state.tail).toEqual({ segIndex: 0, elementId: 'seg_1', base: 0, shownText: '你好' })
  })

  test('尾段增长：元素 update；段切换 text→process→text：insert 交替、elementId 递增', () => {
    const first = planSync(initialStreamState(), [text('你好')], 28_000, 8_000, 5)
    const firstState = applyOps(initialStreamState(), first.ops)
    const grown = planSync({ ...firstState, cardId: 'c1' }, [text('你好，世界')], 28_000, 8_000, 5)
    expect(grown.ops.map((p) => p.op).filter((op) => op.type !== 'noop')).toEqual([{ type: 'update', elementId: 'seg_1', content: '你好，世界', sequence: 2 }])
    // 段切换
    const grownState = applyOps({ ...firstState, cardId: 'c1' }, grown.ops)
    const more = planSync(grownState, [text('你好，世界'), proc('想一想'), text('继续')], 28_000, 8_000, 5)
    expect(more.ops.map((p) => p.op).filter((op) => op.type !== 'noop')).toEqual([
      { type: 'insert', elementJson: buildSegmentJson('process', 'seg_2', '想一想'), sequence: 3 },
      { type: 'insert', elementJson: buildSegmentJson('text', 'seg_3', '继续'), sequence: 4 },
    ])
    const moreState = applyOps(grownState, more.ops)
    expect(moreState.closedSegCount).toBe(2)
    expect(moreState.tail).toEqual({ segIndex: 2, elementId: 'seg_3', base: 0, shownText: '继续' })
  })

  test('process 段超 processMaxBytes：截尾带省略标记', () => {
    const { ops } = planSync(initialStreamState(), [proc('x'.repeat(100))], 28_000, 40, 5)
    const insert = ops.map((p) => p.op).find((op) => op.type === 'insert')!
    if (insert.type !== 'insert') throw new Error('expected insert')
    const panel = JSON.parse(insert.elementJson)
    const md = panel.elements[0].content as string
    expect(md.startsWith(PROCESS_OMITTED)).toBe(true)
    expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(40)
  })

  test('text 段跨卡拆分：满卡关流 → 续卡 insert 续写剩余', () => {
    // 预算 = 基础卡 + 一个空正文元素开销 + 6 转义字节：每张卡至多放 '一二'（6 字节）
    const { ops } = planSync(initialStreamState(), [text('一二三四五')], BASE + EL + 6, 8_000, 5)
    const state = applyOps(initialStreamState(), ops)
    expect(ops.map((p) => p.op).filter((op) => op.type !== 'noop')).toEqual([
      { type: 'create', cardJson: buildCardJson(5) },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('text', 'seg_1', '一二'), sequence: 1 },
      { type: 'update', elementId: STATUS_ELEMENT_ID, content: STATUS_CONTINUED, sequence: 2 },
      { type: 'settings', streaming: false, sequence: 3, summary: STATUS_CONTINUED },
      { type: 'replace', cardId: PENDING_CARD_ID, cardJson: expect.any(String), sequence: 4, elements: 2 },
      { type: 'create', cardJson: buildCardJson(5) },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('text', 'seg_2', '三四'), sequence: 1 },
      { type: 'update', elementId: STATUS_ELEMENT_ID, content: STATUS_CONTINUED, sequence: 2 },
      { type: 'settings', streaming: false, sequence: 3, summary: STATUS_CONTINUED },
      { type: 'replace', cardId: PENDING_CARD_ID, cardJson: expect.any(String), sequence: 4, elements: 2 },
      { type: 'create', cardJson: buildCardJson(5) },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('text', 'seg_3', '五'), sequence: 1 },
    ])
    expect(state.tail).toEqual({ segIndex: 0, elementId: 'seg_3', base: 4, shownText: '五' })
    expect(state.carry).toBeUndefined()
  })

  test('跨卡 text 段跨 flush 增长：从正确偏移续写，不重排时间线', () => {
    // Flush A：'一二三'（escaped 9）在 maxBytes=BASE+EL+8 下拆为 [一二 | 三]
    const a = planSync(initialStreamState(), [text('一二三')], BASE + EL + 8, 8_000, 5)
    const aState = applyOps(initialStreamState(), a.ops)
    expect(aState.tail).toEqual({ segIndex: 0, elementId: 'seg_2', base: 2, shownText: '三' })
    // Flush B：段增长到 '一二三四五'：卡 2 续写 '三四' 装满 → 拆卡 → 卡 3 insert '五'
    const b = planSync({ ...aState, cardId: 'c2' }, [text('一二三四五')], BASE + EL + 8, 8_000, 5)
    const bState = applyOps({ ...aState, cardId: 'c2' }, b.ops)
    expect(b.ops.map((p) => p.op).filter((op) => op.type !== 'noop')).toEqual([
      { type: 'update', elementId: 'seg_2', content: '三四', sequence: 2 },
      { type: 'update', elementId: STATUS_ELEMENT_ID, content: STATUS_CONTINUED, sequence: 3 },
      { type: 'settings', streaming: false, sequence: 4, summary: STATUS_CONTINUED },
      { type: 'replace', cardId: 'c2', cardJson: expect.any(String), sequence: 5, elements: 2 },
      { type: 'create', cardJson: buildCardJson(5) },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('text', 'seg_3', '五'), sequence: 1 },
    ])
    expect(bState.tail).toEqual({ segIndex: 0, elementId: 'seg_3', base: 4, shownText: '五' })
  })

  test('process 段拆卡：旧卡定格，续卡整窗重放', () => {
    // 先建一张几乎满卡的 text 卡，再来 process 段
    const first = planSync(initialStreamState(), [text('一二')], BASE + EL + 6, 8_000, 5)   // 基础+元素+6 满
    const firstState = applyOps(initialStreamState(), first.ops)
    const { ops } = planSync({ ...firstState, cardId: 'c1' }, [text('一二'), proc('思考内容')], BASE + EL + 6, 8_000, 5)
    const state = applyOps({ ...firstState, cardId: 'c1' }, ops)
    // text 无变化；process 12 字节放不进 → 关旧卡 → 新卡整窗插入
    expect(ops.map((p) => p.op).filter((op) => op.type !== 'noop')).toEqual([
      { type: 'update', elementId: STATUS_ELEMENT_ID, content: STATUS_CONTINUED, sequence: 2 },
      { type: 'settings', streaming: false, sequence: 3, summary: STATUS_CONTINUED },
      { type: 'replace', cardId: 'c1', cardJson: expect.any(String), sequence: 4, elements: 2 },
      { type: 'create', cardJson: buildCardJson(5) },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('process', 'seg_2', '思考内容'), sequence: 1 },
    ])
    expect(state.tail).toEqual({ segIndex: 1, elementId: 'seg_2', base: 0, shownText: '思考内容' })
  })

  test('无变化：空 ops', () => {
    const first = planSync(initialStreamState(), [text('你好')], 28_000, 8_000, 5)
    const firstState = applyOps(initialStreamState(), first.ops)
    expect(planSync({ ...firstState, cardId: 'c1' }, [text('你好')], 28_000, 8_000, 5).ops.map((p) => p.op).filter((op) => op.type !== 'noop')).toEqual([])
  })

  test('拆卡定格：关流前先把旧卡状态行更新为「已接续」，summary 同步', () => {
    // maxBytes=BASE+EL+6：每卡至多再放 6 字节 → 必拆卡
    const { ops } = planSync(initialStreamState(), [text('一二三四五')], BASE + EL + 6, 8_000, 5)
    const cardOps = ops.map((p) => p.op).filter((op) => op.type !== 'noop')
    const closes = cardOps.filter((op) => op.type === 'settings')
    expect(closes.length).toBe(2)   // 两次拆卡
    // 每次拆卡都是 update(status) 在前、settings 在后，且 summary 带上定格文案
    const firstClose = cardOps.slice(3, 5)
    expect(firstClose).toEqual([
      { type: 'update', elementId: STATUS_ELEMENT_ID, content: STATUS_CONTINUED, sequence: 2 },
      { type: 'settings', streaming: false, sequence: 3, summary: STATUS_CONTINUED },
    ])
  })

  test('逐 op commit：create 后 cardId=PENDING，拆卡 settings 后 cardId=null', () => {
    const { ops } = planSync(initialStreamState(), [text('一二三四五')], BASE + EL + 6, 8_000, 5)
    let s = initialStreamState()
    s = ops[0].commit(s)   // create
    expect(s.cardId).toBe(PENDING_CARD_ID)
    s = ops[1].commit(s)   // send
    s = ops[2].commit(s)   // insert '一二'
    expect(s.tail?.shownText).toBe('一二')
    s = ops[4].commit(s)   // settings（关第一卡）
    expect(s.cardId).toBeNull()
    expect(s.carry).toEqual({ segIndex: 0, base: 2 })
  })
})

describe('planFinalize', () => {
  test('先 update 状态行再关闭 + summary，再全量重放（sequence 接续）；未建卡空 ops', () => {
    const base = applyOps(initialStreamState(), planSync(initialStreamState(), [text('你好')], 28_000, 8_000, 5).ops)
    const state: StreamState = { ...base, cardId: 'c1' }
    const segments = [text('你好')]
    const { ops } = planFinalize(state, 'done', segments, 8_000)
    expect(ops.slice(0, 2)).toEqual([
      { type: 'update', elementId: STATUS_ELEMENT_ID, content: '✅ 输出完成', sequence: 2 },
      { type: 'settings', streaming: false, sequence: 3, summary: '✅ 输出完成' },
    ])
    expect(ops[2]).toMatchObject({ type: 'replace', cardId: 'c1', sequence: 4, elements: 2 })
    expect(planFinalize(initialStreamState(), 'done', [], 8_000).ops).toEqual([])
    expect(planFinalize(state, 'error', segments, 8_000).ops[0]).toMatchObject({ content: '❌ 输出出错' })
    expect(planFinalize(state, 'cancelled', segments, 8_000).ops[0]).toMatchObject({ content: '⏹ 已取消' })
  })
})

describe('escapedLen / sliceByEscapedBytes', () => {
  test('转义膨胀计入：换行/引号每个 +1 字节', () => {
    expect(escapedLen('ab')).toBe(2)
    expect(escapedLen('a\nb')).toBe(4)      // \n 在 JSON 串里占 2 字节
    expect(escapedLen('中')).toBe(3)
  })

  test('按转义后字节截断，不劈多字节字符', () => {
    expect(sliceByEscapedBytes('a\nb\nc', 4)).toBe('a\nb')   // 'a\nb'=4，'a\nb\n'=6 超
    expect(sliceByEscapedBytes('中中', 4)).toBe('中')
  })
})

describe('planSync DSL 记账', () => {
  const BASE = Buffer.byteLength(buildCardJson(5), 'utf8')              // 实测 286
  const EL = Buffer.byteLength(buildSegmentJson('text', 'seg_1', ''), 'utf8')  // 实测 52

  test('insert 按 elementJson 全字节记账：预算只够一个元素时立即拆卡', () => {
    // 预算 = 基础 + 一个正文元素（空内容开销）+ 6 转义字节：每卡恰好放一个 2 字元素（'一二'）即满
    const maxBytes = BASE + EL + 6
    const { ops } = planSync(initialStreamState(), [text('一二三四五')], maxBytes, 8_000, 5)
    const cardOps = ops.map((p) => p.op).filter((op) => op.type !== 'noop')
    const inserts = cardOps.filter((op) => op.type === 'insert')
    // 元素结构开销计入预算 → '一二'/'三四'/'五' 各占一卡（3 次 insert），贴线 6 转义字节逐卡满
    expect(inserts).toHaveLength(3)
    expect(JSON.parse(inserts[0].elementJson).content).toBe('一二')
    expect(JSON.parse(inserts[1].elementJson).content).toBe('三四')
    expect(JSON.parse(inserts[2].elementJson).content).toBe('五')
    expect(cardOps.filter((op) => op.type === 'settings')).toHaveLength(2)
  })

  test('update 按转义差值记账：换行多的内容更早触发拆卡', () => {
    const maxBytes = BASE + EL + 12   // 首卡放 'a\nb\n'（escaped 6+2=8? 见下）
    const first = planSync(initialStreamState(), [text('a\nb')], maxBytes, 8_000, 5)
    const firstState = applyOps(initialStreamState(), first.ops)
    // 'a\nb' escapedLen=4；增长到 'a\nb\nc\nd' escapedLen=10，delta=6，剩 12-4=8 → 可 update
    const grown = planSync({ ...firstState, cardId: 'c1' }, [text('a\nb\nc\nd')], maxBytes, 8_000, 5)
    expect(grown.ops.map((p) => p.op).find((op) => op.type !== 'noop')).toMatchObject({ type: 'update', content: 'a\nb\nc\nd' })
    // 再增长到 escapedLen=16，delta=6，剩 2 → 拆卡
    const grownState = applyOps({ ...firstState, cardId: 'c1' }, grown.ops)
    const over = planSync({ ...grownState }, [text('a\nb\nc\nd\ne\nf')], maxBytes, 8_000, 5)
    expect(over.ops.map((p) => p.op).some((op) => op.type === 'settings')).toBe(true)
  })
})

const MAX = 26_000
const PROC = 8000
const STEP = 5

/** 纯函数侧模拟确认式执行：依次应用 commit；create 的真实 cardId 手动叠入。 */
function execAll(ops: readonly { commit: (s: StreamState) => StreamState }[], cardId = 'card_1'): StreamState {
  let state = initialStreamState()
  for (const p of ops) state = p.commit(state)
  return state.cardId === PENDING_CARD_ID ? { ...state, cardId } : state
}

describe('关流后全量重放（replace op）', () => {
  test('定格：planFinalize 在 update/settings 后追加 replace，重建内容与本卡已提交内容一致', () => {
    const segments = [
      { kind: 'text' as const, content: '正文一' },
      { kind: 'process' as const, content: '想一想' },
      { kind: 'text' as const, content: '最终答案' },
    ]
    const state = execAll(planSync(initialStreamState(), segments, MAX, PROC, STEP).ops)
    const fin = planFinalize(state, 'done', segments, PROC)
    expect(fin.ops.map((o) => o.type)).toEqual(['update', 'settings', 'replace'])
    const replace = fin.ops[2]!
    if (replace.type !== 'replace') throw new Error('unreachable')
    expect(replace.cardId).toBe('card_1')
    expect(replace.sequence).toBe(state.seq + 3)
    expect(replace.elements).toBe(4)   // 3 段 + 状态行
    const card = JSON.parse(replace.cardJson) as {
      config: { streaming_mode: boolean; summary: { content: string } }
      body: { elements: { tag: string; content?: string; element_id?: string; elements?: { content: string }[] }[] }
    }
    expect(card.config.streaming_mode).toBe(false)
    expect(card.config.summary.content).toBe('✅ 输出完成')
    expect(card.body.elements).toHaveLength(4)
    expect(card.body.elements[0]).toMatchObject({ tag: 'markdown', content: '正文一' })
    expect(card.body.elements[1]!.tag).toBe('collapsible_panel')
    expect(card.body.elements[1]!.elements![0]!.content).toBe('想一想')
    expect(card.body.elements[2]).toMatchObject({ tag: 'markdown', content: '最终答案' })
    expect(card.body.elements[3]).toMatchObject({ tag: 'markdown', content: '✅ 输出完成', element_id: 'status' })
  })

  test('无卡（cardId null）仍返回空 ops', () => {
    expect(planFinalize(initialStreamState(), 'done', [], PROC).ops).toEqual([])
  })

  test('拆卡：closeCard 追加 replace；旧卡重建精确对齐已提交的部分 piece', () => {
    // 极小 maxBytes（400）逼出拆卡：单卡内容预算 ≈ 400 - 基础卡(≈286B) - 元素开销(≈52B) ≈ 62 转义字节，
    // 100 字符 → 首卡 62 + 续卡 38，恰好 2 卡 1 次拆（若预算微变导致 3 卡，按实际 inserts/replaces 计数适配断言）。
    const segments = [{ kind: 'text' as const, content: 'A'.repeat(100) }]
    const { ops } = planSync(initialStreamState(), segments, 400, PROC, STEP)
    const inserts = ops.filter((o) => o.op.type === 'insert')
    const replaces = ops.filter((o) => o.op.type === 'replace')
    expect(inserts.length).toBe(2)          // 首卡部分 piece + 续卡剩余
    expect(replaces.length).toBe(1)         // 只有首卡关流重放（续卡在 planSync 内不关流）
    expect((replaces[0]!.op as { cardId: string }).cardId).toBe(PENDING_CARD_ID)   // 同次规划内建卡即拆卡 → 占位，执行侧解析
    const firstInsert = JSON.parse((inserts[0]!.op as { elementJson: string }).elementJson) as { content: string }
    const replace = replaces[0]!.op as { cardJson: string }
    const card = JSON.parse(replace.cardJson) as { body: { elements: { content?: string; element_id?: string }[] } }
    const textEl = card.body.elements.find((e) => e.element_id === 'seg_1')!
    expect(textEl.content).toBe(firstInsert.content)                 // 逐字节等于已提交 piece
    expect(textEl.content!.length).toBeLessThan(100)
    expect(card.body.elements.at(-1)!.content).toBe(STATUS_CONTINUED)
  })

  test('cardSegs 快照不可变：规划推进不污染先前 commit', () => {
    const segments = [{ kind: 'text' as const, content: '一' }, { kind: 'text' as const, content: '二' }]
    const { ops } = planSync(initialStreamState(), segments, MAX, PROC, STEP)
    const insert1 = ops.find((o) => o.op.type === 'insert')!
    const s1 = insert1.commit(initialStreamState())
    expect(s1.cardSegs).toHaveLength(1)
    const sN = ops[ops.length - 1]!.commit(initialStreamState())
    expect(sN.cardSegs).toHaveLength(2)
    expect(s1.cardSegs).toHaveLength(1)   // 先前快照不被后续规划污染
  })

  test('buildClosedCardJson：carry 续写段按 base + len 切片', () => {
    const json = buildClosedCardJson(
      [{ segIndex: 0, elementId: 'seg_9', kind: 'text', base: 3, len: 4 }],
      [{ kind: 'text', content: '---续写内容' }],
      undefined,
      '✅ 输出完成',
      PROC,
    )
    const card = JSON.parse(json) as { body: { elements: { content?: string }[] } }
    expect(card.body.elements[0]!.content).toBe('续写内容')
  })

  test('封闭 text 段后续增长：重建仍按已提交长度切片，不越界整段', () => {
    // Flush A：段一 'AB' 提交后因 process 段跟随而封闭（cardSegs 钉住 len=2），段二为尾段
    const a = planSync(initialStreamState(), [text('AB'), proc('思考')], MAX, PROC, STEP)
    const aState = applyOps(initialStreamState(), a.ops)
    const closed = aState.cardSegs.find((e) => e.elementId === 'seg_1')!
    expect(closed).toMatchObject({ segIndex: 0, kind: 'text', base: 0, len: 2 })
    // Flush B：段一内容跨 flush 增长到 'ABCDEF'，但已封闭不再重同步，cardSegs 保持 len=2
    const grown = planSync({ ...aState, cardId: 'c1' }, [text('ABCDEF'), proc('思考')], MAX, PROC, STEP)
    const grownState = applyOps({ ...aState, cardId: 'c1' }, grown.ops)
    expect(grownState.cardSegs.find((e) => e.elementId === 'seg_1')!.len).toBe(2)
    // 定格重建：seg_1 只取已提交窗口 'AB'，不得切片整段 'ABCDEF'
    const fin = planFinalize(grownState, 'done', [text('ABCDEF'), proc('思考')], PROC)
    const replace = fin.ops.find((o) => o.type === 'replace')!
    if (replace.type !== 'replace') throw new Error('unreachable')
    const card = JSON.parse(replace.cardJson) as { body: { elements: { content?: string; element_id?: string }[] } }
    const seg1 = card.body.elements.find((e) => e.element_id === 'seg_1')!
    expect(seg1.content).toBe('AB')
  })
})
