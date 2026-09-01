/** 子会话头部模型 chip：仅子会话渲染；数据来自插件持久委派路由（委派时解析的值，全程一致）。 */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 触发 dsh-client-ui-conversation 对 SlotMap 的声明合并（header.utilities 槽位类型）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { fetchChildRoute, type DelegateRoute } from '../delegate/api.ts'
import type { NS } from '../delegate/locales.ts'
import css from './subagent-model.module.css'

export type SubagentModelChipProps =
  PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS>

export function SubagentModelChip({ sessionId, useSession, t }: SubagentModelChipProps) {
  const subagent = useSession(s => s.subagent)
  const [route, setRoute] = useState<DelegateRoute | null>(null)
  const isSubagent = subagent !== null
  useEffect(() => {
    if (!isSubagent) return
    let cancelled = false
    void fetchChildRoute(String(sessionId))
      .then((r) => { if (!cancelled) setRoute(r) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [sessionId, isSubagent])
  if (!isSubagent || route === null) return null
  const text = `${route.provider} / ${route.model}`
  return <span className={css.chip} aria-label={t('header.modelAria', { route: text })}>{text}</span>
}
