import { describe, expect, test, vi } from 'vitest'
import type { ReplyHandle, TurnStatus } from './channel.ts'
import { Outbound, mapTurnEnd, processOf, textOf } from './outbound.ts'
import type { SessionRuntime } from './ports.ts'

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
    outbound.handleSessionEvent('s1', { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '你好' } } })
    outbound.handleSessionEvent('s1', { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '，世界' } } })
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

  test('reasoning 与 tool_call 进过程缓冲：block-end 补段分隔后并入同一 process 段', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '先读文件' } } })
    outbound.handleSessionEvent('s1', { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先读文件' } } } })
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
    outbound.handleSessionEvent('s1', { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: '想' } } })
    outbound.handleSessionEvent('s1', { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'fs_read', arguments: '{}' } })
    outbound.handleSessionEvent('s1', { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: '好' } } })
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

  test('非本插件 session 与错序 turn 的事件被忽略', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('other-session', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'assistant/chunk', data: { turn: 9, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } })
    await drain(rt)
    expect(calls).toEqual([])
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
})
