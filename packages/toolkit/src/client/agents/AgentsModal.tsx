/** Agents 管理面板：左侧角色列表（main 置顶锁定 + 内置徽标）+ 右侧编辑器。 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLoadState } from '../shared/load-state.ts'
import { fetchAgents } from './api.ts'
import type { AgentRecord } from '../../agents/store.ts'
import { AgentEditor } from './AgentEditor.tsx'
import css from './agents.module.css'

export interface AgentsModalProps {
  open: boolean
  onClose: () => void
  /** 测试注入点；缺省走内部视图状态机。 */
  onEdit?: (agent: AgentRecord) => void
  onCreate?: () => void
  onDelete?: (id: string) => void
}

export function AgentsModal({ open, onClose, onEdit, onCreate, onDelete }: AgentsModalProps): ReactNode {
  return (
    <Modal open={open} onClose={onClose} title="Agent 管理" closeLabel="关闭" className={css.dialog}>
      {open && <AgentsModalBody onEdit={onEdit} onCreate={onCreate} onDelete={onDelete} />}
    </Modal>
  )
}

function AgentsModalBody({ onEdit, onCreate, onDelete }: Omit<AgentsModalProps, 'open' | 'onClose'>): ReactNode {
  /** 打开即拉取（body 随 open 全新挂载，天然复位）；保存后 reload 重拉。 */
  const { state, reload } = useLoadState<AgentRecord[]>(fetchAgents, [])
  const [selectedId, setSelectedId] = useState('main')
  const [creating, setCreating] = useState(false)

  const agents = state.kind === 'ok' ? state.data : []
  const selected = creating ? undefined : agents.find((a) => a.id === selectedId)

  function handleSelect(agent: AgentRecord): void {
    if (onEdit !== undefined) { onEdit(agent); return }
    setCreating(false)
    setSelectedId(agent.id)
  }

  function handleNew(): void {
    if (onCreate !== undefined) { onCreate(); return }
    setCreating(true)
  }

  function handleSaved(saved: AgentRecord): void {
    setCreating(false)
    setSelectedId(saved.id)
    reload()
  }

  function handleDeleted(id: string): void {
    if (onDelete !== undefined) { onDelete(id); return }
    setCreating(false)
    setSelectedId('main')
    reload()
  }

  return (
    <div className={css.split}>
      <div className={css.listPane}>
        {state.kind === 'loading' && <p className={css.hint}>加载中…</p>}
        {state.kind === 'error' && <p className={css.hint}>加载失败，请重试</p>}
        {state.kind === 'ok' && agents.map((agent) => (
          <button key={agent.id} type="button"
            className={clsx(css.agentRow, agent.id === selectedId && !creating && css.agentRowActive)}
            onClick={() => { handleSelect(agent) }}>
            <span className={css.agentName}>
              {agent.name}
              {agent.id === 'main' && <span className={css.lock} title="主 Agent 不可删除">锁定</span>}
            </span>
            {agent.builtin === true && <Pill className={css.builtinBadge}>内置</Pill>}
            {agent.description !== undefined && <span className={css.agentDesc}>{agent.description}</span>}
          </button>
        ))}
        <Button variant="primary" className={css.createButton} onClick={handleNew}>新建角色</Button>
      </div>
      <div className={css.editorPane}>
        {state.kind === 'ok' ? (
          <AgentEditor
            // 按选中对象重挂：切换角色 / 新建时 reset 内部 form 状态（useState 只读挂载时 props）。
            key={selected === undefined ? '__new__' : selected.id}
            agent={selected}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
            onCancel={creating ? () => { setCreating(false) } : undefined}
          />
        ) : (
          <p className={css.hint}>{state.kind === 'loading' ? '加载中…' : '加载失败，请重试'}</p>
        )}
      </div>
    </div>
  )
}
