/** role-persona 组合行：在角色 preset 作用域内注入 deployment:persona-prefix 段。 */
import { expect, test, vi } from 'vitest'
import { apply, Config, inject, name } from './role-persona.ts'

function fakeCtx() {
  const section = vi.fn(() => () => {})
  const getSectionOrder = vi.fn(() => 100)
  const effect = vi.fn((fn: () => unknown) => fn())
  return { ctx: { effect, systemPrompt: { section, getSectionOrder } } as never, section, getSectionOrder, effect }
}

test('name/inject/Config 形态符合组合行约定', () => {
  expect(name).toBe('dsh-agent-toolkit-role-persona')
  expect(inject).toEqual(['systemPrompt'])
  expect(() => Config({ prefix: '你是探索者' })).not.toThrow()
  expect(() => Config({} as never)).toThrow()
})

test('apply 注册 deployment:persona-prefix 段并随 effect 清理', () => {
  const { ctx, section, getSectionOrder } = fakeCtx()
  apply(ctx, { prefix: '你是探索者' })
  expect(getSectionOrder).toHaveBeenCalledWith('DEPLOYMENT_PERSONA_PREFIX')
  expect(section).toHaveBeenCalledWith(expect.objectContaining({
    name: 'deployment:persona-prefix',
    order: 100,
    text: '你是探索者',
  }))
})
