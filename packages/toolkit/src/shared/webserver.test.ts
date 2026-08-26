import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerOptionalRoutes } from './webserver.ts'

interface FakeCtx {
  storedDisposer: () => (() => void) | undefined
  inject: (deps: string[], callback: (webCtx: { effect: (fn: () => unknown) => unknown }) => void) => void
}

/** 模拟 ctx.inject 的可选服务语义：webServer 缺席时子 fiber 永不激活。 */
function makeCtx(hasWebServer: boolean): FakeCtx {
  let stored: (() => void) | undefined
  return {
    storedDisposer: () => stored,
    inject(_deps: string[], callback) {
      if (!hasWebServer) return
      callback({
        effect(fn: () => unknown) {
          const disposer = fn()
          stored = typeof disposer === 'function' ? disposer as () => void : undefined
          return disposer
        },
      })
    },
  }
}

test('webServer 缺席：不注册、不抛错', () => {
  const register = vi.fn(() => () => {})
  const ctx = makeCtx(false)
  expect(() => registerOptionalRoutes(ctx as unknown as Context, register)).not.toThrow()
  expect(register).not.toHaveBeenCalled()
  expect(ctx.storedDisposer()).toBeUndefined()
})

test('webServer 在场：注册路由，effect disposer 注销', () => {
  const unregister = vi.fn()
  const register = vi.fn(() => unregister)
  const ctx = makeCtx(true)
  registerOptionalRoutes(ctx as unknown as Context, register)
  expect(register).toHaveBeenCalledTimes(1)
  const disposer = ctx.storedDisposer()
  expect(disposer).toBeTypeOf('function')
  disposer?.()
  expect(unregister).toHaveBeenCalledTimes(1)
})
