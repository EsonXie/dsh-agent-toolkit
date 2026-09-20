import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { setupUsage } from './index.ts'
import { emptyDaily } from './aggregate.ts'
import type { DailyRecord } from './store.ts'

/** 等 open 成功链（openSucceeded → registerOptionalRoutes → inject）落地。 */
const flush = () => new Promise((r) => setTimeout(r, 0))

interface RegisteredRoute {
  kind: string
  path: string
  handler?: (req: unknown, res: unknown) => Promise<void>
}

/** 记录 setupUsage 经 registerOptionalRoutes 注册的 webServer 路由，get 读取注入的记录。 */
function makeCtx(records: Record<string, DailyRecord> = {}) {
  const registered: RegisteredRoute[] = []
  const domain = {
    table: vi.fn(() => ({ get: vi.fn((date: string) => records[date]), put: vi.fn() })),
    close: vi.fn(async () => {}),
  }
  const ctx = {
    registered,
    effect: () => {},
    logger: { warn: vi.fn() },
    tokenMeter: { estimateMessage: () => 0 },
    storageDomain: { open: vi.fn(() => Promise.resolve(domain)) },
    on: () => {},
    commands: { register: vi.fn() },
    get: () => undefined,
    inject: (deps: string[], callback: (webCtx: {
      effect: (fn: () => unknown) => unknown
      webServer: { register: (r: RegisteredRoute) => () => void }
    }) => void) => {
      callback({
        effect: (fn: () => unknown) => fn(),
        webServer: {
          register: (r) => { registered.push(r); return () => {} },
        },
      })
    },
  }
  return { ctx: ctx as unknown as Context, registered }
}

/** 最小 res 桩：记录 status 与 body。 */
function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(code: number) { this.status = code; return this },
    end(body?: string) { this.body = body ?? ''; return this },
  }
}

/** 取指定路径的 handler 并以假 req/res 调用。 */
async function callRoute(registered: RegisteredRoute[], path: string, url: string) {
  const route = registered.find((r) => r.path === path)!
  const res = fakeRes()
  await route.handler!({ method: 'GET', url }, res as never)
  return res
}

test('两个 exact 路由统一挂在 /dsh-agent-toolkit/api/usage 前缀', async () => {
  const { ctx, registered } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  expect(registered.map((r) => r.kind)).toEqual(['exact', 'exact'])
  expect(registered.map((r) => r.path).sort()).toEqual([
    '/dsh-agent-toolkit/api/usage/daily',
    '/dsh-agent-toolkit/api/usage/range',
  ])
})

test('setupUsage 不再注册旧 /token-usage/api 路径', async () => {
  const { ctx, registered } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  expect(registered.every((r) => !r.path.startsWith('/token-usage/'))).toBe(true)
})

test('range：from/to 区间返回摘要、聚合块，单日附带 hours', async () => {
  const rec = emptyDaily('2026-08-17')
  rec.totals = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, estimated: 0, calls: 2, estimatedCalls: 0 }
  const { ctx, registered } = makeCtx({ '2026-08-17': rec })
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  const res = await callRoute(registered, '/dsh-agent-toolkit/api/usage/range',
    '/dsh-agent-toolkit/api/usage/range?from=2026-08-16&to=2026-08-17')
  expect(res.status).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.from).toBe('2026-08-16')
  expect(body.to).toBe('2026-08-17')
  expect(body.days).toHaveLength(2)
  expect(body.days[1]).toEqual({ date: '2026-08-17', billed: 150, calls: 2, fresh: 150, cached: 0 })
  expect(body.aggregate.totals.input).toBe(100)
  expect(body.hours).toBeUndefined() // 多日不带 hours
})

test('range：from === to 时附带 24 小时桶', async () => {
  const { ctx, registered } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  const res = await callRoute(registered, '/dsh-agent-toolkit/api/usage/range',
    '/dsh-agent-toolkit/api/usage/range?from=2026-08-17&to=2026-08-17')
  const body = JSON.parse(res.body)
  expect(body.hours).toHaveLength(24)
})

test('range：days 与 from/to 互斥、倒置区间、超上限均 400', async () => {
  const { ctx, registered } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  for (const url of [
    '/dsh-agent-toolkit/api/usage/range?days=7&from=2026-08-01&to=2026-08-03',
    '/dsh-agent-toolkit/api/usage/range?from=2026-08-18&to=2026-08-01',
    '/dsh-agent-toolkit/api/usage/range?from=2025-08-17&to=2026-08-18',
    '/dsh-agent-toolkit/api/usage/range?from=2026-8-1&to=2026-08-03',
  ]) {
    const res = await callRoute(registered, '/dsh-agent-toolkit/api/usage/range', url)
    expect(res.status).toBe(400)
  }
})

test('range：days 参数保持兼容', async () => {
  const { ctx, registered } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  const res = await callRoute(registered, '/dsh-agent-toolkit/api/usage/range',
    '/dsh-agent-toolkit/api/usage/range?days=7')
  expect(res.status).toBe(200)
  const body = JSON.parse(res.body)
  expect(body.days).toHaveLength(7)
})
