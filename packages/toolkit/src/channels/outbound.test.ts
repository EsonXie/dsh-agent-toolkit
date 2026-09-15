import { describe, expect, test, vi } from 'vitest'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplyHandle, TurnSegment, TurnStatus } from './channel.ts'
import { Outbound, applyStreamChunk, lastTextOf, mapTurnEnd, processOf, reconcileTrailingText, textOf } from './outbound.ts'
import type { SessionRuntime } from './ports.ts'

/** 构造一个 chunk 帧（attemptId/revision/index/time 宿主细节对 outbound 不消费，用占位；chunk 帧无 turn/step，由 start 帧建基线）。 */
function chunkFrame(chunk: StreamChunk): AssistantStreamFrame {
  return { type: 'chunk', attemptId: 'a1' as never, revision: 1, index: 0, time: 0, chunk }
}

/** 构造一个 start 帧（attempt 的 turn/step 基线来源）。 */
function startFrame(turn: number, step: number): AssistantStreamFrame {
  return { type: 'start', attemptId: 'a1' as never, revision: 1, turn, step }
}

function fakeRuntime(reply: ReplyHandle): SessionRuntime {
  return {
    botId: 'b', chatId: 'oc_1', sessionId: 's1', initiatorOpenId: 'ou_x',
    agent: { sessionId: 's1', followup: vi.fn(), cancel: vi.fn(), whenIdle: async () => undefined, dispose: vi.fn(async () => undefined) },
    reply, inflight: { ack: undefined }, tail: Promise.resolve(), turn: undefined, retiring: false,
  }
}

function recorder() {
  const calls: { op: string; arg?: string }[] = []
  const reply: ReplyHandle = {
    beginTurn: async () => { calls.push({ op: 'beginTurn' }) },
    update: async (segs) => {
      calls.push({ op: 'update', arg: (segs as readonly { kind: string; content: string }[]).map((s) => `${s.kind}:${s.content}`).join(' | ') })
    },
    finalize: async (status: TurnStatus, detail?: string) => { calls.push({ op: 'finalize', arg: `${status}${detail ? `:${detail}` : ''}` }) },
    notice: async (text) => { calls.push({ op: 'notice', arg: text }) },
  }
  return { calls, reply }
}

async function drain(rt: SessionRuntime): Promise<void> { await rt.tail }

