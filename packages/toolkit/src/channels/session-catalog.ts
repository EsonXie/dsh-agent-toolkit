/** /sessions 候选目录真实适配器：workspaceRegistry 候选 + live 会话标题（三服务均为可选，惰性解析）。 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionCatalogEntry, SessionCatalogPort } from './ports.ts'

/** 结构化窄接口：只声明用到的成员（与 bots/index.ts 的 WorkspaceRegistryLike 同款模式）。 */
export interface CatalogWorkspaceRegistry {
  create(path: string): Promise<{ sessionIds: readonly SessionId[] }>
}

/** 宿主 sessions 服务窄化：只取 live 会话（不 resume 未加载会话——仅为列表标题太贵）。 */
export interface CatalogSessions {
  get(id: SessionId): unknown | undefined
}

/** 宿主 sessionTitle 服务窄化。 */
export interface CatalogSessionTitle {
  get(session: unknown): { title: string } | undefined
}

export interface CatalogServices {
  workspaceRegistry: CatalogWorkspaceRegistry | undefined
  sessions: CatalogSessions | undefined
  sessionTitle: CatalogSessionTitle | undefined
}

/**
 * workspaceRegistry 缺席 = 环境不支持会话切换，返回 undefined（Inbound 降级文案）。
 * resolve 在取用与每次 list 时调用（attachments 同款"消息时解析"，apply 期不捕获服务实例）。
 */
export function createSessionCatalog(resolve: () => CatalogServices): SessionCatalogPort | undefined {
  if (resolve().workspaceRegistry === undefined) return undefined
  return {
    async list(project: string): Promise<readonly SessionCatalogEntry[]> {
      const { workspaceRegistry, sessions, sessionTitle } = resolve()
      if (workspaceRegistry === undefined) throw new Error('workspaceRegistry 服务不可用')
      const workspace = await workspaceRegistry.create(project)
      return workspace.sessionIds.map((id) => {
        const session = sessions?.get(id)
        const title = session !== undefined ? sessionTitle?.get(session)?.title : undefined
        return title !== undefined
          ? { sessionId: String(id), title }
          : { sessionId: String(id) }
      })
    },
  }
}
