import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Disposer, InboundMessage, ReplyHandle } from './channel.ts'
import { Inbound, type AttachmentsPort, type InboundDeps } from './inbound.ts'
import { Outbound } from './outbound.ts'
import type { AgentPort, AgentsPort, BindingStore, SessionCatalogPort, SessionRuntime } from './ports.ts'
import { Router } from './router.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import { bindingKey, type BotRecord } from '../bots/store.ts'

const BOT: BotRecord = {
  id: 'reviewer', name: '评审', channel: 'feishu',
  feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
  project: 'D:\\work\\demo', createdAt: 0, updatedAt: 0,
}

interface Recorded {
  notices: string[]
  acked: number
  followups: { text: string; source: Record<string, unknown>; content: unknown[] }[]
  cancels: number
  hookInputs: unknown[]
}

function harness(opts: {
  createError?: unknown
  resumeError?: unknown
  project?: string
  attachments?: () => AttachmentsPort | undefined
  catalog?: () => SessionCatalogPort | undefined
  followupThrowsOn?: string
  extraBots?: BotRecord[]
  consumeAnswer?: InboundDeps['consumeAnswer']
} = {}) {
  const rec: Recorded = { notices: [], acked: 0, followups: [], cancels: 0, hookInputs: [] }
  const bot: BotRecord = { ...BOT, ...(opts.project !== undefined ? { project: opts.project } : {}) }
  const allBots = [bot, ...(opts.extraBots ?? [])]
  const agents: AgentsPort = {
    get: () => undefined,
    create: async (input) => {
      if (opts.createError !== undefined) throw opts.createError
      rec.hookInputs.push(input.hooks)
      return fakeAgent(input.sessionId, rec, opts)
    },
    resume: async (input) => {
      if (opts.resumeError !== undefined) throw opts.resumeError
      rec.hookInputs.push(input.hooks)
      return fakeAgent(input.sessionId, rec, opts)
    },
  }
  const map = new Map<string, string>()
  const bindings: BindingStore = {
    get: (b, c, t) => map.get(bindingKey(b, c, t)),
    set: async (b, c, t, s) => { map.set(bindingKey(b, c, t), s) },
    delete: async (b, c, t) => { map.delete(bindingKey(b, c, t)) },
    deleteBot: async () => undefined,
  }
  const sessions = new Map<string, SessionRuntime>()
  const workspace = { attach: vi.fn(async () => undefined) }
  const onWarn = vi.fn()
  const registry: AgentRegistry = {
    list: () => [],
    get: () => undefined,
    upsert: async () => undefined,
    remove: async () => undefined,
    subscribe: () => () => undefined,
  }
  const router = new Router(agents, bindings, sessions, () => ({ provider: 'deepseek', model: 'deepseek-v4' }), workspace, onWarn, registry)
  const inbound = new Inbound({
    router,
    bots: { get: (id) => allBots.find((b) => b.id === id) },
    maxErrorDetailChars: 200,
    docMaxBytes: 1024 * 1024,
    ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
    ...(opts.catalog !== undefined ? { catalog: opts.catalog } : {}),
    ...(opts.consumeAnswer !== undefined ? { consumeAnswer: opts.consumeAnswer } : {}),
    onError: () => undefined,
  })
  function msg(text: string, chatId = 'oc_1', loadImages?: InboundMessage['loadImages'], reply?: ReplyHandle, ackProcessing?: InboundMessage['ackProcessing']): InboundMessage {
    return {
    botId: BOT.id, chatId, userId: 'ou_u1', messageId: `om_${Math.random()}`,
    chatType: 'p2p',
    text,
    ...(loadImages !== undefined ? { loadImages } : {}),
    reply: reply ?? fakeReply(rec),
    ackProcessing: ackProcessing ?? (async (): Promise<Disposer> => {
      rec.acked += 1
      return () => undefined
    }),
  }
}
  return { rec, inbound, sessions, router, msg, workspace, onWarn }
}

