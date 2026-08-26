import { expect, test } from 'vitest'
import { inject, name } from '../src/index.ts'

test('插件导出名与 inject', () => {
  expect(name).toBe('prompt-stack')
  expect(inject).toEqual(['systemPrompt'])
})
