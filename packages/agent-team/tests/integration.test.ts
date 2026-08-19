import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/index.ts'
import type { TeamStateView } from '../src/types.ts'

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'team-preset')

interface RegisteredTool { name: string; description: string }
type Handler = (req: unknown, res: unknown) => Promise<void>
type Disposer = () => void | Promise<void>
type ProviderCaps = { outputSchema: boolean; depthLimit: boolean; toolFilter: boolean; persona: boolean }
const FULL_CAPS: ProviderCaps = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
type FakeCtxOptions = {
  webServer?: boolean
  kv?: Map<string, string>
  sessionId?: string
  failPut?: boolean
  /** getProvider 返回的 provider 能力（默认全开，匹配 spawn/fork）。 */
  providerCapabilities?: Partial<ProviderCaps>
  /** getProvider 返回 undefined（模拟 provider 尚未注册的延迟挂载）。 */
  providerAbsent?: boolean
}

// index.ts 持有模块级共享 domain 单例，每个测试须取全新模块实例以隔离跨测试共享状态。
type FreshMod = typeof import('../src/index.ts')
async function load(): Promise<FreshMod> {
  vi.resetModules()
  return import('../src/index.ts')
}

function fakeCtx(events: SessionEvent[], baseUrl?: string, opts: FakeCtxOptions = {}) {
  const tools: RegisteredTool[] = []                              // 注册日志：现有测试断言用（重注册追加）
  const activeTools = new Map<string, RegisteredTool>()           // 生效注册：HMR 卸载断言用（disposer 摘除）
  const sections: { name: string; order: number; text: unknown }[] = []
  const routes = new Map<string, Handler>()
  const disposers: Disposer[] = []
  const listeners: { event: string; cb: (payload: unknown) => void }[] = []
  const kv = opts.kv ?? new Map<string, string>()
  let openCount = 0
  let closeCount = 0
  const sessionId = opts.sessionId ?? 's1'
  const agent = { session: { id: sessionId, events } }
  const services: Record<string, unknown> = {
    ...(opts.webServer === false ? {} : {
      webServer: {
        register: (route: { kind: string; path: string; handler: Handler }) => {
          routes.set(route.path, route.handler)
          return () => { routes.delete(route.path) }
        },
      },
    }),
  }
  const table = {
    get: (k: string) => kv.get(k),
    put: async (k: string, v: string) => {
      if (opts.failPut === true) throw new Error('kv write failed')
      kv.set(k, v)
    },
  }
  const ctx = {
    baseUrl,
    agent,
    tools: {
      register: (tool: RegisteredTool) => {
        tools.push(tool)
        activeTools.set(tool.name, tool)
        const disposer: Disposer = () => { activeTools.delete(tool.name) }
        disposers.push(disposer)
        return disposer
      },
    },
    systemPrompt: {
      section: (s: { name: string; order: number; text: unknown }) => {
        sections.push(s)
        const disposer: Disposer = () => {
          const i = sections.indexOf(s)
          if (i >= 0) sections.splice(i, 1)
        }
        disposers.push(disposer)
        return disposer
      },
    },
    subagents: {
      start: async () => { throw new Error('integration test 不发起真实委派') },
      getProvider: (name: string) => {
        if (opts.providerAbsent === true) return undefined
        return { name, capabilities: { ...FULL_CAPS, ...opts.providerCapabilities }, inheritsParentContext: false }
      },
    },
    storageDomain: {
      open: async () => {
        openCount++
        return { table: () => table, close: async () => { closeCount++ } }
      },
    },
    inject: (names: string[], cb: (c: unknown) => void) => {
      const service = services[names[0]]
      if (service !== undefined) cb({ ...ctx, [names[0]]: service })
    },
    on: (event: string, cb: (payload: unknown) => void) => {
      listeners.push({ event, cb })
      return () => {}
    },
    effect: (fn: () => unknown) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer as Disposer)
    },
    logger: { info: () => {}, warn: () => {} },
  }
  return {
    ctx: ctx as unknown as Context,
    tools,
    activeTools,
    sections,
    routes,
    kv,
    disposers,
    agent,
    emit: (event: string, payload: unknown) => {
      for (const l of listeners) if (l.event === event) l.cb(payload)
    },
    get openCount() { return openCount },
    get closeCount() { return closeCount },
  }
}

const presetUrl = () => pathToFileURL(FIXTURE_DIR + '/').href

