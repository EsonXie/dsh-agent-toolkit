import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import type { Client } from '@larksuiteoapi/node-sdk'
import { createApiHandler, type ApiDeps } from './api.ts'
import { createFeishuApi } from '../channels/feishu/api.ts'
import { RegisterAppService } from './register-app.ts'
import { BOT_ID_RE, type BotRecord } from './store.ts'

const BOT: BotRecord = {
  id: 'reviewer', name: '评审', channel: 'feishu',
  feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
  project: 'D:\\work\\demo', createdAt: 1, updatedAt: 1,
}
const UNBOUND: BotRecord = {
  id: 'loose', name: '未绑定', project: 'D:\\work\\demo', createdAt: 1, updatedAt: 1,
}
const SCAN_BOUND: BotRecord = {
  id: 'scan-bot', name: '扫码', channel: 'feishu',
  feishu: { appId: 'cli_ffffffffffffffff', appSecretRef: 'project_bot_ffffffff' },
  project: 'D:\\work\\demo', createdAt: 1, updatedAt: 1,
}

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  req.method = method
  req.url = url
  req.headers = {}
  return req
}

type MockRes = ServerResponse & { status: number; body: string }

function mockRes(): MockRes {
  const res = { status: 0, body: '' } as MockRes
  res.writeHead = ((code: number) => { res.status = code; return res }) as unknown as MockRes['writeHead']
  res.end = ((chunk?: unknown) => { if (typeof chunk === 'string') res.body = chunk; return res }) as unknown as MockRes['end']
  return res
}

function harness(overrides: Partial<ApiDeps> = {}) {
  const bots = new Map<string, BotRecord>([['reviewer', BOT], ['loose', UNBOUND], ['scan-bot', SCAN_BOUND]])
  const reconciled: string[] = []
  const stopped: string[] = []
  const unbound: string[] = []
  const deletedSecrets: string[] = []
  const storedSecrets: { key: string; secret: string }[] = []
  const registerApp = new RegisterAppService({
    registerApp: async (options) => {
      options.onQRCodeReady({ url: 'https://example/qr', expireIn: 600 })
      return { client_id: 'cli_ffffffffffffffff', client_secret: 'sec' }
    },
    storeSecret: async () => 'project_bot_ffffffff',
    timeoutMs: 60_000,
  })
  let time = 1000
  const now = () => time++
  const deps: ApiDeps = {
    bots: {
      get: (k: string) => bots.get(k),
      put: async (k: string, v: BotRecord) => { bots.set(k, v) },
      delete: async (k: string) => bots.delete(k),
      entries: () => bots.entries(),
      keys: () => bots.keys(),
    } as unknown as ApiDeps['bots'],
    runtime: {
      reconcile: async (id: string) => { reconciled.push(id) },
      stopBot: async (id: string) => { stopped.push(id) },
      unbindBot: async (id: string) => { unbound.push(id) },
      statusOf: () => 'connected',
    } as unknown as ApiDeps['runtime'],
    registerApp,
    listTools: () => ['bash', 'fs_read', 'fs_write'],
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    storeSecret: async (key, secret) => {
      storedSecrets.push({ key, secret })
      return `project_bot_${key.replace(/[^A-Za-z0-9_]/g, '_')}`
    },
    deleteSecret: async (ref) => { deletedSecrets.push(ref) },
    validateProject: () => true,
    now,
    ...overrides,
  }
  return { deps, bots, reconciled, stopped, unbound, deletedSecrets, storedSecrets, handler: createApiHandler(deps), registerApp }
}

describe('GET /bots', () => {
  test('返回列表与运行状态（不含明文密钥）', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/bots/bots'), res)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.bots).toHaveLength(3)
    expect(body.bots[0]).toMatchObject({ id: 'reviewer', status: 'connected' })
    expect(res.body).not.toContain('secret')
  })
})

