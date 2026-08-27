/** 侧边栏底栏入口工厂：宽栏窄栏统一仅图标 + Tooltip，点击经 renderModal 打开模态框。 */
import { useState, type ComponentType, type ReactNode } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './entry.module.css'

export interface SidebarEntryDeps<Extra = Record<never, never>> {
  /** slot 注册元数据（sidebar.footer.action 的 id），由调用方消费。 */
  id: string
  /** slot 注册元数据（sidebar.footer.action 的 order），由调用方消费。 */
  order: number
  icon: ReactNode
  title: string
  /** renderModal 除 open/onClose 外还可经 Extra 透传入口组件额外 props（如运行时 share）。 */
  renderModal: (props: { open: boolean; onClose: () => void } & Extra) => ReactNode
}

export function createSidebarEntry<Extra extends object = Record<never, never>>(
  deps: SidebarEntryDeps<Extra>,
): ComponentType<{ wide: boolean } & Extra> {
  const { icon, title, renderModal } = deps
  return function SidebarEntry(props: { wide: boolean } & Extra): ReactNode {
    const { wide } = props
    // 交集 {wide} & Extra 可赋值给 Extra（成员交集子类型），透传其余 props 给 renderModal。
    const extra: Extra = props
    const [open, setOpen] = useState(false)
    return (
      <>
        <Tooltip label={title} delayMs={500}>
          <button
            type="button"
            className={clsx(css.trigger, !wide && css.rail)}
            aria-label={title}
            onClick={() => { setOpen(true) }}
          >
            {icon}
          </button>
        </Tooltip>
        {renderModal({ open, onClose: () => { setOpen(false) }, ...extra })}
      </>
    )
  }
}
