// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
// 类型增强：ui-sidebar/client 传递引入 ui-layout/client 对 GlobalStandardProps 的声明合并
// （usePanelInfo 等全局座位）。本 spec 构造宿主完整 slot props，需自行引入，不再依赖 usage 包传递。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DelegateCard } from './delegate-card.tsx'
import { zh } from './locales.ts'

afterEach(cleanup)

const runningBlock = {
  callId: 'c1',
  name: 'team_delegate',
  argsRaw: JSON.stringify({ role: 'explorer', description: '定位登录入口', prompt: '请找出登录页组件' }),
  turn: 1, step: 1, time: 0, callView: null, subCalls: [],
} as unknown as StartedToolCall

const settledBlock = {
  kind: 'tool-result',
  seq: 2, time: 1, callId: 'c1',
  call: { name: 'team_delegate', argsRaw: runningBlock.argsRaw },
  callTime: 0,
  content: [{ type: 'text', text: '登录页在 src/pages/login.tsx' }],
  isError: false,
  meta: { role: 'explorer', runId: 'child-1', childSessionId: 'child-1' },
  callView: null, resultView: null, subCalls: [],
} as unknown as ToolResultNode

function renderCard(phase: 'start' | 'result', block: StartedToolCall | ToolResultNode, openChild: (address: SubagentAddress) => void = () => {}) {
  return render(
    <DelegateCard
      callId="c1"
      toolName="team_delegate"
      // 0.1.7 起 phase 与 block 是关联判别对，独立传两个联合无法直接赋值；按 phase 派生关联对象展开（宿主 spec 先例）。
      {...(phase === 'result' ? { phase: 'result' as const, block: block as ToolResultNode } : { phase: 'start' as const, block: block as StartedToolCall })}
      openFile={() => {}}
      // 0.1.5 起 ToolCallOwnerProps 新增必填 loadImage（tool.call.images 槽的会话授权图加载器）；本卡不渲染图。
      loadImage={(() => { throw new Error('unused') }) as never}
      // 0.1.7 起 ToolCallCommonProps 新增必填 useDisclosure（宿主展开态钩子）；本卡自持 expanded 局部态，不消费，桩掉。
      useDisclosure={(() => ({ open: false, toggle: () => {} })) as never}
      // 0.1.7 起 tool.call.toolview 注入 hooks 新增 useToolCallArgumentsPartial（preparing 阶段原始参数前缀订阅）；
      // 本卡 preparing 阶段不取参数，桩掉。
      useToolCallArgumentsPartial={(() => '') as never}
      sessionId={'parent-1' as SessionId}
      useSession={(() => undefined) as never}
      useSessions={(() => undefined) as never}
      useProjection={(() => undefined) as never}
      useWorkspaces={(() => undefined) as never}
      // subagent-model 模块的 `import type {}` from ui-conversation 触发全局
      // SessionStandardProps 声明合并，使这两项在会话作用域 slot props 上必填；
      // 纯类型效应、无运行时影响，故用 as never 桩掉。
      useInput={(() => undefined) as never}
      inputActions={(() => undefined) as never}
      // 0.1.5 起 SessionStandardProps 新增的会话座位；本卡不消费，桩掉。
      useConversation={(() => undefined) as never}
      useChat={(() => undefined) as never}
      // 0.1.7 起 GlobalStandardProps 新增 useSessionStatus/useSessionRetainInfo（ui-session 合并），
      // 并删除 useSessionPendingInteraction 座位（pendingInteraction 移交 composer chain owner 数据），对应桩移除。
      useSessionStatus={(() => undefined) as never}
      useSessionRetainInfo={(() => undefined) as never}
      usePanelInfo={(() => undefined) as never}
      openChild={openChild}
      t={((key: keyof typeof zh) => zh[key]) as never}
    />,
  )
}

test('运行中：角色 chip + 任务描述 + running 隐藏文本，无结果区', () => {
  renderCard('start', runningBlock)
  expect(screen.getByText('explorer')).toBeTruthy()
  expect(screen.getByText('定位登录入口')).toBeTruthy()
  expect(screen.queryByText('查看子对话')).toBeNull()
})

test('整行 toggle：点击展开后可见任务书全文', () => {
  renderCard('start', runningBlock)
  expect(screen.queryByText('请找出登录页组件')).toBeNull()
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  expect(screen.getByText('请找出登录页组件')).toBeTruthy()
})

test('完成后：结果文本渲染 + 「查看子对话」按钮回调 openChild 携带父子会话坐标', () => {
  const opened: unknown[] = []
  renderCard('result', settledBlock, (address) => opened.push(address))
  expect(screen.getByText('登录页在 src/pages/login.tsx')).toBeTruthy()
  fireEvent.click(screen.getByText('查看子对话'))
  expect(opened).toEqual([{ parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'one-shot' }])
})

test('失败态：meta 缺 childSessionId 时不显示跳转按钮，显示错误内容', () => {
  const failed = { ...settledBlock, isError: true, meta: undefined,
    content: [{ type: 'text', text: '成员运行被取消' }] } as unknown as ToolResultNode
  renderCard('result', failed)
  expect(screen.getByText('成员运行被取消')).toBeTruthy()
  expect(screen.queryByText('查看子对话')).toBeNull()
})