describe('textOf / mapTurnEnd', () => {
  test('textOf 只取 text 块并拼接', () => {
    expect(textOf([{ type: 'text', text: 'a' }, { type: 'tool-call', id: 'x' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(textOf([])).toBe('')
  })

  test('mapTurnEnd 状态映射（reason 为 TurnEndReason 对象，按 kind 判定）', () => {
    expect(mapTurnEnd({ kind: 'completed' })).toBe('done')
    expect(mapTurnEnd({ kind: 'aborted' })).toBe('cancelled')
    expect(mapTurnEnd({ kind: 'interrupted' })).toBe('cancelled')
    expect(mapTurnEnd({ kind: 'error' })).toBe('error')
    expect(mapTurnEnd({ kind: 'max-tokens' })).toBe('error')
    expect(mapTurnEnd({ kind: 'blocked' })).toBe('error')
  })
})

describe('processOf', () => {
  test('reasoning 取全文；tool_call 渲染摘要行；其余块忽略', () => {
    expect(processOf([
      { type: 'reasoning', text: '想一下' },
      { type: 'text', text: '正文' },
      { type: 'tool_call', id: 'c1', name: 'shell', arguments: { command: 'ls' } },
    ])).toBe('想一下\n\n🔧 shell — {"command":"ls"}\n\n')
    expect(processOf([{ type: 'text', text: 'a' }])).toBe('')
  })

  test('参数摘要截断到 120 字符', () => {
    const out = processOf([{ type: 'tool_call', id: 'c', name: 'n', arguments: { x: 'y'.repeat(200) } }])
    const line = out.split('\n')[0]
    expect(line.length).toBeLessThan(200)
    expect(line.endsWith('…')).toBe(true)
  })
})

describe('Outbound.handleSessionEvent', () => {
  test('turn 全流程：beginTurn 一次 → 全量 update → turn/end 定格并释放 inflight + 删除表情', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const ack = vi.fn()
    rt.inflight = { ack }
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)

    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: '你好' }))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: '，世界' }))
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drain(rt)

    expect(calls).toEqual([
      { op: 'beginTurn' },
      { op: 'update', arg: 'text:你好' },
      { op: 'update', arg: 'text:你好，世界' },
      { op: 'finalize', arg: 'done' },
    ])
    expect(ack).toHaveBeenCalledOnce()
    expect(rt.inflight).toBeUndefined()
    expect(rt.turn).toBeUndefined()
  })

  test('turn/end 释放 inflight 后同步触发 onTurnIdle（占槽转移先于删表情）', async () => {
    const { reply } = recorder()
    const rt = fakeRuntime(reply)
    const ack = vi.fn()
    rt.inflight = { ack }
    // 模拟核心侧排水：回调内同步重新占槽（验证释→占同窗，finalize/ack 不覆盖新槽）。
    const idle = vi.fn(() => { rt.inflight = { ack: undefined } })
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined, 500, idle)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drain(rt)
    expect(idle).toHaveBeenCalledOnce()
    expect(idle).toHaveBeenCalledWith(rt)
    expect(idle.mock.invocationCallOrder[0]!).toBeLessThan(ack.mock.invocationCallOrder[0]!)
    expect(rt.inflight).toEqual({ ack: undefined })
  })

  test('reasoning 与 tool_call 进过程缓冲：block-end 补段分隔后并入同一 process 段', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'reasoning-delta', index: 0, text: '先读文件' }))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'block-end', index: 0, block: { type: 'reasoning', text: '先读文件' } }))
    outbound.handleSessionEvent('s1', { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'fs_read', arguments: '{"path":"a.ts"}' } })
    await drain(rt)
    expect(calls).toEqual([
      { op: 'beginTurn' },
      { op: 'update', arg: 'process:先读文件' },
      { op: 'update', arg: 'process:先读文件\n\n' },
      { op: 'update', arg: 'process:先读文件\n\n🔧 fs_read — {"path":"a.ts"}\n\n' },
    ])
  })

  test('思考/工具/正文交替进段序列', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'reasoning-delta', index: 0, text: '想' }))
    outbound.handleSessionEvent('s1', { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'fs_read', arguments: '{}' } })
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 1, text: '好' }))
    await drain(rt)
    expect(calls).toEqual([
      { op: 'beginTurn' },
      { op: 'update', arg: 'process:想' },
      { op: 'update', arg: 'process:想🔧 fs_read — {}\n\n' },
      { op: 'update', arg: 'process:想🔧 fs_read — {}\n\n | text:好' },
    ])
  })

  test('无文本输出的 error turn：finalize 带错误 detail（无卡降级文本），仍释放 inflight 与表情', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const ack = vi.fn()
    rt.inflight = { ack }
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT' } } } })
    await drain(rt)
    expect(calls).toEqual([{ op: 'finalize', arg: 'error:rate limited' }])
    expect(ack).toHaveBeenCalledOnce()
    expect(rt.inflight).toBeUndefined()
  })

  test('error turn 的 detail 截断到 maxErrorDetailChars', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined, 10)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'a'.repeat(50) } } } })
    await drain(rt)
    expect(calls).toEqual([{ op: 'finalize', arg: `error:${'a'.repeat(10)}…` }])
  })

  test('无文本输出且非 error 的 turn：不建卡不出 detail，仍释放 inflight 与表情', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const ack = vi.fn()
    rt.inflight = { ack }
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'blocked' } } })
    await drain(rt)
    expect(calls).toEqual([])
    expect(ack).toHaveBeenCalledOnce()
    expect(rt.inflight).toBeUndefined()
  })

  test('非本插件 session 与错序 turn 的帧被忽略', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('other-session', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(9, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: 'x' }))
    await drain(rt)
    expect(calls).toEqual([])
  })

  test('start 帧只建 attempt 基线不产生卡操作；end 帧被忽略', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', { type: 'end', attemptId: 'a1' as never, revision: 1, index: 3, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 5 as never } })
    await drain(rt)
    expect(calls).toEqual([])
    expect(rt.turn!.attemptStep).toBe(1)
  })

  test('chunk 帧在 turn/start 前到达被忽略', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: 'x' }))
    await drain(rt)
    expect(calls).toEqual([])
  })

  test('chunk 帧无 start 基线（attempt 未开始）被忽略', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: 'x' }))
    await drain(rt)
    expect(calls).toEqual([])
  })

  test('assistant/message 对账补齐缺帧正文：尾 text 段替换为权威全文', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: '你好' }))
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好，世界' }] } } })
    await drain(rt)
    expect(calls).toEqual([
      { op: 'beginTurn' },
      { op: 'update', arg: 'text:你好' },
      { op: 'update', arg: 'text:你好，世界' },
    ])
    expect(rt.turn!.segments).toEqual([{ kind: 'text', content: '你好，世界' }])
  })

  test('assistant/message 对账对 process 段零改动', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'reasoning-delta', index: 0, text: '想' }))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 1, text: '你好' }))
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好，世界' }] } } })
    await drain(rt)
    expect(rt.turn!.segments).toEqual([
      { kind: 'process', content: '想' },
      { kind: 'text', content: '你好，世界' },
    ])
    const last = calls[calls.length - 1]!
    expect(last).toEqual({ op: 'update', arg: 'process:想 | text:你好，世界' })
  })

  test('assistant/attempt 被忽略：不产生 update，turn/end 照常定格', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'reasoning-delta', index: 0, text: '想' }))
    outbound.handleSessionEvent('s1', { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [] } })
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drain(rt)
    expect(calls).toEqual([
      { op: 'beginTurn' },
      { op: 'update', arg: 'process:想' },
      { op: 'finalize', arg: 'done' },
    ])
  })

  test('防护：step2 正文帧全部丢失时对账 append 补回，step1 已提交正文不被覆盖', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: 'A' }))
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'A' }] } } })
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'B' }] } } })
    await drain(rt)
    // 防护未命中 ⇒ 不替换 step1 已提交正文；帧全丢 ⇒ append 补回 step2 正文
    expect(rt.turn!.segments).toEqual([{ kind: 'text', content: 'AB' }])
    expect(calls[calls.length - 1]).toEqual({ op: 'update', arg: 'text:AB' })
  })

  test('防护反向：step2 至少应用过一帧 text-delta 时对账正常补齐', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: 'A' }))
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'A' }] } } })
    outbound.handleAssistantFrame('s1', startFrame(1, 2))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: 'B' }))
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'BC' }] } } })
    await drain(rt)
    expect(rt.turn!.segments).toEqual([{ kind: 'text', content: 'BC' }])
    expect(calls[calls.length - 1]).toEqual({ op: 'update', arg: 'text:BC' })
  })

  test('turn 内两 step 交错次序：按宿主发射顺序喂入，段序列与 update 次数正确', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'reasoning-delta', index: 0, text: '想一' }))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 1, text: '你好' }))
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '你好' }] } } })
    outbound.handleSessionEvent('s1', { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'fs_read', arguments: '{}' } })
    outbound.handleAssistantFrame('s1', startFrame(1, 2))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'reasoning-delta', index: 0, text: '再想' }))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 1, text: '世界' }))
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '世界' }] } } })
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drain(rt)
    expect(rt.turn).toBeUndefined()
    expect(calls).toEqual([
      { op: 'beginTurn' },
      { op: 'update', arg: 'process:想一' },
      { op: 'update', arg: 'process:想一 | text:你好' },
      { op: 'update', arg: 'process:想一 | text:你好 | process:🔧 fs_read — {}\n\n' },
      { op: 'update', arg: 'process:想一 | text:你好 | process:🔧 fs_read — {}\n\n再想' },
      { op: 'update', arg: 'process:想一 | text:你好 | process:🔧 fs_read — {}\n\n再想 | text:世界' },
      { op: 'finalize', arg: 'done' },
    ])
  })
})

