// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BotsModal } from '../src/client/BotsModal.tsx'

const BOTS = {
  bots: [
    {
      id: 'reviewer', name: '评审机器人', channel: 'feishu',
      feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'r1' },
      project: 'D:\\work\\demo', status: 'connected', createdAt: 1, updatedAt: 1,
    },
    {
      id: 'ops', name: '运维机器人', channel: 'feishu',
      feishu: { appId: 'cli_000000000000000a', appSecretRef: 'r2' },
      project: 'D:\\work\\demo', status: 'failed', createdAt: 1, updatedAt: 1,
    },
    {
      id: 'docs', name: '文档机器人', channel: 'feishu',
      feishu: { appId: 'cli_000000000000000b', appSecretRef: 'r3' },
      project: 'D:\\work\\other', status: 'not-running', createdAt: 1, updatedAt: 1,
    },
  ],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(BOTS), { status: 200, headers: { 'content-type': 'application/json' } })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const useWorkspaces = <S,>(selector: (s: { items: unknown[] }) => S): S => selector({ items: [] })

test('列表按项目分组，显示渠道标记与运行状态', async () => {
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces} onEdit={() => undefined} />)
  expect(await screen.findByText('评审机器人')).toBeTruthy()
  expect(screen.getByText('运维机器人')).toBeTruthy()
  expect(screen.getByText('文档机器人')).toBeTruthy()
  // 分组标题：两个项目
  expect(screen.getByText('D:\\work\\demo')).toBeTruthy()
  expect(screen.getByText('D:\\work\\other')).toBeTruthy()
  // 渠道标记
  expect(screen.getAllByText('飞书').length).toBe(3)
  // 状态
  expect(screen.getByText('已连接')).toBeTruthy()
  expect(screen.getByText('连接失败')).toBeTruthy()
  expect(screen.getByText('未运行')).toBeTruthy()
})

test('点击机器人行触发 onEdit；新建按钮触发 onCreate', async () => {
  const edits: string[] = []
  let created = 0
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces}
    onEdit={(bot) => { edits.push(bot.id) }} onCreate={() => { created += 1 }} />)
  ;(await screen.findByText('评审机器人')).click()
  expect(edits).toEqual(['reviewer'])
  screen.getByRole('button', { name: '新建机器人' }).click()
  expect(created).toBe(1)
})

test('加载失败显示错误态', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })))
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces} />)
  expect(await screen.findByText('加载失败，请重试')).toBeTruthy()
})
