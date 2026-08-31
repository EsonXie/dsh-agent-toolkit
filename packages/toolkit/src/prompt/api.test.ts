import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { createPromptLayersApiHandler, type PromptLayersApiDeps } from './api.ts'
import { openLayerSource } from './layer-source.ts'
import { BASE_TEXT } from './defaults.ts'
import type { LayerConfig } from './types.ts'

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

class FakeTable<V> {
  private readonly records = new Map<string, V>()
  get(key: string): V | undefined { return this.records.get(key) }
  entries(): IterableIterator<[string, V]> { return this.records.entries() }
  keys(): IterableIterator<string> { return this.records.keys() }
  get size(): number { return this.records.size }
  async put(key: string, value: V): Promise<void> { this.records.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.records.delete(key) }
  async update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error(`missing-key: ${key}`)
    const next = fn(current)
    this.records.set(key, next)
    return next
  }
}

const SEED: LayerConfig[] = [{ name: 'persona', order: 10, text: 'P' }]
const RULES = [{ match: { modelPattern: 'deepseek*' }, append: 'DS' }]
const NATIVE = {
  sections: [{ name: 'harness:identity', text: 'ID' }],
  contexts: [{ name: 'some-context', text: 'CTX' }],
}

async function harness() {
  const promptLayers = new FakeTable<{ layers: LayerConfig[] }>()
  const meta = new FakeTable<{ value: string }>()
  const source = await openLayerSource(
    { promptLayers, meta } as unknown as Parameters<typeof openLayerSource>[0],
    SEED,
  )
  const deps: PromptLayersApiDeps = { source, rules: RULES, seedLayers: SEED, probe: () => Promise.resolve(NATIVE) }
  return { deps, handler: createPromptLayersApiHandler(deps), source }
}

describe('GET /prompt-layers', () => {
  test('返回 { layers, rules, seedLayers, native }', async () => {
    const { handler } = await harness()
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/prompt-layers'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ layers: SEED, rules: RULES, seedLayers: SEED, native: NATIVE, modelFallbackText: BASE_TEXT })
  })

  test('probe 失败降级为空 native，主数据照常返回', async () => {
    const { deps, handler } = await harness()
    deps.probe = () => Promise.reject(new Error('boom'))
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/prompt-layers'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      layers: SEED, rules: RULES, seedLayers: SEED, native: { sections: [], contexts: [] }, modelFallbackText: BASE_TEXT,
    })
  })
})

describe('PUT /prompt-layers', () => {
  test('同结构改文本写穿并生效', async () => {
    const { handler, source } = await harness()
    const res = mockRes()
    const next: LayerConfig[] = [{ name: 'persona', order: 10, text: 'P2' }]
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/prompt-layers', { layers: next }), res)
    expect(res.status).toBe(200)
    expect(source.get()).toEqual(next)
  })

  test('结构变更（增/删层）→ 400', async () => {
    const { handler } = await harness()
    for (const layers of [
      [{ name: 'persona', order: 10, text: 'P' }, { name: 'task', order: 50, text: 'T' }],
      [],
    ]) {
      const res = mockRes()
      await handler(mockReq('PUT', '/dsh-agent-toolkit/api/prompt-layers', { layers }), res)
      expect(res.status).toBe(400)
      expect(JSON.parse(res.body).error).toMatch(/at least one layer|structure is fixed/)
    }
  })

  test('非法层（重名/保留名/缺字段）→ 400', async () => {
    const { handler } = await harness()
    for (const layers of [
      [{ name: 'a', order: 0, text: 'A' }, { name: 'a', order: 1, text: 'A2' }],
      [{ name: 'model-notes', order: 0, text: 'X' }],
      [{ name: 'base', order: 0, text: 'X' }],
      [{ name: 'base' }],
    ]) {
      const res = mockRes()
      await handler(mockReq('PUT', '/dsh-agent-toolkit/api/prompt-layers', { layers }), res)
      expect(res.status).toBe(400)
    }
  })

  test('body 缺 layers 数组 / 非法 JSON → 400', async () => {
    const { handler } = await harness()
    const missing = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/prompt-layers', { nope: true }), missing)
    expect(missing.status).toBe(400)

    const bad = mockRes()
    await handler(mockRawReq('PUT', '/dsh-agent-toolkit/api/prompt-layers', '{ not json'), bad)
    expect(bad.status).toBe(400)
  })
})

describe('POST /prompt-layers/reset', () => {
  test('重置回种子', async () => {
    const { handler, source } = await harness()
    await source.set([{ name: 'persona', order: 10, text: 'P-EDITED' }])
    const res = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/prompt-layers/reset'), res)
    expect(res.status).toBe(200)
    expect(source.get()).toEqual(SEED)
  })

  test('reset 存储失败 → 500 兜底 JSON 而非抛异常', async () => {
    const { source } = await harness()
    const broken = { ...source, reset: () => Promise.reject(new Error('boom')) }
    const deps: PromptLayersApiDeps = { source: broken, rules: RULES, seedLayers: SEED, probe: () => Promise.resolve(NATIVE) }
    const res = mockRes()
    await createPromptLayersApiHandler(deps)(mockReq('POST', '/dsh-agent-toolkit/api/prompt-layers/reset'), res)
    expect(res.status).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'boom' })
  })
})

test('未知路径 404；已知路径错误方法 405', async () => {
  const { handler } = await harness()
  const res404 = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/prompt-layers/extra'), res404)
  expect(res404.status).toBe(404)

  const res405 = mockRes()
  await handler(mockReq('DELETE', '/dsh-agent-toolkit/api/prompt-layers'), res405)
  expect(res405.status).toBe(405)
})
