import { describe, expect, test, vi } from 'vitest'
import type { Disposer, InboundMessage, ReplyHandle } from '../src/core/channel.ts'
import { Inbound } from '../src/core/inbound.ts'
import type { AgentPort, AgentsPort, BindingStore, SessionRuntime } from '../src/core/ports.ts'
import { Router } from '../src/core/router.ts'
import type { BotRecord } from '../src/store.ts'

const BOT: BotRecord = {
  id: 'reviewer', name: '评审', channel: 'feishu',
  feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
  project: 'D:\\work\\demo', createdAt: 0, updatedAt: 0,
}

interface Recorded {
  notices: string[]
  acked: number
  followups: { text: string; source: Record<string, unknown> }[]
  cancels: number
}

function harness() {
  const rec: Recorded = { notices: [], acked: 0, followups: [], cancels: 0 }
  const agents: AgentsPort = {
    create: async (input) => fakeAgent(input.sessionId, rec),
    resume: async (input) => fakeAgent(input.sessionId, rec),
  }
  const map = new Map<string, string>()
  const bindings: BindingStore = {
    get: (b, c) => map.get(`${b}:${c}`),
    set: async (b, c, s) => { map.set(`${b}:${c}`, s) },
    delete: async (b, c) => { map.delete(`${b}:${c}`) },
    deleteBot: async () => undefined,
  }
  const sessions = new Map<string, SessionRuntime>()
  const router = new Router(agents, bindings, sessions)
  const inbound = new Inbound({
    router,
    bots: { get: (id) => (id === BOT.id ? BOT : undefined) },
    onError: () => undefined,
  })
  function msg(text: string, chatId = 'oc_1'): InboundMessage {
    return {
      botId: BOT.id, chatId, userId: 'ou_u1', messageId: `om_${Math.random()}`,
      text,
      reply: fakeReply(rec),
      ackProcessing: async (): Promise<Disposer> => {
        rec.acked += 1
        return () => undefined
      },
    }
  }
  return { rec, inbound, sessions, msg }
}

function fakeAgent(sessionId: string, rec: Recorded): AgentPort {
  return {
    sessionId,
    followup: (m) => {
      const message = m as { content: { type: string; text?: string }[]; source: Record<string, unknown> }
      rec.followups.push({ text: message.content[0].text ?? '', source: message.source })
    },
    cancel: () => { rec.cancels += 1 },
    whenIdle: async () => undefined,
  }
}

function fakeReply(rec: Recorded): ReplyHandle {
  return {
    beginTurn: async () => undefined,
    update: async () => undefined,
    finalize: async () => undefined,
    notice: async (text) => { rec.notices.push(text) },
  }
}

test('普通消息：建会话、表情回复、followup 携带 project-bot source', async () => {
  const { rec, inbound, sessions, msg } = harness()
  inbound.onMessage(msg('帮我评审这段代码'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  expect(rec.acked).toBe(1)
  expect(rec.followups[0].text).toBe('帮我评审这段代码')
  expect(rec.followups[0].source).toMatchObject({ kind: 'project-bot', channel: 'feishu', botId: 'reviewer', chatId: 'oc_1', userId: 'ou_u1' })
  expect(sessions.size).toBe(1)
})

test('in-flight 占用期间第二条消息被拒并提示', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('第一条'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('第二条'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('上一条还在处理中'))).toBe(true) })
  expect(rec.followups).toHaveLength(1)
})

test('/new：重置会话并确认', async () => {
  const { rec, inbound, sessions, msg } = harness()
  inbound.onMessage(msg('触发建会话'))
  await vi.waitFor(() => { expect(sessions.size).toBe(1) })
  const oldSessionId = [...sessions.keys()][0]
  inbound.onMessage(msg('/new'))
  await vi.waitFor(() => { expect(rec.notices).toContain('已开启新会话') })
  expect(rec.cancels).toBe(1)
  expect([...sessions.keys()][0]).not.toBe(oldSessionId)
})

test('/stop：无任务时提示；有任务时取消', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('/stop'))
  await vi.waitFor(() => { expect(rec.notices).toContain('当前没有进行中的任务') })

  inbound.onMessage(msg('跑个任务'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })   // inflight 未释放
  inbound.onMessage(msg('/stop'))
  await vi.waitFor(() => { expect(rec.notices).toContain('已请求停止当前任务') })
  expect(rec.cancels).toBe(1)
})

test('/status：汇报项目与会话状态', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('/status'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('未创建'))).toBe(true) })
  inbound.onMessage(msg('建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('/status'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('D:\\work\\demo') && n.includes('处理中'))).toBe(true) })
})

test('未知 botId 的消息直接丢弃', async () => {
  const { rec, inbound, msg } = harness()
  const m = msg('hello')
  m.botId = 'ghost'
  inbound.onMessage(m)
  await new Promise((r) => setTimeout(r, 20))
  expect(rec.followups).toHaveLength(0)
  expect(rec.notices).toHaveLength(0)
})
