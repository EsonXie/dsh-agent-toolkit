/** usage 会话标题栏入口：utilities 区图标按钮（Tooltip「Token 用量」），点击打开用量模态框。 */
import { useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// 触发 ui-conversation 对 SlotMap 的声明合并（conversation.session.header.utilities 键）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconDataOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { UsageModal } from './UsageModal.tsx'
import css from './entry.module.css'

export function UsageEntry(_props: PropsRuntime<'conversation.session.header.utilities'>): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip label="Token 用量" delayMs={500}>
        <button type="button" className={css.trigger} aria-label="Token 用量" onClick={() => { setOpen(true) }}>
          <IconDataOutline16 size={18} />
        </button>
      </Tooltip>
      <UsageModal open={open} onClose={() => { setOpen(false) }} />
    </>
  )
}
