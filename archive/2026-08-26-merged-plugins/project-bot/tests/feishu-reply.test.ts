import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FeishuApi } from '../src/channels/feishu/api.ts'
import { FeishuReplyHandle, makeAck, withRetry } from '../src/channels/feishu/reply.ts'

const TUNABLES = { cardUpdateThrottleMs: 500, cardMaxBytes: 100, processMaxBytes: 8000, processingReactionEmoji: 'OneSecond' }

interface Call { op: string; args: unknown[] }

function fakeApi() {
  const calls: Call[] = []
  let cardSeq = 0
  const api: FeishuApi = {
    createCard: async () => { calls.push({ op: 'createCard', args: [] }); return `card_${++cardSeq}` },
    sendCardMessage: async (...args) => { calls.push({ op: 'sendCardMessage', args }) },
    updateCardElement: async (...args) => { calls.push({ op: 'updateCardElement', args }) },
    insertElement: async (...args) => { calls.push({ op: 'insertElement', args }) },
    setCardStreaming: async (...args) => { calls.push({ op: 'setCardStreaming', args }) },
    replaceCard: async (...args) => { calls.push({ op: 'replaceCard', args }) },
    sendText: async (...args) => { calls.push({ op: 'sendText', args }) },
    addReaction: async (...args) => { calls.push({ op: 'addReaction', args }); return 'reaction_1' },
    removeReaction: async (...args) => { calls.push({ op: 'removeReaction', args }) },
  }
  return { api, calls }
}

