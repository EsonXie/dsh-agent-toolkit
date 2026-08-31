import { expect, test } from 'vitest'
import { apply, Config, inject, name } from './index.ts'

test('插件入口导出四件套', () => {
  expect(name).toBe('@dsh-agent-toolkit/token-usage')
  expect(inject).toEqual(['storageDomain', 'tokenMeter', 'commands'])
  expect(typeof apply).toBe('function')
})

test('Config({}) 产出默认时区', () => {
  expect(Config({})).toEqual({ timezone: 'Asia/Shanghai' })
})
