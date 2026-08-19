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

// index.ts 持有模块级共享 domain 单例，每个测试须取全新模块实例以隔离跨测试共享状态。
type FreshMod = typeof import('../src/index.ts')
async function load(): Promise<FreshMod> {
  vi.resetModules()
  return import('../src/index.ts')
}

function fakeCtx(events: SessionEvent[], baseUrl?: string, opts: { webServer?: boolean; kv?: Map<string, string>; sessionId?: string; failPut?: boolean } = {}) {
  const tools: RegisteredTool[] = []
  const sections: { name: string; order: number; text: unknown }[] = []
  const routes = new Map<string, Handler>()
  const disposers: Disposer[] = []
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
    tools: { register: (tool: RegisteredTool) => { tools.push(tool); return () => {} } },
    systemPrompt: { section: (s: { name: string; order: number; text: unknown }) => { sections.push(s); return () => {} } },
    subagents: { start: async () => { throw new Error('integration test 不发起真实委派') } },
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
    effect: (fn: () => unknown) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer as Disposer)
    },
    logger: { info: () => {}, warn: () => {} },
  }
  return {
    ctx: ctx as unknown as Context,
    tools,
    sections,
    routes,
    kv,
    disposers,
    agent,
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

test('激活：注册 team_delegate（默认团队名册入 description）、state/select 路由与提示段', async () => {
  const mod = await load()
  const { ctx, tools, sections, routes } = fakeCtx([], presetUrl())
  await mod.apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(tools[0].description).toContain('reviewer: 代码审查员')   // 默认团队 = 字典序首个 alpha
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

test('POST select 成功：工具重注册（description 含新名册）、KV 写入、返回新视图', async () => {
  const mod = await load()
  const { ctx, tools, routes, kv } = fakeCtx([], presetUrl())
  await mod.apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  expect(status).toBe(200)
  expect(json?.currentId).toBe('beta')
  expect(tools).toHaveLength(2)                                   // 重注册产物
  expect(tools[1].description).toContain('researcher: 资料调研与分析')
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

test('冷恢复：KV 已有选择时初始团队跟随（工具名册与 GET state）', async () => {
  const mod = await load()
  const { ctx, tools, routes } = fakeCtx([], presetUrl(), { kv: new Map([['s1', 'beta']]) })
  await mod.apply(ctx, {} as Config)
  expect(tools[0].description).toContain('researcher')
  const { json } = await callRoute(routes, '/agent-team/s1/state', 'GET')
  expect(json?.currentId).toBe('beta')
})

test('defaultTeam 命中时作为初始团队；未命中时激活失败', async () => {
  const mod = await load()
  const ok = fakeCtx([], presetUrl())
  await mod.apply(ok.ctx, { defaultTeam: 'beta' } as Config)
  expect(ok.tools[0].description).toContain('researcher: 资料调研与分析')
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