function fakeAgent(sessionId: string, rec: Recorded, opts: { followupThrowsOn?: string }): AgentPort {
  return {
    sessionId,
    followup: (m) => {
      const message = m as { content: { type: string; text?: string }[]; source: Record<string, unknown> }
      if (opts.followupThrowsOn !== undefined && message.content[0]?.text === opts.followupThrowsOn) throw new Error('投递失败')
      rec.followups.push({ text: message.content[0].text ?? '', source: message.source, content: message.content })
    },
    cancel: () => { rec.cancels += 1 },
    whenIdle: async () => undefined,
    dispose: async () => undefined,
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

test('普通消息：建会话、表情回复、followup 携带 user source（与 dsh 原生命名一致）', async () => {
  const { rec, inbound, sessions, msg } = harness()
  inbound.onMessage(msg('帮我评审这段代码'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  expect(rec.acked).toBe(1)
  expect(rec.followups[0].text).toBe('帮我评审这段代码')
  expect(rec.followups[0].source).toEqual({ kind: 'user' })
  expect(sessions.size).toBe(1)
})

test('首条消息投递时惰性 attach 到 bot 项目 workspace（/new 空白会话在此之前不被 web blank 复用捕获）', async () => {
  const { rec, inbound, router, msg, workspace } = harness()
  inbound.onMessage(msg('帮我评审这段代码'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const rt = router.lookup('reviewer', 'oc_1')!
  expect(workspace.attach).toHaveBeenCalledOnce()
  expect(workspace.attach).toHaveBeenCalledWith('D:\\work\\demo', rt.sessionId)
})

test('同一会话后续消息不重复 attach', async () => {
  const { rec, inbound, router, msg, workspace } = harness()
  inbound.onMessage(msg('第一条'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const rt = router.lookup('reviewer', 'oc_1')!
  rt.inflight = undefined
  inbound.onMessage(msg('第二条'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(2) })
  expect(workspace.attach).toHaveBeenCalledOnce()
})

test('attach 失败仅告警，消息照常投递', async () => {
  const { rec, inbound, msg, workspace, onWarn } = harness()
  workspace.attach.mockRejectedValueOnce(new Error('no workspaceRegistry'))
  inbound.onMessage(msg('帮我评审这段代码'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  expect(onWarn).toHaveBeenCalledOnce()
})

test('in-flight 占用期间第二条消息排队并提示队位', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('第一条'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('第二条'))
  inbound.onMessage(msg('第三条'))
  await vi.waitFor(() => { expect(rec.notices).toContain('已排队（第 2 位），撤回原消息可取消执行') })
  expect(rec.notices).toContain('已排队（第 1 位），撤回原消息可取消执行')
  expect(rec.followups).toHaveLength(1)
})

test('排队中消息不替换 rt.reply，运行中 turn 仍在旧句柄收尾', async () => {
  const { rec, inbound, router, msg } = harness()
  inbound.onMessage(msg('任务一'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const rt = router.lookup('reviewer', 'oc_1')!
  const firstReply = rt.reply
  inbound.onMessage(msg('追问'))
  await vi.waitFor(() => { expect(rec.notices).toContain('已排队（第 1 位），撤回原消息可取消执行') })
  expect(rt.reply).toBe(firstReply)
})

test('drain：槽位空闲且队列非空时立即执行队首（幂等）', async () => {
  const { rec, inbound, router, msg } = harness()
  inbound.onMessage(msg('第一条'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('第二条'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
  const rt = router.lookup('reviewer', 'oc_1')!
  rt.inflight = undefined
  inbound.drain('reviewer', 'oc_1')
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(2) })
  expect(rec.followups[1].text).toBe('第二条')
  expect(rt.inflight).not.toBeUndefined()
  // 幂等：队列空后再 drain 无事发生
  rt.inflight = undefined
  inbound.drain('reviewer', 'oc_1')
  await new Promise((r) => setTimeout(r, 20))
  expect(rec.followups).toHaveLength(2)
})

test('drain：无绑定会话或 retiring 时不排水', async () => {
  const { rec, inbound, router, msg } = harness()
  inbound.drain('reviewer', 'oc_never')   // 无队列无会话：静默
  inbound.onMessage(msg('任务'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('排队'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
  const rt = router.lookup('reviewer', 'oc_1')!
  rt.retiring = true
  rt.inflight = undefined
  inbound.drain('reviewer', 'oc_1')
  await new Promise((r) => setTimeout(r, 20))
  expect(rec.followups).toHaveLength(1)
})

test('clearQueues：清空该 bot 全部 chat 的队列，不影响其他 bot', async () => {
  const other: BotRecord = { ...BOT, id: 'writer', name: '写手' }
  const { rec, inbound, router, msg } = harness({ extraBots: [other] })
  // reviewer 占槽 + 排队
  inbound.onMessage(msg('任务'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('排队'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
  // writer 占槽 + 排队
  const writerTask = msg('写手任务')
  writerTask.botId = 'writer'
  inbound.onMessage(writerTask)
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(2) })
  const writerQueued = msg('写手排队')
  writerQueued.botId = 'writer'
  inbound.onMessage(writerQueued)
  await vi.waitFor(() => { expect(rec.notices.filter((n) => n.includes('已排队'))).toHaveLength(2) })

  inbound.clearQueues('reviewer')

  // reviewer 队列已清：释放槽位排水不执行「排队」
  const rtR = router.lookup('reviewer', 'oc_1')!
  rtR.inflight = undefined
  inbound.drain('reviewer', 'oc_1')
  await new Promise((r) => setTimeout(r, 20))
  expect(rec.followups.map((f) => f.text)).toEqual(['任务', '写手任务'])

  // writer 队列不受影响：释放槽位排水执行「写手排队」
  const rtW = router.lookup('writer', 'oc_1')!
  rtW.inflight = undefined
  inbound.drain('writer', 'oc_1')
  await vi.waitFor(() => { expect(rec.followups.map((f) => f.text)).toEqual(['任务', '写手任务', '写手排队']) })
})

test('撤回排队消息：撤销并提示；撤回正在执行/不存在的消息静默忽略', async () => {
  const { rec, inbound, router, msg } = harness()
  const m1 = msg('第一条')
  inbound.onMessage(m1)
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const m2 = msg('帮我总结一下这个仓库的结构')
  inbound.onMessage(m2)
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })

  inbound.revokeQueued('reviewer', 'oc_1', m2.messageId)
  await vi.waitFor(() => {
    expect(rec.notices).toContain('已撤销排队消息：帮我总结一下这个仓库的结构')
  })

  // 正在执行的第一条与不存在的 messageId：静默忽略
  inbound.revokeQueued('reviewer', 'oc_1', m1.messageId)
  inbound.revokeQueued('reviewer', 'oc_1', 'om_ghost')
  await new Promise((r) => setTimeout(r, 20))
  expect(rec.notices.filter((n) => n.includes('已撤销'))).toHaveLength(1)

  // 撤销后排水不再执行该消息
  const rt = router.lookup('reviewer', 'oc_1')!
  rt.inflight = undefined
  inbound.drain('reviewer', 'oc_1')
  await new Promise((r) => setTimeout(r, 20))
  expect(rec.followups).toHaveLength(1)
})

describe('话题键控（threadId）', () => {
  test('话题 A 执行中，话题 B 消息走独立会话、不进 A 的队列', async () => {
    const { rec, inbound, router, msg } = harness()
    const topicMsg = (text: string, threadId: string): InboundMessage => ({ ...msg(text), chatType: 'group', threadId })
    // 两话题先后各发一条：应各建各的 session（绑定键不同）
    inbound.onMessage(topicMsg('任务A', 'omt_a'))
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
    inbound.onMessage(topicMsg('任务B', 'omt_b'))
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(2) })
    const rtA = router.lookup(BOT.id, 'oc_1', 'omt_a')
    const rtB = router.lookup(BOT.id, 'oc_1', 'omt_b')
    expect(rtA).toBeDefined()
    expect(rtB).toBeDefined()
    expect(rtA!.sessionId).not.toBe(rtB!.sessionId)
    // B 直接执行（独立会话空闲），无排队提示、不进 A 的队列
    expect(rec.notices.some((n) => n.includes('已排队'))).toBe(false)
  })

  test('撤回撤销排队按 messageId 匹配（撤回事件不带 threadId 也能命中话题队列）', async () => {
    const { rec, inbound, router, msg } = harness()
    const topicMsg = (text: string, threadId: string): InboundMessage => ({ ...msg(text), chatType: 'group', threadId })
    // 占住话题 A 的槽后排队一条，再撤回排队消息
    inbound.onMessage(topicMsg('任务A1', 'omt_a'))
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
    // A 执行中（in-flight fake 挂起），第二条进队列
    const queued = topicMsg('任务A2', 'omt_a')
    inbound.onMessage(queued)
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
    inbound.revokeQueued(BOT.id, 'oc_1', queued.messageId)
    await vi.waitFor(() => { expect(rec.notices).toContain('已撤销排队消息：任务A2') })
    // 队列已空：释放槽位排水不再执行任何消息
    const rt = router.lookup(BOT.id, 'oc_1', 'omt_a')!
    rt.inflight = undefined
    inbound.drain(BOT.id, 'oc_1', 'omt_a')
    await new Promise((r) => setTimeout(r, 20))
    expect(rec.followups).toHaveLength(1)
  })

  test('话题队列排水：drain 带 threadId 命中话题绑定 rt，排队消息进话题会话执行', async () => {
    const { rec, inbound, router, msg } = harness()
    const topicMsg = (text: string, threadId: string): InboundMessage => ({ ...msg(text), chatType: 'group', threadId })
    inbound.onMessage(topicMsg('任务A1', 'omt_a'))
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
    inbound.onMessage(topicMsg('任务A2', 'omt_a'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
    const rt = router.lookup(BOT.id, 'oc_1', 'omt_a')!
    rt.inflight = undefined
    inbound.drain(BOT.id, 'oc_1', 'omt_a')
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(2) })
    expect(rec.followups[1].text).toBe('任务A2')
  })
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

test('/status：列出全部排队消息（前 20 字截断；纯图片显示 [图片]）', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('正在跑的任务'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('这是一条特别特别特别特别特别特别长的排队消息'))
  inbound.onMessage(msg('', 'oc_1', async () => [{ data: new Uint8Array([1]), mediaType: 'image/png' }]))
  inbound.onMessage(msg('短消息'))
  await vi.waitFor(() => { expect(rec.notices.filter((n) => n.includes('已排队'))).toHaveLength(3) })
  inbound.onMessage(msg('/status'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('排队（3）'))).toBe(true) })
  const status = rec.notices.find((n) => n.includes('排队（3）'))!
  expect(status).toContain('状态：处理中')
  expect(status).toContain('1. 这是一条特别特别特别特别特别特别长的排队…')
  expect(status).toContain('2. [图片]')
  expect(status).toContain('3. 短消息')
})

test('/status：无排队时不出现队列段', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('/status'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('处理中'))).toBe(true) })
  expect(rec.notices.find((n) => n.includes('处理中'))).not.toContain('排队')
})

test('/stop：无进行中任务但有排队消息时提示排队数', async () => {
  const { rec, inbound, router, msg } = harness()
  inbound.onMessage(msg('任务'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('排队一'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
  // 模拟边界态：槽空但队列非空（正常流程不出现，防御文案分支）。
  router.lookup('reviewer', 'oc_1')!.inflight = undefined
  inbound.onMessage(msg('/stop'))
  await vi.waitFor(() => {
    expect(rec.notices).toContain('当前没有进行中的任务（1 条排队中，撤回原消息可取消）')
  })
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

test('建会话失败：回复携带错误摘要（不再只有通用文案）', async () => {
  const { rec, inbound, msg } = harness({ createError: new Error("Cannot find package '@deepseek-ai/dsh-persona'") })
  inbound.onMessage(msg('/new'))
  await vi.waitFor(() => {
    expect(rec.notices.some((n) => n.includes('处理失败') && n.includes("Cannot find package '@deepseek-ai/dsh-persona'"))).toBe(true)
  })
})

test('建会话失败：超长错误摘要截断到 maxErrorDetailChars', async () => {
  const { rec, inbound, msg } = harness({ createError: new Error('x'.repeat(500)) })
  inbound.onMessage(msg('/new'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('处理失败'))).toBe(true) })
  const notice = rec.notices.find((n) => n.includes('处理失败'))
  expect(notice!.length).toBeLessThanOrEqual('处理失败：'.length + 200 + 1)
  expect(notice!.endsWith('…')).toBe(true)
})

test('图片消息：懒下载 → 存附件 → 文本+image 内容块按序 followup', async () => {
  const saved: unknown[] = []
  const fakeRef = (id: string): ImageAttachmentRef => ({ attachmentId: id as ImageAttachmentRef['attachmentId'], mediaType: 'image/png', bytes: 1, width: 1, height: 1 })
  const { rec, inbound, msg } = harness({
    attachments: () => ({ saveImages: async (inputs) => {
      saved.push(...inputs)
      return inputs.map((_i, index) => fakeRef(`att_${index}`))
    } }),
  })
  const loads: number[] = []
  inbound.onMessage(msg('看这张图', 'oc_1', async () => {
    loads.push(1)
    return [{ data: new Uint8Array([1]), mediaType: 'image/png' }, { data: new Uint8Array([2]), mediaType: 'image/jpeg' }]
  }))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  expect(loads).toEqual([1])
  expect(saved).toHaveLength(2)
  const content = rec.followups[0].content as { type: string; text?: string; attachment?: { attachmentId: string } }[]
  expect(content.map((b) => b.type)).toEqual(['text', 'image', 'image'])
  expect(content[0].text).toBe('看这张图')
  expect(content[1].attachment!.attachmentId).toBe('att_0')
  expect(content[2].attachment!.attachmentId).toBe('att_1')
})

test('attachments 服务缺席：文本照常处理，图片降级为提示', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('看这张图', 'oc_1', async () => [{ data: new Uint8Array([1]), mediaType: 'image/png' }]))
  await vi.waitFor(() => {
    expect(rec.followups).toHaveLength(1)
    expect(rec.notices.some((n) => n.includes('图片'))).toBe(true)
  })
  const content = rec.followups[0].content as { type: string }[]
  expect(content.map((b) => b.type)).toEqual(['text'])
})

test('纯图片（无文本）：仅 image 内容块也能建会话', async () => {
  const { rec, inbound, msg } = harness({
    attachments: () => ({
      saveImages: async (inputs) => inputs.map((_i, index) => ({
        attachmentId: `att_${index}` as ImageAttachmentRef['attachmentId'], mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      })),
    }),
  })
  inbound.onMessage(msg('', 'oc_1', async () => [{ data: new Uint8Array([9]), mediaType: 'image/png' }]))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const content = rec.followups[0].content as { type: string }[]
  expect(content.map((b) => b.type)).toEqual(['image'])
})

test('懒下载失败：走失败路径并回复错误摘要', async () => {
  const { rec, inbound, msg } = harness({
    attachments: () => ({ saveImages: async () => [] }),
  })
  inbound.onMessage(msg('看这张图', 'oc_1', async () => { throw new Error('下载超时') }))
  await vi.waitFor(() => {
    expect(rec.notices.some((n) => n.includes('处理失败') && n.includes('下载超时'))).toBe(true)
  })
  expect(rec.followups).toHaveLength(0)
})

test('入站消息：会话 hooks 含 guidance 段与 sender 段（userId 透传 ou_u1）', async () => {
  const { inbound, msg, rec } = harness()
  inbound.onMessage(msg('你好'))
  await vi.waitFor(() => { expect(rec.hookInputs).toHaveLength(1) })
  expect(rec.hookInputs[0]).toMatchObject({
    sections: [
      { name: 'dsh-agent-toolkit:channel:guidance', order: 15, text: '本会话经 feishu 渠道进行。如需用户补充信息或做出决策，优先使用 ask_user_question 工具；该工具不可用时，直接在回复中提问并等待用户下一条消息。' },
      { name: 'dsh-agent-toolkit:channel:sender', order: 20, text: '本会话由 feishu 渠道的单聊会话发起。发起人 ID（feishu open_id）：`ou_u1`。' },
    ],
  })
})

test('/new 指令：reset 路径同样携带 userId', async () => {
  const { inbound, msg, rec } = harness()
  inbound.onMessage(msg('/new'))
  await vi.waitFor(() => { expect(rec.hookInputs).toHaveLength(1) })
  expect(rec.hookInputs[0]).toMatchObject({
    sections: [
      { name: 'dsh-agent-toolkit:channel:guidance' },
      { name: 'dsh-agent-toolkit:channel:sender' },
    ],
  })
})

const CATALOG_ENTRIES = [
  { sessionId: 'aaaa1111-0000-0000-0000-000000000000', title: '修复登录闪退' },
  { sessionId: 'bbbb2222-0000-0000-0000-000000000000', title: 'bbbb2222-0000-0000-0000-000000000000' },
]

function catalogHarness(entries = CATALOG_ENTRIES) {
  return harness({ catalog: () => ({ list: async () => entries }) })
}

test('/help：列出全部指令', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('/help'))
  await vi.waitFor(() => { expect(rec.notices).toHaveLength(1) })
  for (const cmd of ['/new', '/stop', '/status', '/sessions', '/switch', '/help']) {
    expect(rec.notices[0]).toContain(cmd)
  }
})

test('/sessions：列表含标题、id 前缀与当前绑定 ✓ 标记', async () => {
  // catalog 内容可变：先建会话拿到真实绑定 id，再让列表包含它
  let entries: { sessionId: string; title: string }[] = [...CATALOG_ENTRIES]
  const { rec, inbound, router, msg } = harness({ catalog: () => ({ list: async () => entries }) })
  inbound.onMessage(msg('先建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const current = router.boundSessionId('reviewer', 'oc_1')!
  entries = [CATALOG_ENTRIES[0], { sessionId: current, title: '当前这个' }, CATALOG_ENTRIES[1]]
  inbound.onMessage(msg('/sessions'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('会话列表'))).toBe(true) })
  const list = rec.notices.find((n) => n.includes('会话列表'))!
  expect(list).toContain('1. 修复登录闪退（aaaa1111）')
  expect(list).toContain(`2. ✓ 当前这个（${current.slice(0, 8)}）`)
  // catalog 契约：title 为展示标题（web displayTitle 同义），无标题会话由适配器回退为 id
  expect(list).toContain(`3. bbbb2222-0000-0000-0000-000000000000（bbbb2222）`)
})

test('/sessions：catalog 缺席降级文案', async () => {
  const degraded = harness() // 不传 catalog
  degraded.inbound.onMessage(degraded.msg('/sessions'))
  await vi.waitFor(() => { expect(degraded.rec.notices).toContain('会话切换在当前环境不可用') })
})

test('/sessions：空列表提示', async () => {
  const { rec, inbound, msg } = catalogHarness([])
  inbound.onMessage(msg('/sessions'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('还没有可切换的会话'))).toBe(true) })
})

test('/switch 序号：按最近一次 /sessions 列表切换并确认', async () => {
  const { rec, inbound, router, msg } = catalogHarness()
  inbound.onMessage(msg('建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const old = router.boundSessionId('reviewer', 'oc_1')!
  inbound.onMessage(msg('/sessions'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('会话列表'))).toBe(true) })
  inbound.onMessage(msg('/switch 1'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已切换到会话'))).toBe(true) })
  expect(router.boundSessionId('reviewer', 'oc_1')).toBe(CATALOG_ENTRIES[0].sessionId)
  expect(router.boundSessionId('reviewer', 'oc_1')).not.toBe(old)
  // 旧会话不取消
  expect(rec.cancels).toBe(0)
})

test('/switch id 前缀：不依赖列表缓存直接切', async () => {
  const { rec, inbound, router, msg } = catalogHarness()
  inbound.onMessage(msg('建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('/switch bbbb2222'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已切换到会话'))).toBe(true) })
  expect(router.boundSessionId('reviewer', 'oc_1')).toBe(CATALOG_ENTRIES[1].sessionId)
})

test('/switch 边界：无参 / 序号无缓存 / 已是当前 / 前缀零命中与多命中 / catalog 缺席', async () => {
  const { rec, inbound, msg } = catalogHarness()
  inbound.onMessage(msg('建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })

  inbound.onMessage(msg('/switch'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('用法：/switch'))).toBe(true) })

  inbound.onMessage(msg('/switch 9'))   // 从未 /sessions：无缓存
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('序号无效'))).toBe(true) })

  const h2entries: { sessionId: string; title: string }[] = []
  const h2 = harness({ catalog: () => ({ list: async () => h2entries }) })
  h2.inbound.onMessage(h2.msg('建会话'))
  await vi.waitFor(() => { expect(h2.rec.followups).toHaveLength(1) })
  const h2Current = h2.router.boundSessionId('reviewer', 'oc_1')!
  h2entries.push({ sessionId: h2Current, title: '自己' })
  h2.inbound.onMessage(h2.msg(`/switch ${h2Current.slice(0, 8)}`))
  await vi.waitFor(() => { expect(h2.rec.notices).toContain('已是当前会话') })

  inbound.onMessage(msg('/switch zzzz'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('没有 id 前缀为'))).toBe(true) })

  const dup = harness({ catalog: () => ({ list: async () => [
    { sessionId: 'aaaa1111-0000-0000-0000-000000000000', title: '甲' },
    { sessionId: 'aaaa9999-0000-0000-0000-000000000000', title: '乙' },
  ] }) })
  dup.inbound.onMessage(dup.msg('/switch aaaa'))
  await vi.waitFor(() => { expect(dup.rec.notices.some((n) => n.includes('命中多个会话'))).toBe(true) })

  const degraded = harness()
  degraded.inbound.onMessage(degraded.msg('/switch 1'))
  await vi.waitFor(() => { expect(degraded.rec.notices).toContain('会话切换在当前环境不可用') })
})

