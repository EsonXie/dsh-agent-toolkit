/** 保存反馈共享件：顶部 toast（ui-primitives Toast）+ 编辑区底部保存条。 */
import { useCallback, useState, type ReactNode } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './feedback.module.css'

export function useToast(): { toastText: string | null; showToast: (text: string) => void; toastNode: ReactNode } {
  const [toastText, setToastText] = useState<string | null>(null)
  const showToast = useCallback((text: string) => { setToastText(text) }, [])
  const toastNode = toastText === null ? null : <Toast text={toastText} onDone={() => { setToastText(null) }} />
  return { toastText, showToast, toastNode }
}

export interface SaveBarLabels { save: string; cancel: string; saved: string }

export function SaveBar(props: {
  labels: SaveBarLabels
  dirty: boolean
  saving: boolean
  saved: boolean
  error?: string | null
  onSave: () => void
  onCancel: () => void
}): ReactNode {
  const { labels } = props
  return (
    <div className={css.bar}>
      {props.error != null && <span className={css.error} role="alert">{props.error}</span>}
      {props.saved && !props.dirty && <span className={css.saved}>{labels.saved}</span>}
      <span className={css.spacer} />
      <Button onClick={props.onCancel}>{labels.cancel}</Button>
      <Button variant="primary" disabled={!props.dirty || props.saving} onClick={props.onSave}>
        {props.saving ? `${labels.save}…` : labels.save}
      </Button>
    </div>
  )
}
