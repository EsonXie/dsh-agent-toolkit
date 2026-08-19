import { expect, test } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createTeamState, foldSelectedTeam, isSessionBlank, teamOption } from '../src/teams.ts'
import { TEAM_SELECTED_EVENT } from '../src/types.ts'
import type { Team } from '../src/roles.ts'

const teams: Team[] = [
  { id: 'alpha', roles: [{ name: 'reviewer', description: '代码审查员', persona: 'p' }] },
  { id: 'beta', roles: [{ name: 'researcher', description: '资料调研', persona: 'q' }] },
]

const ev = (type: string, data: unknown = {}) => ({ type, data }) as SessionEvent

test('foldSelectedTeam 取最新 team/selected，无事件返回 undefined', () => {
  expect(foldSelectedTeam([])).toBeUndefined()
  expect(foldSelectedTeam([ev('user/message'), ev(TEAM_SELECTED_EVENT, { team: 'alpha' })])).toBe('alpha')
  expect(foldSelectedTeam([
    ev(TEAM_SELECTED_EVENT, { team: 'alpha' }),
    ev(TEAM_SELECTED_EVENT, { team: 'beta' }),
  ])).toBe('beta')
})

test('isSessionBlank：无 turn/start 为 true，有则为 false', () => {
  expect(isSessionBlank([])).toBe(true)
  expect(isSessionBlank([ev('agent-preset/selected')])).toBe(true)
  expect(isSessionBlank([ev('turn/start')])).toBe(false)
})

test('teamOption 摘要取首角色 description', () => {
  expect(teamOption(teams[0])).toEqual({ id: 'alpha', summary: '代码审查员' })
  expect(teamOption({ id: 'empty', roles: [] })).toEqual({ id: 'empty', summary: 'empty' })
})

test('默认团队：initialId 优先，其次 defaultTeamId，再次字典序首个', () => {
  expect(createTeamState({ teams }).current.id).toBe('alpha')
  expect(createTeamState({ teams, defaultTeamId: 'beta' }).current.id).toBe('beta')
  expect(createTeamState({ teams, defaultTeamId: 'beta', initialId: 'alpha' }).current.id).toBe('alpha')
  // initialId/defaultTeamId 未命中名册时回退首个（激活期已对 defaultTeam 单独响亮失败，此处是防御）
  expect(createTeamState({ teams, defaultTeamId: 'ghost', initialId: 'ghost' }).current.id).toBe('alpha')
})

test('trySelect 成功：切换并报告 changed', () => {
  const state = createTeamState({ teams })
  expect(state.trySelect('beta', [])).toEqual({ ok: true, changed: true })
  expect(state.current.id).toBe('beta')
  expect(state.trySelect('beta', [])).toEqual({ ok: true, changed: false })
})

test('trySelect 未知团队：报错列出可用团队，状态不变', () => {
  const state = createTeamState({ teams })
  const outcome = state.trySelect('ghost', [])
  expect(outcome).toMatchObject({ ok: false })
  expect((outcome as { error: string }).error).toContain('alpha, beta')
  expect(state.current.id).toBe('alpha')
})

test('trySelect 会话已开始：拒绝锁定，状态不变', () => {
  const state = createTeamState({ teams })
  const outcome = state.trySelect('beta', [ev('turn/start')])
  expect(outcome).toMatchObject({ ok: false })
  expect((outcome as { error: string }).error).toContain('锁定')
  expect(state.current.id).toBe('alpha')
})
