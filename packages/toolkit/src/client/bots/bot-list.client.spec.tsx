// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { BotList } from './BotList.tsx'
import type { BotListItem } from './api.ts'

const BOTS: BotListItem[] = [
  {
    id: 'reviewer', name: '评审机器人', channel: 'feishu',
    feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'r1' },
    project: 'D:\\work\\demo', status: 'connected', createdAt: 1, updatedAt: 1,
  },
  {
    id: 'ops', name: '运维机器人', channel: 'feishu',
    feishu: { appId: 'cli_000000000000000a', appSecretRef: 'r2' },
    project: 'D:\\work\\other', status: 'failed', createdAt: 1, updatedAt: 1,
  },
  {
    id: 'docs', name: '文档机器人', project: 'D:\\work\\other', status: 'not-running', createdAt: 1, updatedAt: 1,
  },
]

interface FetchCall { url: string; method: string; body?: unknown }

function stubFetch(routes: Record<string, (init?: RequestInit) => { status?: number; body?: unknown }>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined })
    const handler = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1]
    if (handler === undefined) return new Response('not found', { status: 404 })
    const result = handler(init)
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
  return calls
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function rowOf(name: string): HTMLElement {
  const label = screen.getByText(name)
  const row = label.closest('[data-testid="bot-row"]')
  if (row === null) throw new Error(`row not found: ${name}`)
  return row as HTMLElement
}

test('状态点四色映射：已连接/连接失败/未运行 + 未绑定文案', () => {
  render(<BotList bots={BOTS} onEdit={() => undefined} onDeleted={() => undefined} />)

  expect(within(rowOf('评审机器人')).getByText('已连接')).toBeTruthy()
  expect(within(rowOf('运维机器人')).getByText('连接失败')).toBeTruthy()
  expect(within(rowOf('文档机器人')).getByText('未运行')).toBeTruthy()
})

test('项目路径逐行展示', () => {
  render(<BotList bots={BOTS} onEdit={() => undefined} onDeleted={() => undefined} />)

  expect(within(rowOf('评审机器人')).getByText('D:\\work\\demo')).toBeTruthy()
  expect(within(rowOf('运维机器人')).getByText('D:\\work\\other')).toBeTruthy()
})

test('删除两段确认：首点仅切确认态；再点 DELETE 并回调 onDeleted', async () => {
  const calls = stubFetch({
    '/dsh-agent-toolkit/api/bots/bots': () => ({ body: { ok: true } }),
  })
  const onDeleted = vi.fn()
  render(<BotList bots={BOTS} onEdit={() => undefined} onDeleted={onDeleted} />)

  // 首段：只切确认态，不发 DELETE
  fireEvent.click(within(rowOf('评审机器人')).getByRole('button', { name: '删除' }))
  expect(within(rowOf('评审机器人')).getByRole('button', { name: '确认删除？' })).toBeTruthy()
  expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)

  // 第二段：确认 → DELETE → onDeleted
  fireEvent.click(within(rowOf('评审机器人')).getByRole('button', { name: '确认删除？' }))
  await vi.waitFor(() => { expect(onDeleted).toHaveBeenCalledOnce() })
  const del = calls.find((c) => c.method === 'DELETE')
  expect(del?.url).toBe('/dsh-agent-toolkit/api/bots/bots?id=reviewer')
})

test('删除确认态转移：点其它行的删除按钮，原行复位', () => {
  render(<BotList bots={BOTS} onEdit={() => undefined} onDeleted={() => undefined} />)

  fireEvent.click(within(rowOf('评审机器人')).getByRole('button', { name: '删除' }))
  expect(within(rowOf('评审机器人')).getByRole('button', { name: '确认删除？' })).toBeTruthy()
  fireEvent.click(within(rowOf('运维机器人')).getByRole('button', { name: '删除' }))
  expect(within(rowOf('评审机器人')).getByRole('button', { name: '删除' })).toBeTruthy()
  expect(within(rowOf('运维机器人')).getByRole('button', { name: '确认删除？' })).toBeTruthy()
})

test('删除失败：DELETE 500 → role=alert 错误行且不回调 onDeleted', async () => {
  stubFetch({ '/dsh-agent-toolkit/api/bots/bots': () => ({ status: 500, body: 'boom' }) })
  const onDeleted = vi.fn()
  render(<BotList bots={BOTS} onEdit={() => undefined} onDeleted={onDeleted} />)

  fireEvent.click(within(rowOf('评审机器人')).getByRole('button', { name: '删除' }))
  fireEvent.click(within(rowOf('评审机器人')).getByRole('button', { name: '确认删除？' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('删除失败')
  expect(onDeleted).not.toHaveBeenCalled()
})

test('点击编辑回调携带该行 bot', () => {
  const edits: string[] = []
  render(<BotList bots={BOTS} onEdit={(bot) => { edits.push(bot.id) }} onDeleted={() => undefined} />)

  fireEvent.click(within(rowOf('评审机器人')).getByRole('button', { name: '编辑' }))
  expect(edits).toEqual(['reviewer'])
})
