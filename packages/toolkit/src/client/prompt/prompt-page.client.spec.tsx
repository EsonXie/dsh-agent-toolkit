// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { PromptPage } from './PromptPage.tsx'
import type { PromptLayersPayload } from './api.ts'
import { zh, type ToolkitKey } from '../settings/locales.ts'

/** t 桩：zh 真源（本页文案无插值）。 */
function t(key: ToolkitKey): string { return zh[key] }

const PAYLOAD: PromptLayersPayload = {
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

function renderPage(): void {
  render(<PromptPage t={t} />)
}

test('无弹窗壳 + 四层卡按 identity/模型层/persona/动态层顺序渲染，只读与可编辑徽标各二', async () => {
  stubFetch()
  renderPage()
  await screen.findByLabelText(zh['prompt.persona.label'])

  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getAllByTestId('prompt-card-title').map((n) => n.textContent)).toEqual([
    zh['prompt.card.identity'], zh['prompt.card.model'], zh['prompt.card.persona'], zh['prompt.card.dynamic'],
  ])
  expect(screen.getAllByText(zh['prompt.badge.readonly'])).toHaveLength(2)
  expect(screen.getAllByText(zh['prompt.badge.editable'])).toHaveLength(2)
})

test('说明区默认展开，点击标题折叠、再点击展开', async () => {
  stubFetch()
  renderPage()
  const toggle = await screen.findByRole('button', { name: zh['prompt.introTitle'] })

  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText(zh['prompt.intro'])).toBeTruthy()

  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText(zh['prompt.intro'])).toBeNull()

  fireEvent.click(toggle)
  expect(screen.getByText(zh['prompt.intro'])).toBeTruthy()
})

test('persona 示例模板一键填入并置 dirty，保存携带新文本', async () => {
  const calls = stubFetch()
  renderPage()
  const textarea = await screen.findByLabelText(zh['prompt.persona.label']) as HTMLTextAreaElement

  fireEvent.click(screen.getByRole('button', { name: zh['prompt.exampleReviewerName'] }))
  expect(textarea.value).toBe(zh['prompt.exampleReviewer'])

  fireEvent.click(screen.getByRole('button', { name: zh['prompt.save'] }))
  await vi.waitFor(() => {
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({
      layers: [{ name: 'persona', order: 10, text: zh['prompt.exampleReviewer'] }],
      identityOverride: '',
    })
  })
})

test('identity 卡：原生文本只读回显；覆盖编辑留空保存 = 空串还原原生', async () => {
  const calls = stubFetch({ ...PAYLOAD, identityOverride: 'SAVED-IDENTITY' })
  renderPage()
  const override = await screen.findByLabelText(zh['prompt.identity.overrideLabel']) as HTMLTextAreaElement

  expect(override.value).toBe('SAVED-IDENTITY')
  expect(screen.getByLabelText(zh['prompt.identity.nativeLabel'])).toHaveProperty('value', 'IDENTITY')
  expect(screen.getByText(zh['prompt.identity.note'])).toBeTruthy()

  fireEvent.change(override, { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: zh['prompt.save'] }))
  await vi.waitFor(() => {
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ layers: [{ name: 'persona', order: 10, text: 'PERSONA' }], identityOverride: '' })
  })
})

test('保存成功 → 顶部 toast 反馈', async () => {
  stubFetch()
  renderPage()
  const textarea = await screen.findByLabelText(zh['prompt.persona.label'])
  fireEvent.change(textarea, { target: { value: 'NEW' } })

  fireEvent.click(screen.getByRole('button', { name: zh['prompt.save'] }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain(zh['feedback.saved'])
})

test('重置两段确认：首点仅变确认态不发请求，再点 POST reset', async () => {
  const calls = stubFetch()
  renderPage()
  await screen.findByLabelText(zh['prompt.persona.label'])

  fireEvent.click(screen.getByRole('button', { name: zh['prompt.reset'] }))
  expect(screen.getByRole('button', { name: zh['prompt.resetConfirm'] })).toBeTruthy()
  expect(calls.some((c) => c.method === 'POST')).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: zh['prompt.resetConfirm'] }))
  await vi.waitFor(() => {
    expect(calls.some((c) => c.method === 'POST' && c.url === '/dsh-agent-toolkit/api/prompt-layers/reset')).toBe(true)
  })
})

test('模型层卡展示兜底文本与命中规则 tab；动态层默认折叠、展开显示 append 只读文本', async () => {
  stubFetch()
  renderPage()
  await screen.findByLabelText(zh['prompt.persona.label'])

  const modelCard = screen.getByTestId('prompt-card-model')
  expect(within(modelCard).getByRole('tab', { name: '内置默认' }).getAttribute('aria-selected')).toBe('true')
  expect((within(modelCard).getByLabelText(zh['prompt.model.textLabel']) as HTMLTextAreaElement).value).toBe('FALLBACK-BASE')

  const dynamicCard = screen.getByTestId('prompt-card-dynamic')
  const toggle = within(dynamicCard).getByRole('button', { name: zh['prompt.dynamic.expand'] })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(within(dynamicCard).queryByLabelText(zh['prompt.dynamic.textLabel'])).toBeNull()

  fireEvent.click(toggle)
  expect(within(dynamicCard).getByRole('tab', { name: 'deepseek*' }).getAttribute('aria-selected')).toBe('true')
  const notes = within(dynamicCard).getByLabelText(zh['prompt.dynamic.textLabel']) as HTMLTextAreaElement
  expect(notes.value).toBe('V4-NOTES')
  expect(notes.readOnly).toBe(true)
})

test('动态层无 append 规则时展开显示空态提示，无 tab 栏', async () => {
  stubFetch({ ...PAYLOAD, rules: [{ match: { modelPattern: 'claude*' }, overrides: { base: 'CLAUDE-BASE' } }] })
  renderPage()
  await screen.findByLabelText(zh['prompt.persona.label'])

  const dynamicCard = screen.getByTestId('prompt-card-dynamic')
  fireEvent.click(within(dynamicCard).getByRole('button', { name: zh['prompt.dynamic.expand'] }))
  expect(within(dynamicCard).queryByRole('tablist')).toBeNull()
  expect(within(dynamicCard).getByText(zh['prompt.dynamic.empty'])).toBeTruthy()
})
