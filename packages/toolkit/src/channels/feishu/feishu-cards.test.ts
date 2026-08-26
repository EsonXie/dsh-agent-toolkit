import { describe, expect, test } from 'vitest'
import {
  buildCardJson, buildSegmentJson, initialStreamState, PENDING_CARD_ID,
  planFinalize, planSync, PROCESS_OMITTED, STATUS_ELEMENT_ID,
  sliceByBytes, sliceTailByBytes, type StreamState, type TurnSegment,
} from './cards.ts'

// sliceByBytes / sliceTailByBytes 五个测试原样保留（见现文件，不重复列出）
const text = (content: string): TurnSegment => ({ kind: 'text', content })
const proc = (content: string): TurnSegment => ({ kind: 'process', content })

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
    const json = JSON.parse(buildCardJson())
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
})

describe('planSync', () => {
  test('首段 text：create + send + insert（锚定状态行之前）', () => {
    const { state, ops } = planSync(initialStreamState(), [text('你好')], 28_000, 8_000)
    expect(ops).toEqual([
      { type: 'create', cardJson: buildCardJson() },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('text', 'seg_1', '你好'), sequence: 1 },
    ])
    expect(state.cardId).toBe(PENDING_CARD_ID)
    expect(state.tail).toEqual({ segIndex: 0, elementId: 'seg_1', base: 0, shownText: '你好' })
  })

  test('尾段增长：元素 update；段切换 text→process→text：insert 交替、elementId 递增', () => {
    const first = planSync(initialStreamState(), [text('你好')], 28_000, 8_000)
    const grown = planSync({ ...first.state, cardId: 'c1' }, [text('你好，世界')], 28_000, 8_000)
    expect(grown.ops).toEqual([{ type: 'update', elementId: 'seg_1', content: '你好，世界', sequence: 2 }])
    // 段切换
    const more = planSync(grown.state, [text('你好，世界'), proc('想一想'), text('继续')], 28_000, 8_000)
    expect(more.ops).toEqual([
      { type: 'insert', elementJson: buildSegmentJson('process', 'seg_2', '想一想'), sequence: 3 },
      { type: 'insert', elementJson: buildSegmentJson('text', 'seg_3', '继续'), sequence: 4 },
    ])
    expect(more.state.closedSegCount).toBe(2)
    expect(more.state.tail).toEqual({ segIndex: 2, elementId: 'seg_3', base: 0, shownText: '继续' })
  })

  test('process 段超 processMaxBytes：截尾带省略标记', () => {
    const { ops } = planSync(initialStreamState(), [proc('x'.repeat(100))], 28_000, 40)
    const insert = ops.find((op) => op.type === 'insert')!
    if (insert.type !== 'insert') throw new Error('expected insert')
    const panel = JSON.parse(insert.elementJson)
    const md = panel.elements[0].content as string
    expect(md.startsWith(PROCESS_OMITTED)).toBe(true)
    expect(Buffer.byteLength(md, 'utf8')).toBeLessThanOrEqual(40)
  })

  test('text 段跨卡拆分：满卡关流 → 续卡 insert 续写剩余', () => {
    // CARD_FIXED_BYTES=64：maxBytes=70 时每张卡至多再放 6 字节（2 个汉字）
    const { state, ops } = planSync(initialStreamState(), [text('一二三四五')], 70, 8_000)
    expect(ops).toEqual([
      { type: 'create', cardJson: buildCardJson() },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('text', 'seg_1', '一二'), sequence: 1 },
      { type: 'settings', streaming: false, sequence: 2 },
      { type: 'create', cardJson: buildCardJson() },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('text', 'seg_2', '三四'), sequence: 1 },
      { type: 'settings', streaming: false, sequence: 2 },
      { type: 'create', cardJson: buildCardJson() },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('text', 'seg_3', '五'), sequence: 1 },
    ])
    expect(state.tail).toEqual({ segIndex: 0, elementId: 'seg_3', base: 4, shownText: '五' })
    expect(state.carry).toBeUndefined()
  })

  test('跨卡 text 段跨 flush 增长：从正确偏移续写，不重排时间线', () => {
    // Flush A：'一二三'（9B）在 maxBytes=70（固定开销 64）下拆为 [一二 | 三]
    const a = planSync(initialStreamState(), [text('一二三')], 70, 8_000)
    expect(a.state.tail).toEqual({ segIndex: 0, elementId: 'seg_2', base: 2, shownText: '三' })
    // Flush B：段增长到 '一二三四五'：卡 2 续写 '三四' 装满 → 拆卡 → 卡 3 insert '五'
    const b = planSync({ ...a.state, cardId: 'c2' }, [text('一二三四五')], 70, 8_000)
    expect(b.ops).toEqual([
      { type: 'update', elementId: 'seg_2', content: '三四', sequence: 2 },
      { type: 'settings', streaming: false, sequence: 3 },
      { type: 'create', cardJson: buildCardJson() },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('text', 'seg_3', '五'), sequence: 1 },
    ])
    expect(b.state.tail).toEqual({ segIndex: 0, elementId: 'seg_3', base: 4, shownText: '五' })
  })

  test('process 段拆卡：旧卡定格，续卡整窗重放', () => {
    // 先建一张几乎满卡的 text 卡，再来 process 段
    const first = planSync(initialStreamState(), [text('一二')], 70, 8_000)   // 64+6=70 满
    const { state, ops } = planSync({ ...first.state, cardId: 'c1' }, [text('一二'), proc('思考内容')], 70, 8_000)
    // text 无变化；process 12 字节放不进 → 关旧卡 → 新卡整窗插入
    expect(ops).toEqual([
      { type: 'settings', streaming: false, sequence: 2 },
      { type: 'create', cardJson: buildCardJson() },
      { type: 'send' },
      { type: 'insert', elementJson: buildSegmentJson('process', 'seg_2', '思考内容'), sequence: 1 },
    ])
    expect(state.tail).toEqual({ segIndex: 1, elementId: 'seg_2', base: 0, shownText: '思考内容' })
  })

  test('无变化：空 ops', () => {
    const first = planSync(initialStreamState(), [text('你好')], 28_000, 8_000)
    expect(planSync({ ...first.state, cardId: 'c1' }, [text('你好')], 28_000, 8_000).ops).toEqual([])
  })
})

describe('planFinalize', () => {
  test('先 update 状态行再关闭 + summary（sequence 接续）；未建卡空 ops', () => {
    const base = planSync(initialStreamState(), [text('你好')], 28_000, 8_000).state
    const state: StreamState = { ...base, cardId: 'c1' }
    const { ops } = planFinalize(state, 'done')
    expect(ops).toEqual([
      { type: 'update', elementId: STATUS_ELEMENT_ID, content: '✅ 输出完成', sequence: 2 },
      { type: 'settings', streaming: false, sequence: 3, summary: '✅ 输出完成' },
    ])
    expect(planFinalize(initialStreamState(), 'done').ops).toEqual([])
    expect(planFinalize(state, 'error').ops[0]).toMatchObject({ content: '❌ 输出出错' })
    expect(planFinalize(state, 'cancelled').ops[0]).toMatchObject({ content: '⏹ 已取消' })
  })
})
