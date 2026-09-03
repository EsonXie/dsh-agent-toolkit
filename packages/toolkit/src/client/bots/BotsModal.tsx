/** 机器人管理模态框：列表视图（按项目分组）+ 创建/编辑表单视图。 */
import { useState, type ReactNode } from 'react'
import {
  Button, Modal, Pill, StateDot, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useLoadState } from '../shared/load-state.ts'
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

type View = 'list' | { mode: 'create' } | { mode: 'edit'; bot: BotListItem }

const STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  idle: '空闲',
  failed: '连接失败',
  'not-running': '未运行',
  unbound: '未绑定',
}

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

export function BotsModal({ open, onClose, useWorkspaces, onEdit, onCreate }: BotsModalProps): ReactNode {
  return (
    <Modal open={open} onClose={onClose} title="消息机器人" closeLabel="关闭" className={css.dialog}>
      {open && <BotsModalBody useWorkspaces={useWorkspaces} onEdit={onEdit} onCreate={onCreate} />}
    </Modal>
  )
}

function BotsModalBody({ useWorkspaces, onEdit, onCreate }: Omit<BotsModalProps, 'open' | 'onClose'>): ReactNode {
  const [view, setView] = useState<View>('list')
  /** 打开即拉取（body 随 open 全新挂载，天然复位）；保存后 reload 重拉。 */
  const { state, reload } = useLoadState<BotListItem[]>(() => fetchBots(), [])

  const groups = new Map<string, BotListItem[]>()
  if (state.kind === 'ok') {
    for (const bot of state.data) {
      const list = groups.get(bot.project) ?? []
      list.push(bot)
      groups.set(bot.project, list)
    }
  }

  return (
    <>
      {view === 'list' ? (
        <>
          {state.kind === 'loading' && <p>加载中…</p>}
          {state.kind === 'error' && <p>加载失败，请重试</p>}
          {state.kind === 'ok' && state.data.length === 0 && <p>还没有机器人，点击「新建机器人」开始。</p>}
          {state.kind === 'ok' && [...groups.entries()].map(([project, bots]) => (
            <section key={project} className={css.group}>
              <h3 className={css.groupTitle}>{project}</h3>
              {bots.map((bot) => (
                <button key={bot.id} type="button" className={css.botRow}
                  onClick={() => { onEdit !== undefined ? onEdit(bot) : setView({ mode: 'edit', bot }) }}>
                  <span className={css.botName}>{bot.name}</span>
                  {/* 渠道徽标：仅已绑定（feishu 存在）的 bot 显示 */}
                  {bot.feishu !== undefined && <Pill className={css.channelBadge}>飞书</Pill>}
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
          onSaved={() => { reload(); setView('list') }}
          onCancel={() => { setView('list') }}
        />
      )}
    </>
  )
}