test('/switch 目标写句柄被占用（web 界面打开中）：占用提示，绑定不变，不走 onError', async () => {
  const owned = Object.assign(
    new Error('session "aaaa1111-0000-0000-0000-000000000000" is already owned by an active write handle'),
    { name: 'SessionAlreadyOwnedError' },
  )
  const { rec, inbound, router, msg } = harness({ resumeError: owned, catalog: () => ({ list: async () => CATALOG_ENTRIES }) })
  inbound.onMessage(msg('建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const before = router.boundSessionId('reviewer', 'oc_1')
  inbound.onMessage(msg('/switch aaaa1111'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('正被占用'))).toBe(true) })
  expect(router.boundSessionId('reviewer', 'oc_1')).toBe(before)
})

describe('开放题文本拦截（consumeAnswer）', () => {
  test('发起人纯文本被消费为答案：不建/复用会话、不排队、不 followup、无 notice/ack', async () => {
    const calls: unknown[][] = []
    const { rec, inbound, sessions, router, msg } = harness({
      consumeAnswer: (...args) => { calls.push(args); return true },
    })
    const ensureSpy = vi.spyOn(router, 'ensure')
    inbound.onMessage(msg('这就是我的答案'))
    await vi.waitFor(() => { expect(calls).toHaveLength(1) })
    expect(calls[0]).toEqual(['reviewer', 'oc_1', undefined, 'ou_u1', '这就是我的答案'])
    expect(ensureSpy).not.toHaveBeenCalled()
    expect(sessions.size).toBe(0)
    expect(rec.followups).toHaveLength(0)
    expect(rec.acked).toBe(0)
    expect(rec.notices).toHaveLength(0)
  })

  test('consumeAnswer 返回 false（非发起人/无 pending 开放题）：走正常流程建会话', async () => {
    const { rec, inbound, sessions, msg } = harness({ consumeAnswer: () => false })
    inbound.onMessage(msg('普通消息'))
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
    expect(sessions.size).toBe(1)
  })

  test('带图片消息不拦截：consumeAnswer 不被调用，图片照常落库', async () => {
    const consumer = vi.fn(() => true)
    const { rec, inbound, msg } = harness({
      consumeAnswer: consumer,
      attachments: () => ({
        saveImages: async (inputs) => inputs.map((_i, index) => ({
          attachmentId: `att_${index}` as ImageAttachmentRef['attachmentId'], mediaType: 'image/png', bytes: 1, width: 1, height: 1,
        })),
      }),
    })
    inbound.onMessage(msg('看图', 'oc_1', async () => [{ data: new Uint8Array([1]), mediaType: 'image/png' }]))
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
    expect(consumer).not.toHaveBeenCalled()
    const content = rec.followups[0].content as { type: string }[]
    expect(content.map((b) => b.type)).toEqual(['text', 'image'])
  })

  test('指令优先于拦截：pending 中 /stop 仍走指令分支，consumeAnswer 不被调用', async () => {
    const consumer = vi.fn(() => true)
    const { rec, inbound, msg } = harness({ consumeAnswer: consumer })
    inbound.onMessage(msg('/stop'))
    await vi.waitFor(() => { expect(rec.notices).toContain('当前没有进行中的任务') })
    expect(consumer).not.toHaveBeenCalled()
    expect(rec.followups).toHaveLength(0)
  })

  test('deps 未传 consumeAnswer：行为与现状一致（正常建会话）', async () => {
    const { rec, inbound, sessions, msg } = harness()
    inbound.onMessage(msg('普通消息'))
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
    expect(sessions.size).toBe(1)
  })
})

