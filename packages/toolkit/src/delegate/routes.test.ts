import { expect, test } from 'vitest'
import { delegationRoutesDomain, DelegationRouteRecordSchema } from './routes.ts'

test('域声明：name/version/表布局', () => {
  expect(delegationRoutesDomain.name).toBe('dsh_agent_toolkit_routes')
  expect(delegationRoutesDomain.version).toBe(1)
  expect(Object.keys(delegationRoutesDomain.tables)).toEqual(['routes'])
})

test('记录 schema：合法通过，缺字段/错类型拒绝', () => {
  expect(DelegationRouteRecordSchema.safeParse({ provider: 'deepseek', model: 'deepseek-chat', at: 1 }).success).toBe(true)
  expect(DelegationRouteRecordSchema.safeParse({ provider: 'deepseek', model: 'deepseek-chat' }).success).toBe(false)
  expect(DelegationRouteRecordSchema.safeParse({ provider: 1, model: 'm', at: 1 }).success).toBe(false)
})
