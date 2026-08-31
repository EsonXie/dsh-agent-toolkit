// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { PromptLayersModal } from './PromptLayersModal.tsx'
import type { PromptLayersPayload } from './api.ts'

const PAYLOAD = {
  layers: [{ name: 'persona', order: 10, text: 'PERSONA' }],
  rules: [{ match: { modelPattern: 'deepseek*' }, overrides: { base: 'V4-BASE' }, append: 'V4-NOTES' }],
  seedLayers: [{ name: 'persona', order: 10, text: '' }],
  native: {
    sections: [
      { name: 'harness:identity', text: 'IDENTITY' },
      { name: 'prompt-stack:model-notes', text: '' },
    ],
    contexts: [{ name: 'some-context', text: 'CTX-TEXT' }],
  },
  modelFallbackText: 'FALLBACK-BASE',
  identityOverride: '',
}

/** 多规则 payload：含 base 覆盖（claude 通配 / moonshotai / 多字段）与 append-only（deepseek 通配）规则。 */
const RULES_PAYLOAD = {
  ...PAYLOAD,
  rules: [
    { match: { modelPattern: 'claude*' }, overrides: { base: 'CLAUDE-BASE' } },
    { match: { provider: 'moonshotai' }, overrides: { base: 'KIMI-BASE' } },
    { match: { provider: 'p', model: 'm', modelPattern: 'x*' }, overrides: { base: 'MULTI-BASE' } },
    { match: { modelPattern: 'deepseek*' }, append: 'V4-NOTES' },
  ],
}

function stubFetch(getPayload: PromptLayersPayload = PAYLOAD) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    if (url === '/dsh-agent-toolkit/api/prompt-layers' && method === 'GET') {
      return new Response(JSON.stringify(getPayload), { status: 200, headers: { 'content-type': 'application/json' } })
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

test('加载后展示层栈：identity 可覆盖行 + 模型层只读行 + persona 可编辑 + model-notes 只读行', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  expect(await screen.findByText('harness:identity')).toBeTruthy()
  expect(screen.getByText('模型层', { selector: 'button > span' })).toBeTruthy()
  // 并发运行下同行渲染可能晚一拍：persona 用异步查询兜底（既有 flaky race）
  expect(await screen.findByText('persona', { selector: 'button > span' })).toBeTruthy()
  expect(screen.getByText('model-notes')).toBeTruthy()
  // 两个只读徽标（模型层 / model-notes）；identity 可覆盖，不再带徽标
  expect(screen.getAllByText('只读')).toHaveLength(2)
  expect(screen.getByText('原生身份段 · 可覆盖')).toBeTruthy()
  // 无 base/domain/task 可编辑行
  for (const name of ['base', 'domain', 'task']) {
    expect(screen.queryByText(name, { selector: 'button > span' })).toBeNull()
  }
  // 默认选中 persona，编辑器回显其文本
  expect(screen.getByLabelText('层文本')).toHaveProperty('value', 'PERSONA')
})

test('结构固定：无新建/删除/上移/下移入口，编辑区不展示层名/order（仅层文本可编辑）', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })
  for (const name of ['新建层', '删除层', '上移', '下移']) {
    expect(screen.queryByRole('button', { name })).toBeNull()
  }
  expect(screen.queryByText('层名')).toBeNull()
  // 列表行里是 "order 10"，编辑区的独立 "order" 字段已删除
  expect(screen.queryByText('order')).toBeNull()
})

test('编辑 persona 文本并保存 → PUT 全量携带（单层结构不变）', async () => {
  const calls = stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.change(screen.getByLabelText('层文本'), { target: { value: 'NEW PERSONA' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/prompt-layers' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).toEqual({ layers: [{ name: 'persona', order: 10, text: 'NEW PERSONA' }], identityOverride: '' })
  })
})

test('选中 identity 行 → 编辑覆盖文本并保存 → PUT 携带 identityOverride（空 = 还原原生）', async () => {
  const calls = stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.click(screen.getByText('harness:identity'))
  const textarea = screen.getByLabelText('身份段覆盖文本')
  // 空覆盖时 placeholder 展示原生句
  expect(textarea).toHaveProperty('placeholder', 'IDENTITY')
  expect(textarea).toHaveProperty('value', '')

  fireEvent.change(textarea, { target: { value: 'MY-IDENTITY' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/prompt-layers' && c.method === 'PUT')
    expect(put?.body).toEqual({ layers: [{ name: 'persona', order: 10, text: 'PERSONA' }], identityOverride: 'MY-IDENTITY' })
  })
})

test('加载回显：identity 覆盖文本非空时回显到「身份段覆盖文本」', async () => {
  stubFetch({ ...PAYLOAD, identityOverride: 'SAVED-IDENTITY' })
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.click(screen.getByText('harness:identity'))
  expect(screen.getByLabelText('身份段覆盖文本')).toHaveProperty('value', 'SAVED-IDENTITY')
})

test('选中 model-notes 只读行 → 展示只读文本，不出现层文本编辑器', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.click(screen.getByText('model-notes'))
  expect(screen.queryByLabelText('层文本')).toBeNull()
  expect(screen.getByLabelText('只读段文本')).toHaveProperty('value', '')
})

test('选中模型层只读行 → 展示其兜底文本，不出现层文本编辑器', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.click(screen.getByText('模型层', { selector: 'button > span' }))
  expect(screen.queryByLabelText('层文本')).toBeNull()
  expect(screen.getByLabelText('只读段文本')).toHaveProperty('value', 'FALLBACK-BASE')
})

test('模型层：tab 数 = 内置默认 + 含 base 规则匹配条件，默认选中内置默认', async () => {
  stubFetch(RULES_PAYLOAD)
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.click(screen.getByText('模型层', { selector: 'button > span' }))
  expect(screen.getByRole('tab', { name: '内置默认' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tab', { name: 'claude*' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: 'provider: moonshotai' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: 'provider: p + model: m + x*' })).toBeTruthy()
  // append-only 规则不进模型层 tab
  expect(screen.queryByRole('tab', { name: 'deepseek*' })).toBeNull()
  expect(screen.getByLabelText('只读段文本')).toHaveProperty('value', 'FALLBACK-BASE')
})

test('模型层：点击规则 tab → 只读框显示该规则 overrides.base', async () => {
  stubFetch(RULES_PAYLOAD)
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.click(screen.getByText('模型层', { selector: 'button > span' }))
  fireEvent.click(screen.getByRole('tab', { name: 'claude*' }))
  const textarea = screen.getByLabelText('只读段文本')
  expect(textarea).toHaveProperty('value', 'CLAUDE-BASE')
  expect(textarea).toHaveProperty('readOnly', true)
  fireEvent.click(screen.getByRole('tab', { name: 'provider: moonshotai' }))
  expect(textarea).toHaveProperty('value', 'KIMI-BASE')
})

test('模型层：切到其他层再切回 → tab 复位到内置默认', async () => {
  stubFetch(RULES_PAYLOAD)
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona', { selector: 'button > span' })

  fireEvent.click(screen.getByText('模型层', { selector: 'button > span' }))
  fireEvent.click(screen.getByRole('tab', { name: 'claude*' }))
  fireEvent.click(screen.getByText('persona', { selector: 'button > span' }))
  fireEvent.click(screen.getByText('模型层', { selector: 'button > span' }))
  expect(screen.getByRole('tab', { name: '内置默认' }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByLabelText('只读段文本')).toHaveProperty('value', 'FALLBACK-BASE')
})