describe('/doc 指令', () => {
  let project: string
  beforeAll(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'dsh-doc-inbound-'))
    await writeFile(path.join(project, 'report.md'), '# 报告\n', 'utf8')
  })
  afterAll(async () => { await rm(project, { recursive: true, force: true }) })

  function fileReply(rec: Recorded) {
    const files: { name: string; data: Uint8Array }[] = []
    const reply: ReplyHandle = { ...fakeReply(rec), sendFile: async (name, data) => { files.push({ name, data }) } }
    return { reply, files }
  }

  test('/doc 发送项目内文件', async () => {
    const { rec, inbound, msg } = harness({ project })
    const { reply, files } = fileReply(rec)
    inbound.onMessage(msg('/doc report.md', 'oc_1', undefined, reply))
    await vi.waitFor(() => { expect(files).toHaveLength(1) })
    expect(files[0].name).toBe('report.md')
    expect(new TextDecoder().decode(files[0].data)).toBe('# 报告\n')
    expect(rec.followups).toHaveLength(0)  // 不进会话 turn
  })

  test('/doc 无参提示用法', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/doc'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('用法：/doc'))).toBe(true) })
  })

  test('/doc 越界路径拒绝', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/doc ../secret.md'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('项目目录内'))).toBe(true) })
  })

  test('/doc 文件不存在', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/doc nope.md'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('文件不存在'))).toBe(true) })
  })

  test('/doc 渠道不支持 sendFile 时降级提示', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/doc report.md'))  // fakeReply 无 sendFile
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('不支持发送文件'))).toBe(true) })
  })

  test('/doc 上传失败 notice 摘要', async () => {
    const { rec, inbound, msg } = harness({ project })
    const reply: ReplyHandle = { ...fakeReply(rec), sendFile: async () => { throw new Error('上传失败：code=230002') } }
    inbound.onMessage(msg('/doc report.md', 'oc_1', undefined, reply))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('发送文件失败'))).toBe(true) })
  })
})

