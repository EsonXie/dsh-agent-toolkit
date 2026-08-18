/** 会话头"Token 用量"按钮：点击打开用量模态框。 */
import { useState, type ReactNode } from 'react'
import { UsageModal } from './UsageModal.tsx'

export function UsageButton(): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" title="Token 用量" onClick={() => setOpen(true)}>📊</button>
      <UsageModal open={open} onClose={() => setOpen(false)} initialDate={null} />
    </>
  )
}
