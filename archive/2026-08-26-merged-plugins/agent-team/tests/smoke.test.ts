import { expect, test } from 'vitest'
import { inject, name } from '../src/index.ts'

test('插件导出名', () => {
  expect(name).toBe('agent-team')
})

test('inject 依赖声明', () => {
  expect(inject).toEqual(['tools', 'subagents', 'systemPrompt'])
})