describe('POST /bots', () => {
  test('合法创建：密钥入库、记录落表、reconcile', async () => {
    const { handler, bots, reconciled, storedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/bots/bots', {
      id: 'ops', name: '运维', project: 'D:\\work\\ops',
      feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' },
    }), res)
    expect(res.status).toBe(200)
    expect(bots.get('ops')).toMatchObject({ feishu: { appSecretRef: 'project_bot_ops' } })
    expect(storedSecrets).toEqual([{ key: 'ops', secret: 'plain-secret' }])
    expect(reconciled).toEqual(['ops'])
  })

  test('扫码路径：直接携带 appSecretRef，不再入库', async () => {
    const { handler, bots, storedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/bots/bots', {
      id: 'scan-bot2', name: '扫码', project: 'D:\\work\\ops',
      feishu: { appId: 'cli_000000000000000b', appSecretRef: 'project_bot_ffffffff' },
    }), res)
    expect(res.status).toBe(200)
    expect(bots.get('scan-bot2')).toMatchObject({ feishu: { appSecretRef: 'project_bot_ffffffff' } })
    expect(storedSecrets).toEqual([])
  })

  test('缺省 id：自动生成 bot-<8 位随机小写字母数字>（过 BOT_ID_RE）', async () => {
    const { handler, bots, storedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/bots/bots', {
      name: '自动', project: 'D:\\work\\ops',
      feishu: { appId: 'cli_000000000000000d', appSecret: 'plain-secret' },
    }), res)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { bot: { id: string } }
    expect(body.bot.id).toMatch(/^bot-[a-z0-9]{8}$/)
    expect(BOT_ID_RE.test(body.bot.id)).toBe(true)
    expect(bots.get(body.bot.id)).toBeDefined()
    expect(storedSecrets).toEqual([{ key: body.bot.id, secret: 'plain-secret' }])
  })

  test('非法 appId → 400；重复 appId → 409；重复 id → 409', async () => {
    const { handler } = harness()
    const bad = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/bots/bots', { id: 'ops', name: 'x', project: 'p', feishu: { appId: 'bad', appSecret: 's' } }), bad)
    expect(bad.status).toBe(400)

    const dup = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/bots/bots', { id: 'ops', name: 'x', project: 'p', feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecret: 's' } }), dup)
    expect(dup.status).toBe(409)

    const dupId = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/bots/bots', { id: 'reviewer', name: 'x', project: 'p', feishu: { appId: 'cli_000000000000000c', appSecret: 's' } }), dupId)
    expect(dupId.status).toBe(409)
  })
})

describe('PUT /bots', () => {
  test('更新 persona/工具并 reconcile；密钥引用不变', async () => {
    const { handler, bots, reconciled } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=reviewer', { persona: '新人设', tools: ['bash'] }), res)
    expect(res.status).toBe(200)
    expect(bots.get('reviewer')).toMatchObject({ persona: '新人设', tools: ['bash'], feishu: { appSecretRef: 'project_bot_reviewer' } })
    expect(reconciled).toEqual(['reviewer'])
  })

  test('不存在 → 404', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=ghost', { name: 'x' }), res)
    expect(res.status).toBe(404)
  })

  test('null 清除 persona/tools 字段，其余不变', async () => {
    const { handler, bots } = harness()
    const add = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=reviewer', { persona: '新人设', tools: ['bash'] }), add)
    expect(add.status).toBe(200)
    const clear = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=reviewer', { persona: null, tools: null }), clear)
    expect(clear.status).toBe(200)
    const record = bots.get('reviewer')
    expect(record).not.toHaveProperty('persona')
    expect(record).not.toHaveProperty('tools')
    expect(record).toMatchObject({ id: 'reviewer', name: '评审', feishu: { appSecretRef: 'project_bot_reviewer' } })
  })

  test('PUT 刷新 updatedAt（同名更新也刷新；fake 单调递增）', async () => {
    const { handler, bots } = harness()
    expect(bots.get('reviewer')?.updatedAt).toBe(1)
    const first = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=reviewer', { name: '评审2' }), first)
    expect(first.status).toBe(200)
    const record = bots.get('reviewer')!
    expect(record.updatedAt).toBeGreaterThan(1)
    const second = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=reviewer', { persona: '新' }), second)
    expect(second.status).toBe(200)
    expect(bots.get('reviewer')?.updatedAt).toBeGreaterThan(record.updatedAt)
  })

  test('agentRef：创建落表、更新覆盖、null 清除（回主 Agent）', async () => {
    const { handler, bots } = harness()
    const create = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/bots/bots', {
      id: 'ops', name: '运维', project: 'D:\\work\\ops', agentRef: 'reviewer',
      feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' },
    }), create)
    expect(create.status).toBe(200)
    expect(bots.get('ops')).toMatchObject({ agentRef: 'reviewer' })

    const update = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=ops', { agentRef: 'scout' }), update)
    expect(update.status).toBe(200)
    expect(bots.get('ops')).toMatchObject({ agentRef: 'scout' })

    const clear = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=ops', { agentRef: null }), clear)
    expect(clear.status).toBe(200)
    expect(bots.get('ops')).not.toHaveProperty('agentRef')
  })
})

