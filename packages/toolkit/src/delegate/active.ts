/** 在途委派路由表：运行中委派卡模型 chip 的数据源（进程内，HMR/重启即清空，settle 后由 presentationMeta 兜底）。 */

/** 一条已解析的委派路由（委派时确定，全程一致）。 */
export interface DelegateRoute {
  readonly provider: string
  readonly model: string
}

export interface ActiveRoutes {
  /** startRun 前写入；同 key 并发委派后写覆盖（纯展示，可接受）。 */
  set(parentSessionId: string, roleId: string, route: DelegateRoute): void
  /** 端点读取；无条目返回 undefined。 */
  get(parentSessionId: string, roleId: string): DelegateRoute | undefined
  /** try/finally 删除（startRun 抛错、settle 成功/出错都删）。 */
  delete(parentSessionId: string, roleId: string): void
}

export function createActiveRoutes(): ActiveRoutes {
  const map = new Map<string, DelegateRoute>()
  const key = (sessionId: string, roleId: string): string => `${sessionId}:${roleId}`
  return {
    set: (sessionId, roleId, route) => { map.set(key(sessionId, roleId), route) },
    get: (sessionId, roleId) => map.get(key(sessionId, roleId)),
    delete: (sessionId, roleId) => { map.delete(key(sessionId, roleId)) },
  }
}
