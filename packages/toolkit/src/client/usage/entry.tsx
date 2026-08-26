/** usage 侧边栏底栏入口：createSidebarEntry 工厂产物（宽栏图标+文字 / 窄栏仅图标），点击打开 Token 用量模态框。 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 触发 ui-sidebar 对 SlotMap 的声明合并（sidebar.footer.action 键与 owner props）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSidebarEntry } from '../shared/entry.tsx'
import { UsageModal } from './UsageModal.tsx'

const SidebarEntry = createSidebarEntry({
  id: 'dsh-agent-toolkit:usage',
  order: 0,
  icon: <IconDataOutline16 size={18} />,
  title: 'Token 用量',
  renderModal: (p) => <UsageModal {...p} />,
})

/** 槽注册要求完整 composed props（含运行时 share useSessions/useWorkspaces）；实现只消费 wide。 */
export function UsageEntry(props: PropsRuntime<'sidebar.footer.action'>): ReactNode {
  return <SidebarEntry wide={props.wide} />
}
