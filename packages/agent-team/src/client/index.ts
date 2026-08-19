/** agent-team 浏览器半：在 conversation.input.dock 注册团队选择下拉（数据走插件 HTTP 端点）。 */
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// 触发 ui-conversation 对 SlotMap 的声明合并（conversation.input.dock 键）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TeamDock } from './TeamDock.tsx'
import type { SelectTeamRequest, TeamStateView } from '../types.ts'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  // inject() 等 ui-conversation 声明该槽位后再注册，声明消失自动回滚。
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'team',
        order: -10, // 现有 occupant：todo=0、goal=10、queue=20；负值栈顶
        inject: (sessionId: SessionId) => {
          const base = `/agent-team/${encodeURIComponent(String(sessionId))}`
          return {
            fetchState: async (): Promise<TeamStateView | null> => {
              const res = await fetch(`${base}/state`)
              if (res.status === 404) return null // 非团队会话：插件未挂载，路由不存在
              if (!res.ok) throw new Error(`agent-team state: HTTP ${res.status}`)
              return await res.json() as TeamStateView
            },
            selectTeam: async (team: string): Promise<TeamStateView> => {
              const res = await fetch(`${base}/select`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ team } satisfies SelectTeamRequest),
              })
              const body = await res.json() as TeamStateView & { error?: string }
              if (!res.ok) throw new Error(body.error ?? `agent-team select: HTTP ${res.status}`)
              return body
            },
          }
        },
      },
      TeamDock,
    ))
}