describe('PUT /bots 渠道解绑与重绑', () => {
  test('feishu: null 解绑：unbindBot + 删密钥 + 摘字段；不删绑定（绑定表不经 API 触碰）', async () => {
    const { handler, bots, unbound, deletedSecrets, storedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=reviewer', { feishu: null }), res)
    expect(res.status).toBe(200)
    const record = bots.get('reviewer')
    expect(record).not.toHaveProperty('channel')
    expect(record).not.toHaveProperty('feishu')
    expect(record).toMatchObject({ id: 'reviewer', name: '评审' })
    expect(unbound).toEqual(['reviewer'])
    expect(deletedSecrets).toEqual(['project_bot_reviewer'])
    expect(storedSecrets).toEqual([])
  })

  test('未绑定 bot 解绑（幂等）：不再删密钥、照常返回', async () => {
    const { handler, deletedSecrets, unbound } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=loose', { feishu: null }), res)
    expect(res.status).toBe(200)
    expect(unbound).toEqual(['loose'])
    expect(deletedSecrets).toEqual([])
  })

  test('重绑（appSecret 路径）：新密钥入库、写回 channel/feishu、reconcile；旧 ref ≠ 新 ref 清理旧凭据', async () => {
    const { handler, bots, storedSecrets, deletedSecrets, reconciled } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=scan-bot', {
      feishu: { appId: 'cli_000000000000000a', appSecret: 'new-secret' },
    }), res)
    expect(res.status).toBe(200)
    expect(bots.get('scan-bot')).toMatchObject({
      channel: 'feishu',
      feishu: { appId: 'cli_000000000000000a', appSecretRef: 'project_bot_scan_bot' },
    })
    expect(storedSecrets).toEqual([{ key: 'scan-bot', secret: 'new-secret' }])
    expect(deletedSecrets).toEqual(['project_bot_ffffffff'])
    expect(reconciled).toEqual(['scan-bot'])
  })

  test('重绑（appSecretRef 扫码路径）：直接引用不再入库', async () => {
    const { handler, bots, storedSecrets, deletedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=scan-bot', {
      feishu: { appId: 'cli_000000000000000a', appSecretRef: 'project_bot_newref' },
    }), res)
    expect(res.status).toBe(200)
    expect(bots.get('scan-bot')).toMatchObject({ feishu: { appId: 'cli_000000000000000a', appSecretRef: 'project_bot_newref' } })
    expect(storedSecrets).toEqual([])
    expect(deletedSecrets).toEqual(['project_bot_ffffffff'])
  })

  test('重绑 appId 被其他 bot 占用 → 409（未绑定 bot 不占 appId）', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=scan-bot', {
      feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecret: 's' },
    }), res)
    expect(res.status).toBe(409)
  })

  test('重绑缺 appSecret 与 appSecretRef → 400', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/bots/bots?id=scan-bot', {
      feishu: { appId: 'cli_000000000000000a' },
    }), res)
    expect(res.status).toBe(400)
  })
})

describe('DELETE /bots', () => {
  test('stopBot → 删记录 → 删密钥', async () => {
    const { handler, bots, stopped, deletedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('DELETE', '/dsh-agent-toolkit/api/bots/bots?id=reviewer'), res)
    expect(res.status).toBe(200)
    expect(stopped).toEqual(['reviewer'])
    expect(bots.has('reviewer')).toBe(false)
    expect(deletedSecrets).toEqual(['project_bot_reviewer'])
  })

  test('DELETE 未绑定 bot：不删密钥、照常删除', async () => {
    const { handler, bots, stopped, deletedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('DELETE', '/dsh-agent-toolkit/api/bots/bots?id=loose'), res)
    expect(res.status).toBe(200)
    expect(stopped).toEqual(['loose'])
    expect(bots.has('loose')).toBe(false)
    expect(deletedSecrets).toEqual([])
  })
})

