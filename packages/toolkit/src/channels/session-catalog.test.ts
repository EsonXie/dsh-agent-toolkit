import { describe, expect, test } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  createSessionCatalog,
  type CatalogServices,
  type CatalogSessionHeader,
} from './session-catalog.ts'

const LIVE_ID = 'sess-live' as unknown as SessionId
const COLD_ID = 'sess-cold' as unknown as SessionId
const MISSING_ID = 'sess-missing' as unknown as SessionId

const coldHeader: CatalogSessionHeader = { id: COLD_ID, isSeeded: false, cwd: 'D:\\work\\demo' }

function services(overrides: Partial<CatalogServices> = {}): CatalogServices {
  return {
    workspaceRegistry: {
      create: async () => ({ sessionIds: [LIVE_ID, COLD_ID, MISSING_ID] }),
    },
    sessions: {
      get: (id) => (id === LIVE_ID ? { header: { cwd: 'D:\\work\\liveproj' } } : undefined),
    },
    sessionProjections: {
      cachedSnapshot: () => ({ values: { title: 'live 标题' } }),
    },
    sessionTitle: { get: () => ({ title: 'fold 标题' }) },
    sessionQuery: {
      listSessions: async () => [{ header: coldHeader }],
    },
    sessionProjectionCache: {
      cachedSnapshot: () => ({ values: { title: '冷会话标题' } }),
      cachedPredecessorTitle: () => undefined,
    },
    ...overrides,
  }
}

describe('createSessionCatalog', () => {
  test('workspaceRegistry 缺席：返回 undefined（环境不支持会话切换）', () => {
    expect(createSessionCatalog(() => services({ workspaceRegistry: undefined }))).toBeUndefined()
  })

  test('list：live 走 sessionProjections 标题，冷会话走投影缓存标题，无记录会话回退 id', async () => {
    const catalog = createSessionCatalog(() => services())!
    const entries = await catalog.list('D:\\work\\demo')
    expect(entries).toEqual([
      { sessionId: 'sess-live', title: 'live 标题' },
      { sessionId: 'sess-cold', title: '冷会话标题' },
      { sessionId: 'sess-missing', title: 'sess-missing' },
    ])
  })

  test('live：sessionProjections 缺席时 sessionTitle fold 兜底（同源 session/title 事件）', async () => {
    const catalog = createSessionCatalog(() => services({ sessionProjections: undefined }))!
    const entries = await catalog.list('p')
    expect(entries[0]).toEqual({ sessionId: 'sess-live', title: 'fold 标题' })
  })

  test('live：标题取不到时回退 cwd 末段（web displayTitleOf 同款）', async () => {
    const catalog = createSessionCatalog(() => services({
      sessionProjections: { cachedSnapshot: () => ({ values: { title: null } }) },
      sessionTitle: { get: () => undefined },
    }))!
    const entries = await catalog.list('p')
    expect(entries[0]).toEqual({ sessionId: 'sess-live', title: 'liveproj' })
  })

  test('live：空串标题视为缺席', async () => {
    const catalog = createSessionCatalog(() => services({
      sessionProjections: { cachedSnapshot: () => ({ values: { title: '' } }) },
      sessionTitle: { get: () => undefined },
    }))!
    const entries = await catalog.list('p')
    expect(entries[0]).toEqual({ sessionId: 'sess-live', title: 'liveproj' })
  })

  test('cold：cachedSnapshot 缺席时回退 cachedPredecessorTitle', async () => {
    const catalog = createSessionCatalog(() => services({
      sessionProjectionCache: {
        cachedSnapshot: () => undefined,
        cachedPredecessorTitle: () => ({ values: { title: '前代标题' } }),
      },
    }))!
    const entries = await catalog.list('p')
    expect(entries[1]).toEqual({ sessionId: 'sess-cold', title: '前代标题' })
  })

  test('cold：isSeeded 头部不读缓存，直接 cwd 末段回退', async () => {
    let cacheReads = 0
    const catalog = createSessionCatalog(() => services({
      sessionQuery: { listSessions: async () => [{ header: { ...coldHeader, isSeeded: true } }] },
      sessionProjectionCache: {
        cachedSnapshot: () => { cacheReads++; return { values: { title: '不应读到' } } },
        cachedPredecessorTitle: () => { cacheReads++; return { values: { title: '不应读到' } } },
      },
    }))!
    const entries = await catalog.list('p')
    expect(entries[1]).toEqual({ sessionId: 'sess-cold', title: 'demo' })
    expect(cacheReads).toBe(0)
  })

  test('cold：缓存无标题时回退 cwd 末段；cwd 也缺时回退 id', async () => {
    const noTitle = services({
      sessionProjectionCache: { cachedSnapshot: () => undefined, cachedPredecessorTitle: () => undefined },
    })
    const catalog = createSessionCatalog(() => noTitle)!
    const entries = await catalog.list('p')
    expect(entries[1]).toEqual({ sessionId: 'sess-cold', title: 'demo' })

    const noCwd = createSessionCatalog(() => services({
      sessionQuery: { listSessions: async () => [{ header: { id: COLD_ID, isSeeded: false } }] },
      sessionProjectionCache: { cachedSnapshot: () => undefined, cachedPredecessorTitle: () => undefined },
    }))!
    expect((await noCwd.list('p'))[1]).toEqual({ sessionId: 'sess-cold', title: 'sess-cold' })
  })

  test('sessionQuery 缺席：冷会话回退 id，列表照常（降级不抛错）', async () => {
    const catalog = createSessionCatalog(() => services({ sessionQuery: undefined }))!
    const entries = await catalog.list('p')
    expect(entries).toEqual([
      { sessionId: 'sess-live', title: 'live 标题' },
      { sessionId: 'sess-cold', title: 'sess-cold' },
      { sessionId: 'sess-missing', title: 'sess-missing' },
    ])
  })

  test('sessionProjectionCache 缺席：冷会话仍有 cwd 末段回退', async () => {
    const catalog = createSessionCatalog(() => services({ sessionProjectionCache: undefined }))!
    const entries = await catalog.list('p')
    expect(entries[1]).toEqual({ sessionId: 'sess-cold', title: 'demo' })
  })

  test('冷会话缓存读抛错：该行回退标题，列表照常（web projectionsFor 同款韧性）', async () => {
    const catalog = createSessionCatalog(() => services({
      sessionProjectionCache: {
        cachedSnapshot: () => { throw new Error('cache boom') },
        cachedPredecessorTitle: () => { throw new Error('cache boom') },
      },
    }))!
    const entries = await catalog.list('p')
    expect(entries[1]).toEqual({ sessionId: 'sess-cold', title: 'demo' })
  })

  test('服务按 list 调用时惰性解析（apply 期不捕获）', async () => {
    let current = services({ workspaceRegistry: undefined })
    // 首次缺席 → undefined；之后服务就绪 → 同一取用器返回可用 catalog
    expect(createSessionCatalog(() => current)).toBeUndefined()
    current = services()
    const catalog = createSessionCatalog(() => current)!
    expect(await catalog.list('p')).toHaveLength(3)
  })
})
