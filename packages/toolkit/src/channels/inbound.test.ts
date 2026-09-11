import { describe, expect, test, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Disposer, InboundMessage, ReplyHandle } from './channel.ts'
import { Inbound, type AttachmentsPort, type InboundDeps } from './inbound.ts'
import type { AgentPort, AgentsPort, BindingStore, SessionCatalogPort, SessionRuntime } from './ports.ts'
import { Router } from './router.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import type { BotRecord } from '../bots/store.ts'

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
  attachments?: () => AttachmentsPort | undefined
  catalog?: () => SessionCatalogPort | undefined
} = {}) {
  const rec: Recorded = { notices: [], acked: 0, followups: [], cancels: 0, hookInputs: [] }
  const agents: AgentsPort = {
    get: () => undefined,
    create: async (input) => {
      if (opts.createError !== undefined) throw opts.createError
      rec.hookInputs.push(input.hooks)
      return fakeAgent(input.sessionId, rec)
    },
    resume: async (input) => {
      if (opts.resumeError !== undefined) throw opts.resumeError
      rec.hookInputs.push(input.hooks)
      return fakeAgent(input.sessionId, rec)
    },
  }
  const map = new Map<string, string>()
  const bindings: BindingStore = {
    get: (b, c) => map.get(`${b}:${c}`),
    set: async (b, c, s) => { map.set(`${b}:${c}`, s) },
    delete: async (b, c) => { map.delete(`${b}:${c}`) },
    deleteBot: async () => undefined,
  }
  const sessions = new Map<string, SessionRuntime>()
  const registry: AgentRegistry = {
    list: () => [],
    get: () => undefined,
    upsert: async () => undefined,
    remove: async () => undefined,
    subscribe: () => () => undefined,
  }
  const router = new Router(agents, bindings, sessions, () => ({ provider: 'deepseek', model: 'deepseek-v4' }), { attach: async () => undefined }, () => undefined, registry)
  const inbound = new Inbound({
    router,
    bots: { get: (id) => (id === BOT.id ? BOT : undefined) },
    maxErrorDetailChars: 200,
    docMaxBytes: 1024 * 1024,
    ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
    ...(opts.catalog !== undefined ? { catalog: opts.catalog } : {}),
    onError: () => undefined,
  })
  function msg(text: string, chatId = 'oc_1', loadImages?: InboundMessage['loadImages']): InboundMessage {
    return {
      botId: BOT.id, chatId, userId: 'ou_u1', messageId: `om_${Math.random()}`,
      text,
      ...(loadImages !== undefined ? { loadImages } : {}),
      reply: fakeReply(rec),
      ackProcessing: async (): Promise<Disposer> => {
        rec.acked += 1
        return () => undefined
      },
    }
  }
  return { rec, inbound, sessions, router, msg }
}

function fakeAgent(sessionId: string, rec: Recorded): AgentPort {
  return {
    sessionId,
    followup: (m) => {
      const message = m as { content: { type: string; text?: string }[]; source: Record<string, unknown> }
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

test('in-flight 占用期间第二条消息被拒并提示', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('第一条'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('第二条'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('上一条还在处理中'))).toBe(true) })
  expect(rec.followups).toHaveLength(1)
})

test('处理中再发消息：rt.reply 不被替换，运行中 turn 仍在旧句柄收尾', async () => {
  const { rec, inbound, router, msg } = harness()
  inbound.onMessage(msg('任务一'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  const rt = router.lookup('reviewer', 'oc_1')!
  const firstReply = rt.reply
  inbound.onMessage(msg('追问'))
  await vi.waitFor(() => { expect(rec.notices).toContain('上一条还在处理中，请稍候（或发送 /stop 取消）') })
  expect(rt.reply).toBe(firstReply)
  expect(rec.notices).toEqual(['上一条还在处理中，请稍候（或发送 /stop 取消）'])
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

test('入站消息把 userId 透传：会话 hooks 含 sender 段（ou_u1）', async () => {
  const { inbound, msg, rec } = harness()
  inbound.onMessage(msg('你好'))
  await vi.waitFor(() => { expect(rec.hookInputs).toHaveLength(1) })
  expect(rec.hookInputs[0]).toMatchObject({
    sections: [{ name: 'dsh-agent-toolkit:channel:sender', order: 20, text: '本会话由 feishu 渠道的单聊会话发起。发起人 ID（feishu open_id）：`ou_u1`。' }],
  })
})

test('/new 指令：reset 路径同样携带 userId', async () => {
  const { inbound, msg, rec } = harness()
  inbound.onMessage(msg('/new'))
  await vi.waitFor(() => { expect(rec.hookInputs).toHaveLength(1) })
  expect(rec.hookInputs[0]).toMatchObject({ sections: [{ name: 'dsh-agent-toolkit:channel:sender' }] })
})

const CATALOG_ENTRIES = [
  { sessionId: 'aaaa1111-0000-0000-0000-000000000000', title: '修复登录闪退' },
  { sessionId: 'bbbb2222-0000-0000-0000-000000000000' },
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
  let entries: { sessionId: string; title?: string }[] = [...CATALOG_ENTRIES]
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
  expect(list).toContain(`3. (无标题)（bbbb2222）`)
})

test('/sessions：无标题会话显示 (无标题)，catalog 缺席降级文案', async () => {
  const { rec, inbound, msg } = catalogHarness([{ sessionId: 'cccc3333-0000-0000-0000-000000000000' }])
  inbound.onMessage(msg('/sessions'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('(无标题)') && n.includes('cccc3333'))).toBe(true) })

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

  const h2entries: { sessionId: string; title?: string }[] = []
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
    { sessionId: 'aaaa1111-0000-0000-0000-000000000000' },
    { sessionId: 'aaaa9999-0000-0000-0000-000000000000' },
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
