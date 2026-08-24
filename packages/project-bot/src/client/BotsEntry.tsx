/** 侧边栏底栏入口：宽栏图标+文字 / 窄栏仅图标；点击开机器人管理模态框。 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconAgentPresetOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { BotsModal, type BotsModalProps } from './BotsModal.tsx'
import css from './bots.module.css'

export interface BotsEntryProps {
  /** slot owner share：宽栏内容 vs 56px 窄栏。 */
  wide: boolean
  /** 框架注入的 workspace 列表 hook（PropsRuntime 派生）。 */
  useWorkspaces: BotsModalProps['useWorkspaces']
}

export function BotsEntry({ wide, useWorkspaces }: BotsEntryProps): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip label="消息机器人" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-label="消息机器人"
          onClick={() => { setOpen(true) }}
        >
          <IconAgentPresetOutline16 size={wide ? 16 : 18} />
          {wide && <span className={css.triggerLabel}>消息机器人</span>}
        </button>
      </Tooltip>
      <BotsModal open={open} onClose={() => { setOpen(false) }} useWorkspaces={useWorkspaces} />
    </>
  )
}
