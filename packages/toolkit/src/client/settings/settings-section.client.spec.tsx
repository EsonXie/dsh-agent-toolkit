// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, test, vi } from 'vitest'
import { ToolkitSection } from './ToolkitSection.tsx'
import { setupSettingsClient } from './index.ts'
import { zh } from './locales.ts'
import { zh as scheduleZh } from '../schedule/locales.ts'

const AGENTS = [
  { id: 'main', name: '主 Agent', builtin: true, createdAt: 0 },
  { id: 'aaa', name: 'AAA', createdAt: 1 },
]

const TASK = {
  id: 'task-1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
  schedule: { kind: 'cron', expr: '0 9 * * *' },
  target: { kind: 'main' }, catchup: true, enabled: true,
  nextRunAt: null,
  createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
}

/** stubFetch：按前缀命中；覆盖三页所需路由。 */
function stubFetch(overrides: Record<string, () => unknown> = {}) {
  const routes: Record<string, () => unknown> = {
    '/dsh-agent-toolkit/api/agents': () => AGENTS,
    '/dsh-agent-toolkit/api/bots/bots': () => ({ bots: [] }),
    '/dsh-agent-toolkit/api/tools': () => ({ preset: [], global: [] }),
    '/dsh-agent-toolkit/api/providers': () => [],
    '/dsh-agent-toolkit/api/cron/tasks': () => ({ tasks: [TASK] }),
    '/dsh-agent-toolkit/api/prompt-layers': () => ({
      layers: [{ name: 'persona', order: 10, text: '' }],
      rules: [], seedLayers: [{ name: 'persona', order: 10, text: '' }],
      native: { sections: [], contexts: [] }, modelFallbackText: '', identityOverride: '',
    }),
    ...overrides,
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const handler = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1]
    if (handler === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(handler()), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** 桩 t：agent-toolkit 词典（无插值键断言用）。 */
function t(key: string): string { return (zh as Record<string, string>)[key] ?? key }

/** 桩 tSchedule：agent-schedule 词典 + {param} 插值。 */
function tSchedule(key: string, params?: Record<string, unknown>): string {
  let text = (scheduleZh as Record<string, string>)[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v))
  return text
}

const useWorkspaces = <S,>(selector: (s: { items: readonly unknown[] }) => S): S => selector({ items: [] })

function renderSection() {
  const openSession = vi.fn()
  const props = { t, useWorkspaces, openSession, tSchedule } as unknown as Parameters<typeof ToolkitSection>[0]
  render(<ToolkitSection {...props} />)
  return { openSession }
}

test('tab 切换：默认 Agents 卡片，切到 Schedule 见任务列表，切到 Prompt 见四层卡', async () => {
  stubFetch()
  renderSection()

  // 默认 Agents：见 Agent 卡片
  expect(await screen.findByText('AAA')).toBeTruthy()

  fireEvent.click(screen.getByRole('tab', { name: zh['tab.schedule'] }))
  expect(await screen.findByText('日报')).toBeTruthy()

  fireEvent.click(screen.getByRole('tab', { name: zh['tab.prompt'] }))
  expect(await screen.findByText(zh['prompt.card.identity'])).toBeTruthy()
})

test('tab 样式：激活项同时带基础类与激活类，非激活项仅基础类（回归保护）', async () => {
  stubFetch()
  renderSection()
  await screen.findByText('AAA')

  // 回归：激活 tab 曾只挂激活类、丢基础类，渲染成浏览器默认按钮。激活态须保留基础类。
  const active = screen.getByRole('tab', { name: zh['tab.agents'] })
  expect(active.getAttribute('aria-selected')).toBe('true')
  expect(active.className.split(/\s+/)).toContain('tab')
  expect(active.className.split(/\s+/)).toContain('tabActive')

  const inactive = screen.getByRole('tab', { name: zh['tab.schedule'] })
  expect(inactive.getAttribute('aria-selected')).toBe('false')
  expect(inactive.className.split(/\s+/)).toContain('tab')
  expect(inactive.className.split(/\s+/)).not.toContain('tabActive')
})

test('setupSettingsClient：注册 settings.section（id agent-toolkit, order 25），label thunk 本地化', () => {
  const registered: Array<{ options: Record<string, unknown>; component: unknown }> = []
  const localeRegistered: Array<{ ns: string; dicts: Record<string, unknown> }> = []
  const opened: string[] = []
  const ctx = {
    effect: (fn: () => unknown) => { const d = fn(); return () => { if (typeof d === 'function') (d as () => unknown)() } },
    locale: {
      register: (ns: string, dicts: Record<string, unknown>) => { localeRegistered.push({ ns, dicts }); return () => {} },
      bind: (ns: string) => (key: string) => (ns === 'agent-toolkit' ? t(key) : tSchedule(key)),
    },
    sessions: { open: (id: string) => { opened.push(id) } },
    slots: {
      inject: (_key: string, callback: () => unknown) => { callback(); return () => {} },
      register: (options: Record<string, unknown>, component: unknown) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  setupSettingsClient(ctx as unknown as Context)

  // 两个词典都注册（agent-toolkit + 补回的 agent-schedule）
  expect(localeRegistered.map((r) => r.ns)).toEqual(['agent-toolkit', 'agent-schedule'])

  const section = registered.find((r) => r.options.id === 'agent-toolkit')
  expect(section).toBeTruthy()
  expect(section?.options.name).toBe('settings.section')
  expect(section?.options.order).toBe(25)
  const label = section?.options.label as () => string
  expect(label()).toBe('Agent 工具箱')

  // inject 面下发 openSession（包装 ctx.sessions.open）与 tSchedule
  const inject = (section?.options.inject as () => { openSession: (id: string) => void; tSchedule: (k: string) => string })()
  inject.openSession('sess-1')
  expect(opened).toEqual(['sess-1'])
  expect(inject.tSchedule('list.loading')).toBe(scheduleZh['list.loading'])
})