describe('applyStreamChunk / reconcileTrailingText / lastTextOf', () => {
  test('applyStreamChunk：三类消费，其余返回 false', () => {
    const segments: { kind: 'text' | 'process'; content: string }[] = []
    expect(applyStreamChunk(segments, { type: 'text-delta', index: 0, text: 'a' })).toBe(true)
    expect(applyStreamChunk(segments, { type: 'reasoning-delta', index: 0, text: '想' })).toBe(true)
    expect(applyStreamChunk(segments, { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想' } })).toBe(true)
    expect(applyStreamChunk(segments, { type: 'block-start', index: 0, blockType: 'text' })).toBe(false)
    expect(applyStreamChunk(segments, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } })).toBe(false)
    expect(applyStreamChunk(segments, { type: 'finish', reason: { kind: 'stop' } })).toBe(false)
    expect(applyStreamChunk(segments, { type: 'tool-call-delta', index: 0, id: 'c1' as never, argumentsDelta: '{}' })).toBe(false)
    expect(segments).toEqual([
      { kind: 'text', content: 'a' },
      { kind: 'process', content: '想\n\n' },
    ])
  })

  test('reconcileTrailingText 幂等：内容相等返回 false 且不改段', () => {
    const segments: TurnSegment[] = [{ kind: 'text', content: 'abc' }]
    expect(reconcileTrailingText(segments, 'abc')).toBe(false)
    expect(segments).toEqual([{ kind: 'text', content: 'abc' }])
  })

  test('reconcileTrailingText 补齐前缀：返回 true 且替换为权威全文', () => {
    const segments: TurnSegment[] = [{ kind: 'text', content: 'ab' }]
    expect(reconcileTrailingText(segments, 'abcd')).toBe(true)
    expect(segments).toEqual([{ kind: 'text', content: 'abcd' }])
  })

  test('reconcileTrailingText：authoritative 为空不改段，无 text 段返回 false', () => {
    expect(reconcileTrailingText([{ kind: 'text', content: 'abc' }], '')).toBe(false)
    const processOnly: TurnSegment[] = [{ kind: 'process', content: '想' }]
    expect(reconcileTrailingText(processOnly, 'abc')).toBe(false)
    expect(processOnly).toEqual([{ kind: 'process', content: '想' }])
  })

  test('reconcileTrailingText 多 text 段只改尾段（不动前序 text 与 process）', () => {
    const segments: TurnSegment[] = [
      { kind: 'process', content: 'p1' },
      { kind: 'text', content: 'A' },
      { kind: 'process', content: 'p2' },
      { kind: 'text', content: 'B' },
    ]
    expect(reconcileTrailingText(segments, 'B2')).toBe(true)
    expect(segments).toEqual([
      { kind: 'process', content: 'p1' },
      { kind: 'text', content: 'A' },
      { kind: 'process', content: 'p2' },
      { kind: 'text', content: 'B2' },
    ])
  })

  test('lastTextOf 无 text 块返回空串（非 undefined）', () => {
    expect(lastTextOf([{ type: 'reasoning', text: 'r' }, { type: 'tool-call', id: 'c' }])).toBe('')
    expect(lastTextOf([])).toBe('')
    expect(lastTextOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('b')
  })

  test('lastTextOf 多 text 块只取最后块，不与前序块串接', () => {
    expect(lastTextOf([{ type: 'text', text: '前序' }, { type: 'reasoning', text: 'r' }, { type: 'text', text: '末尾' }])).toBe('末尾')
    expect(lastTextOf([{ type: 'text', text: '前序' }, { type: 'text', text: '末尾' }])).toBe('末尾')
  })
})

describe('Outbound.handleAgentError（turn 外错误）', () => {
  test('无进行中 turn：notice 错误摘要并释放 inflight + 删除表情', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const ack = vi.fn()
    rt.inflight = { ack }
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleAgentError('s1', 'provider unavailable')
    await drain(rt)
    expect(calls).toEqual([{ op: 'notice', arg: '出错了：provider unavailable' }])
    expect(ack).toHaveBeenCalledOnce()
    expect(rt.inflight).toBeUndefined()
  })

  test('有进行中 turn：跳过（由 turn/end 报告，避免双发）', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAgentError('s1', 'boom')
    await drain(rt)
    expect(calls).toEqual([])
  })

  test('非本插件 session 的 agent/error 被忽略', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleAgentError('other-session', 'boom')
    await drain(rt)
    expect(calls).toEqual([])
  })

  test('notice 文本同样截断到 maxErrorDetailChars', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined, 5)
    outbound.handleAgentError('s1', 'x'.repeat(20))
    await drain(rt)
    expect(calls).toEqual([{ op: 'notice', arg: `出错了：${'x'.repeat(5)}…` }])
  })

  test('agent/error（turn 外）释放 inflight 后同样触发 onTurnIdle', async () => {
    const { reply } = recorder()
    const rt = fakeRuntime(reply)
    rt.inflight = { ack: undefined }
    const idle = vi.fn()
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined, 500, idle)
    outbound.handleAgentError('s1', 'boom')
    await drain(rt)
    expect(idle).toHaveBeenCalledOnce()
  })
})

