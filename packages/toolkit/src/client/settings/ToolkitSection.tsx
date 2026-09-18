/** 设置面板「Agent 工具箱」section 壳：页内三 tab（Agents / 定时任务 / 分层提示词）。 */
import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AgentsPage } from '../agents/AgentsPage.tsx'
import { SchedulePage } from '../schedule/SchedulePage.tsx'
import { PromptPage } from '../prompt/PromptPage.tsx'
import { NS, type ToolkitKey } from './locales.ts'
import type { ScheduleT } from '../schedule/SchedulePage.tsx'
import css from './settings.module.css'

/** 壳经 inject 面下发给三页的业务回调（openSession 由 ctx.sessions 包装）。 */
export interface ToolkitSectionInjected {
  openSession: (sessionId: string) => void
  tSchedule: ScheduleT
}

type Tab = 'agents' | 'schedule' | 'prompt'
const TAB_KEYS: Record<Tab, ToolkitKey> = { agents: 'tab.agents', schedule: 'tab.schedule', prompt: 'tab.prompt' }

type Props = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & InjectFace<ToolkitSectionInjected>

export function ToolkitSection(props: Props): ReactNode {
  const { t, useWorkspaces, openSession, tSchedule } = props
  const [tab, setTab] = useState<Tab>('agents')
  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <div className={css.tabs} role="tablist">
        {(['agents', 'schedule', 'prompt'] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id}
            className={tab === id ? css.tabActive : css.tab}
            onClick={() => { setTab(id) }}>
            {t(TAB_KEYS[id])}
          </button>
        ))}
      </div>
      {tab === 'agents' && <AgentsPage t={t} useWorkspaces={useWorkspaces} />}
      {tab === 'schedule' && <SchedulePage t={tSchedule} openSession={openSession} />}
      {tab === 'prompt' && <PromptPage t={t} />}
    </div>
  )
}
