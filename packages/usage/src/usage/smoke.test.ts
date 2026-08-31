import { expect, test } from 'vitest'
import { setupUsage } from './index.ts'

test('usage 模块导出 setupUsage', () => {
  expect(typeof setupUsage).toBe('function')
})
