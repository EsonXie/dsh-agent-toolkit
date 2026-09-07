import { describe, expect, test } from 'vitest'
import { teamSectionText } from './index.ts'

const ROSTER = [
  { id: 'main', name: '主 Agent' },
  { id: 'reviewer', name: 'Reviewer', description: '代码审查员' },
  { id: 'scout', name: 'Scout' },
]

describe('teamSectionText', () => {
  test('工具对当前 scope 不可见：段落为空（渲染时被丢弃）', () => {
    expect(teamSectionText('team_delegate', ROSTER, false)).toBe('')
  })

  test('工具可见：段落含工具名与成员名册（main 排除，description 优先）', () => {
    const text = teamSectionText('team_delegate', ROSTER, true)
    expect(text).toContain('team_delegate')
    expect(text).toContain('reviewer: 代码审查员')
    expect(text).toContain('scout: Scout')
    expect(text).not.toContain('main')
  })

  test('visibleInTeam: false 的成员不进名册；缺省与 true 照常列出', () => {
    const roster = [
      { id: 'main', name: '主 Agent' },
      { id: 'reviewer', name: 'Reviewer', description: '代码审查员' },
      { id: 'hidden', name: 'Hidden', description: '团队不可见', visibleInTeam: false },
      { id: 'shown', name: 'Shown', visibleInTeam: true },
    ]
    const text = teamSectionText('team_delegate', roster, true)
    expect(text).toContain('reviewer: 代码审查员')
    expect(text).toContain('shown: Shown')
    expect(text).not.toContain('hidden')
  })
})
