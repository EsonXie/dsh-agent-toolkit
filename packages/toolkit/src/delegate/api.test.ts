import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { expect, test } from 'vitest'
import { createActiveRoutes } from './active.ts'
import { createDelegateApiHandler, type DelegateApiDeps } from './api.ts'
import type { DelegationRouteRecord } from './routes.ts'

function mockReq(method: string, url: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage
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

function harness(overrides: Partial<DelegateApiDeps> = {}) {
  const routes = new Map<string, DelegationRouteRecord>()
  const deps: DelegateApiDeps = {
    active: createActiveRoutes(),
    routes: { get: (id) => routes.get(id) },
    ...overrides,
  }
  return { handler: createDelegateApiHandler(deps), deps, routes }
}

test('GET /delegate/active：命中 200，未命中/缺参 404', async () => {
  const { handler, deps } = harness()
  deps.active.set('s1', 'reviewer', { provider: 'deepseek', model: 'deepseek-reasoner' })
  const hit = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/delegate/active?session=s1&role=reviewer'), hit)
  expect(hit.status).toBe(200)
  expect(JSON.parse(hit.body)).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  const miss = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/delegate/active?session=s1&role=worker'), miss)
  expect(miss.status).toBe(404)
  const noParam = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/delegate/active'), noParam)
  expect(noParam.status).toBe(404)
})

test('GET /delegate/route：命中返回 provider/model（不带 at），未命中 404', async () => {
  const { handler, routes } = harness()
  routes.set('child-1', { provider: 'deepseek', model: 'deepseek-chat', at: 123 })
  const hit = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/delegate/route?session=child-1'), hit)
  expect(hit.status).toBe(200)
  expect(JSON.parse(hit.body)).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  const miss = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/delegate/route?session=nobody'), miss)
  expect(miss.status).toBe(404)
})

test('非 GET 405；未知路径 404', async () => {
  const { handler } = harness()
  const wrong = mockRes()
  await handler(mockReq('POST', '/dsh-agent-toolkit/api/delegate/active?session=s&role=r'), wrong)
  expect(wrong.status).toBe(405)
  const unknown = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/delegate/nope'), unknown)
  expect(unknown.status).toBe(404)
})