function make(api: FeishuApi) {
  const logs: string[] = []
  const reply = new FeishuReplyHandle(api, 'oc_1', TUNABLES, (m) => { logs.push(m) })
  return { reply, logs }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('FeishuReplyHandle', () => {
  test('首次 update 建卡并发卡；节流窗口内多次 update 只同步最新内容', async () => {
    const { api, calls } = fakeApi()
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '你好' }])
    await reply.update([{ kind: 'text', content: '你好，世界' }])
    await vi.advanceTimersByTimeAsync(500)
    expect(calls.map((c) => c.op)).toEqual(['createCard', 'sendCardMessage', 'insertElement'])
    await reply.update([{ kind: 'text', content: '你好，世界！' }])
    await vi.advanceTimersByTimeAsync(500)
    const updates = calls.filter((c) => c.op === 'updateCardElement')
    expect(updates).toHaveLength(1)
    expect(updates[0].args[1]).toBe('seg_1')          // elementId
    expect(updates[0].args[2]).toBe('你好，世界！')
    expect(updates[0].args[3]).toBe(2)                // sequence（insert 占 1 后接续）
  })

  test('过程区增量更新路由到 process 元素', async () => {
    const { api, calls } = fakeApi()
    const { reply } = make(api)
    await reply.update([{ kind: 'process', content: '想一下' }])
    await vi.advanceTimersByTimeAsync(500)
    expect(calls.map((c) => c.op)).toEqual(['createCard', 'sendCardMessage', 'insertElement'])
    await reply.update([{ kind: 'process', content: '想一下再想想' }])
    await vi.advanceTimersByTimeAsync(500)
    const updates = calls.filter((c) => c.op === 'updateCardElement')
    expect(updates).toHaveLength(1)
    expect(updates[0].args[1]).toBe('seg_1')
    expect(updates[0].args[2]).toBe('想一下再想想')
  })

  test('段切换：text 后插入 process 折叠面板', async () => {
    const { api, calls } = fakeApi()
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '正文' }])
    await vi.advanceTimersByTimeAsync(500)
    await reply.update([{ kind: 'text', content: '正文' }, { kind: 'process', content: '想一想' }])
    await vi.advanceTimersByTimeAsync(500)
    const inserts = calls.filter((c) => c.op === 'insertElement')
    expect(inserts).toHaveLength(2)
    const panel = JSON.parse(String(inserts[1].args[1])) as { tag: string; elements: { content: string }[] }
    expect(panel.tag).toBe('collapsible_panel')
    expect(panel.elements[0].content).toBe('想一想')
  })

  test('finalize：冲刷尾部 → 关流式 → 状态行定格', async () => {
    const { api, calls } = fakeApi()
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '结论' }])
    await reply.finalize('done')
    const ops = calls.map((c) => c.op)
    expect(ops.slice(0, 2)).toEqual(['createCard', 'sendCardMessage'])
    expect(ops).toContain('setCardStreaming')
    expect(ops).not.toContain('replaceCard')
    // 正确顺序：状态行定格更新在前（流式还开着），关流式 + summary 定格在后
    const tail2 = calls.slice(-2)
    expect(tail2[0].op).toBe('updateCardElement')
    expect(tail2[0].args[1]).toBe('status')
    expect(tail2[0].args[2]).toBe('✅ 输出完成')
    expect(tail2[1].op).toBe('setCardStreaming')
    expect(tail2[1].args[1]).toBe(false)
    expect(tail2[1].args[3]).toBe('✅ 输出完成')   // summary 透传
  })

  test('建卡失败：重试耗尽只记日志不抛出，finalize 补建仍失败则降级文本', async () => {
    const { api, calls } = fakeApi()
    api.createCard = async () => { calls.push({ op: 'createCard', args: [] }); throw new Error('rate limited') }
    const { reply, logs } = make(api)
    await reply.update([{ kind: 'text', content: '内容' }])
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(5000)   // 退避窗口（300+600ms + 余量）
    const fin = reply.finalize('error', '出错了')
    await vi.advanceTimersByTimeAsync(5000)   // finalize 的补建重试退避
    await fin
    expect(calls.filter((c) => c.op === 'createCard').length).toBe(6)   // 首次 flush 3 次 + finalize 补建 3 次
    expect(logs.length).toBeGreaterThan(0)
    // 失败后降级文本（无卡片 + detail）
    expect(calls.some((c) => c.op === 'sendText' && String(c.args[1]).includes('出错了'))).toBe(true)
  })

  test('建卡瞬时失败：下一次 flush 重新建卡并完整插入内容（不丢失、不对 null 卡号发 update）', async () => {
    const { api, calls } = fakeApi()
    let failing = true
    api.createCard = async () => {
      calls.push({ op: 'createCard', args: [] })
      if (failing) throw new Error('rate limited')
      return 'card_recreated'
    }
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '你好' }])
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(5000)   // 退避窗口，失败定局
    failing = false
    await reply.update([{ kind: 'text', content: '你好呀' }])
    await vi.advanceTimersByTimeAsync(500)
    // 恢复路径必须是重建（create → send → insert 全量内容），而不是对 null 卡号发 update
    expect(calls.filter((c) => c.op === 'updateCardElement')).toHaveLength(0)
    const tail3 = calls.slice(-3).map((c) => c.op)
    expect(tail3).toEqual(['createCard', 'sendCardMessage', 'insertElement'])
    const insert = calls[calls.length - 1]
    expect(String(insert.args[1])).toContain('你好呀')
    expect(insert.args[0]).toBe('card_recreated')
  })

  test('无卡片输出的 error finalize 降级为文本通知', async () => {
    const { api, calls } = fakeApi()
    const { reply } = make(api)
    await reply.finalize('error', '模型服务不可用')
    expect(calls.some((c) => c.op === 'sendText' && String(c.args[1]).includes('模型服务不可用'))).toBe(true)
  })

  test('notice 走普通文本', async () => {
    const { api, calls } = fakeApi()
    const { reply } = make(api)
    await reply.notice('上一条还在处理中')
    expect(calls).toEqual([{ op: 'sendText', args: ['oc_1', '上一条还在处理中'] }])
  })
})

describe('makeAck', () => {
  test('加表情返回删除 disposer；删除失败静默', async () => {
    const { api, calls } = fakeApi()
    const ack = await makeAck(api, 'om_1', 'OneSecond')()
    expect(calls).toEqual([{ op: 'addReaction', args: ['om_1', 'OneSecond'] }])
    await ack?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls[1]).toEqual({ op: 'removeReaction', args: ['om_1', 'reaction_1'] })
  })

  test('加表情失败返回 undefined', async () => {
    const { api } = fakeApi()
    api.addReaction = async () => { throw new Error('forbidden') }
    expect(await makeAck(api, 'om_1', 'OneSecond')()).toBeUndefined()
  })
})

describe('withRetry', () => {
  test('成功后立即返回；耗尽后抛最后错误', async () => {
    let n = 0
    const first = withRetry(async () => (++n === 2 ? 'ok' : Promise.reject<string>(new Error('x'))), 3, 1)
    await vi.advanceTimersByTimeAsync(10)   // 假定时器下推进 withRetry 退避（baseDelayMs=1）
    expect(await first).toBe('ok')
    const second = expect(withRetry(async () => { throw new Error('boom') }, 3, 1)).rejects.toThrow('boom')
    await vi.advanceTimersByTimeAsync(100)   // 推进第 1、2 次退避，第 3 次尝试抛错
    await second
  })
})
