/** 分层提示词侧边栏底栏入口：createSidebarEntry 工厂产物，点击打开管理模态框。 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconListPenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSidebarEntry } from '../shared/entry.tsx'
import { PromptLayersModal } from './PromptLayersModal.tsx'

const SidebarEntry = createSidebarEntry({
  id: 'dsh-agent-toolkit:prompt-layers',
  order: 0,
  icon: <IconListPenOutline16 size={18} />,
  title: '分层提示词',
  renderModal: (p) => <PromptLayersModal {...p} />,
})

export function PromptLayersEntry(props: PropsRuntime<'sidebar.footer.action'>): ReactNode {
  return <SidebarEntry wide={props.wide} />
}
