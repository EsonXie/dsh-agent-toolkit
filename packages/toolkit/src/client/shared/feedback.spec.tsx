// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SaveBar, useToast } from './feedback.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const labels = { save: '保存', cancel: '取消', saved: '已保存' }

test('SaveBar：dirty 时保存按钮可用，saved 时显示「已保存」', () => {
  const { rerender } = render(
    <SaveBar labels={labels} dirty saving={false} saved={false} onSave={() => {}} onCancel={() => {}} />,
  )
  expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false)
  rerender(
    <SaveBar labels={labels} dirty={false} saving={false} saved onSave={() => {}} onCancel={() => {}} />,
  )
  expect(screen.getByText('已保存')).toBeDefined()
})

test('SaveBar：error 内联展示', () => {
  render(
    <SaveBar labels={labels} dirty saving={false} saved={false} error="boom" onSave={() => {}} onCancel={() => {}} />,
  )
  expect(screen.getByText('boom')).toBeDefined()
})

function ToastHost(): ReactNode {
  const { showToast, toastNode } = useToast()
  return (
    <>
      <button type="button" onClick={() => { showToast('已保存') }}>触发</button>
      {toastNode}
    </>
  )
}

test('useToast：showToast 后渲染 Toast 文本，onDone 后卸载', () => {
  vi.useFakeTimers()
  render(<ToastHost />)
  fireEvent.click(screen.getByRole('button', { name: '触发' }))
  expect(screen.getByRole('alert').textContent).toContain('已保存')
  act(() => { vi.advanceTimersByTime(4000) })
  expect(screen.queryByRole('alert')).toBeNull()
})

function RerenderableToastHost({ tick }: { tick: number }): ReactNode {
  const { showToast, toastNode } = useToast()
  return (
    <>
      <span data-testid="tick">{tick}</span>
      <button type="button" onClick={() => { showToast('已保存') }}>触发</button>
      {toastNode}
    </>
  )
}

test('useToast：toast 显示期间父组件重渲染不重置消失计时器', () => {
  vi.useFakeTimers()
  const { rerender } = render(<RerenderableToastHost tick={0} />)
  fireEvent.click(screen.getByRole('button', { name: '触发' }))
  expect(screen.getByRole('alert').textContent).toContain('已保存')
  // hold 期结束前推进 3000ms，再驱动父组件重渲染：若 onDone 每次换身份，
  // Toast 的 effect 会清掉旧计时器重设 4000ms，Toast 便不会按原计时消失。
  act(() => { vi.advanceTimersByTime(3000) })
  rerender(<RerenderableToastHost tick={1} />)
  act(() => { vi.advanceTimersByTime(1000) })
  expect(screen.queryByRole('alert')).toBeNull()
})
