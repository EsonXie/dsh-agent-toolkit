// @vitest-environment jsdom
import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from './index.ts'

test('双装：usage 入口被独立包占用时 apply 不向上抛，warn 恰好一次，settings.section 照常注册', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const registered: string[] = []
  const ctx = {
    effect: (fn: () => unknown) => { const d = fn(); return () => { if (typeof d === 'function') (d as () => unknown)() } },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    sessions: { open: () => {} },
    slots: {
      inject: (_key: string, callback: () => unknown) => { callback(); return () => {} },
      register: (options: { id?: string }) => {
        if (options.id === 'dsh-agent-toolkit:usage') {
          // 模拟独立包 @dsh-agent-toolkit/token-usage 已注册同一入口 id：ui-slots
          // register 的 list 分支同步抛错，toolkit 的 apply 应捕获并 warn，不拖垮本包浏览器半。
          throw new Error('list slot "conversation.session.header.utilities" already has an entry with id "dsh-agent-toolkit:usage"')
        }
        registered.push(options.id ?? '(no-id)')
        return () => {}
      },
    },
  }
  try {
    expect(() => apply(ctx as unknown as Context)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('token-usage')
    // 其余面板（设置面板 section）不受影响，照常注册。
    expect(registered).toContain('agent-toolkit')
  } finally {
    warn.mockRestore()
  }
})
