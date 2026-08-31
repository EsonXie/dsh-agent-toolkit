// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { PromptLayersModal } from './PromptLayersModal.tsx'

const PAYLOAD = {
  layers: [
    { name: 'persona', order: 0, text: 'PERSONA' },
    { name: 'base', order: 0, text: 'BASE' },
    { name: 'domain', order: 20, text: '' },
    { name: 'task', order: 50, text: 'TASK' },
  ],
  rules: [{ match: { modelPattern: 'deepseek*' }, overrides: { task: 'V4-TASK' }, append: 'V4-NOTES' }],
  seedLayers: [
    { name: 'persona', order: 0, text: '' },
    { name: 'base', order: 0, text: 'BASE' },
    { name: 'domain', order: 20, text: '' },
    { name: 'task', order: 50, text: '' },
  ],
  native: {
    sections: [
      { name: 'harness:identity', text: 'IDENTITY' },
      { name: 'prompt-stack:model-notes', text: '' },
    ],
    contexts: [{ name: 'some-context', text: 'CTX-TEXT' }],
  },
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

test('加载后展示固定层栈：原生只读行 + 四个可编辑层 + model-notes 只读行', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  expect(await screen.findByText('harness:identity')).toBeTruthy()
  // 层名同时出现在行按钮与编辑器静态值里：行断言限定在按钮内
  for (const name of ['persona', 'base', 'domain', 'task']) {
    expect(screen.getByText(name, { selector: 'button > span' })).toBeTruthy()
  }
  expect(screen.getByText('model-notes')).toBeTruthy()
  // 只读行带徽标
  expect(screen.getAllByText('只读')).toHaveLength(2)
  // 默认选中首个可编辑层（persona），编辑器回显其文本
  expect(screen.getByLabelText('层文本')).toHaveProperty('value', 'PERSONA')
})

test('结构固定：无新建/删除/上移/下移入口，层名与 order 只读', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('base')
  for (const name of ['新建层', '删除层', '上移', '下移']) {
    expect(screen.queryByRole('button', { name })).toBeNull()
  }
  expect(screen.queryByLabelText('层名')).toBeNull()
  expect(screen.queryByLabelText('order')).toBeNull()
})

test('编辑层文本并保存 → PUT 全量携带（结构不变，仅文本变化）', async () => {
  const calls = stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('base')

  fireEvent.click(screen.getByText('base', { selector: 'button > span' }))
  fireEvent.change(screen.getByLabelText('层文本'), { target: { value: 'NEW BASE' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/prompt-layers' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).toEqual({
      layers: [
        { name: 'persona', order: 0, text: 'PERSONA' },
        { name: 'base', order: 0, text: 'NEW BASE' },
        { name: 'domain', order: 20, text: '' },
        { name: 'task', order: 50, text: 'TASK' },
      ],
    })
  })
})

test('选中只读行 → 展示只读文本，不出现层文本编辑器', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('base')

  fireEvent.click(screen.getByText('harness:identity'))
  expect(screen.queryByLabelText('层文本')).toBeNull()
  expect(screen.getByLabelText('只读段文本')).toHaveProperty('value', 'IDENTITY')

  fireEvent.click(screen.getByText('model-notes'))
  expect(screen.getByLabelText('只读段文本')).toHaveProperty('value', '')
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

test('动态层只读视图：展开后展示 contexts 快照', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('base')

  fireEvent.click(screen.getByRole('button', { name: '动态层（只读）' }))
  expect(await screen.findByText('some-context')).toBeTruthy()
  expect(screen.getByText('CTX-TEXT')).toBeTruthy()
})
