import { expect, test } from 'vitest'
import { buildMemberPersona } from '../src/prompt.ts'

const role = { name: 'explorer', description: '探索', persona: '你是探索员。' }

test('A 段含角色名与委派契约（看不到主对话/结果返回/不能再委派）', () => {
  const text = buildMemberPersona(role)
  expect(text).toContain('角色：explorer')
  expect(text).toContain('看不到主对话')
  expect(text).toContain('不能再次委派')
})

test('B 段含 AGENTS.md 与验证守则', () => {
  const text = buildMemberPersona(role)
  expect(text).toContain('AGENTS.md')
  expect(text).toContain('测试、类型检查')
})

test('拼接顺序 A → B → persona，空行分隔；无 C 段模型适配残留', () => {
  const text = buildMemberPersona(role)
  const idxA = text.indexOf('角色：explorer')
  const idxB = text.indexOf('能力使用守则')
  const idxP = text.indexOf('你是探索员。')
  expect(idxA).toBeGreaterThanOrEqual(0)
  expect(idxA).toBeLessThan(idxB)
  expect(idxB).toBeLessThan(idxP)
  expect(text).not.toContain('先结论') // 旧 chat 族模板已删除
})
