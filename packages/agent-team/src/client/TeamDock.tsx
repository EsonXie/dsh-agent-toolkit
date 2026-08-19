/** 团队选择 dock：blank 期可切，首条消息后锁定；数据来自插件 HTTP 端点（fetch 封装经 inject 面注入）。 */
import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TeamStateView } from '../types.ts'
import css from './TeamDock.module.css'

/** inject 面：团队状态读取与切换提交。 */
export interface TeamDockInjected {
  /** 读当前团队状态；非团队会话（插件未挂载）返回 null。 */
  readonly fetchState: () => Promise<TeamStateView | null>
  /** 提交团队选择；失败 reject（错误文本为宿主返回的 error）。 */
  readonly selectTeam: (team: string) => Promise<TeamStateView>
}

export type TeamDockProps = PropsRuntime<'conversation.input.dock'> & TeamDockInjected

export function TeamDock({ useSession, fetchState, selectTeam }: TeamDockProps) {
  const blank = useSession(s => s.blank)
  const [view, setView] = useState<TeamStateView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    fetchState()
      .then(v => { if (live) { setView(v); setLoaded(true) } })
      .catch(() => { if (live) setLoaded(true) }) // 端点故障等同无团队：不渲染
      return () => { live = false }
  }, [fetchState])
  if (!loaded || view === null) return null
  const onChange = (team: string) => {
    setError(null)
    // select 是受控组件：成功前 view 不变即视觉回退；失败仅提示。
    selectTeam(team).then(setView).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
    })
  }
  return (
    <div className={css.dock}>
      <span className={css.label}>团队</span>
      <select
        className={css.select}
        value={view.currentId}
        disabled={!blank}
        title={blank ? (error ?? '选择本会话使用的团队') : '会话已开始，团队已锁定'}
        onChange={event => onChange(event.target.value)}
      >
        {view.options.map(option => (
          <option key={option.id} value={option.id}>{option.id} · {option.summary}</option>
        ))}
      </select>
    </div>
  )
}
