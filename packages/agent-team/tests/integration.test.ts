import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Config } from '../src/index.ts'
import type { TeamStateView } from '../src/types.ts'

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'team-preset')

interface RegisteredTool { name: string; description: string }
type RouteRes = {
  writeHead(status: number, headers?: Record<string, string>): RouteRes
  end(chunk?: string): unknown
}
type Handler = (req: { method?: string; url?: string } & AsyncIterable<unknown>, res: RouteRes) => Promise<void>
type Disposer = () => void | Promise<void>
type ProviderCaps = { outputSchema: boolean; depthLimit: boolean; toolFilter: boolean; persona: boolean }
const FULL_CAPS: ProviderCaps = { outputSchema: true, depthLimit: true, toolFilter: true, persona: true }
type FakeCtxOptions = {
  webServer?: boolean
  kv?: Map<string, string>
  failPut?: boolean
  /** sid → 会话事件；缺失的 sid 视为"会话不存在"。 */
  sessions?: Map<string, SessionEvent[]>
  providerCapabilities?: Partial<ProviderCaps>
  providerAbsent?: boolean
}

// index.ts 持有模块级共享 domain 单例，每个测试须取全新模块实例以隔离跨测试共享状态。
type FreshMod = typeof import('../src/index.ts')
async function load(): Promise<FreshMod> {
  vi.resetModules()
  return import('../src/index.ts')
}

