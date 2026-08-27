import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { createAgentsApiHandler, type AgentsApiDeps } from './api.ts'
import { AgentRecordSchema, type AgentRecord } from './store.ts'
import type { AgentRegistry } from './registry.ts'
import { NATIVE_TOOL_NAMES } from '../channels/basic-tools.ts'

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  req.method = method
  req.url = url
  req.headers = {}
  return req
}

function mockRawReq(method: string, url: string, raw: string): IncomingMessage {
  const req = Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage
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

/** fake 注册表：忠实复刻 AgentRegistry 的语义（main 置顶、main/builtin 不可删、main 的 name/builtin 不可改）。 */
function harness(overrides: Partial<AgentsApiDeps> = {}) {
  const store = new Map<string, AgentRecord>([
    ['main', { id: 'main', name: '主 Agent', builtin: true }],
    ['explorer', { id: 'explorer', name: 'Explorer', builtin: true }],
    ['general', { id: 'general', name: 'General', builtin: true }],
    ['scout', { id: 'scout', name: '侦察', description: '只读探索' }],
  ])
  const registry: AgentRegistry = {
    list: () => {
      const main = store.get('main')
      const rest = [...store.entries()]
        .filter(([id]) => id !== 'main')
        .map(([, record]) => record)
        .sort((a, b) => a.id.localeCompare(b.id))
      return main === undefined ? rest : [main, ...rest]
    },
    get: (id) => store.get(id),
    async upsert(record: AgentRecord): Promise<void> {
      const parsed = AgentRecordSchema.safeParse(record)
      if (!parsed.success) throw new Error(`校验失败：${parsed.error.message}`)
      const existing = store.get(record.id)
      if (record.id === 'main' && existing !== undefined) {
        if (existing.name !== record.name || existing.builtin !== record.builtin) {
          throw new Error('主 Agent（main）的 name/builtin 字段不可修改')
        }
      }
      if (existing?.builtin === true && record.builtin !== true) {
        throw new Error(`内置角色 ${record.id} 的 builtin 标记不可修改`)
      }
      store.set(record.id, record)
    },
    async remove(id: string): Promise<void> {
      if (id === 'main') throw new Error('主 Agent（main）不可删除')
      const existing = store.get(id)
      if (existing?.builtin === true) throw new Error(`内置角色 ${id} 不可删除`)
      store.delete(id)
    },
    subscribe: () => () => {},
  }
  const deps: AgentsApiDeps = {
    registry,
    listTools: () => ['bash', 'read', 'write'],
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async (provider) => [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    ...overrides,
  }
  return { deps, store, handler: createAgentsApiHandler(deps) }
}

describe('GET /agents', () => {
  test('返回 AgentRecord[] 裸数组（main 置顶，其余按 id 字典序）', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/agents'), res)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as AgentRecord[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.map((a) => a.id)).toEqual(['main', 'explorer', 'general', 'scout'])
  })
})

describe('PUT /agents/:id', () => {
  test('upsert：新建角色落表', async () => {
    const { handler, store } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/agents/sentry', {
      id: 'sentry', name: '哨兵', description: '监控',
      persona: '只读观察',
      tools: { allow: ['read'] },
    }), res)
    expect(res.status).toBe(200)
    expect(store.get('sentry')).toMatchObject({
      name: '哨兵', description: '监控', tools: { allow: ['read'] },
    })
  })

  test('upsert：客户端携带 builtin:true 新建 → 剥离为普通记录（可删）', async () => {
    const { handler, store, deps } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/agents/sentry', {
      id: 'sentry', name: '哨兵', builtin: true,
    }), res)
    expect(res.status).toBe(200)
    expect(store.get('sentry')).toMatchObject({ name: '哨兵' })
    expect(store.get('sentry')?.builtin).toBeUndefined()
    await expect(deps.registry.remove('sentry')).resolves.toBeUndefined()
    expect(store.has('sentry')).toBe(false)
  })

  test('upsert：更新既有角色（id 以路径为准，覆盖 body.id）', async () => {
    const { handler, store } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/agents/scout', {
      id: 'ignored', name: '侦察员',
    }), res)
    expect(res.status).toBe(200)
    expect(store.get('scout')).toMatchObject({ name: '侦察员' })
    expect(store.has('ignored')).toBe(false)
  })

  test('非法记录 → 400（空 name / 非法 id / 空 tools.allow）', async () => {
    const { handler } = harness()
    const badName = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/agents/ghost', { id: 'ghost', name: '' }), badName)
    expect(badName.status).toBe(400)

    const badId = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/agents/UP-CASE', { id: 'UP-CASE', name: 'x' }), badId)
    expect(badId.status).toBe(400)

    const badTools = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/agents/ghost', { id: 'ghost', name: 'x', tools: { allow: [] } }), badTools)
    expect(badTools.status).toBe(400)
  })

  test('非法 JSON body → 400', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockRawReq('PUT', '/dsh-agent-toolkit/api/agents/ghost', '{ not json'), res)
    expect(res.status).toBe(400)
  })

  test('改 main 的 name/builtin → 409（registry 约束）', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/agents/main', { id: 'main', name: '改名', builtin: true }), res)
    expect(res.status).toBe(409)
  })

  test('编辑内置角色可保存：不携带 builtin 也保留内置标记', async () => {
    const { handler, store } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/agents/explorer', {
      id: 'explorer', name: 'Explorer 探索员', description: '新描述',
    }), res)
    expect(res.status).toBe(200)
    expect(store.get('explorer')).toMatchObject({ name: 'Explorer 探索员', description: '新描述', builtin: true })
  })

  test('改 main 的 name 仍被拒（409）：服务端回填 builtin 不绕过 name 不可改守卫', async () => {
    const { handler, store } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/agents/main', { id: 'main', name: '改名' }), res)
    expect(res.status).toBe(409)
    expect(store.get('main')).toMatchObject({ name: '主 Agent' })
  })
})

