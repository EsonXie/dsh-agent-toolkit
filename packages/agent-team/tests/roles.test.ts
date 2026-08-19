import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadTeams, parseRolesYaml } from '../src/roles.ts'

const VALID = `
roles:
  - name: reviewer
    description: 代码审查员
    persona: 你是资深代码审查员。
    provider: deepseek
    model: deepseek-reasoner
  - name: researcher
    description: 资料调研
    persona: 你是调研分析员。
`

test('解析合法名册', () => {
  const roles = parseRolesYaml(VALID, 'test.yml')
  expect(roles).toHaveLength(2)
  expect(roles[0]).toMatchObject({ name: 'reviewer', provider: 'deepseek', model: 'deepseek-reasoner' })
  expect(roles[1].provider).toBeUndefined()
  expect(roles[1].model).toBeUndefined()
})

test('缺 persona 报错并指出角色名', () => {
  const bad = `roles:\n  - name: reviewer\n    description: x\n`
  expect(() => parseRolesYaml(bad, 'r.yml')).toThrowError(/persona/)
})

test('重名角色报错', () => {
  const bad = `roles:\n  - { name: a, description: x, persona: p }\n  - { name: a, description: y, persona: q }\n`
  expect(() => parseRolesYaml(bad, 'r.yml')).toThrowError(/重复/)
})

test('非法 name 字符报错', () => {
  const bad = `roles:\n  - { name: "坏 名", description: x, persona: p }\n`
  expect(() => parseRolesYaml(bad, 'r.yml')).toThrowError(/name/)
})

test('顶层缺 roles 键报错', () => {
  expect(() => parseRolesYaml(`foo: 1`, 'r.yml')).toThrowError(/roles/)
})

test('非法 YAML 报错含来源', () => {
  expect(() => parseRolesYaml(`roles: [unclosed`, 'bad/roles.yml')).toThrowError(/bad\/roles\.yml/)
})

describe('loadTeams', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'agent-team-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  test('读取目录全部 yml，按文件名字典序返回，id 为文件名去后缀', async () => {
    await writeFile(join(dir, 'beta.yml'), VALID)
    await writeFile(join(dir, 'alpha.yml'), VALID)
    await writeFile(join(dir, 'notes.txt'), 'ignored')
    const teams = await loadTeams(dir)
    expect(teams.map(t => t.id)).toEqual(['alpha', 'beta'])
    expect(teams[0].roles.map(r => r.name)).toEqual(['reviewer', 'researcher'])
  })

  test('目录不存在时报错含路径', async () => {
    await expect(loadTeams(join(dir, 'nope'))).rejects.toThrowError(/nope/)
  })

  test('目录内无 yml 文件时报错', async () => {
    await writeFile(join(dir, 'readme.md'), 'x')
    await expect(loadTeams(dir)).rejects.toThrowError(/没有.*\.yml|名册/)
  })

  test('团队 id 非法字符报错含文件名', async () => {
    await writeFile(join(dir, '坏 名.yml'), VALID)
    await expect(loadTeams(dir)).rejects.toThrowError(/坏 名\.yml/)
  })

  test.skipIf(process.platform === 'win32')('团队 id 大小写归一重名报错', async () => {
    await writeFile(join(dir, 'Dev.yml'), VALID)
    await writeFile(join(dir, 'dev.yml'), VALID)
    await expect(loadTeams(dir)).rejects.toThrowError(/重复/)
  })

  test('任一名册内容非法时报错含该文件路径', async () => {
    await writeFile(join(dir, 'ok.yml'), VALID)
    await writeFile(join(dir, 'bad.yml'), `roles:\n  - name: x\n    description: y\n`)
    await expect(loadTeams(dir)).rejects.toThrowError(/bad\.yml/)
  })
})