describe('/ls 指令', () => {
  let project: string
  beforeAll(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'dsh-ls-inbound-'))
    await mkdir(path.join(project, 'docs', 'sub'), { recursive: true })
    await writeFile(path.join(project, 'docs', 'report.md'), '# 报告\n', 'utf8')
    await writeFile(path.join(project, 'docs', 'sub', 'notes.md'), 'x', 'utf8')
    await writeFile(path.join(project, 'README.md'), 'x', 'utf8')
  })
  afterAll(async () => { await rm(project, { recursive: true, force: true }) })

  test('/ls 无参列项目根（不进会话 turn）', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/ls'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('项目根目录'))).toBe(true) })
    const text = rec.notices.find((n) => n.includes('项目根目录'))!
    expect(text).toContain('├── 📁 docs')
    expect(text).toContain('└── 📝 README.md  1 B')
    expect(rec.followups).toHaveLength(0)
  })

  test('/ls 有参列子目录', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/ls docs'))
    await vi.waitFor(() => {
      expect(rec.notices.some((n) => n.includes('├── 📁 sub') && n.includes('└── 📝 report.md  9 B'))).toBe(true)
    })
  })

  test('/ls 带关键字递归搜索（多词关键字 join）', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/ls docs NOTES'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('📝 docs/sub/notes.md  1 B'))).toBe(true) })
  })

  test('/ls 越界路径拒绝', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/ls ../secret'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('项目目录内'))).toBe(true) })
  })

  test('/ls 目录不存在', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/ls nope'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('目录不存在'))).toBe(true) })
  })

  test('/ls 目标是文件时提示用 /doc', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/ls README.md'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('发文件请用 /doc'))).toBe(true) })
  })
})

