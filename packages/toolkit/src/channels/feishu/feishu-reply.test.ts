import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ChannelTunables } from '../channel.ts'
import type { FeishuApi } from './api.ts'
import { buildCardJson, buildSegmentJson } from './cards.ts'
import { FeishuReplyHandle, makeAck, withRetry } from './reply.ts'

const TUNABLES = { cardUpdateThrottleMs: 500, cardMaxBytes: 26_000, processMaxBytes: 8000, cardPrintStep: 5, processingReactionEmoji: 'OneSecond' }

/** 飞书业务错误（模拟 lark SDK 的 axios error 形状）。 */
const bizError = (code: number): Error => Object.assign(new Error(`biz ${code}`), { response: { data: { code } } })

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
    downloadImage: async (...args) => { calls.push({ op: 'downloadImage', args }); return { data: new Uint8Array(), mediaType: 'image/png' } },
    getBotOpenId: async () => 'ou_bot_self',
    uploadFile: vi.fn(async (name: string) => { calls.push({ op: 'uploadFile', args: [name] }); return 'file_v3_xxx' }),
    sendFile: vi.fn(async (...args) => { calls.push({ op: 'sendFile', args }) }),
  }
  return { api, calls }
}

function make(api: FeishuApi, tunables: ChannelTunables = TUNABLES) {
  const logs: string[] = []
  const reply = new FeishuReplyHandle(api, 'oc_1', tunables, (m) => { logs.push(m) })
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
    expect(updates[0].args[0]).toBe('card_1')         // 真实 cardId 未被 PENDING 快照覆盖（flush fold 须在 exec 前）
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

  test('finalize：冲刷尾部 → 关流式 → 状态行定格 → 全量重放', async () => {
    const { api, calls } = fakeApi()
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '结论' }])
    await reply.finalize('done')
    const ops = calls.map((c) => c.op)
    expect(ops.slice(0, 2)).toEqual(['createCard', 'sendCardMessage'])
    expect(ops).toContain('setCardStreaming')
    expect(ops[ops.length - 1]).toBe('replaceCard')
    // 正确顺序：状态行定格更新在前（流式还开着），关流式 + summary 定格在后，最后全量重放
    const statusUpdate = calls.find((c) => c.op === 'updateCardElement' && c.args[1] === 'status')
    expect(statusUpdate).toBeDefined()
    expect(statusUpdate!.args[2]).toBe('✅ 输出完成')
    const close = calls.find((c) => c.op === 'setCardStreaming' && c.args[1] === false)
    expect(close).toBeDefined()
    expect(close!.args[3]).toBe('✅ 输出完成')   // summary 透传
    const replace = calls[calls.length - 1]!
    const card = JSON.parse(String(replace.args[1])) as { config: { streaming_mode: boolean }; body: { elements: { content?: string }[] } }
    expect(card.config.streaming_mode).toBe(false)
    expect(card.body.elements[0]!.content).toBe('结论')
    expect(card.body.elements.at(-1)!.content).toBe('✅ 输出完成')
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

