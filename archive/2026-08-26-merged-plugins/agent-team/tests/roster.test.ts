import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { BUILTIN_ROLES } from '../src/builtin-roles.ts'
import { resolveRoster } from '../src/roster.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'agent-team-roster-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

test('内置名册：explorer（deny write/edit）+ general（不限制），均不配 provider/model', () => {
  const names = BUILTIN_ROLES.map(r => r.name)
  expect(names).toEqual(['explorer', 'general'])
  const explorer = BUILTIN_ROLES[0]
  expect(explorer.tools).toEqual({ deny: ['write', 'edit'] })
  expect(explorer.provider).toBeUndefined()
  expect(explorer.model).toBeUndefined()
  expect(BUILTIN_ROLES[1].tools).toBeUndefined()
  for (const role of BUILTIN_ROLES) {
    expect(role.description.length).toBeGreaterThan(0)
    expect(role.persona.length).toBeGreaterThan(0)
  }
})

test('用户目录不存在：返回内置名册，overridden 为空', async () => {
  const roster = await resolveRoster(join(dir, 'missing'))
  expect(roster.roles.map(r => r.name)).toEqual(['explorer', 'general'])
  expect(roster.overridden).toEqual([])
})

test('用户追加新角色：排在内置之后', async () => {
  await writeFile(join(dir, 'reviewer.yml'), 'description: 代码审查\npersona: 你是审查员。\n')
  const roster = await resolveRoster(dir)
  expect(roster.roles.map(r => r.name)).toEqual(['explorer', 'general', 'reviewer'])
  expect(roster.overridden).toEqual([])
})

test('用户同名覆盖内置：内容替换、位置保持、记入 overridden', async () => {
  await writeFile(join(dir, 'explorer.yml'),
    'description: 定制探索\npersona: 定制。\nmodel: deepseek-reasoner\n')
  const roster = await resolveRoster(dir)
  expect(roster.roles.map(r => r.name)).toEqual(['explorer', 'general'])
  const explorer = roster.roles[0]
  expect(explorer.description).toBe('定制探索')
  expect(explorer.model).toBe('deepseek-reasoner')
  expect(explorer.tools).toBeUndefined()       // 整角色覆盖：内置的 deny 也被替换掉
  expect(roster.overridden).toEqual(['explorer'])
})

test('用户目录含非法文件：激活期响亮抛错', async () => {
  await writeFile(join(dir, 'bad.yml'), 'description: [未闭合')
  await expect(resolveRoster(dir)).rejects.toThrowError(/bad\.yml/)
})
