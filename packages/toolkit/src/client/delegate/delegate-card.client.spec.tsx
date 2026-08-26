// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { SubagentAddress, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { DelegateCard } from './delegate-card.tsx'
import { zh } from './locales.ts'

afterEach(cleanup)

type RunningFixture = ToolCallBlock & { argsRaw: string }

const runningBlock = {
  callId: 'c1',
  name: 'team_delegate',
  argsRaw: JSON.stringify({ role: 'explorer', description: '定位登录入口', prompt: '请找出登录页组件' }),
  turn: 1, step: 1, time: 0, callView: null, subCalls: [],
} as unknown as RunningFixture

const settledBlock = {
  kind: 'tool-result',
  seq: 2, time: 1, callId: 'c1',
  call: { name: 'team_delegate', argsRaw: runningBlock.argsRaw },
  callTime: 0,
  content: [{ type: 'text', text: '登录页在 src/pages/login.tsx' }],
  isError: false,
  meta: { role: 'explorer', runId: 'child-1', childSessionId: 'child-1' },
  callView: null, resultView: null, subCalls: [],
} as unknown as ToolCallBlock

function renderCard(block: ToolCallBlock, openChild: (address: SubagentAddress) => void = () => {}) {
  return render(
    <DelegateCard
      callId="c1"
      toolName="team_delegate"
      block={block}
      openFile={() => {}}
      sessionId="parent-1"
      useSession={(() => undefined) as never}
      useSessions={(() => undefined) as never}
      useProjection={(() => undefined) as never}
      useWorkspaces={(() => undefined) as never}
      openChild={openChild}
      t={((key: keyof typeof zh) => zh[key]) as never}
    />,
  )
}

test('运行中：角色 chip + 任务描述 + running 隐藏文本，无结果区', () => {
  renderCard(runningBlock)
  expect(screen.getByText('explorer')).toBeTruthy()
  expect(screen.getByText('定位登录入口')).toBeTruthy()
  expect(screen.queryByText('查看子对话')).toBeNull()
})

test('整行 toggle：点击展开后可见任务书全文', () => {
  renderCard(runningBlock)
  expect(screen.queryByText('请找出登录页组件')).toBeNull()
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  expect(screen.getByText('请找出登录页组件')).toBeTruthy()
})

test('完成后：结果文本渲染 + 「查看子对话」按钮回调 openChild 携带父子会话坐标', () => {
  const opened: unknown[] = []
  renderCard(settledBlock, (address) => opened.push(address))
  expect(screen.getByText('登录页在 src/pages/login.tsx')).toBeTruthy()
  fireEvent.click(screen.getByText('查看子对话'))
  expect(opened).toEqual([{ parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'one-shot' }])
})

test('失败态：meta 缺 childSessionId 时不显示跳转按钮，显示错误内容', () => {
  const failed = { ...settledBlock, isError: true, meta: undefined,
    content: [{ type: 'text', text: '成员运行被取消' }] } as unknown as ToolCallBlock
  renderCard(failed)
  expect(screen.getByText('成员运行被取消')).toBeTruthy()
  expect(screen.queryByText('查看子对话')).toBeNull()
})