function fakeReqRes(method: string, body?: unknown) {
  const req = {
    method,
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  const res = {
    status: 0,
    body: '',
    writeHead(status: number) { res.status = status; return res },
    end(chunk?: string) { if (chunk !== undefined) res.body += chunk; return res },
  }
  return { req, res }
}

async function callRoute(routes: Map<string, Handler>, path: string, method: string, body?: unknown) {
  const handler = routes.get(path)
  expect(handler, `路由已注册：${path}`).toBeDefined()
  const { req, res } = fakeReqRes(method, body)
  await handler!(req, res)
  return { status: res.status, json: res.body === '' ? undefined : JSON.parse(res.body) as TeamStateView & { error?: string } }
}

test('激活：注册 team_delegate（静态 description）、state/select 路由与提示段', async () => {
  const mod = await load()
  const { ctx, tools, sections, routes } = fakeCtx([], presetUrl())
  await mod.apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(tools[0].description).not.toContain('reviewer')           // 静态描述，不含名册
  expect(tools[0].description).not.toContain('researcher')
  expect([...routes.keys()].sort()).toEqual(['/agent-team/s1/select', '/agent-team/s1/state'])
  expect(sections).toHaveLength(1)
  expect(String(sections[0].text)).toContain('team_delegate')
})

test('GET state：返回当前团队与选项摘要', async () => {
  const mod = await load()
  const { ctx, routes } = fakeCtx([], presetUrl())
  await mod.apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/state', 'GET')
  expect(status).toBe(200)
  expect(json).toEqual({
    currentId: 'alpha',
    options: [{ id: 'alpha', summary: '代码审查员' }, { id: 'beta', summary: '资料调研与分析' }],
  })
})

test('POST select 成功：工具重注册（静态 description 不变）、KV 写入、返回新视图', async () => {
  const mod = await load()
  const { ctx, tools, routes, kv } = fakeCtx([], presetUrl())
  await mod.apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  expect(status).toBe(200)
  expect(json?.currentId).toBe('beta')
  expect(tools).toHaveLength(2)                                   // 重注册产物（v2；Task 6b 移除）
  expect(tools[1].description).toBe(tools[0].description)         // 静态描述，重注册不改变
  expect(kv.get('s1')).toBe('beta')
})

test('POST select 同团队：200 但不重注册、不写 KV', async () => {
  const mod = await load()
  const { ctx, tools, routes, kv } = fakeCtx([], presetUrl())
  await mod.apply(ctx, {} as Config)
  const { status } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'alpha' })
  expect(status).toBe(200)
  expect(tools).toHaveLength(1)
  expect(kv.has('s1')).toBe(false)
})

test('POST select 未知团队：400 列出可用团队，不重注册', async () => {
  const mod = await load()
  const { ctx, tools, routes } = fakeCtx([], presetUrl())
  await mod.apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'ghost' })
  expect(status).toBe(400)
  expect(json?.error).toContain('alpha, beta')
  expect(tools).toHaveLength(1)
})

test('POST select 会话已开始：409 锁定，不重注册、不写 KV', async () => {
  const mod = await load()
  const events = [{ type: 'turn/start', data: {} } as SessionEvent]
  const { ctx, tools, routes, kv } = fakeCtx(events, presetUrl())
  await mod.apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  expect(status).toBe(409)
  expect(json?.error).toContain('锁定')
  expect(tools).toHaveLength(1)
  expect(kv.has('s1')).toBe(false)
})

test('冷恢复：KV 已有选择时初始团队跟随（GET state）', async () => {
  const mod = await load()
  const { ctx, tools, routes } = fakeCtx([], presetUrl(), { kv: new Map([['s1', 'beta']]) })
  await mod.apply(ctx, {} as Config)
  expect(tools[0].description).not.toContain('researcher')         // 静态描述不含名册
  const { json } = await callRoute(routes, '/agent-team/s1/state', 'GET')
  expect(json?.currentId).toBe('beta')
})

test('defaultTeam 命中时作为初始团队（GET state）；未命中时激活失败', async () => {
  const mod = await load()
  const ok = fakeCtx([], presetUrl())
  await mod.apply(ok.ctx, { defaultTeam: 'beta' } as Config)
  const { json } = await callRoute(ok.routes, '/agent-team/s1/state', 'GET')
  expect(json?.currentId).toBe('beta')
  const bad = fakeCtx([], presetUrl())
  await expect(mod.apply(bad.ctx, { defaultTeam: 'ghost' } as Config)).rejects.toThrowError(/ghost/)
})

test('teamsDir 指向缺失目录时激活失败', async () => {
  const mod = await load()
  const { ctx } = fakeCtx([], presetUrl())
  await expect(mod.apply(ctx, { teamsDir: './missing' } as Config)).rejects.toThrowError(/missing/)
})

