// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TeamDock, type TeamDockProps } from '../src/client/TeamDock.tsx'
import type { TeamStateView } from '../src/types.ts'

afterEach(cleanup)

const STATE: TeamStateView = {
  currentId: 'alpha',
  options: [
    { id: 'alpha', summary: '代码审查员' },
    { id: 'beta', summary: '资料调研与分析' },
  ],
}

function propsOf(state: TeamStateView | null, blank: boolean, selectTeam?: TeamDockProps['selectTeam']) {
  return {
    useSession: (selector: (s: { blank: boolean }) => unknown) => selector({ blank }),
    fetchState: vi.fn(async () => state),
    selectTeam: selectTeam ?? vi.fn(async (team: string) => ({ ...state!, currentId: team })),
  } as unknown as TeamDockProps
}

test('非团队会话（fetchState 返回 null）时不渲染', async () => {
  const props = propsOf(null, true)
  const { container } = render(<TeamDock {...props} />)
  await waitFor(() => expect(props.fetchState).toHaveBeenCalled())
  expect(container.firstChild).toBeNull()
})

test('渲染团队下拉：当前值选中，选项带摘要，blank 期可用', async () => {
  render(<TeamDock {...propsOf(STATE, true)} />)
  const select = await screen.findByRole('combobox') as HTMLSelectElement
  expect(select.value).toBe('alpha')
  expect(screen.getByText('beta · 资料调研与分析')).toBeTruthy()
  expect(select.disabled).toBe(false)
})

test('选择团队成功：selectTeam 被调，UI 更新为新团队', async () => {
  const props = propsOf(STATE, true)
  render(<TeamDock {...props} />)
  const select = await screen.findByRole('combobox') as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'beta' } })
  await waitFor(() => expect(props.selectTeam).toHaveBeenCalledWith('beta'))
  await waitFor(() => expect(select.value).toBe('beta'))
})

test('选择失败（如锁定 409）：回退原值并在 title 显示错误', async () => {
  const selectTeam = vi.fn(async () => { throw new Error('会话已开始，团队已锁定') })
  render(<TeamDock {...propsOf(STATE, true, selectTeam)} />)
  const select = await screen.findByRole('combobox') as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'beta' } })
  await waitFor(() => expect(select.title).toContain('锁定'))
  expect(select.value).toBe('alpha')
})

test('会话已开始时禁用并提示锁定', async () => {
  render(<TeamDock {...propsOf(STATE, false)} />)
  const select = await screen.findByRole('combobox') as HTMLSelectElement
  expect(select.disabled).toBe(true)
  expect(select.title).toContain('锁定')
})
