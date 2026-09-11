import { describe, expect, test } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createSessionCatalog, type CatalogServices } from './session-catalog.ts'

function services(overrides: Partial<CatalogServices> = {}): CatalogServices {
  return {
    workspaceRegistry: {
      create: async () => ({ sessionIds: ['sess-1', 'sess-2'] as unknown as SessionId[] }),
    },
    sessions: { get: (id) => (id === ('sess-1' as unknown as SessionId) ? { id } : undefined) },
    sessionTitle: { get: () => ({ title: '修复登录闪退' }) },
    ...overrides,
  }
}

describe('createSessionCatalog', () => {
  test('workspaceRegistry 缺席：返回 undefined（环境不支持会话切换）', () => {
    expect(createSessionCatalog(() => services({ workspaceRegistry: undefined }))).toBeUndefined()
  })

  test('list：workspace 候选 + live 会话标题', async () => {
    const catalog = createSessionCatalog(() => services())!
    const entries = await catalog.list('D:\\work\\demo')
    expect(entries).toEqual([
      { sessionId: 'sess-1', title: '修复登录闪退' },
      { sessionId: 'sess-2' },                    // 非 live：无 title 键
    ])
  })

  test('sessionTitle 缺席：标题全部降级（列表照常）', async () => {
    const catalog = createSessionCatalog(() => services({ sessionTitle: undefined }))!
    const entries = await catalog.list('p')
    expect(entries).toEqual([{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }])
  })

  test('sessions 缺席：取不到 live 会话，标题全部降级', async () => {
    const catalog = createSessionCatalog(() => services({ sessions: undefined }))!
    const entries = await catalog.list('p')
    expect(entries).toEqual([{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }])
  })

  test('标题服务返回 undefined：该条无 title 键', async () => {
    const catalog = createSessionCatalog(() => services({ sessionTitle: { get: () => undefined } }))!
    const entries = await catalog.list('p')
    expect(entries).toEqual([{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }])
  })

  test('服务按 list 调用时惰性解析（apply 期不捕获）', async () => {
    let current = services({ workspaceRegistry: undefined })
    // 首次缺席 → undefined；之后服务就绪 → 同一取用器返回可用 catalog
    expect(createSessionCatalog(() => current)).toBeUndefined()
    current = services()
    const catalog = createSessionCatalog(() => current)!
    expect(await catalog.list('p')).toHaveLength(2)
  })
})
