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
    inject: () => {},
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
  tables.get // 预占：先建 meta 表再写入
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
