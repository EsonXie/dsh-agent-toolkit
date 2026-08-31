// @vitest-environment jsdom
import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../index.ts'

test('双装：第二次 apply 命中重复入口，不向上抛、warn 降级', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let calls = 0
  const ctx = {
    slots: {
      inject: (_key: string, callback: () => unknown) => {
        calls += 1
        if (calls > 1) {
          // 与真实宿主一致：后到实例在 slots 重复 id 处同步抛错（ui-slots register 的 list 分支）。
          throw new Error('list slot "sidebar.footer.action" already has an entry with id "dsh-agent-toolkit:usage"')
        }
        callback()
        return () => {}
      },
      register: () => () => {},
    },
  }
  try {
    expect(() => apply(ctx as unknown as Context)).not.toThrow()
    expect(() => apply(ctx as unknown as Context)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('Token 用量')
  } finally {
    warn.mockRestore()
  }
})
