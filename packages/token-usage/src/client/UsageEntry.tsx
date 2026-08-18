/** Sidebar footer entry: wide icon+label row vs rail icon-only; opens the usage modal. */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconDataOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { UsageModal } from './UsageModal.tsx'
import css from './UsageEntry.module.css'

export interface UsageEntryProps {
  /** Owner share from the sidebar shell: wide content vs 56px rail. */
  wide: boolean
}

export function UsageEntry({ wide }: UsageEntryProps): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* Wide rows carry their own label — tooltip only on the rail (mirrors
          the built-in New Session button's behavior). */}
      <Tooltip label="Token 用量" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-label="Token 用量"
          onClick={() => { setOpen(true) }}
        >
          <IconDataOutline16 size={wide ? 16 : 18} />
          {wide && <span className={css.triggerLabel}>Token 用量</span>}
        </button>
      </Tooltip>
      <UsageModal open={open} onClose={() => { setOpen(false) }} initialDate={null} />
    </>
  )
}