test('无 webServer 服务（headless）：激活成功，无路由，工具与提示段在', async () => {
  const mod = await load()
  const { ctx, tools, sections, routes } = fakeCtx([], presetUrl(), { webServer: false })
  await mod.apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(sections).toHaveLength(1)
  expect(routes.size).toBe(0)
})

test('多会话共享 domain 单例：一次 open，KV 按 sessionId 互不干扰', async () => {
  const mod = await load()
  const kv = new Map<string, string>()
  const a = fakeCtx([], presetUrl(), { kv, sessionId: 'sA' })
  const b = fakeCtx([], presetUrl(), { kv, sessionId: 'sB' })
  await mod.apply(a.ctx, {} as Config)
  await mod.apply(b.ctx, {} as Config)
  expect(a.openCount).toBe(1)                                     // 首次 open
  expect(b.openCount).toBe(0)                                     // 复用同一 Promise
  await callRoute(a.routes, '/agent-team/sA/select', 'POST', { team: 'beta' })
  expect(kv.get('sA')).toBe('beta')
  expect(kv.has('sB')).toBe(false)
  await callRoute(b.routes, '/agent-team/sB/select', 'POST', { team: 'beta' })
  expect(kv.get('sB')).toBe('beta')
  expect(kv.get('sA')).toBe('beta')                               // 各自 key，互不干扰
})

test('共享 domain 卸载：close 仅一次且发生在最后一次卸载后', async () => {
  const mod = await load()
  const a = fakeCtx([], presetUrl())
  const b = fakeCtx([], presetUrl())
  await mod.apply(a.ctx, {} as Config)
  await mod.apply(b.ctx, {} as Config)
  expect(a.openCount).toBe(1)
  expect(b.openCount).toBe(0)
  for (const dispose of a.disposers) await dispose()              // 第一次卸载：refs 2→1
  expect(a.closeCount + b.closeCount).toBe(0)
  for (const dispose of b.disposers) await dispose()              // 最后一次卸载：refs 1→0 → close
  expect(a.closeCount + b.closeCount).toBe(1)
  expect(a.closeCount).toBe(1)                                    // 被关的是 a 打开的 domain
})

test('POST select：KV 写失败时返回非 200、不重注册、状态不变', async () => {
  const mod = await load()
  const { ctx, tools, routes } = fakeCtx([], presetUrl(), { failPut: true })
  await mod.apply(ctx, {} as Config)
  expect(tools).toHaveLength(1)
  const { status } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  expect(status).not.toBe(200)
  expect(tools).toHaveLength(1)                                   // 不重注册
  const { json } = await callRoute(routes, '/agent-team/s1/state', 'GET')
  expect(json?.currentId).toBe('alpha')                           // state.current 不变（回滚）
})

test('HMR 安全：卸载后工具/路由/提示段全部摘除，fresh ctx 重挂载成功', async () => {
  const mod = await load()
  const first = fakeCtx([], presetUrl())
  await mod.apply(first.ctx, {} as Config)
  expect(first.tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(first.routes.size).toBe(2)
  expect(first.sections).toHaveLength(1)
  for (const dispose of first.disposers) await dispose()          // 模拟 fiber 卸载
  expect(first.activeTools.size).toBe(0)                          // 工具已摘除
  expect(first.routes.size).toBe(0)
  expect(first.sections).toHaveLength(0)
  const second = fakeCtx([], presetUrl())                          // HMR 重挂载
  await mod.apply(second.ctx, {} as Config)
  expect(second.tools.map(t => t.name)).toEqual(['team_delegate'])
  expect([...second.routes.keys()].sort()).toEqual(['/agent-team/s1/select', '/agent-team/s1/state'])
  expect(second.sections).toHaveLength(1)
})

test('provider 缺 persona 能力：激活响亮失败（挂载点能力校验）', async () => {
  const mod = await load()
  const { ctx } = fakeCtx([], presetUrl(), { providerCapabilities: { persona: false } })
  await expect(mod.apply(ctx, {} as Config)).rejects.toThrowError(/persona/)
})

test('provider 缺 depthLimit 能力：激活响亮失败（挂载点能力校验）', async () => {
  const mod = await load()
  const { ctx } = fakeCtx([], presetUrl(), { providerCapabilities: { depthLimit: false } })
  await expect(mod.apply(ctx, {} as Config)).rejects.toThrowError(/depthLimit/)
})

test('provider 尚未注册：激活成功但工具延迟挂载，provider-added 后注册', async () => {
  const mod = await load()
  const { ctx, tools, emit } = fakeCtx([], presetUrl(), { providerAbsent: true })
  await mod.apply(ctx, {} as Config)
  expect(tools).toHaveLength(0)
  emit('subagent/provider-added', { name: 'spawn', capabilities: FULL_CAPS, inheritsParentContext: false })
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
})
