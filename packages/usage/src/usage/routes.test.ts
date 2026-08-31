import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { setupUsage } from './index.ts'

/** 等 open 成功链（openSucceeded → registerOptionalRoutes → inject）落地。 */
const flush = () => new Promise((r) => setTimeout(r, 0))

/** 记录 setupUsage 经 registerOptionalRoutes 注册的 webServer 路由。 */
function makeCtx() {
  const registered: { kind: string; path: string }[] = []
  const domain = {
    table: vi.fn(() => ({ get: vi.fn(() => undefined), put: vi.fn() })),
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
    inject: (deps: string[], callback: (webCtx: {
      effect: (fn: () => unknown) => unknown
      webServer: { register: (r: { kind: string; path: string }) => () => void }
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