describe('确认式出站与失败治理', () => {
  test('insert 遇 300301（元素重复）= 服务端已执行，视为成功', async () => {
    const { api, calls } = fakeApi()
    let once = true
    api.insertElement = async (...args) => {
      calls.push({ op: 'insertElement', args })
      if (once) { once = false; throw bizError(300301) }
    }
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '你好' }])
    await vi.advanceTimersByTimeAsync(500)
    // 简化：直接再 update 一个增长触发 update 即可；核心断言：insert 只调一次且后续 update 正常
    await reply.update([{ kind: 'text', content: '你好呀' }])
    await vi.advanceTimersByTimeAsync(500)
    expect(calls.filter((c) => c.op === 'insertElement')).toHaveLength(1)   // 300301 未触发重插
    expect(calls.some((c) => c.op === 'updateCardElement')).toBe(true)
  })

  test('update 遇 200850（流式超时关闭）：重激活后重放，内容完整', async () => {
    const { api, calls } = fakeApi()
    let once = true
    api.updateCardElement = async (...args) => {
      calls.push({ op: 'updateCardElement', args })
      if (once) { once = false; throw bizError(200850) }
    }
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '你好' }])
    await vi.advanceTimersByTimeAsync(500)
    await reply.update([{ kind: 'text', content: '你好，世界' }])
    await vi.advanceTimersByTimeAsync(500)
    const reactivate = calls.find((c) => c.op === 'setCardStreaming' && c.args[1] === true)
    expect(reactivate).toBeDefined()                        // 重激活发生
    const updates = calls.filter((c) => c.op === 'updateCardElement')
    expect(updates[updates.length - 1].args[2]).toBe('你好，世界')   // 重放后内容完整
    expect(updates[updates.length - 1].args[3]).toBeGreaterThan(updates[0].args[3] as number)  // sequence 递增
  })

  test('批内 insert 200850 重激活重放后 trailing noop 不回归已确认 seq：下一 flush 更新序号严格大于重放序号', async () => {
    const { api, calls } = fakeApi()
    let n = 0
    api.insertElement = async (...args) => {
      calls.push({ op: 'insertElement', args })
      if (++n === 2) throw bizError(200850)   // flush2 的 insert 首试命中 200850（flush1 正常）
    }
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '你好' }])
    await vi.advanceTimersByTimeAsync(500)                            // flush1：建卡 + insert seg_1@1
    await reply.update([{ kind: 'text', content: '你好' }, { kind: 'text', content: '再见' }])
    await vi.advanceTimersByTimeAsync(500)                            // flush2：insert seg_2 200850 → 重激活 → seq+1 重放
    const inserts = calls.filter((c) => c.op === 'insertElement')
    expect(inserts).toHaveLength(3)                                   // flush1 + flush2 首试 + 重放
    const replaySeq = inserts[2].args[3] as number                    // 重放成功那次的序号
    expect(calls.some((c) => c.op === 'setCardStreaming' && c.args[1] === true)).toBe(true)
    await reply.update([{ kind: 'text', content: '你好' }, { kind: 'text', content: '再见啦' }])
    await vi.advanceTimersByTimeAsync(500)                            // flush3：seg_2 增长 → update
    const updates = calls.filter((c) => c.op === 'updateCardElement')
    expect(updates).toHaveLength(1)
    expect(updates[0].args[3] as number).toBeGreaterThan(replaySeq)   // 不回归：更新序号严格大于重放序号
  })

  test('update 遇 200860（超 30KB）：废弃旧卡拆新卡续写，内容零丢失零重复', async () => {
    const { api, calls } = fakeApi()
    api.updateCardElement = async (...args) => { calls.push({ op: 'updateCardElement', args }); throw bizError(200860) }
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '前半' }])
    await vi.advanceTimersByTimeAsync(500)
    await reply.update([{ kind: 'text', content: '前半后半' }])
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(5000)
    // 旧卡尝试关流；新卡从「后半」（确认点之后）续写，不重演「前半」
    const inserts = calls.filter((c) => c.op === 'insertElement')
    const newCardInsert = inserts[inserts.length - 1]
    expect(String(newCardInsert.args[1])).toContain('后半')
    expect(String(newCardInsert.args[1])).not.toContain('前半')
    expect(calls.some((c) => c.op === 'createCard')).toBe(true)
    expect(calls.filter((c) => c.op === 'createCard').length).toBe(2)
  })

  test('未知网络错误：sequence+2 重放一次成功；持续失败则废弃重演尾段并 notice', async () => {
    const { api, calls } = fakeApi()
    let fail = 1
    api.updateCardElement = async (...args) => {
      calls.push({ op: 'updateCardElement', args })
      if (fail-- > 0) throw new Error('socket hangup')
    }
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '你好' }])
    await vi.advanceTimersByTimeAsync(500)
    await reply.update([{ kind: 'text', content: '你好，世界' }])
    await vi.advanceTimersByTimeAsync(500)
    const updates = calls.filter((c) => c.op === 'updateCardElement')
    expect(updates).toHaveLength(2)                                   // 首次失败 + 重放成功
    expect(updates[1].args[3]).toBe((updates[0].args[3] as number) + 2)  // seq+2
    expect(updates[1].args[2]).toBe('你好，世界')

    // 持续失败分支
    const { api: api2, calls: calls2 } = fakeApi()
    api2.updateCardElement = async (...args) => { calls2.push({ op: 'updateCardElement', args }); throw new Error('down') }
    const { reply: reply2 } = make(api2)
    await reply2.update([{ kind: 'text', content: '前半' }])
    await vi.advanceTimersByTimeAsync(500)
    await reply2.update([{ kind: 'text', content: '前半后半' }])
    await vi.advanceTimersByTimeAsync(500)
    const inserts2 = calls2.filter((c) => c.op === 'insertElement')
    // 废弃时重演尾段：新卡 insert 含完整段（从 base 重插）
    expect(String(inserts2[inserts2.length - 1].args[1])).toContain('前半后半')
    expect(calls2.some((c) => c.op === 'sendText' && String(c.args[1]).includes('卡片输出异常'))).toBe(true)
  })

  test('建卡链路失败保持现状语义：不重放不废弃，下次 flush 重试', async () => {
    const { api, calls } = fakeApi()
    let failing = true
    api.createCard = async () => {
      calls.push({ op: 'createCard', args: [] })
      if (failing) throw new Error('rate limited')
      return 'card_back'
    }
    const { reply } = make(api)
    await reply.update([{ kind: 'text', content: '你好' }])
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(5000)
    failing = false
    await reply.update([{ kind: 'text', content: '你好呀' }])
    await vi.advanceTimersByTimeAsync(500)
    const tail3 = calls.slice(-3).map((c) => c.op)
    expect(tail3).toEqual(['createCard', 'sendCardMessage', 'insertElement'])
    expect(String(calls[calls.length - 1].args[1])).toContain('你好呀')
  })

  /** 单次 flush 产出 insert + 定格(update status) + 关流(settings) + 续卡(create) 多 op 批：
   *  卡预算只够 4 字符/卡，7 字符内容恰好拆两张（首卡 4 字符后 closeCard，续卡 3 字符收尾）。 */
  function overflowBatchTunables(): ChannelTunables {
    const CARD_BASE = Buffer.byteLength(buildCardJson(5))
    const OVERHEAD = Buffer.byteLength(buildSegmentJson('text', 'seg_1', ''), 'utf8')
    return { ...TUNABLES, cardMaxBytes: CARD_BASE + OVERHEAD + 4 }
  }

  test('批内重放推高已确认 seq（200850 重激活）：后续定格/关流 op 序号抬升，不碰撞不回归', async () => {
    const { api, calls } = fakeApi()
    let once = true
    api.insertElement = async (...args) => {
      calls.push({ op: 'insertElement', args })
      if (once) { once = false; throw bizError(200850) }
    }
    const { reply } = make(api, overflowBatchTunables())
    await reply.update([{ kind: 'text', content: 'x'.repeat(7) }])
    await vi.advanceTimersByTimeAsync(500)
    const inserts = calls.filter((c) => c.op === 'insertElement')
    expect(inserts).toHaveLength(3)                                  // 首卡失败 + 重激活后重放 + 续卡
    const replaySeq = inserts[1].args[3] as number
    expect(replaySeq).toBeGreaterThan(inserts[0].args[3] as number)  // 重激活占一位后以 seq+1 重放
    expect(calls.some((c) => c.op === 'setCardStreaming' && c.args[1] === true)).toBe(true)
    const updates = calls.filter((c) => c.op === 'updateCardElement')
    expect(updates).toHaveLength(1)                                  // 首卡状态行定格
    expect(updates[0].args[3]).toBeGreaterThan(replaySeq)            // 定格 update > 已确认 seq（避让碰撞）
    const closes = calls.filter((c) => c.op === 'setCardStreaming' && c.args[1] === false)
    expect(closes).toHaveLength(1)                                   // 首卡关流
    expect(closes[0].args[2]).toBeGreaterThan(updates[0].args[3] as number)  // 关流继续递增
    expect(inserts[2].args[3]).toBe(1)                               // 续卡从新卡 seq 0 起排
  })

  test('批内未知错误重放（seq+2）：后续定格/关流 op 序号抬升到已确认 seq+1，不回归不碰撞', async () => {
    const { api, calls } = fakeApi()
    let once = true
    api.insertElement = async (...args) => {
      calls.push({ op: 'insertElement', args })
      if (once) { once = false; throw new Error('socket hangup') }
    }
    const { reply } = make(api, overflowBatchTunables())
    await reply.update([{ kind: 'text', content: 'x'.repeat(7) }])
    await vi.advanceTimersByTimeAsync(500)
    const inserts = calls.filter((c) => c.op === 'insertElement')
    expect(inserts).toHaveLength(3)
    const replaySeq = inserts[1].args[3] as number
    expect(replaySeq).toBeGreaterThan(inserts[0].args[3] as number)  // seq+2 重放
    const updates = calls.filter((c) => c.op === 'updateCardElement')
    expect(updates).toHaveLength(1)
    expect(updates[0].args[3]).toBeGreaterThan(replaySeq)
    const closes = calls.filter((c) => c.op === 'setCardStreaming' && c.args[1] === false)
    expect(closes).toHaveLength(1)
    expect(closes[0].args[2]).toBeGreaterThan(updates[0].args[3] as number)
    expect(inserts[2].args[3]).toBe(1)
  })

  test('同次规划内建卡即拆卡：replace 占位解析为关流 settings 捕获的真实 cardId', async () => {
    const { api, calls } = fakeApi()
    const { reply } = make(api, overflowBatchTunables())
    await reply.update([{ kind: 'text', content: 'x'.repeat(7) }])
    await vi.advanceTimersByTimeAsync(500)
    const replaces = calls.filter((c) => c.op === 'replaceCard')
    expect(replaces).toHaveLength(1)
    expect(replaces[0].args[0]).toBe('card_1')   // 折叠后的真实 id，非 PENDING 占位
    const card = JSON.parse(String(replaces[0].args[1])) as { body: { elements: { content?: string; element_id?: string }[] } }
    expect(card.body.elements[0]!.content).toBe('xxxx')   // 本卡已提交 piece 全量重放
    expect(card.body.elements.at(-1)!.content).toBe('📦 内容较长，已接续到下一张卡片')
    expect(replaces[0].args[2]).toBe(4)   // 关流 settings 后一位的 sequence
    // 拆卡批内后续 op 照常执行：续卡建卡并承接剩余
    const inserts = calls.filter((c) => c.op === 'insertElement')
    expect(inserts).toHaveLength(2)
    expect(inserts[1].args[0]).toBe('card_2')
    expect(JSON.parse(String(inserts[1].args[1])).content).toBe('xxx')
  })

  test('replace 失败非致命：记日志、照常 commit、批内后续 op 继续，不触发废弃', async () => {
    const { api, calls } = fakeApi()
    api.replaceCard = async (...args) => { calls.push({ op: 'replaceCard', args }); throw new Error('network down') }
    const { reply, logs } = make(api, overflowBatchTunables())
    await reply.update([{ kind: 'text', content: 'x'.repeat(7) }])
    await vi.advanceTimersByTimeAsync(500)    // flush：replace 首试失败，排 300ms 重试
    await vi.advanceTimersByTimeAsync(1000)   // 重试再败 → 记日志 + commit + 批内续卡继续
    expect(logs.some((m) => m.includes('全量重放失败'))).toBe(true)
    const replaces = calls.filter((c) => c.op === 'replaceCard')
    expect(replaces.length).toBeGreaterThan(0)
    expect(replaces[0].args[0]).toBe('card_1')   // 重放仍解析到真实卡号
    // 非致命：未触发废弃 notice，批内后续 op 照常 commit（续卡建卡并承接剩余）
    expect(calls.some((c) => c.op === 'sendText' && String(c.args[1]).includes('卡片输出异常'))).toBe(false)
    expect(calls.filter((c) => c.op === 'createCard').length).toBe(2)
    const inserts = calls.filter((c) => c.op === 'insertElement')
    expect(inserts[inserts.length - 1].args[0]).toBe('card_2')
    expect(JSON.parse(String(inserts[inserts.length - 1].args[1])).content).toBe('xxx')
  })
})

test('sendFile：上传后经 chatId 发文件消息，不走卡片串行链', async () => {
  const { api, calls } = fakeApi()
  const { reply } = make(api)
  await reply.sendFile!('report.md', new TextEncoder().encode('# 报告'))
  expect(calls.map((c) => c.op)).toEqual(['uploadFile', 'sendFile'])
  expect(calls[0].args[0]).toBe('report.md')
  expect(calls[1].args).toEqual(['oc_1', 'file_v3_xxx'])
})

test('sendFile：上传失败向调用方传播（重试耗尽后抛最后一次错误）', async () => {
  const { api } = fakeApi()
  vi.mocked(api.uploadFile).mockRejectedValue(new Error('网络错误'))
  const { reply } = make(api)
  const pending = reply.sendFile!('a.md', new Uint8Array(1))
  const assertion = expect(pending).rejects.toThrow('网络错误')
  await vi.advanceTimersByTimeAsync(3000)
  await assertion
})
