import { describe, expect, test, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { createPresetApplier, type PermissionPresetsLike } from './permission-preset.ts'

const session = {} as Session

describe('createPresetApplier', () => {
  test('服务缺席：warn 一次后静默，重复调用不重复 warn、不抛错', () => {
    const warn = vi.fn()
    const apply = createPresetApplier(() => undefined, 'danger-full-access', warn)
    apply(session)
    apply(session)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('permissionPresets')
  })

  test('非法预设名：warn 且不调用 set', () => {
    const set = vi.fn()
    const svc: PermissionPresetsLike = { names: ['workspace-write'], set }
    const warn = vi.fn()
    const apply = createPresetApplier(() => svc, 'bogus', warn)
    apply(session)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('bogus')
    expect(set).not.toHaveBeenCalled()
  })

  test('合法预设：调用 svc.set(session, name)，不 warn', () => {
    const set = vi.fn()
    const svc: PermissionPresetsLike = { names: ['workspace-write', 'danger-full-access'], set }
    const warn = vi.fn()
    const apply = createPresetApplier(() => svc, 'danger-full-access', warn)
    apply(session)
    expect(set).toHaveBeenCalledWith(session, 'danger-full-access')
    expect(warn).not.toHaveBeenCalled()
  })

  test('svc.set 抛错：warn 一次且异常不传播', () => {
    const set = vi.fn(() => {
      throw new Error('projection unavailable')
    })
    const svc: PermissionPresetsLike = { names: ['workspace-write', 'danger-full-access'], set }
    const warn = vi.fn()
    const apply = createPresetApplier(() => svc, 'danger-full-access', warn)
    expect(() => apply(session)).not.toThrow()
    expect(set).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('danger-full-access')
    expect(warn.mock.calls[0]![0]).toContain('projection unavailable')
  })
})
