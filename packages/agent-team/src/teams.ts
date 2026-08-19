/** 团队状态机：当前团队 ref、trySelect、blank 锁定——全部纯逻辑，不含 ctx 接线。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Team } from './roles.ts'
import type { TeamOption } from './types.ts'

/**
 * 会话是否仍处于 blank 期（可切团队的唯一时间窗）。
 * 定义照抄宿主 sessionBlank（api-proxy.ts:476-478）：无 turn/start 事件。
 */
export function isSessionBlank(events: readonly SessionEvent[]): boolean {
  return !events.some(event => event.type === 'turn/start')
}

/** 团队的状态视图选项：摘要取首角色 description，空名册回退 id。 */
export function teamOption(team: Team): TeamOption {
  return { id: team.id, summary: team.roles[0]?.description ?? team.id }
}

/** trySelect 的结果。 */
export type SelectOutcome =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly error: string }

/** 团队状态：当前团队 + 切换入口。 */
export interface TeamState {
  readonly current: Team
  readonly teams: readonly Team[]
  /**
   * 尝试切换团队。
   * @param id - 目标团队 id。
   * @param events - 当前会话事件（blank 判定用）。
   */
  trySelect(id: string, events: readonly SessionEvent[]): SelectOutcome
}

/**
 * 创建团队状态机。
 * @param options.teams - 激活时加载的全部团队（非空，loadTeams 保证）。
 * @param options.defaultTeamId - Config.defaultTeam（激活期已校验命中）。
 * @param options.initialId - KV 冷恢复结果（按 sessionId 读回）。
 */
export function createTeamState(options: {
  teams: readonly Team[]
  defaultTeamId?: string
  initialId?: string
}): TeamState {
  const { teams } = options
  const byId = new Map(teams.map(t => [t.id, t]))
  const pick = (id: string | undefined): string | undefined =>
    id !== undefined && byId.has(id) ? id : undefined
  let currentId = pick(options.initialId) ?? pick(options.defaultTeamId) ?? teams[0].id
  return {
    teams,
    get current() { return byId.get(currentId)! },
    trySelect(id, events) {
      if (!byId.has(id)) {
        return { ok: false, error: `未知团队 "${id}"。可用团队：${teams.map(t => t.id).join(', ')}` }
      }
      if (!isSessionBlank(events)) {
        return { ok: false, error: '会话已开始，团队已锁定' }
      }
      const changed = id !== currentId
      currentId = id
      return { ok: true, changed }
    },
  }
}
