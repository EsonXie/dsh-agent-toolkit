import { expect, test } from 'vitest'
import { createActiveRoutes } from './active.ts'

test('set 后 get 命中；delete 后 get 落空', () => {
  const active = createActiveRoutes()
  active.set('s1', 'reviewer', { provider: 'deepseek', model: 'deepseek-reasoner' })
  expect(active.get('s1', 'reviewer')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  active.delete('s1', 'reviewer')
  expect(active.get('s1', 'reviewer')).toBeUndefined()
})

test('同 key 后写覆盖；不同 session/role 互不影响', () => {
  const active = createActiveRoutes()
  active.set('s1', 'r', { provider: 'a', model: 'm1' })
  active.set('s1', 'r', { provider: 'a', model: 'm2' })
  active.set('s2', 'r', { provider: 'b', model: 'm3' })
  expect(active.get('s1', 'r')).toEqual({ provider: 'a', model: 'm2' })
  expect(active.get('s2', 'r')).toEqual({ provider: 'b', model: 'm3' })
  active.delete('s1', 'r')
  expect(active.get('s2', 'r')).toEqual({ provider: 'b', model: 'm3' })
})
