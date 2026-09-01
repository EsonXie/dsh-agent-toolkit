/** 委派路由查询封装（fetch → Node 半 /api/delegate 路由）。 */
export interface DelegateRoute {
  provider: string
  model: string
}

/** GET /delegate/active：运行中委派的已解析路由；404/失败 → null（不渲染 chip）。 */
export async function fetchActiveRoute(sessionId: string, role: string): Promise<DelegateRoute | null> {
  const res = await fetch(`/dsh-agent-toolkit/api/delegate/active?session=${encodeURIComponent(sessionId)}&role=${encodeURIComponent(role)}`)
  if (!res.ok) return null
  return res.json() as Promise<DelegateRoute>
}

/** GET /delegate/route：子会话的持久委派路由；404/失败 → null。 */
export async function fetchChildRoute(sessionId: string): Promise<DelegateRoute | null> {
  const res = await fetch(`/dsh-agent-toolkit/api/delegate/route?session=${encodeURIComponent(sessionId)}`)
  if (!res.ok) return null
  return res.json() as Promise<DelegateRoute>
}
