// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { createSidebarEntry } from './entry.tsx'
import { useLoadState } from './load-state.ts'

afterEach(() => {
  cleanup()
})

const Entry = createSidebarEntry({
  id: 'demo-entry',
  order: 0,
  icon: <span data-testid="entry-icon">图标</span>,
  title: 'Demo 用量',
  renderModal: ({ open, onClose }) => (
    <div data-testid="modal">
      <span>{open ? 'open' : 'closed'}</span>
      {open && <button type="button" onClick={onClose}>关闭</button>}
    </div>
  ),
})

test('点击入口按钮：renderModal 收到 open: true，onClose 复位', () => {
  render(<Entry wide />)
  const button = screen.getByRole('button', { name: 'Demo 用量' })
  expect(button.textContent).toContain('图标')
  expect(button.textContent).not.toContain('Demo 用量')
  expect(screen.getByTestId('modal').textContent).toContain('closed')
  fireEvent.click(button)
  expect(screen.getByTestId('modal').textContent).toContain('open')
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(screen.getByTestId('modal').textContent).toContain('closed')
})

test('wide=false：按钮带 rail class、无文字标签', () => {
  render(<Entry wide={false} />)
  const button = screen.getByRole('button', { name: 'Demo 用量' })
  expect(button.className).toContain('rail')
  expect(button.textContent).not.toContain('Demo 用量')
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
