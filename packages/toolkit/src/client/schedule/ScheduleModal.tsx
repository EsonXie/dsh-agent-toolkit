/** 定时任务管理模态框：任务列表（行内开关/编辑/删除两段确认/立即触发）+ 运行历史展开。 */
import { useState, type ReactNode } from 'react'
import { Button, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useLoadState } from '../shared/load-state.ts'
import { deleteTask, fetchRuns, fetchTasks, triggerTask, updateTask, type CronRun, type CronTaskView } from './api.ts'
import type { NS } from './locales.ts'
import type { ScheduleTaskDraft } from './TaskForm.types.ts'
import css from './schedule.module.css'

type T = PropsLocale<typeof NS>['t']

export interface ScheduleModalProps {
  open: boolean
  onClose: () => void
  /** 打开运行历史对应会话（sessions.open 包装）。 */
  openSession: (sessionId: string) => void
  t: T
  /** 测试注入点；缺省走内部视图状态机（Task 12 接 TaskForm）。 */
  onEdit?: (task: CronTaskView) => void
  onCreate?: () => void
  /** Task 12 注入：渲染创建/编辑表单（draft 缺省 = 新建）。 */
  renderForm?: (draft: ScheduleTaskDraft | undefined, onSaved: () => void, onCancel: () => void) => ReactNode
}

type View = 'list' | { mode: 'create' } | { mode: 'edit'; task: CronTaskView }

/** 调度规则摘要（列表行内一行）。 */
export function scheduleSummary(task: CronTaskView): string {
  switch (task.schedule.kind) {
    case 'cron':
      return `cron: ${task.schedule.expr}${task.schedule.timeZone !== undefined ? ` (${task.schedule.timeZone})` : ''}`
    case 'at':
      return `at: ${new Date(task.schedule.at).toLocaleString()}`
    case 'every':
      return `every ${task.schedule.seconds}s`
  }
}

const RUN_STATUS_KEY: Record<CronRun['status'], 'run.ok' | 'run.error' | 'run.running' | 'run.skipped-overlap'> = {
  ok: 'run.ok',
  error: 'run.error',
  running: 'run.running',
  'skipped-overlap': 'run.skipped-overlap',
}

export function ScheduleModal(props: ScheduleModalProps): ReactNode {
  return (
    <Modal open={props.open} onClose={props.onClose} title={props.t('modal.title')} closeLabel={props.t('modal.close')} className={css.dialog}>
      {props.open && <ScheduleModalBody {...props} />}
    </Modal>
  )
}

function ScheduleModalBody({ onClose: _onClose, ...props }: ScheduleModalProps): ReactNode {
  const { t, openSession } = props
  const [view, setView] = useState<View>('list')
  const { state, reload } = useLoadState<CronTaskView[]>(() => fetchTasks(), [])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  async function remove(task: CronTaskView): Promise<void> {
    if (confirmDeleteId !== task.id) {
      setConfirmDeleteId(task.id)
      setError(null)
      return
    }
    try {
      await deleteTask(task.id)
      setConfirmDeleteId(null)
      reload()
    } catch (e) {
      setError(t('list.deleteFailed', { message: e instanceof Error ? e.message : String(e) }))
    }
  }

  async function toggleEnabled(task: CronTaskView): Promise<void> {
    try {
      await updateTask(task.id, { enabled: !task.enabled })
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function trigger(task: CronTaskView): Promise<void> {
    try {
      await triggerTask(task.id)
      reload()
    } catch (e) {
      setError(t('list.triggerFailed', { message: e instanceof Error ? e.message : String(e) }))
    }
  }

  if (view !== 'list' && props.renderForm !== undefined) {
    return <>{props.renderForm(
      view.mode === 'edit' ? view.task : undefined,
      () => { reload(); setView('list') },
      () => { setView('list') },
    )}</>
  }

  return (
    <>
      {state.kind === 'loading' && <p>{t('list.loading')}</p>}
      {state.kind === 'error' && <p>{t('list.error')}</p>}
      {state.kind === 'ok' && state.data.length === 0 && <p>{t('list.empty')}</p>}
      {state.kind === 'ok' && state.data.map((task) => (
        <div key={task.id}>
          <div className={css.row}>
            <input
              type="checkbox"
              aria-label={task.name}
              checked={task.enabled}
              onChange={() => { void toggleEnabled(task) }}
            />
            <button type="button" className={css.main}
              onClick={() => { setConfirmDeleteId(null); props.onEdit !== undefined ? props.onEdit(task) : setView({ mode: 'edit', task }) }}>
              <span className={css.name}>{task.name}</span>
              <span className={css.meta}>
                <span>{scheduleSummary(task)}</span>
                {' · '}
                <span>{task.target.kind === 'main' ? t('list.targetMain') : t('list.targetRole', { roleId: task.target.roleId })}</span>
                {' · '}
                <span>{task.enabled && task.nextRunAt !== null
                  ? t('list.nextRun', { time: new Date(task.nextRunAt).toLocaleString() })
                  : t('list.noNextRun')}</span>
              </span>
            </button>
            {task.lastRun !== undefined && <Pill>{t(RUN_STATUS_KEY[task.lastRun.status])}</Pill>}
            <button type="button" onClick={() => { setExpandedId(expandedId === task.id ? null : task.id) }}>
              {t('list.history')}
            </button>
            <button type="button" onClick={() => { void trigger(task) }}>{t('list.trigger')}</button>
            <button type="button" onClick={() => { void remove(task) }}>
              {confirmDeleteId === task.id ? t('list.confirmDelete') : t('list.delete')}
            </button>
          </div>
          {expandedId === task.id && <RunHistory taskId={task.id} openSession={openSession} t={t} />}
        </div>
      ))}
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
      <Button variant="primary" className={css.createButton}
        onClick={() => { setConfirmDeleteId(null); props.onCreate !== undefined ? props.onCreate() : setView({ mode: 'create' }) }}>
        {t('list.create')}
      </Button>
    </>
  )
}

function RunHistory({ taskId, openSession, t }: { taskId: string; openSession: (id: string) => void; t: T }): ReactNode {
  const { state } = useLoadState<CronRun[]>(() => fetchRuns(taskId), [taskId])
  if (state.kind !== 'ok') return <p className={css.runs}>{t('list.loading')}</p>
  if (state.data.length === 0) return <p className={css.runs}>{t('list.historyEmpty')}</p>
  return (
    <div className={css.runs}>
      {state.data.map((run) => (
        <div key={run.id} className={css.runRow}>
          <span>{new Date(run.triggeredAt).toLocaleString()}</span>
          <Pill>{t(RUN_STATUS_KEY[run.status])}</Pill>
          {run.finishedAt !== undefined && (
            <span>{Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.triggeredAt)) / 1000))}s</span>
          )}
          {run.error !== undefined && <span className={css.error}>{run.error}</span>}
          {run.sessionId !== undefined && (
            <button type="button" onClick={() => { openSession(run.sessionId as string) }}>
              {t('run.openSession')}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