describe('排水接线（Outbound onTurnIdle + /new /switch 兜底）', () => {
  test('turn/end 后自动排水：排队消息立即执行', async () => {
    const { rec, inbound, sessions, router, msg } = harness()
    const outbound = new Outbound(sessions, () => undefined, 500, (rt) => inbound.drain(rt.botId, rt.chatId))
    inbound.onMessage(msg('第一条'))
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
    inbound.onMessage(msg('第二条'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
    const sessionId = router.boundSessionId('reviewer', 'oc_1')!
    const rt = sessions.get(sessionId)!
    outbound.handleSessionEvent(sessionId, { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(2) })
    expect(rec.followups[1].text).toBe('第二条')
    expect(rt.inflight).not.toBeUndefined()
  })

  test('/new 不清队列：新会话建好后排队消息继续执行', async () => {
    const { rec, inbound, msg } = harness()
    inbound.onMessage(msg('任务一'))
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
    inbound.onMessage(msg('任务二'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
    inbound.onMessage(msg('/new'))
    await vi.waitFor(() => { expect(rec.notices).toContain('已开启新会话') })
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(2) })
    expect(rec.followups[1].text).toBe('任务二')
  })

  test('排水的 followup 抛错：释放槽位后继续排水下一条', async () => {
    const { rec, inbound, sessions, router, msg } = harness({ followupThrowsOn: '第二条' })
    const outbound = new Outbound(sessions, () => undefined, 500, (rt) => inbound.drain(rt.botId, rt.chatId))
    inbound.onMessage(msg('第一条'))
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
    inbound.onMessage(msg('第二条'))
    inbound.onMessage(msg('第三条'))
    await vi.waitFor(() => { expect(rec.notices.filter((n) => n.includes('已排队'))).toHaveLength(2) })
    const sessionId = router.boundSessionId('reviewer', 'oc_1')!
    outbound.handleSessionEvent(sessionId, { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.waitFor(() => { expect(rec.followups.some((f) => f.text === '第三条')).toBe(true) })
    expect(rec.notices.some((n) => n.includes('处理失败') && n.includes('投递失败'))).toBe(true)
    expect(rec.followups.map((f) => f.text)).toEqual(['第一条', '第三条'])
  })

  test('回滚路径：释放槽位后先排水再 ack，窗口内新到消息不插队', async () => {
    const { rec, inbound, router, msg } = harness({ followupThrowsOn: '炸' })
    // 占槽：任务一在飞
    inbound.onMessage(msg('任务一'))
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })

    // dispatch「炸」时 followup 抛错走回滚；ack disposer 悬挂，制造「释放后、ack 完成前」窗口
    let releaseAck!: () => void
    const pendingDisposer: Disposer = () => new Promise<void>((r) => { releaseAck = r })
    inbound.onMessage(msg('炸', 'oc_1', undefined, undefined, async () => pendingDisposer))
    inbound.onMessage(msg('旧队首'))
    await vi.waitFor(() => { expect(rec.notices.filter((n) => n.includes('已排队'))).toHaveLength(2) })

    // 触发排水：队首「炸」占槽后回滚释放；旧队首须在 await ack 前完成占槽转移
    const rt = router.lookup('reviewer', 'oc_1')!
    rt.inflight = undefined
    inbound.drain('reviewer', 'oc_1')
    await vi.waitFor(() => { expect(releaseAck).toBeDefined() })

    // 窗口内新消息到达：排序错误会被直接 dispatch 插队到旧队首之前
    inbound.onMessage(msg('新到消息'))
    await new Promise((r) => setTimeout(r, 20))

    releaseAck()
    await new Promise((r) => setTimeout(r, 20))

    // 释放槽位排水剩余队列（旧的排在其后）
    rt.inflight = undefined
    inbound.drain('reviewer', 'oc_1')
    await vi.waitFor(() => { expect(rec.followups.map((f) => f.text)).toEqual(['任务一', '旧队首', '新到消息']) })
  })

  test('/stop 只停当前任务：队列保留，turn/end 后续上', async () => {
    const { rec, inbound, sessions, router, msg } = harness()
    const outbound = new Outbound(sessions, () => undefined, 500, (rt) => inbound.drain(rt.botId, rt.chatId))
    inbound.onMessage(msg('任务一'))
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
    inbound.onMessage(msg('任务二'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('已排队'))).toBe(true) })
    inbound.onMessage(msg('/stop'))
    await vi.waitFor(() => { expect(rec.notices).toContain('已请求停止当前任务') })
    expect(rec.cancels).toBe(1)
    const sessionId = router.boundSessionId('reviewer', 'oc_1')!
    outbound.handleSessionEvent(sessionId, { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } })
    await vi.waitFor(() => { expect(rec.followups).toHaveLength(2) })
    expect(rec.followups[1].text).toBe('任务二')
  })
})
