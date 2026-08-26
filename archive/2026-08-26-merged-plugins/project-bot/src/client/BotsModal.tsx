/** 机器人管理模态框：列表视图（按项目分组）+ 创建/编辑表单视图。 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  Button, Modal, Pill, StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchBots, type BotListItem } from './api.ts'
import { BotForm } from './BotForm.tsx'
import css from './bots.module.css'

/** useWorkspaces 的窄化类型（框架注入；selector 读 WorkspaceListState）。 */
export type UseWorkspaces = <S>(selector: (state: { items: readonly unknown[] }) => S) => S

export interface BotsModalProps {
  open: boolean
  onClose: () => void
  useWorkspaces: UseWorkspaces
  /** 测试注入点；缺省走内部视图状态机。 */
  onEdit?: (bot: BotListItem) => void
  onCreate?: () => void
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; bots: BotListItem[] }

type View = 'list' | { mode: 'create' } | { mode: 'edit'; bot: BotListItem }

const STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  idle: '空闲',
  failed: '连接失败',
  'not-running': '未运行',
}

/** 连接状态 → StateDot 四色语义：正常绿 / 过渡蓝跑马 / 非故障停止琥珀 / 故障红。 */
const STATUS_DOT: Record<string, StateDotState> = {
  connected: 'done',
  connecting: 'ongoing',
  reconnecting: 'ongoing',
  idle: 'warning',
  failed: 'error',
  'not-running': 'warning',
}

export function BotsModal({ open, onClose, useWorkspaces, onEdit, onCreate }: BotsModalProps): ReactNode {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [view, setView] = useState<View>('list')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!open) return
    setView('list')
  }, [open])

  useEffect(() => {
    if (!open) return
    let stale = false
    setState({ status: 'loading' })
    fetchBots()
      .then((bots) => { if (!stale) setState({ status: 'ok', bots }) })
      .catch(() => { if (!stale) setState({ status: 'error' }) })
    return () => { stale = true }
  }, [open, reload])

  const groups = new Map<string, BotListItem[]>()
  if (state.status === 'ok') {
    for (const bot of state.bots) {
      const list = groups.get(bot.project) ?? []
      list.push(bot)
      groups.set(bot.project, list)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="消息机器人" closeLabel="关闭" className={css.dialog}>
      {view === 'list' ? (
        <>
          {state.status === 'loading' && <p>加载中…</p>}
          {state.status === 'error' && <p>加载失败，请重试</p>}
          {state.status === 'ok' && state.bots.length === 0 && <p>还没有机器人，点击「新建机器人」开始。</p>}
          {state.status === 'ok' && [...groups.entries()].map(([project, bots]) => (
            <section key={project} className={css.group}>
              <h3 className={css.groupTitle}>{project}</h3>
              {bots.map((bot) => (
                <button key={bot.id} type="button" className={css.botRow}
                  onClick={() => { onEdit !== undefined ? onEdit(bot) : setView({ mode: 'edit', bot }) }}>
                  <span className={css.botName}>{bot.name}</span>
                  <Pill className={css.channelBadge}>飞书</Pill>
                  <span className={css.status}>
                    <StateDot state={STATUS_DOT[bot.status] ?? 'warning'} size={8} />
                    <span>{STATUS_LABEL[bot.status] ?? bot.status}</span>
                  </span>
                </button>
              ))}
            </section>
          ))}
          <Button variant="primary" className={css.createButton}
            onClick={() => { onCreate !== undefined ? onCreate() : setView({ mode: 'create' }) }}>
            新建机器人
          </Button>
        </>
      ) : (
        <BotForm
          useWorkspaces={useWorkspaces}
          bot={view.mode === 'edit' ? view.bot : undefined}
          onSaved={() => { setReload((n) => n + 1); setView('list') }}
          onCancel={() => { setView('list') }}
        />
      )}
    </Modal>
  )
}
