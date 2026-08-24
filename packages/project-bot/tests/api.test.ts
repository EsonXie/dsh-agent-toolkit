import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import { createApiHandler, type ApiDeps } from '../src/api.ts'
import { RegisterAppService } from '../src/register-app.ts'
import { BOT_ID_RE, type BotRecord } from '../src/store.ts'

const BOT: BotRecord = {
  id: 'reviewer', name: '评审', channel: 'feishu',
  feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
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
  const bots = new Map<string, BotRecord>([['reviewer', BOT]])
  const reconciled: string[] = []
  const stopped: string[] = []
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
    now: () => 1000,
    ...overrides,
  }
  return { deps, bots, reconciled, stopped, deletedSecrets, storedSecrets, handler: createApiHandler(deps), registerApp }
}

describe('GET /bots', () => {
  test('返回列表与运行状态（不含明文密钥）', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('GET', '/project-bot/api/bots'), res)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.bots).toHaveLength(1)
    expect(body.bots[0]).toMatchObject({ id: 'reviewer', status: 'connected' })
    expect(res.body).not.toContain('secret')
  })
})

describe('POST /bots', () => {
  test('合法创建：密钥入库、记录落表、reconcile', async () => {
    const { handler, bots, reconciled, storedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('POST', '/project-bot/api/bots', {
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
    await handler(mockReq('POST', '/project-bot/api/bots', {
      id: 'scan-bot', name: '扫码', project: 'D:\\work\\ops',
      feishu: { appId: 'cli_ffffffffffffffff', appSecretRef: 'project_bot_ffffffff' },
    }), res)
    expect(res.status).toBe(200)
    expect(bots.get('scan-bot')).toMatchObject({ feishu: { appSecretRef: 'project_bot_ffffffff' } })
    expect(storedSecrets).toEqual([])
  })

  test('缺省 id：自动生成 bot-<8 位随机小写字母数字>（过 BOT_ID_RE）', async () => {
    const { handler, bots, storedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('POST', '/project-bot/api/bots', {
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
    await handler(mockReq('POST', '/project-bot/api/bots', { id: 'ops', name: 'x', project: 'p', feishu: { appId: 'bad', appSecret: 's' } }), bad)
    expect(bad.status).toBe(400)

    const dup = mockRes()
    await handler(mockReq('POST', '/project-bot/api/bots', { id: 'ops', name: 'x', project: 'p', feishu: { appId: BOT.feishu.appId, appSecret: 's' } }), dup)
    expect(dup.status).toBe(409)

    const dupId = mockRes()
    await handler(mockReq('POST', '/project-bot/api/bots', { id: 'reviewer', name: 'x', project: 'p', feishu: { appId: 'cli_000000000000000c', appSecret: 's' } }), dupId)
    expect(dupId.status).toBe(409)
  })
})

describe('PUT /bots', () => {
  test('更新 persona/工具并 reconcile；密钥引用不变', async () => {
    const { handler, bots, reconciled } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/project-bot/api/bots?id=reviewer', { persona: '新人设', tools: ['bash'] }), res)
    expect(res.status).toBe(200)
    expect(bots.get('reviewer')).toMatchObject({ persona: '新人设', tools: ['bash'], feishu: { appSecretRef: 'project_bot_reviewer' } })
    expect(reconciled).toEqual(['reviewer'])
  })

  test('不存在 → 404', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/project-bot/api/bots?id=ghost', { name: 'x' }), res)
    expect(res.status).toBe(404)
  })

  test('null 清除 persona/tools 字段，其余不变', async () => {
    const { handler, bots } = harness()
    const add = mockRes()
    await handler(mockReq('PUT', '/project-bot/api/bots?id=reviewer', { persona: '新人设', tools: ['bash'] }), add)
    expect(add.status).toBe(200)
    const clear = mockRes()
    await handler(mockReq('PUT', '/project-bot/api/bots?id=reviewer', { persona: null, tools: null }), clear)
    expect(clear.status).toBe(200)
    const record = bots.get('reviewer')
    expect(record).not.toHaveProperty('persona')
    expect(record).not.toHaveProperty('tools')
    expect(record).toMatchObject({ id: 'reviewer', name: '评审', feishu: { appSecretRef: 'project_bot_reviewer' } })
  })
})

describe('DELETE /bots', () => {
  test('stopBot → 删记录 → 删密钥', async () => {
    const { handler, bots, stopped, deletedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('DELETE', '/project-bot/api/bots?id=reviewer'), res)
    expect(res.status).toBe(200)
    expect(stopped).toEqual(['reviewer'])
    expect(bots.has('reviewer')).toBe(false)
    expect(deletedSecrets).toEqual(['project_bot_reviewer'])
  })
})

describe('register-app 流程', () => {
  test('start 返回 id；status 轮询到 done', async () => {
    const { handler } = harness()
    const startRes = mockRes()
    await handler(mockReq('POST', '/project-bot/api/register-app'), startRes)
    expect(startRes.status).toBe(200)
    const { id } = JSON.parse(startRes.body) as { id: string }
    await vi.waitFor(async () => {
      const statusRes = mockRes()
      await handler(mockReq('GET', `/project-bot/api/register-app/status?id=${id}`), statusRes)
      expect((JSON.parse(statusRes.body) as { state: { status: string } }).state.status).toBe('done')
    })
    const finalRes = mockRes()
    await handler(mockReq('GET', `/project-bot/api/register-app/status?id=${id}`), finalRes)
    expect(JSON.parse(finalRes.body)).toMatchObject({ state: { status: 'done', appId: 'cli_ffffffffffffffff', credentialRef: 'project_bot_ffffffff' } })
  })
})

test('GET /tools 返回已注册工具名', async () => {
  const { handler } = harness()
  const res = mockRes()
  await handler(mockReq('GET', '/project-bot/api/tools'), res)
  expect(JSON.parse(res.body)).toEqual({ tools: ['bash', 'fs_read', 'fs_write'] })
})

describe('GET /providers 与 GET /models', () => {
  test('/providers 返回 provider 列表', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('GET', '/project-bot/api/providers'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ providers: [{ id: 'deepseek', name: 'DeepSeek' }] })
  })

  test('/models 按 provider 返回模型列表', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('GET', '/project-bot/api/models?provider=deepseek'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] })
  })

  test('listModels 失败 → 200 空数组降级（不报错）', async () => {
    const { handler } = harness({ listModels: async () => { throw new Error('network down') } })
    const res = mockRes()
    await handler(mockReq('GET', '/project-bot/api/models?provider=deepseek'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ models: [] })
  })
})

test('未知路径 404；已知路径错误方法 405', async () => {
  const { handler } = harness()
  const res404 = mockRes()
  await handler(mockReq('GET', '/project-bot/api/nope'), res404)
  expect(res404.status).toBe(404)
  const res405 = mockRes()
  await handler(mockReq('PATCH', '/project-bot/api/bots'), res405)
  expect(res405.status).toBe(405)
})
