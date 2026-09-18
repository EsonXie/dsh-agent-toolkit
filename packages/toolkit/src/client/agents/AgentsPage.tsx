/** Agents 设置页：Agent 卡片流（main 置顶只读），卡内挂 Bot 列表；编辑/新建内联展开。 */
import { useMemo, useState, type ReactNode } from 'react'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentRecord } from '../../agents/store.ts'
import { deleteAgent, fetchAgents } from './api.ts'
import { fetchBots, type BotListItem } from '../bots/api.ts'
import { BotList } from '../bots/BotList.tsx'
import { BotForm } from '../bots/BotForm.tsx'
import { useLoadState } from '../shared/load-state.ts'
import { useToast } from '../shared/feedback.tsx'
import { AgentEditor } from './AgentEditor.tsx'
import css from './agents.module.css'

/** 编辑器底部 SaveBar 文案；Task 12 统一收口进 settings 词典。 */
const SAVE_LABELS = { save: '保存', cancel: '取消', saved: '已保存' }

export function AgentsPage(props: {
  /** 宽松签名；Task 12 接线时收紧为 ToolkitKey。 */
  t: (key: string) => string
  useWorkspaces: <S>(selector: (state: { items: readonly unknown[] }) => S) => S
}): ReactNode {
  const { showToast, toastNode } = useToast()
  const { state, reload } = useLoadState(
    () => Promise.all([fetchAgents(), fetchBots()]).then(([agents, bots]) => ({ agents, bots })),
    [],
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  /** 新建 Bot 归属的卡片；与 botEditing 互斥。 */
  const [botAddingFor, setBotAddingFor] = useState<string | null>(null)
  const [botEditing, setBotEditing] = useState<{ agentId: string; bot: BotListItem } | null>(null)

  const botsByAgent = useMemo(() => {
    const map = new Map<string, BotListItem[]>()
    if (state.kind === 'ok') {
      for (const bot of state.data.bots) {
        const ref = bot.agentRef ?? 'main'
        map.set(ref, [...(map.get(ref) ?? []), bot])
      }
    }
    return map
  }, [state])

  function handleSaved(): void {
    setEditingId(null)
    reload()
    showToast(props.t('feedback.saved'))
  }

  function handleBotSaved(): void {
    setBotAddingFor(null)
    setBotEditing(null)
    reload()
    showToast(props.t('feedback.saved'))
  }

  function handleBotDeleted(): void {
    reload()
    showToast(props.t('feedback.deleted'))
  }

  async function remove(agent: AgentRecord): Promise<void> {
    if (confirmDeleteId !== agent.id) {
      setConfirmDeleteId(agent.id)
      setDeleteError(null)
      return
    }
    setDeletingId(agent.id)
    setDeleteError(null)
    try {
      await deleteAgent(agent.id)
      setConfirmDeleteId(null)
      reload()
    } catch (e) {
      // 服务端 409 载荷 { error, bots }；优先 Bot 数量提示，否则回退 error 字段可读文案。
      const message = e instanceof Error ? e.message : String(e)
      let bots: number | undefined
      let readable = message
      try {
        const parsed: unknown = JSON.parse(message)
        if (typeof parsed === 'object' && parsed !== null) {
          const record = parsed as { bots?: unknown; error?: unknown }
          if (typeof record.bots === 'number') bots = record.bots
          if (typeof record.error === 'string' && record.error.length > 0) readable = record.error
        }
      } catch { /* 非 JSON 错误体：按原文展示 */ }
      setDeleteError(bots === undefined
        ? `删除失败：${readable}`
        : `无法删除：名下仍有 ${bots} 个 Bot，请先删除或移出这些 Bot`)
    } finally {
      setDeletingId(null)
    }
  }

  if (state.kind === 'loading') return <p>加载中…</p>
  if (state.kind === 'error') return <p role="alert">{state.message}</p>

  const renderEditor = (agent?: AgentRecord): ReactNode => (
    <div className={css.editorWrap}>
      <AgentEditor
        key={agent === undefined ? '__new__' : agent.id}
        agent={agent}
        labels={SAVE_LABELS}
        onSaved={handleSaved}
        onCancel={() => { setEditingId(null) }}
      />
    </div>
  )

  const renderBotForm = (agentId: string, bot?: BotListItem): ReactNode => (
    <div className={css.editorWrap}>
      <BotForm
        key={bot === undefined ? `__new__:${agentId}` : bot.id}
        agentRef={agentId}
        bot={bot}
        useWorkspaces={props.useWorkspaces}
        onSaved={handleBotSaved}
        onCancel={() => { setBotAddingFor(null); setBotEditing(null) }}
      />
    </div>
  )

  return (
    <div className={css.cards}>
      {toastNode}
      {deleteError !== null && <p role="alert" className={css.error}>{deleteError}</p>}
      {editingId === '__new__' && renderEditor()}
      {state.data.agents.map((agent) => {
        const isMain = agent.id === 'main'
        const bots = botsByAgent.get(agent.id) ?? []
        return (
          <div key={agent.id} data-testid="agent-card" className={css.card}>
            <div className={css.cardHead}>
              <span data-testid="agent-card-name" className={css.cardName}>{agent.name}</span>
              {agent.builtin === true && <Pill className={css.badge}>内置</Pill>}
              {agent.visibleInTeam === false && <Pill className={css.badge}>团队不可见</Pill>}
            </div>
            {isMain ? (
              <p className={css.readonlyNote}>使用宿主默认模型与装配</p>
            ) : (
              <>
                <p className={css.summary}>
                  {agent.model === undefined ? '模型：跟随默认' : `模型：${agent.model.provider}/${agent.model.model}`}
                  {' · '}
                  {agent.tools === undefined ? '工具：不限制' : `工具：白名单 ${agent.tools.allow.length} 项`}
                  {' · '}
                  {`Bot：${bots.length}`}
                </p>
                <div className={css.cardActions} data-testid="agent-card-actions">
                  <Button variant="outline" onClick={() => {
                    setEditingId(editingId === agent.id ? null : agent.id)
                    setConfirmDeleteId(null)
                  }}>编辑</Button>
                  {/* 内置角色服务端恒拒删（registry.remove 抛错 → 409），不渲染必然失败的删除按钮。 */}
                  {agent.builtin !== true && (
                    <Button variant="outline" className={css.dangerButton} disabled={deletingId !== null}
                      onClick={() => { void remove(agent) }}>
                      {confirmDeleteId === agent.id ? '确认删除？' : '删除'}
                    </Button>
                  )}
                </div>
              </>
            )}
            <div className={css.botList}>
              <BotList
                bots={bots}
                onEdit={(bot) => { setBotAddingFor(null); setBotEditing({ agentId: agent.id, bot }) }}
                onDeleted={handleBotDeleted}
              />
              {botEditing !== null && botEditing.agentId === agent.id && renderBotForm(agent.id, botEditing.bot)}
              {botAddingFor === agent.id && renderBotForm(agent.id)}
              <div>
                <Button variant="outline" onClick={() => {
                  setBotEditing(null)
                  setBotAddingFor(botAddingFor === agent.id ? null : agent.id)
                }}>+ 添加 Bot</Button>
              </div>
            </div>
            {editingId === agent.id && renderEditor(agent)}
          </div>
        )
      })}
      <div>
        <Button variant="primary" onClick={() => { setEditingId('__new__'); setConfirmDeleteId(null) }}>新建角色</Button>
      </div>
    </div>
  )
}
