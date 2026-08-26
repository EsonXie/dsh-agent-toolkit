// @vitest-environment jsdom
import { expect, test } from 'vitest'
import * as clientEntry from './index.ts'

test('客户端入口导出 inject 覆盖所访问的全部服务（sessions/slots/locale）', () => {
  expect(clientEntry.inject).toEqual(expect.arrayContaining(['sessions', 'slots', 'locale']))
  expect(clientEntry.inject).toContain('sessions')
  expect(clientEntry.inject).toContain('slots')
  expect(clientEntry.inject).toContain('locale')
})