describe('DELETE /agents/:id', () => {
  test('删除普通角色', async () => {
    const { handler, store } = harness()
    const res = mockRes()
    await handler(mockReq('DELETE', '/dsh-agent-toolkit/api/agents/scout'), res)
    expect(res.status).toBe(200)
    expect(store.has('scout')).toBe(false)
  })

  test('不存在 → 404', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('DELETE', '/dsh-agent-toolkit/api/agents/ghost'), res)
    expect(res.status).toBe(404)
  })

  test('main → 409；builtin → 409', async () => {
    const { handler } = harness()
    const mainRes = mockRes()
    await handler(mockReq('DELETE', '/dsh-agent-toolkit/api/agents/main'), mainRes)
    expect(mainRes.status).toBe(409)

    const builtinRes = mockRes()
    await handler(mockReq('DELETE', '/dsh-agent-toolkit/api/agents/explorer'), builtinRes)
    expect(builtinRes.status).toBe(409)
  })
})

describe('GET /providers 与 GET /providers/:provider/models', () => {
  test('/providers 返回 {id,name}[]', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/providers'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual([{ id: 'deepseek', name: 'DeepSeek' }])
  })

  test('/providers/:provider/models 按 provider 透传模型列表', async () => {
    const { handler } = harness({ listModels: async (p) => [{ id: `${p}-m1`, name: 'M1' }] })
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/providers/deepseek/models'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual([{ id: 'deepseek-m1', name: 'M1' }])
  })

  test('listModels 失败 → 200 空数组降级（不报错）', async () => {
    const { handler } = harness({ listModels: async () => { throw new Error('network down') } })
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/providers/deepseek/models'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })
})

test('GET /tools 返回分组工具名册（native 常量 + global 全局注册）', async () => {
  const { handler } = harness()
  const res = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/tools'), res)
  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({
    native: [...NATIVE_TOOL_NAMES],
    global: ['bash', 'read', 'write'],
  })
})

test('未知路径 404；已知路径错误方法 405', async () => {
  const { handler } = harness()
  const res404 = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/nope'), res404)
  expect(res404.status).toBe(404)

  const res405 = mockRes()
  await handler(mockReq('POST', '/dsh-agent-toolkit/api/tools'), res405)
  expect(res405.status).toBe(405)

  const patch405 = mockRes()
  await handler(mockReq('PATCH', '/dsh-agent-toolkit/api/agents/main'), patch405)
  expect(patch405.status).toBe(405)
})
