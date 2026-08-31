import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { setupUsage } from './index.ts'

/** Map 支撑的假存储域：按 table 名惰性建表，够守卫逻辑读写即可。 */
function makeCtx() {
  const tables = new Map<string, Map<string, unknown>>()
  const domain = {
    table: (name: string) => {
      let records = tables.get(name)
      if (records === undefined) { records = new Map(); tables.set(name, records) }
      return {
        get: (k: string) => records!.get(k),
        put: async (k: string, v: unknown) => { records!.set(k, v) },
        delete: async (k: string) => records!.delete(k),
      }
    },
    close: async () => {},
  }
  const listeners: unknown[] = []
  const disposers: (() => unknown)[] = []
  const warn = vi.fn()
  const ctx = {
    logger: { warn },
    tokenMeter: { estimateMessage: () => 0 },
    storageDomain: { open: () => Promise.resolve(domain) },
    effect: (fn: () => unknown) => { disposers.push(fn() as () => unknown) },
    on: (_event: string, fn: unknown) => { listeners.push(fn) },
    commands: { register: vi.fn() },
    inject: vi.fn(),
  }
  return { ctx: ctx as unknown as Context, tables, listeners, disposers, warn }
}

/** 等 domainReady/metering 微任务链落地。 */
const flush = () => new Promise((r) => setTimeout(r, 0))

test('meter_owner 空缺：占位并挂载采集监听', async () => {
  const { ctx, tables, listeners } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  expect(listeners).toHaveLength(1)
  expect(tables.get('meta')?.get('meter_owner')).toEqual({ value: 'pkg-a' })
})

test('meter_owner 已占用：不挂采集监听、warn 提示、命令仍注册', async () => {
  const { ctx, tables, listeners, warn } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  const h2 = makeCtx()
  h2.tables.set('meta', tables.get('meta')!) // 共享同一存储介质
  // 用共享 domain 重建 h2 的 open
  const domain2 = {
    table: (name: string) => ({
      get: (k: string) => tables.get(name)?.get(k),
      put: async (k: string, v: unknown) => { let t = tables.get(name); if (!t) { t = new Map(); tables.set(name, t) } t.set(k, v) },
      delete: async (k: string) => tables.get(name)?.delete(k) ?? false,
    }),
    close: async () => {},
  }
  ;(h2.ctx as unknown as { storageDomain: unknown }).storageDomain = { open: () => Promise.resolve(domain2) }
  setupUsage(h2.ctx, { timezone: 'Asia/Shanghai' }, 'pkg-b')
  await flush()
  expect(h2.listeners).toHaveLength(0)
  expect(h2.warn).toHaveBeenCalledWith(expect.stringContaining('pkg-a'))
  expect((h2.ctx as unknown as { commands: { register: unknown } }).commands.register).toHaveBeenCalled()
})

test('占位方卸载：释放 meter_owner', async () => {
  const { ctx, tables, disposers } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  expect(tables.get('meta')?.get('meter_owner')).toEqual({ value: 'pkg-a' })
  for (const d of disposers) await d()
  expect(tables.get('meta')?.get('meter_owner')).toBeUndefined()
})

test('open 失败：不挂采集监听、无 unhandled rejection 崩掉宿主', async () => {
  const h = makeCtx()
  ;(h.ctx as unknown as { storageDomain: unknown }).storageDomain = { open: () => Promise.reject(new Error('boom')) }
  const onUnhandled = vi.fn()
  const listener = () => { onUnhandled() }
  process.on('unhandledRejection', listener)
  try {
    setupUsage(h.ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
    await flush()
    await new Promise((r) => setTimeout(r, 10))
    expect(onUnhandled).not.toHaveBeenCalled()
    expect(h.listeners).toHaveLength(0)
  } finally {
    process.off('unhandledRejection', listener)
  }
})

test('already-open：后到实例自动停用——warn、不挂监听、不注册命令与路由', async () => {
  const h = makeCtx()
  const err = Object.assign(new Error('domain token_usage is already open'), { code: 'already-open' })
  ;(h.ctx as unknown as { storageDomain: unknown }).storageDomain = { open: () => Promise.reject(err) }
  const onUnhandled = vi.fn()
  const listener = () => { onUnhandled() }
  process.on('unhandledRejection', listener)
  try {
    setupUsage(h.ctx, { timezone: 'Asia/Shanghai' }, 'pkg-b')
    await flush()
    await new Promise((r) => setTimeout(r, 10))
    // 不抛错、无 unhandled rejection 崩掉宿主。
    expect(onUnhandled).not.toHaveBeenCalled()
    // 已停用：warn 说明由先到实例挂载、不挂采集监听。
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('停用'))
    expect(h.listeners).toHaveLength(0)
    // 不注册 /token-usage 命令、不触发路由注册（registerOptionalRoutes 未进入 ctx.inject）。
    expect((h.ctx as unknown as { commands: { register: ReturnType<typeof vi.fn> } }).commands.register).not.toHaveBeenCalled()
    expect((h.ctx as unknown as { inject: ReturnType<typeof vi.fn> }).inject).not.toHaveBeenCalled()
  } finally {
    process.off('unhandledRejection', listener)
  }
})

test('占位 put 在途时卸载：释放不丢 meter_owner', async () => {
  // 真实 KvTable 的 put/delete 经 host.enqueue 串行：delete 排到 put 之后会观测到 put
  // 落盘（见 storage-domain domain.ts delete 注释）。用同一串行链模拟 in-flight 占位：
  // beforeClose 在 put 落盘前已发起释放（ownsMeter 先置位），串行链保证 delete 随后观测并删除。
  const records = new Map<string, unknown>()
  let chain: Promise<unknown> = Promise.resolve()
  let releasePut!: () => void
  const gate = new Promise<void>((r) => { releasePut = r })
  const enqueue = (job: () => unknown) => { chain = chain.then(job); return chain }
  const table = {
    get: (k: string) => records.get(k),
    put: (k: string, v: unknown) => enqueue(async () => { await gate; records.set(k, v) }),
    delete: (k: string) => enqueue(() => { const had = records.has(k); records.delete(k); return had }),
  }
  const domain = { table: () => table, close: async () => {} }
  const listeners: unknown[] = []
  const disposers: (() => unknown)[] = []
  const ctx = {
    logger: { warn: vi.fn() },
    tokenMeter: { estimateMessage: () => 0 },
    storageDomain: { open: () => Promise.resolve(domain) },
    effect: (fn: () => unknown) => { disposers.push(fn() as () => unknown) },
    on: (_event: string, fn: unknown) => { listeners.push(fn) },
    commands: { register: vi.fn() },
    inject: () => {},
  }
  setupUsage(ctx as unknown as Context, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  // meteringReady 已把 put 排入串行链并在 gate 上等待：占位尚未落盘。
  expect(records.has('meter_owner')).toBe(false)
  // 卸载：beforeClose 发起释放（delete 排在 put 之后），会 await 到串行链排空。
  const unload = (async () => { for (const d of disposers) await d() })()
  await flush()
  releasePut() // 放行 put 落盘
  await unload
  await flush()
  expect(records.get('meter_owner')).toBeUndefined()
})
