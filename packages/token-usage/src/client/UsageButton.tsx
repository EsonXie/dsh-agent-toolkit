/** 会话头"Token 用量"按钮：点击弹窗；执行 /token-usage 命令后自动弹窗。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { UseConversationSession } from '@deepseek-ai/dsh-client-runtime/client'
import { UsageModal } from './UsageModal.tsx'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface UsageButtonProps {
  useSession: UseConversationSession
}

export function UsageButton({ useSession }: UsageButtonProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState<string | null>(null)
  const handledSeq = useRef(0)

  const lastCommand = useSession((s) => {
    for (let i = s.nodes.length - 1; i >= 0; i -= 1) {
      const n = s.nodes[i]
      if (n.kind === 'command' && n.name === 'token-usage') return n
    }
    return null
  })

  useEffect(() => {
    if (lastCommand === null || lastCommand.outcome === null) return
    if (lastCommand.seq <= handledSeq.current) return
    handledSeq.current = lastCommand.seq
    const arg = lastCommand.args?.trim() ?? ''
    setDate(DATE_RE.test(arg) ? arg : null)
    setOpen(true)
  }, [lastCommand])

  return (
    <>
      <button type="button" title="Token 用量" aria-label="Token 用量" onClick={() => { setDate(null); setOpen(true) }}>📊</button>
      <UsageModal open={open} onClose={() => setOpen(false)} initialDate={date} />
    </>
  )
}
