import { describe, expect, test } from 'vitest'
import { BotRecordSchema, bindingKey, projectBotDomain, type BotRecord } from '../src/store.ts'

const validBot: BotRecord = {
  id: 'reviewer',
  name: '评审机器人',
  channel: 'feishu',
  feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
  project: 'D:\\work\\demo',
  persona: '你是评审助手',
  tools: ['bash', 'fs_read'],
  agentOptions: { provider: 'deepseek', model: 'deepseek-v4' },
  createdAt: 1,
  updatedAt: 1,
}

describe('projectBotDomain', () => {
  test('域名、版本与表清单', () => {
    expect(projectBotDomain.name).toBe('project_bot')
    expect(projectBotDomain.version).toBe(1)
    expect(Object.keys(projectBotDomain.tables).sort()).toEqual(['bindings', 'bots'])
  })
})

describe('BotRecordSchema', () => {
  test('接受完整合法记录', () => {
    expect(BotRecordSchema.safeParse(validBot).success).toBe(true)
  })

  test('接受省略可选字段的最小记录', () => {
    const minimal = {
      id: 'ops', name: '运维', channel: 'feishu',
      feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_ops' },
      project: '/tmp/x', createdAt: 0, updatedAt: 0,
    }
    expect(BotRecordSchema.safeParse(minimal).success).toBe(true)
  })

  test('拒绝非法 appId / 非法 id / 空工具白名单', () => {
    expect(BotRecordSchema.safeParse({ ...validBot, feishu: { ...validBot.feishu, appId: 'bad' } }).success).toBe(false)
    expect(BotRecordSchema.safeParse({ ...validBot, id: '1bad' }).success).toBe(false)
    expect(BotRecordSchema.safeParse({ ...validBot, tools: [] }).success).toBe(false)
  })
})

test('bindingKey 拼接', () => {
  expect(bindingKey('reviewer', 'oc_abc')).toBe('reviewer:oc_abc')
})
