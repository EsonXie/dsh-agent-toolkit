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

// 本插件自有事件的类型化（"typed events use declaration merging"规约）：
// 声明合并目标分别是 dsh-session 的 SessionEventMap（先例 interaction/permission-presets/
// src/index.ts:42）与 dsh-session-projection 的 SessionProjectionMap（先例 session/
// session-title/src/types.ts）。team/selected 为 log-only 事件，不入模型 transcript。

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 团队切换成功时追加的会话事件：记录目标团队 id。 */
    'team/selected': { team: string }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 当前团队选择投影：dock 下拉的唯一数据源。 */
    'team': TeamProjection
  }
}
