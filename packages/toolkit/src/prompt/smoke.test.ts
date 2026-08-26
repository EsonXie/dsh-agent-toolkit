import { expect, test } from 'vitest'
import { setupPrompt, validateConfig } from './index.ts'

test('prompt 模块导出 setupPrompt 与 validateConfig', () => {
  expect(typeof setupPrompt).toBe('function')
  expect(typeof validateConfig).toBe('function')
})
