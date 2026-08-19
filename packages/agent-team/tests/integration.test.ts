import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { apply, type Config } from '../src/index.ts'
import type { TeamStateView } from '../src/types.ts'

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'team-preset')

interface RegisteredTool { name: string; description: string }
type Handler = (req: unknown, res: unknown) => Promise<void>

function fakeCtx(events: SessionEvent[], baseUrl?: string, opts: { webServer?: boolean; kv?: Map<string, string> } = {}) {
  const tools: RegisteredTool[] = []
  const sections: { name: string; order: number; text: unknown }[] = []
  const routes = new Map<string, Handler>()
  const kv = opts.kv ?? new Map<string, string>()
  const agent = { session: { id: 's1', events } }
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
  const table = { get: (k: string) => kv.get(k), put: async (k: string, v: string) => { kv.set(k, v) } }
  const ctx = {
    baseUrl,
    agent,
    tools: { register: (tool: RegisteredTool) => { tools.push(tool); return () => {} } },
    systemPrompt: { section: (s: { name: string; order: number; text: unknown }) => { sections.push(s); return () => {} } },
    subagents: { start: async () => { throw new Error('integration test 不发起真实委派') } },
    storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
    inject: (names: string[], cb: (c: unknown) => void) => {
      const service = services[names[0]]
      if (service !== undefined) cb({ ...ctx, [names[0]]: service })
    },
    effect: (fn: () => unknown) => { fn() },
    logger: { info: () => {}, warn: () => {} },
  }
  return { ctx: ctx as unknown as Context, tools, sections, routes, kv, agent }
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
  const { ctx, tools, sections, routes } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(tools[0].description).toContain('reviewer: 代码审查员')   // 默认团队 = 字典序首个 alpha
  expect(tools[0].description).not.toContain('researcher')
  expect([...routes.keys()].sort()).toEqual(['/agent-team/s1/select', '/agent-team/s1/state'])
  expect(sections).toHaveLength(1)
  expect(String(sections[0].text)).toContain('team_delegate')
})

test('GET state：返回当前团队与选项摘要', async () => {
  const { ctx, routes } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/state', 'GET')
  expect(status).toBe(200)
  expect(json).toEqual({
    currentId: 'alpha',
    options: [{ id: 'alpha', summary: '代码审查员' }, { id: 'beta', summary: '资料调研与分析' }],
  })
})

test('POST select 成功：工具重注册（description 含新名册）、KV 写入、返回新视图', async () => {
  const { ctx, tools, routes, kv } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  expect(status).toBe(200)
  expect(json?.currentId).toBe('beta')
  expect(tools).toHaveLength(2)                                   // 重注册产物
  expect(tools[1].description).toContain('researcher: 资料调研与分析')
  expect(kv.get('s1')).toBe('beta')
})

test('POST select 同团队：200 但不重注册、不写 KV', async () => {
  const { ctx, tools, routes, kv } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const { status } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'alpha' })
  expect(status).toBe(200)
  expect(tools).toHaveLength(1)
  expect(kv.has('s1')).toBe(false)
})

test('POST select 未知团队：400 列出可用团队，不重注册', async () => {
  const { ctx, tools, routes } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'ghost' })
  expect(status).toBe(400)
  expect(json?.error).toContain('alpha, beta')
  expect(tools).toHaveLength(1)
})

test('POST select 会话已开始：409 锁定，不重注册、不写 KV', async () => {
  const events = [{ type: 'turn/start', data: {} } as SessionEvent]
  const { ctx, tools, routes, kv } = fakeCtx(events, presetUrl())
  await apply(ctx, {} as Config)
  const { status, json } = await callRoute(routes, '/agent-team/s1/select', 'POST', { team: 'beta' })
  expect(status).toBe(409)
  expect(json?.error).toContain('锁定')
  expect(tools).toHaveLength(1)
  expect(kv.has('s1')).toBe(false)
})

test('冷恢复：KV 已有选择时初始团队跟随（工具名册与 GET state）', async () => {
  const { ctx, tools, routes } = fakeCtx([], presetUrl(), { kv: new Map([['s1', 'beta']]) })
  await apply(ctx, {} as Config)
  expect(tools[0].description).toContain('researcher')
  const { json } = await callRoute(routes, '/agent-team/s1/state', 'GET')
  expect(json?.currentId).toBe('beta')
})

test('defaultTeam 命中时作为初始团队；未命中时激活失败', async () => {
  const ok = fakeCtx([], presetUrl())
  await apply(ok.ctx, { defaultTeam: 'beta' } as Config)
  expect(ok.tools[0].description).toContain('researcher: 资料调研与分析')
  const bad = fakeCtx([], presetUrl())
  await expect(apply(bad.ctx, { defaultTeam: 'ghost' } as Config)).rejects.toThrowError(/ghost/)
})

test('teamsDir 指向缺失目录时激活失败', async () => {
  const { ctx } = fakeCtx([], presetUrl())
  await expect(apply(ctx, { teamsDir: './missing' } as Config)).rejects.toThrowError(/missing/)
})

test('无 webServer 服务（headless）：激活成功，无路由，工具与提示段在', async () => {
  const { ctx, tools, sections, routes } = fakeCtx([], presetUrl(), { webServer: false })
  await apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(sections).toHaveLength(1)
  expect(routes.size).toBe(0)
})
