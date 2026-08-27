// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PromptLayersModal } from './PromptLayersModal.tsx'

const PAYLOAD = {
  layers: [
    { name: 'base', order: 0, text: 'BASE' },
    { name: 'task', order: 50, text: 'TASK' },
  ],
  rules: [{ match: { modelPattern: 'deepseek*' }, overrides: { task: 'V4-TASK' }, append: 'V4-NOTES' }],
  seedLayers: [{ name: 'base', order: 0, text: 'BASE' }],
}

function stubFetch() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    if (url === '/dsh-agent-toolkit/api/prompt-layers' && method === 'GET') {
      return new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === '/dsh-agent-toolkit/api/prompt-layers' && method === 'PUT') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === '/dsh-agent-toolkit/api/prompt-layers/reset' && method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }))
  return calls
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('加载后按 order 展示层列表与选中编辑器回显', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  expect(await screen.findByText('base')).toBeTruthy()
  expect(screen.getByText('task')).toBeTruthy()
  // 编辑器回显选中层（默认首个 = base）
  expect(screen.getByLabelText('层名')).toHaveProperty('value', 'base')
  expect(screen.getByLabelText('层文本')).toHaveProperty('value', 'BASE')
})

test('编辑层文本并保存 → PUT /prompt-layers 全量携带', async () => {
  const calls = stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('base')

  fireEvent.change(screen.getByLabelText('层文本'), { target: { value: 'NEW BASE' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/prompt-layers' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).toEqual({
      layers: [
        { name: 'base', order: 0, text: 'NEW BASE' },
        { name: 'task', order: 50, text: 'TASK' },
      ],
    })
  })
})

test('新建层、上移、删除只改内存，保存时统一提交', async () => {
  const calls = stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('base')

  fireEvent.click(screen.getByRole('button', { name: '新建层' }))
  fireEvent.change(screen.getByLabelText('层名'), { target: { value: 'domain' } })
  fireEvent.click(screen.getByRole('button', { name: '上移' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/prompt-layers' && c.method === 'PUT')
    expect(put).toBeTruthy()
    const layers = (put?.body as { layers: Array<{ name: string }> }).layers
    expect(layers.map((l) => l.name)).toEqual(['domain', 'base', 'task'])
  })
})

test('规则只读视图：展开后展示规则，悬空引用标红', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('base')

  fireEvent.click(screen.getByRole('button', { name: '规则（只读）' }))
  expect(await screen.findByText(/provider=|model=|modelPattern=/)).toBeTruthy()
  expect(screen.getByText('modelPattern=deepseek*')).toBeTruthy()
})

test('规则只读视图：overrides 键以可读文本渲染（不显示 [object Object]）', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('base')

  fireEvent.click(screen.getByRole('button', { name: '规则（只读）' }))
  const overrides = await screen.findByText('overrides:')
  expect(overrides.textContent).toContain('task')
  expect(screen.queryByText('[object Object]')).toBeNull()
})
