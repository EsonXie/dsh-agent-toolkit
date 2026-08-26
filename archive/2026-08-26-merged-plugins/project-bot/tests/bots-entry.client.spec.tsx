// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BotsEntry } from '../src/client/BotsEntry.tsx'

const BOTS = {
  bots: [{
    id: 'reviewer', name: '评审机器人', channel: 'feishu',
    feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
    project: 'D:\\work\\demo', status: 'connected', createdAt: 1, updatedAt: 1,
  }],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.startsWith('/project-bot/api/bots') ? BOTS : { tools: ['bash'] }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const useWorkspaces = <S,>(selector: (s: { items: unknown[] }) => S): S => selector({ items: [] })

test('宽栏：图标 + 文字标签；窄栏：仅图标', () => {
  const { unmount } = render(<BotsEntry wide useWorkspaces={useWorkspaces} />)
  expect(screen.getByRole('button', { name: '消息机器人' }).textContent).toContain('消息机器人')
  unmount()
  render(<BotsEntry wide={false} useWorkspaces={useWorkspaces} />)
  expect(screen.getByRole('button', { name: '消息机器人' }).textContent).not.toContain('消息机器人')
})

test('点击打开机器人列表模态框并拉取列表', async () => {
  render(<BotsEntry wide useWorkspaces={useWorkspaces} />)
  screen.getByRole('button', { name: '消息机器人' }).click()
  expect(await screen.findByText('评审机器人')).toBeTruthy()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/project-bot/api/bots')
})
