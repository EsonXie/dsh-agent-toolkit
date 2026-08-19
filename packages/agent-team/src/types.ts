/** 团队选择的持久事件与投影契约（纯类型，Node 半/浏览器半/测试共用）。 */

/** 团队切换成功时追加的会话事件类型。 */
export const TEAM_SELECTED_EVENT = 'team/selected'

/** 投影中的可选项：id + 一句话摘要（首角色 description）。 */
export interface TeamOption {
  readonly id: string
  readonly summary: string
}

/** `team` 会话投影的视图：dock 下拉的唯一数据源。 */
export interface TeamProjection {
  readonly currentId: string
  readonly options: readonly TeamOption[]
}
