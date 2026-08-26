/** bots 侧边栏底栏入口：createSidebarEntry 工厂产物（宽栏图标+文字 / 窄栏仅图标），点击打开机器人管理模态框。 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 触发 ui-sidebar 对 SlotMap 的声明合并（sidebar.footer.action 键与 owner props）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconAgentPresetOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSidebarEntry } from '../shared/entry.tsx'
import { BotsModal, type UseWorkspaces } from './BotsModal.tsx'

/** 入口需透传给模态框的运行时 share（useWorkspaces），经工厂 Extra 透传。 */
type BotsExtra = { useWorkspaces: UseWorkspaces }

const SidebarEntry = createSidebarEntry<BotsExtra>({
  id: 'dsh-agent-toolkit:bots',
  order: 1,
  icon: <IconAgentPresetOutline16 size={18} />,
  title: '消息机器人',
  renderModal: (p) => <BotsModal {...p} />,
})

/** 槽注册要求完整 composed props（含运行时 share useSessions/useWorkspaces）；实现只消费 wide + useWorkspaces。 */
export function BotsEntry(props: PropsRuntime<'sidebar.footer.action'>): ReactNode {
  return <SidebarEntry wide={props.wide} useWorkspaces={props.useWorkspaces} />
}
