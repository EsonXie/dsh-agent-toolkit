import { describe, expect, test, vi } from 'vitest'
import type { ReplyHandle, TurnStatus } from '../src/core/channel.ts'
import { Outbound, mapTurnEnd, textOf } from '../src/core/outbound.ts'
import type { SessionRuntime } from '../src/core/ports.ts'

function fakeRuntime(reply: ReplyHandle): SessionRuntime {
  return {
    botId: 'b', chatId: 'oc_1', sessionId: 's1',
    agent: { sessionId: 's1', followup: vi.fn(), cancel: vi.fn(), whenIdle: async () => undefined },
    reply, inflight: { ack: undefined }, tail: Promise.resolve(), turn: undefined,
  }
}

function recorder() {
  const calls: { op: string; arg?: string }[] = []
  const reply: ReplyHandle = {
    beginTurn: async () => { calls.push({ op: 'beginTurn' }) },
    update: async (md) => { calls.push({ op: 'update', arg: md }) },
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

  test('mapTurnEnd 状态映射', () => {
    expect(mapTurnEnd('completed')).toBe('done')
    expect(mapTurnEnd('aborted')).toBe('cancelled')
    expect(mapTurnEnd('interrupted')).toBe('cancelled')
    expect(mapTurnEnd('error')).toBe('error')
    expect(mapTurnEnd('max-tokens')).toBe('error')
    expect(mapTurnEnd('blocked')).toBe('error')
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
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '你好' }] } } })
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '，世界' }] } } })
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
    await drain(rt)

    expect(calls).toEqual([
      { op: 'beginTurn' },
      { op: 'update', arg: '你好' },
      { op: 'update', arg: '你好，世界' },
      { op: 'finalize', arg: 'done' },
    ])
    expect(ack).toHaveBeenCalledOnce()
    expect(rt.inflight).toBeUndefined()
    expect(rt.turn).toBeUndefined()
  })

  test('无文本输出的 turn：不建卡，仍释放 inflight 与表情', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const ack = vi.fn()
    rt.inflight = { ack }
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: 'error' } })
    await drain(rt)
    expect(calls).toEqual([])
    expect(ack).toHaveBeenCalledOnce()
    expect(rt.inflight).toBeUndefined()
  })

  test('非本插件 session 与错序 turn 的事件被忽略', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('other-session', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 9, message: { content: [{ type: 'text', text: 'x' }] } } })
    await drain(rt)
    expect(calls).toEqual([])
  })
})
