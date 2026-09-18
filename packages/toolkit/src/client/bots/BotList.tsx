/** Bot 列表（归属某个 Agent 卡片）：行级名称/项目路径/连接状态 + 编辑/删除（两段确认）。 */
import { useState, type ReactNode } from 'react'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { deleteBot, type BotListItem } from './api.ts'
import css from './bots.module.css'

/** 连接状态 → StateDot 四色语义：正常绿 / 过渡蓝跑马 / 非故障停止琥珀 / 故障红。 */
const STATUS_DOT: Record<string, StateDotState> = {
  connected: 'done',
  connecting: 'ongoing',
  reconnecting: 'ongoing',
  idle: 'warning',
  failed: 'error',
  'not-running': 'warning',
  unbound: 'warning',
}

const STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  idle: '空闲',
  failed: '连接失败',
  'not-running': '未运行',
  unbound: '未绑定',
}

export interface BotListProps {
  bots: BotListItem[]
  onEdit: (bot: BotListItem) => void
  /** 删除成功后父级 reload + toast。 */
  onDeleted: () => void
}

export function BotList({ bots, onEdit, onDeleted }: BotListProps): ReactNode {
  /** 两段确认：记录待删行 id；点其它行转移，执行后清空。 */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  async function remove(bot: BotListItem): Promise<void> {
    if (confirmDeleteId !== bot.id) {
      setConfirmDeleteId(bot.id)
      setDeleteError(null)
      return
    }
    setDeletingId(bot.id)
    try {
      await deleteBot(bot.id)
      setConfirmDeleteId(null)
      onDeleted()
    } catch (e) {
      setDeleteError(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <>
      {bots.map((bot) => (
        <div key={bot.id} data-testid="bot-row" className={css.botRow}>
          <span className={css.botName}>{bot.name}</span>
          <span className={css.botProject}>{bot.project}</span>
          <span className={css.status} title={STATUS_LABEL[bot.status] ?? bot.status}>
            <StateDot state={STATUS_DOT[bot.status] ?? 'warning'} size={8} />
            <span>{STATUS_LABEL[bot.status] ?? bot.status}</span>
          </span>
          <button type="button" className={css.botEdit}
            onClick={() => { setConfirmDeleteId(null); onEdit(bot) }}>
            编辑
          </button>
          <button type="button" className={css.botDelete} disabled={deletingId !== null}
            onClick={() => { void remove(bot) }}>
            {confirmDeleteId === bot.id ? '确认删除？' : '删除'}
          </button>
        </div>
      ))}
      {deleteError !== null && <p role="alert" className={css.error}>{deleteError}</p>}
    </>
  )
}
