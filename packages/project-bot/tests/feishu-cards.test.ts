import { describe, expect, test } from 'vitest'
import {
  buildCardJson, CARD_ELEMENT_ID, initialStreamState, PENDING_CARD_ID,
  planFinalize, planSync, sliceByBytes, type StreamState,
} from '../src/channels/feishu/cards.ts'

describe('sliceByBytes', () => {
  test('短文本原样返回', () => {
    expect(sliceByBytes('abc', 10)).toBe('abc')
  })

  test('按 UTF-8 字节截断且不劈开多字节字符', () => {
    // '中' = 3 字节：maxBytes=4 只能容纳 1 个
    expect(sliceByBytes('中中', 4)).toBe('中')
    expect(sliceByBytes('中中', 6)).toBe('中中')
  })

  test('不劈开代理对（emoji）', () => {
    const s = 'ab😀cd'   // 😀 = 2 个 code unit / 4 字节
    expect(sliceByBytes(s, 6)).toBe('ab😀')   // 2 + 4 恰好容下
    expect(sliceByBytes(s, 5)).toBe('ab')     // 容不下时整对移除
  })
})

describe('buildCardJson', () => {
  test('JSON 2.0 流式卡片结构', () => {
    const json = JSON.parse(buildCardJson({ title: '评审', content: '正文', streaming: true, template: 'blue' }))
    expect(json.schema).toBe('2.0')
    expect(json.header).toEqual({ template: 'blue', title: { content: '评审', tag: 'plain_text' } })
    expect(json.config.streaming_mode).toBe(true)
    expect(json.config.streaming_config.print_strategy).toBe('fast')
    expect(json.body.elements).toEqual([{ tag: 'markdown', content: '正文', element_id: CARD_ELEMENT_ID }])
  })

  test('非流式不带 streaming_config', () => {
    const json = JSON.parse(buildCardJson({ title: 't', content: 'c', streaming: false, template: 'green' }))
    expect(json.config.streaming_mode).toBe(false)
    expect(json.config.streaming_config).toBeUndefined()
  })
})

describe('planSync', () => {
  test('首次更新：create + send', () => {
    const { state, ops } = planSync(initialStreamState(), '你好', 100, 't')
    expect(ops).toEqual([
      { type: 'create', cardJson: buildCardJson({ title: 't', content: '你好', streaming: true, template: 'blue' }) },
      { type: 'send' },
    ])
    expect(state.cardId).toBe(PENDING_CARD_ID)
    expect(state.shownLen).toBe(2)
  })

  test('增量更新：全量替换当前卡内容，sequence 递增', () => {
    const first = planSync(initialStreamState(), '你好', 100, 't')
    const { state, ops } = planSync({ ...first.state, cardId: 'card_1' }, '你好，世界', 100, 't')
    expect(ops).toEqual([{ type: 'update', content: '你好，世界', sequence: 1 }])
    expect(state.shownLen).toBe(5)
  })

  test('无新内容：空 ops', () => {
    const first = planSync(initialStreamState(), 'abc', 100, 't')
    expect(planSync(first.state, 'abc', 100, 't').ops).toEqual([])
  })

  test('超长拆卡：满卡关流 → 新卡 create+send 承接剩余（新卡 sequence 从 1 重新计）', () => {
    // maxBytes=6：每张卡最多 2 个汉字
    const { state, ops } = planSync(initialStreamState(), '一二三四五', 6, 't')
    expect(ops).toEqual([
      { type: 'create', cardJson: buildCardJson({ title: 't', content: '一二', streaming: true, template: 'blue' }) },
      { type: 'send' },
      { type: 'settings', streaming: false, sequence: 1 },
      { type: 'create', cardJson: buildCardJson({ title: 't', content: '三四', streaming: true, template: 'blue' }) },
      { type: 'send' },
      { type: 'settings', streaming: false, sequence: 1 },
      { type: 'create', cardJson: buildCardJson({ title: 't', content: '五', streaming: true, template: 'blue' }) },
      { type: 'send' },
    ])
    expect(state.cardId).toBe(PENDING_CARD_ID)
    expect(state.offset).toBe(4)
    expect(state.shownLen).toBe(5)
  })
})

describe('planFinalize', () => {
  test('关流式 + 按状态换头色全量替换（sequence 接续）', () => {
    const state: StreamState = { cardId: 'card_1', seq: 3, offset: 0, shownLen: 2 }
    const { ops } = planFinalize(state, '你好', 'done', 't')
    expect(ops).toEqual([
      { type: 'settings', streaming: false, sequence: 4 },
      { type: 'replace', cardJson: buildCardJson({ title: 't', content: '你好', streaming: false, template: 'green' }), sequence: 5 },
    ])
  })

  test('error → red，cancelled → grey；从未建卡 → 空 ops', () => {
    const state: StreamState = { cardId: 'c', seq: 0, offset: 0, shownLen: 1 }
    const errorOps = planFinalize(state, 'x', 'error', 't').ops
    const replace = errorOps.find((op) => op.type === 'replace')!
    expect(JSON.parse(replace.type === 'replace' ? replace.cardJson : '').header.template).toBe('red')
    const cancelledOps = planFinalize(state, 'x', 'cancelled', 't').ops
    const replace2 = cancelledOps.find((op) => op.type === 'replace')!
    expect(JSON.parse(replace2.type === 'replace' ? replace2.cardJson : '').header.template).toBe('grey')
    expect(planFinalize(initialStreamState(), '', 'done', 't').ops).toEqual([])
  })
})
