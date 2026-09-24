/** 设置面板 section 注册：Agent 工具箱（Agents/Schedule/Prompt 三 tab）。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// 触发 ui-workspace 对 Context.uiWorkspace 的声明合并（0.1.7 起会话导航由 view owner 承担）。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ToolkitSection, type ToolkitSectionInjected } from './ToolkitSection.tsx'
import { en, NS, zh } from './locales.ts'
import { en as scheduleEn, NS as SCHEDULE_NS, zh as scheduleZh, type ScheduleKey } from '../schedule/locales.ts'

export function setupSettingsClient(ctx: Context): void {
  // 两个词典各自注册：agent-schedule 的原注册点随 schedule/index.ts 删除丢失，此处补回。
  ctx.effect(() => {
    const offToolkit = ctx.locale.register(NS, { zh, en })
    const offSchedule = ctx.locale.register(SCHEDULE_NS, { zh: scheduleZh, en: scheduleEn })
    return () => { offToolkit(); offSchedule() }
  }, 'dsh-agent-toolkit: settings dictionaries')
  const openSession = (sessionId: string): void => { ctx.uiWorkspace.openSession(sessionId as SessionId) }
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'agent-toolkit',
      order: 25,
      label: () => ctx.locale.bind(NS)('nav'),
      locale: NS,
      inject: (): ToolkitSectionInjected => ({
        openSession,
        tSchedule: ctx.locale.bind(SCHEDULE_NS) as (key: ScheduleKey, params?: Record<string, unknown>) => string,
      }),
    }, ToolkitSection))
}
