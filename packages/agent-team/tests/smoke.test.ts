import { expect, test } from 'vitest'
import { name } from '../src/index.ts'

test('插件导出名', () => {
  expect(name).toBe('agent-team')
})
