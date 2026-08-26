/** 侧边栏底栏入口工厂：宽栏图标+文字 / 窄栏仅图标，点击经 renderModal 打开模态框。 */
import { useState, type ComponentType, type ReactNode } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './entry.module.css'

export interface SidebarEntryDeps {
  /** slot 注册元数据（sidebar.footer.action 的 id），由调用方消费。 */
  id: string
  /** slot 注册元数据（sidebar.footer.action 的 order），由调用方消费。 */
  order: number
  icon: ReactNode
  title: string
  renderModal: (props: { open: boolean; onClose: () => void }) => ReactNode
}

export function createSidebarEntry(deps: SidebarEntryDeps): ComponentType<{ wide: boolean }> {
  const { icon, title, renderModal } = deps
  return function SidebarEntry({ wide }: { wide: boolean }): ReactNode {
    const [open, setOpen] = useState(false)
    return (
      <>
        {/* 宽栏自带文字标签——仅窄栏显示 tooltip（与内置 New Session 按钮一致）。 */}
        <Tooltip label={title} delayMs={500} disabled={wide}>
          <button
            type="button"
            className={clsx(css.trigger, !wide && css.rail)}
            aria-label={title}
            onClick={() => { setOpen(true) }}
          >
            {icon}
            {wide && <span className={css.triggerLabel}>{title}</span>}
          </button>
        </Tooltip>
        {renderModal({ open, onClose: () => { setOpen(false) } })}
      </>
    )
  }
}