function fakeCtx(baseUrl?: string, opts: FakeCtxOptions = {}) {
  const tools: RegisteredTool[] = []                                // 注册日志（断言只注册一次）
  const activeTools = new Map<string, RegisteredTool>()             // 生效注册（HMR 卸载断言用）
  const sections: { name: string; order: number; text: unknown }[] = []
  const routes = new Map<string, Handler>()
  const disposers: Disposer[] = []
  const listeners: { event: string; cb: (payload: unknown) => void }[] = []
  const kv = opts.kv ?? new Map<string, string>()
  const sessions = opts.sessions ?? new Map<string, SessionEvent[]>()
  let openCount = 0
  let closeCount = 0
  const services: Record<string, unknown> = {
    ...(opts.webServer === false ? {} : {
      webServer: {
        register: (route: { kind: string; path: string; handler: Handler }) => {
          routes.set(route.path, route.handler)
          const disposer: Disposer = () => { routes.delete(route.path) }
          disposers.push(disposer)
          return disposer
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
    sessions: {
      get: (id: SessionId) => {
        const events = sessions.get(String(id))
        return events === undefined ? undefined : { id, events }
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
    sessions,
    disposers,
    emit: (event: string, payload: unknown) => {
      for (const l of listeners) if (l.event === event) l.cb(payload)
    },
    get openCount() { return openCount },
    get closeCount() { return closeCount },
  }
}

const presetUrl = () => pathToFileURL(FIXTURE_DIR + '/').href

function fakeReqRes(method: string, url: string, body?: unknown) {
  const req = {
    method,
    url,
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

async function callRoute(routes: Map<string, Handler>, url: string, method: string, body?: unknown) {
  const handler = routes.get('/agent-team')
  expect(handler, '路由已注册：/agent-team').toBeDefined()
  const { req, res } = fakeReqRes(method, url, body)
  await handler!(req, res)
  return { status: res.status, json: res.body === '' ? undefined : JSON.parse(res.body) as TeamStateView & { error?: string } }
}

/** 以指定会话 agent 调用 prompt 段 text 函数；agent 缺省模拟非 agent 组装。 */
function renderSection(sections: { text: unknown }[], agent?: { session: { id: string } }): string {
  const text = sections[0].text as (context: unknown) => string
  return agent === undefined ? text({}) : text({ agent })
}

test('挂载：工具仅注册一次且 description 静态，prompt 段为函数，注册一条 prefix 路由', async () => {
  const mod = await load()
  const { ctx, tools, sections, routes } = fakeCtx(presetUrl())
  await mod.apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(tools).toHaveLength(1)
  expect(tools[0].description).not.toContain('reviewer')
  expect(tools[0].description).toMatch(/current session/)
  expect(routes.size).toBe(1)
  expect(routes.has('/agent-team')).toBe(true)
  expect(sections).toHaveLength(1)
  expect(typeof sections[0].text).toBe('function')
})

test('prompt 段 text 函数：带 agent 渲染该会话当前团队名册（每角色一行 name: description）；缺省返回通用介绍', async () => {
  const mod = await load()
  const { ctx, sections } = fakeCtx(presetUrl())
  await mod.apply(ctx, {} as Config)
  const withAgent = renderSection(sections, { session: { id: 's1' } })
  expect(withAgent).toContain('当前团队')
  expect(withAgent).toContain('reviewer: 代码审查员')
  expect(withAgent).not.toContain('researcher')
  expect(renderSection(sections)).toContain('team_delegate')
  expect(renderSection(sections)).not.toContain('reviewer')
})

test('GET /agent-team/<sid>/state：惰性建态返回 200', async () => {
  const mod = await load()
  const { ctx, routes } = fakeCtx(presetUrl())
  await mod.apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/state', 'GET')
  expect(status).toBe(200)
  expect(json?.currentId).toBe('alpha')
  expect(json?.options).toEqual([
    { id: 'alpha', summary: '代码审查员' },
    { id: 'beta', summary: '资料调研与分析' },
  ])
})

test('POST select 切到 beta：同 sid 的 prompt 段名册变化，工具注册不变，KV 写入', async () => {
  const mod = await load()
  const { ctx, tools, routes, sections, kv } = fakeCtx(presetUrl())
  await mod.apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  expect(status).toBe(200)
  expect(json?.currentId).toBe('beta')
  expect(tools).toHaveLength(1)                                   // 注册一次，切换不重注册
  expect(renderSection(sections, { session: { id: 's1' } })).toContain('researcher: 资料调研与分析')
  expect(renderSection(sections, { session: { id: 's1' } })).not.toContain('reviewer')
  expect(kv.get('s1')).toBe('beta')
})

test('两个不同 sid 各自独立切换互不影响', async () => {
  const mod = await load()
  const { ctx, routes, sections } = fakeCtx(presetUrl())
  await mod.apply(ctx, {} as Config)
  await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  const { json } = await callRoute(routes, '/agent-team/s2/state', 'GET')
  expect(json?.currentId).toBe('alpha')                           // s2 未切换，默认 alpha
  expect(renderSection(sections, { session: { id: 's1' } })).toContain('researcher: 资料调研与分析')
  expect(renderSection(sections, { session: { id: 's2' } })).toContain('reviewer: 代码审查员')
})

test('已发 turn/start 的会话 POST select：409 锁定，不写 KV', async () => {
  const mod = await load()
  const { ctx, routes, kv } = fakeCtx(presetUrl(), {
    sessions: new Map([['s1', [{ type: 'turn/start', data: {} } as SessionEvent]]]),
  })
  await mod.apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  expect(status).toBe(409)
  expect(json?.error).toContain('锁定')
  expect(kv.has('s1')).toBe(false)
})

test('session/disposed 清 Map：该 sid 状态清除后重新懒建', async () => {
  const mod = await load()
  const kv = new Map<string, string>()
  const { ctx, routes, emit } = fakeCtx(presetUrl(), { kv })
  await mod.apply(ctx, {} as Config)
  await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  kv.delete('s1')                                                 // 模拟 KV 记录已失效
  emit('session/disposed', { id: 's1', events: [] })
  const { json } = await callRoute(routes, '/agent-team/s1/state', 'GET')
  expect(json?.currentId).toBe('alpha')                           // 旧缓存已清，重新懒建回默认
})

test('KV 冷恢复：切换写 KV 后，新挂载代 GET 返回已选团队', async () => {
  const mod = await load()
  const kv = new Map<string, string>()
  const first = fakeCtx(presetUrl(), { kv })
  await mod.apply(first.ctx, {} as Config)
  await callRoute(first.routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  const second = fakeCtx(presetUrl(), { kv })                     // 新挂载代（HMR/新 preset 代）
  await mod.apply(second.ctx, {} as Config)
  const { json } = await callRoute(second.routes, '/agent-team/s1/state', 'GET')
  expect(json?.currentId).toBe('beta')
})

test('clientOnly: true：无工具/路由/提示段注册', async () => {
  const mod = await load()
  const { ctx, tools, routes, sections } = fakeCtx(presetUrl())
  await mod.apply(ctx, { clientOnly: true } as Config)
  expect(tools).toHaveLength(0)
  expect(routes.size).toBe(0)
  expect(sections).toHaveLength(0)
})

test('POST select 未知团队：400 列出可用团队，不写 KV', async () => {
  const mod = await load()
  const { ctx, routes, kv } = fakeCtx(presetUrl())
  await mod.apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'ghost' })
  expect(status).toBe(400)
  expect(json?.error).toContain('alpha, beta')
  expect(kv.has('s1')).toBe(false)
})

test('POST select 同团队：200 但不写 KV', async () => {
  const mod = await load()
  const { ctx, routes, kv } = fakeCtx(presetUrl())
  await mod.apply(ctx, {} as Config)
  const { status } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'alpha' })
  expect(status).toBe(200)
  expect(kv.has('s1')).toBe(false)
})

test('会话不存在（ctx.sessions 无该 sid）按 blank 处理：POST select 允许', async () => {
  const mod = await load()
  const { ctx, routes } = fakeCtx(presetUrl())
  await mod.apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/unknown-sid/select', 'POST', { team: 'beta' })
  expect(status).toBe(200)
  expect(json?.currentId).toBe('beta')
})

test('非 state/select 路径与方法：404', async () => {
  const mod = await load()
  const { ctx, routes } = fakeCtx(presetUrl())
  await mod.apply(ctx, {} as Config)
  expect((await callRoute(routes, '/agent-team/s1/unknown', 'GET')).status).toBe(404)
  expect((await callRoute(routes, '/agent-team/s1', 'GET')).status).toBe(404)
  expect((await callRoute(routes, '/agent-team', 'GET')).status).toBe(404)
  expect((await callRoute(routes, '/agent-team/s1/select', 'GET')).status).toBe(404)
})

test('POST select：KV 写失败时返回非 200、状态不变', async () => {
  const mod = await load()
  const { ctx, routes } = fakeCtx(presetUrl(), { failPut: true })
  await mod.apply(ctx, {} as Config)
  const { status } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  expect(status).not.toBe(200)
  const { json } = await callRoute(routes, '/agent-team/s1/state', 'GET')
  expect(json?.currentId).toBe('alpha')                           // state.current 不变（回滚）
})

test('teamsDir 指向缺失目录时激活失败', async () => {
  const mod = await load()
  const { ctx } = fakeCtx(presetUrl())
  await expect(mod.apply(ctx, { teamsDir: './missing' } as Config)).rejects.toThrowError(/missing/)
})

test('defaultTeam 未命中时激活失败', async () => {
  const mod = await load()
  const { ctx } = fakeCtx(presetUrl())
  await expect(mod.apply(ctx, { defaultTeam: 'ghost' } as Config)).rejects.toThrowError(/ghost/)
})

test('无 webServer 服务（headless）：激活成功，无路由，工具与提示段在', async () => {
  const mod = await load()
  const { ctx, tools, sections, routes } = fakeCtx(presetUrl(), { webServer: false })
  await mod.apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(sections).toHaveLength(1)
  expect(routes.size).toBe(0)
})

test('多会话共享 domain 单例：一次 open，KV 按 sessionId 互不干扰', async () => {
  const mod = await load()
  const kv = new Map<string, string>()
  const a = fakeCtx(presetUrl(), { kv })
  const b = fakeCtx(presetUrl(), { kv })
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
  const a = fakeCtx(presetUrl())
  const b = fakeCtx(presetUrl())
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

test('HMR 安全：卸载后工具/路由/提示段全部摘除，fresh ctx 重挂载成功', async () => {
  const mod = await load()
  const first = fakeCtx(presetUrl())
  await mod.apply(first.ctx, {} as Config)
  expect(first.tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(first.routes.size).toBe(1)
  expect(first.sections).toHaveLength(1)
  for (const dispose of first.disposers) await dispose()          // 模拟 fiber 卸载
  expect(first.activeTools.size).toBe(0)                          // 工具已摘除
  expect(first.routes.size).toBe(0)
  expect(first.sections).toHaveLength(0)
  const second = fakeCtx(presetUrl())                              // HMR 重挂载
  await mod.apply(second.ctx, {} as Config)
  expect(second.tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(second.routes.size).toBe(1)
  expect(second.sections).toHaveLength(1)
})

test('provider 缺 persona 能力：激活响亮失败（挂载点能力校验）', async () => {
  const mod = await load()
  const { ctx } = fakeCtx(presetUrl(), { providerCapabilities: { persona: false } })
  await expect(mod.apply(ctx, {} as Config)).rejects.toThrowError(/persona/)
})

test('provider 缺 depthLimit 能力：激活响亮失败（挂载点能力校验）', async () => {
  const mod = await load()
  const { ctx } = fakeCtx(presetUrl(), { providerCapabilities: { depthLimit: false } })
  await expect(mod.apply(ctx, {} as Config)).rejects.toThrowError(/depthLimit/)
})

test('provider 尚未注册：激活成功但工具延迟挂载，provider-added 后注册', async () => {
  const mod = await load()
  const { ctx, tools, emit } = fakeCtx(presetUrl(), { providerAbsent: true })
  await mod.apply(ctx, {} as Config)
  expect(tools).toHaveLength(0)
  emit('subagent/provider-added', { name: 'spawn', capabilities: FULL_CAPS, inheritsParentContext: false })
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
})
