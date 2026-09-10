/** dsh-agent-toolkit schedule 浏览器半：注册侧边栏底栏入口 + 文案词典。 */
import type { Context } from '@deepseek-ai/cordis'
import { createElement } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// 触发 dsh-client-locale 对 Context.locale 的声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 触发 ui-sidebar 对 SlotMap 的声明合并（sidebar.footer.action 键）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// 触发 ui-renderer 对 Context.slots 的声明合并（0.1.5 起由 client-runtime 迁入）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ScheduleEntry } from './entry.tsx'
import { TaskForm } from './TaskForm.tsx'
import { en, NS, zh, type ScheduleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 定时任务面板文案。 */
    'agent-schedule': ScheduleKey
  }
}

export function setupScheduleClient(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agent-toolkit: schedule dictionaries')
  // dsh-session (Node half's JsonValue type source) declares the same-named
  // Context.sessions, shadowing the client ISessions type — restore the face
  // the runtime actually serves（delegate/index.ts 同款注释与强转）。
  const sessions = ctx.sessions as unknown as ISessions
  const openSession = (sessionId: string): void => { sessions.open(sessionId as SessionId) }
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'dsh-agent-toolkit:schedule', order: 2, locale: NS },
      (props) => ScheduleEntry({
        ...props,
        openSession,
        renderForm: (draft, onSaved, onCancel) =>
          createElement(TaskForm, { draft, t: props.t, onSaved, onCancel }),
      }),
    ))
}
