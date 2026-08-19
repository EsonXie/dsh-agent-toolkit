/** 团队选择的 HTTP wire 契约（纯类型，Node 半/浏览器半/测试共用）。 */

/** 可选团队：id + 一句话摘要（首角色 description）。 */
export interface TeamOption {
  readonly id: string
  readonly summary: string
}

/** GET /agent-team/<sessionId>/state 与 POST /agent-team/<sessionId>/select 的响应体。 */
export interface TeamStateView {
  readonly currentId: string
  readonly options: readonly TeamOption[]
}

/** POST /agent-team/<sessionId>/select 的请求体。 */
export interface SelectTeamRequest {
  readonly team: string
}
