/**
 * /sessions 候选目录真实适配器：workspaceRegistry 候选 + 与 web 端完全同源的展示标题
 * （六服务均为可选，惰性解析）。
 *
 * 标题链路与 web session.list 一致（deepseek-harness packages/api/session-controller/src/list.ts）：
 *  - live 会话：sessionProjections.cachedSnapshot(session) 的 title 投影；投影服务缺席时
 *    sessionTitle fold 兜底（同源 session/title 日志事件，结果等价）。
 *  - 冷会话：sessionQuery.listSessions() 取 header（不激活 Agent），非 seeded 时
 *    sessionProjectionCache.cachedSnapshot(header, 0) ?? cachedPredecessorTitle(header, 0)
 *    读持久化 title 投影（零 I/O 列表读，不 resume 会话）。
 *  - 展示标题统一 displayTitleOf 三级回退：title（非空）→ cwd 末段 → session id
 *    （web client/sessions/service.ts 同款；cwd 末段规则同 dsh-workspace-path workspaceTitleOf）。
 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionCatalogEntry, SessionCatalogPort } from './ports.ts'

/** 结构化窄接口：只声明用到的成员（与 bots/index.ts 的 WorkspaceRegistryLike 同款模式）。 */
export interface CatalogWorkspaceRegistry {
  create(path: string): Promise<{ sessionIds: readonly SessionId[] }>
}

/** live 会话窄化：真实 Session 结构子集（header.cwd 供展示标题回退）。 */
export interface CatalogLiveSession {
  header?: { cwd?: string }
}

/** 宿主 sessions 服务窄化：只取 live 会话（不 resume 未加载会话——仅为列表标题太贵）。 */
export interface CatalogSessions {
  get(id: SessionId): CatalogLiveSession | undefined
}

/** 宿主 sessionTitle 服务窄化（sessionProjections 缺席时的 live 兜底）。 */
export interface CatalogSessionTitle {
  get(session: CatalogLiveSession): { title: string } | undefined
}

/** 宿主 sessionProjections 服务窄化：web live 列表行同款投影读。 */
export interface CatalogSessionProjections {
  cachedSnapshot(session: CatalogLiveSession): { values: Record<string, unknown> } | undefined
}

/** 宿主 SessionHeader 窄化（投影缓存读的身份见证 + cwd 回退来源）。 */
export interface CatalogSessionHeader {
  id: SessionId
  isSeeded: boolean
  cwd?: string
}

/** 宿主 sessionQuery 服务窄化：列出持久化会话 header（不激活 Agent）。 */
export interface CatalogSessionQuery {
  listSessions(): Promise<readonly { header: CatalogSessionHeader }[]>
}

/** 宿主 sessionProjectionCache 服务窄化：web 冷列表行同款零 I/O 投影读。 */
export interface CatalogSessionProjectionCache {
  cachedSnapshot(header: CatalogSessionHeader, inheritedEventCount: number): { values: Record<string, unknown> } | undefined
  cachedPredecessorTitle(header: CatalogSessionHeader, inheritedEventCount: number): { values: Record<string, unknown> } | undefined
}

export interface CatalogServices {
  workspaceRegistry: CatalogWorkspaceRegistry | undefined
  sessions: CatalogSessions | undefined
  sessionProjections: CatalogSessionProjections | undefined
  sessionTitle: CatalogSessionTitle | undefined
  sessionQuery: CatalogSessionQuery | undefined
  sessionProjectionCache: CatalogSessionProjectionCache | undefined
}

/** web displayTitleOf 同款：durable title（空串视为缺席）→ cwd 末段 → session id。 */
function displayTitleOf(title: unknown, cwd: string | undefined, id: SessionId): string {
  if (typeof title === 'string' && title !== '') return title
  if (cwd !== undefined && cwd !== '') {
    // dsh-workspace-path workspaceTitleOf 同款末段规则（/ 与 \ 皆分隔，先剥尾部分隔符）。
    const trimmed = cwd.replace(/[/\\]+$/, '')
    const base = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
    if (base !== '') return base
  }
  return String(id)
}

/** 冷会话持久化投影读：web projectionsFor 同款韧性——读失败时该行降级回退，不拖垮整个列表。 */
function coldTitle(
  cache: CatalogSessionProjectionCache,
  header: CatalogSessionHeader,
): unknown {
  try {
    const block = cache.cachedSnapshot(header, 0) ?? cache.cachedPredecessorTitle(header, 0)
    return block?.values.title
  } catch {
    return undefined
  }
}

/**
 * workspaceRegistry 缺席 = 环境不支持会话切换，返回 undefined（Inbound 降级文案）。
 * resolve 在取用与每次 list 时调用（attachments 同款"消息时解析"，apply 期不捕获服务实例）。
 */
export function createSessionCatalog(resolve: () => CatalogServices): SessionCatalogPort | undefined {
  if (resolve().workspaceRegistry === undefined) return undefined
  return {
    async list(project: string): Promise<readonly SessionCatalogEntry[]> {
      const {
        workspaceRegistry, sessions, sessionProjections, sessionTitle, sessionQuery, sessionProjectionCache,
      } = resolve()
      if (workspaceRegistry === undefined) throw new Error('workspaceRegistry 服务不可用')
      const workspace = await workspaceRegistry.create(project)
      // 冷会话 header 目录（web session.list 同源索引读）：投影缓存身份见证 + cwd 回退来源。
      const headers = new Map<string, CatalogSessionHeader>()
      if (sessionQuery !== undefined) {
        for (const record of await sessionQuery.listSessions()) {
          headers.set(String(record.header.id), record.header)
        }
      }
      return workspace.sessionIds.map((id) => {
        const live = sessions?.get(id)
        if (live !== undefined) {
          const title = sessionProjections?.cachedSnapshot(live)?.values.title
            ?? sessionTitle?.get(live)?.title
          return { sessionId: String(id), title: displayTitleOf(title, live.header?.cwd, id) }
        }
        const header = headers.get(String(id))
        const title = header !== undefined && !header.isSeeded && sessionProjectionCache !== undefined
          ? coldTitle(sessionProjectionCache, header)
          : undefined
        return { sessionId: String(id), title: displayTitleOf(title, header?.cwd, id) }
      })
    },
  }
}
