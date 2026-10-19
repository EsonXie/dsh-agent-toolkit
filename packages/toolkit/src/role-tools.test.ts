/** role-tools 组合行：在角色 preset 作用域内按白名单 restrict 全局工具面。 */
import { expect, test, vi } from 'vitest'
import { apply, Config, inject, name } from './role-tools.ts'

test('name/inject/Config 形态符合组合行约定', () => {
  expect(name).toBe('dsh-agent-toolkit-role-tools')
  expect(inject).toEqual(['tools'])
  expect(() => Config({ allow: ['read'] })).not.toThrow()
  expect(() => Config({} as never)).toThrow()
})

test('apply 调用 tools.restrict({ allow })', () => {
  const restrict = vi.fn(() => () => {})
  const ctx = { effect: (fn: () => unknown) => fn(), tools: { restrict } } as never
  apply(ctx, { allow: ['read', 'write'] })
  expect(restrict).toHaveBeenCalledWith({ allow: ['read', 'write'] })
})
