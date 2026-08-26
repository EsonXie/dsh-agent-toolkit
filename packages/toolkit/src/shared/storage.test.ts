import { afterEach, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { openDomainSafely } from './storage.ts'

const SPEC: DomainSpec = { name: 'demo', version: 1, tables: {} }

interface FakeCtx {
  effects: (() => unknown)[]
  storageDomain: { open: () => Promise<unknown> }
  effect: (fn: () => unknown) => void
}

function makeCtx(openImpl: () => Promise<unknown>): FakeCtx {
  const effects: (() => unknown)[] = []
  return {
    effects,
    storageDomain: { open: vi.fn(openImpl) },
    effect(fn: () => unknown) { effects.push(fn) },
  }
}

const UNHANDLED: (() => void)[] = []
const onUnhandled = vi.fn()

afterEach(() => {
  for (const off of UNHANDLED.splice(0)) off()
})

test('open 成功：effect disposer 关闭已打开的 domain', async () => {
  const close = vi.fn(async () => {})
  const ctx = makeCtx(() => Promise.resolve({ close }))
  const warn = vi.fn()
  const ready = openDomainSafely(ctx as unknown as Context, SPEC, warn)
  await ready
  expect(close).not.toHaveBeenCalled()
  const disposer = ctx.effects[0]() as () => Promise<void>
  await disposer()
  expect(close).toHaveBeenCalledTimes(1)
})

test('open 失败：warn 被调用，返回 promise 仍 reject 让调用方感知', async () => {
  const openError = new Error('version-mismatch: 介质版本不兼容')
  const warn = vi.fn()
  const ctx = makeCtx(() => Promise.reject(openError))
  const ready = openDomainSafely(ctx as unknown as Context, SPEC, warn)
  await expect(ready).rejects.toThrow('version-mismatch')
  expect(warn).toHaveBeenCalledWith('version-mismatch: 介质版本不兼容')
})

test('open 失败挂 rejection handler：不抛 unhandled，disposer 不抛错', async () => {
  const listener = () => { onUnhandled() }
  process.on('unhandledRejection', listener)
  UNHANDLED.push(() => { process.off('unhandledRejection', listener) })
  onUnhandled.mockClear()
  const warn = vi.fn()
  const ctx = makeCtx(() => Promise.reject(new Error('boom')))
  // 故意不 catch 返回的 promise：只有内部 .catch 在场，必须不触发 unhandled。
  openDomainSafely(ctx as unknown as Context, SPEC, warn)
  await new Promise((r) => setTimeout(r, 20))
  expect(warn).toHaveBeenCalledWith('boom')
  expect(onUnhandled).not.toHaveBeenCalled()
  const disposer = ctx.effects[0]() as () => Promise<void>
  await expect(disposer()).resolves.toBeUndefined()
})
