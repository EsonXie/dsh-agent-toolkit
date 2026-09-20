// @vitest-environment jsdom
// useLoadState 单测：resolve/reject/reload 与 deps 变化时丢弃 stale 结果。
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { useLoadState } from './load-state.ts'

afterEach(() => {
  cleanup()
})

test('useLoadState：resolve → ok', async () => {
  const { result } = renderHook(() => useLoadState(() => Promise.resolve(42), []))
  await act(async () => {})
  expect(result.current.state).toEqual({ kind: 'ok', data: 42 })
})

test('useLoadState：reject → error（携带 message）', async () => {
  const { result } = renderHook(() => useLoadState(() => Promise.reject(new Error('加载失败')), []))
  await act(async () => {})
  expect(result.current.state).toEqual({ kind: 'error', message: '加载失败' })
})

test('useLoadState：reload 触发重新加载', async () => {
  let calls = 0
  const { result } = renderHook(() => useLoadState(async () => { calls += 1; return calls }, []))
  await act(async () => {})
  expect(result.current.state).toEqual({ kind: 'ok', data: 1 })
  act(() => { result.current.reload() })
  await act(async () => {})
  expect(result.current.state).toEqual({ kind: 'ok', data: 2 })
})

test('useLoadState：deps 变化期间慢 resolve 被 stale 丢弃', async () => {
  let resolveFirst!: (v: number) => void
  const first = new Promise<number>((r) => { resolveFirst = r })
  const { result, rerender } = renderHook(
    ({ load, dep }: { load: () => Promise<number>; dep: string }) => useLoadState(load, [dep]),
    { initialProps: { load: () => first, dep: 'a' } },
  )
  await act(async () => {})
  expect(result.current.state.kind).toBe('loading')
  rerender({ load: () => Promise.resolve(7), dep: 'b' })
  await act(async () => { resolveFirst(99) })
  await act(async () => {})
  expect(result.current.state).toEqual({ kind: 'ok', data: 7 })
})
