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
})
