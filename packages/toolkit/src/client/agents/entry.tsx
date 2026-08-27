/** agents 侧边栏底栏入口：createSidebarEntry 工厂产物（宽栏窄栏统一仅图标 + Tooltip），点击打开 Agent 管理模态框。 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 触发 ui-sidebar 对 SlotMap 的声明合并（sidebar.footer.action 键与 owner props）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSidebarEntry } from '../shared/entry.tsx'
import { AgentsModal } from './AgentsModal.tsx'

const SidebarEntry = createSidebarEntry({
  id: 'dsh-agent-toolkit:agents',
  order: -1,
  icon: <IconUserOutline16 size={18} />,
  title: 'Agent 管理',
  renderModal: (p) => <AgentsModal {...p} />,
})

/** 槽注册要求完整 composed props（含运行时 share useSessions/useWorkspaces）；实现只消费 wide。 */
export function AgentsEntry(props: PropsRuntime<'sidebar.footer.action'>): ReactNode {
  return <SidebarEntry wide={props.wide} />
}