describe('register-app 流程', () => {
  test('start 返回 id；status 轮询到 done', async () => {
    const { handler } = harness()
    const startRes = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/bots/register-app'), startRes)
    expect(startRes.status).toBe(200)
    const { id } = JSON.parse(startRes.body) as { id: string }
    await vi.waitFor(async () => {
      const statusRes = mockRes()
      await handler(mockReq('GET', `/dsh-agent-toolkit/api/bots/register-app/status?id=${id}`), statusRes)
      expect((JSON.parse(statusRes.body) as { state: { status: string } }).state.status).toBe('done')
    })
    const finalRes = mockRes()
    await handler(mockReq('GET', `/dsh-agent-toolkit/api/bots/register-app/status?id=${id}`), finalRes)
    expect(JSON.parse(finalRes.body)).toMatchObject({ state: { status: 'done', appId: 'cli_ffffffffffffffff', credentialRef: 'project_bot_ffffffff' } })
  })
})

test('GET /tools 返回已注册工具名', async () => {
  const { handler } = harness()
  const res = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/bots/tools'), res)
  expect(JSON.parse(res.body)).toEqual({ tools: ['bash', 'fs_read', 'fs_write'] })
})

describe('GET /providers 与 GET /models', () => {
  test('/providers 返回 provider 列表', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/bots/providers'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] })
  })

  test('/models 按 provider 返回模型列表', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/bots/models?provider=deepseek'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] })
  })

  test('listModels 失败 → 200 空数组降级（不报错）', async () => {
    const { handler } = harness({ listModels: async () => { throw new Error('network down') } })
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/bots/models?provider=deepseek'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ models: [] })
  })
})

test('未知路径 404；已知路径错误方法 405', async () => {
  const { handler } = harness()
  const res404 = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/bots/nope'), res404)
  expect(res404.status).toBe(404)
  const res405 = mockRes()
  await handler(mockReq('PATCH', '/dsh-agent-toolkit/api/bots/bots'), res405)
  expect(res405.status).toBe(405)
})

describe('createFeishuApi.setCardStreaming', () => {
  function fakeClient() {
    const calls: { settings: string; sequence: number }[] = []
    const client = {
      cardkit: { v1: { card: { settings: async ({ data }: { data: { settings: string; sequence: number } }) => { calls.push({ settings: data.settings, sequence: data.sequence }); return {} } } } },
    } as unknown as Client
    return { client, calls }
  }

  test('带 summary：settings JSON 含 streaming_mode 与 summary.content', async () => {
    const { client, calls } = fakeClient()
    await createFeishuApi(client).setCardStreaming('card_1', false, 3, '✅ 输出完成')
    expect(calls).toHaveLength(1)
    expect(calls[0].sequence).toBe(3)
    const parsed = JSON.parse(calls[0].settings) as { config: { streaming_mode: boolean; summary: { content: string } } }
    expect(parsed.config.streaming_mode).toBe(false)
    expect(parsed.config.summary.content).toBe('✅ 输出完成')
  })

  test('不带 summary：settings JSON 不含 summary 键', async () => {
    const { client, calls } = fakeClient()
    await createFeishuApi(client).setCardStreaming('card_1', true, 1)
    const parsed = JSON.parse(calls[0].settings) as { config: Record<string, unknown> }
    expect(parsed.config.streaming_mode).toBe(true)
    expect(parsed.config).not.toHaveProperty('summary')
  })
})

describe('createFeishuApi.insertElement', () => {
  function fakeClient() {
    const calls: { cardId: string; data: Record<string, unknown> }[] = []
    const client = {
      cardkit: {
        v1: {
          cardElement: {
            create: async ({ path, data }: { path: { card_id: string }; data: Record<string, unknown> }) => {
              calls.push({ cardId: path.card_id, data })
              return {}
            },
          },
        },
      },
    } as unknown as Client
    return { client, calls }
  }

  test('insert_before 锚定状态行；elements 为数组字符串；sequence 透传', async () => {
    const { client, calls } = fakeClient()
    const elementJson = JSON.stringify({ tag: 'markdown', content: '你好', element_id: 'seg_1' })
    await createFeishuApi(client).insertElement('card_1', elementJson, 'status', 3)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      cardId: 'card_1',
      data: {
        type: 'insert_before',
        target_element_id: 'status',
        elements: `[${elementJson}]`,
        sequence: 3,
      },
    })
  })
})
