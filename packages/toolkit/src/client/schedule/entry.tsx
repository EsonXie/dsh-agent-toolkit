/** 定时任务侧边栏底栏入口：createSidebarEntry 工厂产物（order 紧随 bots=1），点击打开任务管理模态框。 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 触发 ui-sidebar 对 SlotMap 的声明合并（sidebar.footer.action 键与 owner props）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { createSidebarEntry } from '../shared/entry.tsx'
import { ScheduleModal } from './ScheduleModal.tsx'
import type { NS } from './locales.ts'
import type { ScheduleTaskDraft } from './TaskForm.tsx'

/** 时钟图标（ui-primitives 无现成时钟图标，内联 16px outline SVG）。 */
const IconClock = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" />
    <path d="M8 4.5V8L10.5 9.5" stroke="currentColor" strokeLinecap="round" />
  </svg>
)

/** 入口需透传给模态框的运行时注入：openSession（宿主 sessions 服务包装）+ t（slot locale 声明注入）+ renderForm（Task 12）。 */
type ScheduleExtra = {
  openSession: (sessionId: string) => void
  renderForm?: ScheduleModalRenderForm
}

type ScheduleModalRenderForm = NonNullable<Parameters<typeof ScheduleModal>[0]['renderForm']>

const SidebarEntry = createSidebarEntry<ScheduleExtra & { t: PropsLocale<typeof NS>['t'] }>({
  id: 'dsh-agent-toolkit:schedule',
  order: 2,
  icon: IconClock,
  title: '定时任务',
  renderModal: (p) => <ScheduleModal {...p} />,
})

export function ScheduleEntry(props: PropsRuntime<'sidebar.footer.action'> & PropsLocale<typeof NS> & ScheduleExtra): ReactNode {
  return <SidebarEntry wide={props.wide} t={props.t} openSession={props.openSession} renderForm={props.renderForm} />
}