describe('对账 replace-or-append', () => {
  test('本 step 一帧未到（start 帧丢）：append 新 text 段补回权威全文', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const events: { event: string; [k: string]: unknown }[] = []
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined, 500, undefined, (e) => { events.push(e) })
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    // start 帧丢失、chunk 全丢：直接来持久结算事件
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '完整答复' }] } } })
    await drain(rt)
    expect(calls).toEqual([{ op: 'beginTurn' }, { op: 'update', arg: 'text:完整答复' }])
    expect(events).toContainEqual(expect.objectContaining({ event: 'reconcile', result: 'appended', authoritativeLen: 4 }))
  })

  test('防护未命中且权威文本为空：跳过（skipped-empty），不产生 update', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'tool_call', id: 'c', name: 'n' }] } } })
    await drain(rt)
    expect(calls).toEqual([])
  })

  test('多 text 块消息：权威文本为全部 text 块拼接（textOf），不丢前块', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: 'A' }))   // B 的帧丢了
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'A' }, { type: 'tool_call', id: 'c', name: 'n' }, { type: 'text', text: 'B' }] } } })
    await drain(rt)
    // 对账把尾 text 段从 'A' 替换为拼接全文 'AB'
    expect(calls[calls.length - 1]).toEqual({ op: 'update', arg: 'text:AB' })
  })

  test('frame-stats：turn/end 输出帧统计（含基线缺失丢弃计数）', async () => {
    const { reply } = recorder()
    const rt = fakeRuntime(reply)
    const events: { event: string; [k: string]: unknown }[] = []
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined, 500, undefined, (e) => { events.push(e) })
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleAssistantFrame('s1', startFrame(1, 1))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: '你好' }))
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'reasoning-delta', index: 1, text: '想' }))
    // 无基线丢弃：把 attemptStep 清掉模拟 start 帧丢失后的 chunk（直接改 turn 状态模拟第二步丢 start）
    rt.turn!.attemptStep = undefined
    outbound.handleAssistantFrame('s1', chunkFrame({ type: 'text-delta', index: 0, text: '丢' }))
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await drain(rt)
    expect(events).toContainEqual(expect.objectContaining({
      event: 'frame-stats', turn: 1, starts: 1, textDeltas: 1, reasoningDeltas: 1, droppedNoBaseline: 1, lastTextStep: 1,
    }))
  })
})
