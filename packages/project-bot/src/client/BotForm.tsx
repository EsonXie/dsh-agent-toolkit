/** 机器人创建/编辑表单占位：Task 16 整体替换为真实 BotForm。 */
import type { ReactNode } from 'react'
import type { UseWorkspaces } from './BotsModal.tsx'
import type { BotListItem } from './api.ts'

export interface BotFormProps {
  useWorkspaces: UseWorkspaces
  bot?: BotListItem
  onSaved: () => void
  onCancel: () => void
}

export function BotForm(props: BotFormProps): ReactNode {
  return <p>表单</p>
}
