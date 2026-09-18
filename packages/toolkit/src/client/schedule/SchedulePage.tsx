/** 定时任务设置页：整页任务行列表（行内开关/编辑/删除两段确认/立即触发）+ 点击行展开运行历史。 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Pill, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useLoadState } from '../shared/load-state.ts'
import { useToast } from '../shared/feedback.tsx'
import { deleteTask, fetchRuns, fetchTasks, triggerTask, updateTask, type CronRun, type CronTaskView } from './api.ts'
import { TaskForm } from './TaskForm.tsx'
import type { NS, ScheduleKey } from './locales.ts'
import css from './schedule.module.css'

type T = PropsLocale<typeof NS>['t']

/** 页内翻译座位：键域收窄到 agent-schedule 词典，params 用于 {name} 插值。 */
export type ScheduleT = (key: ScheduleKey, params?: Record<string, unknown>) => string

export interface SchedulePageProps {
  t: ScheduleT
  /** 打开运行历史对应会话（sessions.open 包装）。 */
  openSession: (sessionId: string) => void
}

type View = 'list' | { mode: 'create' } | { mode: 'edit'; task: CronTaskView }

/** 调度规则原始摘要（表达式与参数，非本地化 code token）。 */
function scheduleSummary(task: CronTaskView): string {
  switch (task.schedule.kind) {
    case 'cron':
      return `cron: ${task.schedule.expr}${task.schedule.timeZone !== undefined ? ` (${task.schedule.timeZone})` : ''}`
    case 'at':
      return `at: ${new Date(task.schedule.at).toLocaleString()}`
    case 'every':
      return `every ${task.schedule.seconds}s`
  }
}

const WEEKDAY_KEYS = [
  'desc.weekday.0', 'desc.weekday.1', 'desc.weekday.2', 'desc.weekday.3',
  'desc.weekday.4', 'desc.weekday.5', 'desc.weekday.6',
] as const

/** 人类可读调度描述：覆盖常见 cron 形态，其余回退到自定义表达式。 */
function describeSchedule(task: CronTaskView, t: ScheduleT): string {
  const s = task.schedule
  if (s.kind === 'at') return t('desc.at').replaceAll('{time}', new Date(s.at).toLocaleString())
  if (s.kind === 'every') return t('desc.everySeconds').replaceAll('{seconds}', String(s.seconds))
  const parts = s.expr.trim().split(/\s+/)
  const custom = (): string => t('desc.cron').replaceAll('{expr}', s.expr)
  if (parts.length !== 5) return custom()
  const [min, hour, dom, mon, dow] = parts
  const num = (v: string): number | undefined => (/^\d+$/.test(v) ? Number(v) : undefined)
  const mm = num(min)
  const hh = num(hour)
  const at = (h: number, m: number): string => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  if (mon === '*' && dom === '*') {
    if (dow === '*' && mm !== undefined && hh !== undefined) return t('desc.daily').replaceAll('{time}', at(hh, mm))
    if (dow === '1-5' && mm !== undefined && hh !== undefined) return t('desc.weekdays').replaceAll('{time}', at(hh, mm))
    const d = num(dow)
    if (d !== undefined && d >= 0 && d <= 6 && mm !== undefined && hh !== undefined) {
      return t('desc.weekly')
        .replaceAll('{weekday}', t(WEEKDAY_KEYS[d]))
        .replaceAll('{time}', at(hh, mm))
    }
  }
  if (dom === '*' && mon === '*' && dow === '*' && hour === '*' && mm !== undefined) {
    return t('desc.hourly').replaceAll('{minute}', String(mm))
  }
  return custom()
}

const RUN_STATUS_KEY: Record<CronRun['status'], 'run.ok' | 'run.error' | 'run.running' | 'run.skipped-overlap'> = {
  ok: 'run.ok',
  error: 'run.error',
  running: 'run.running',
  'skipped-overlap': 'run.skipped-overlap',
}

export function SchedulePage(props: SchedulePageProps): ReactNode {
  const { t, openSession } = props
  // TaskForm 的 t 座位键域含共享 common 词汇；本页契约收窄为 ScheduleKey（壳绑定 agent-schedule 词典）。
  const formT = t as unknown as T
  const { showToast, toastNode } = useToast()
  const [view, setView] = useState<View>('list')
  const { state, reload } = useLoadState<CronTaskView[]>(() => fetchTasks(), [])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  function handleSaved(): void {
    setView('list')
    reload()
    showToast(t('feedback.saved'))
  }

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
      showToast(t('feedback.deleted'))
    } catch (e) {
      setError(t('list.deleteFailed', { message: e instanceof Error ? e.message : String(e) }))
    }
  }

  async function toggleEnabled(task: CronTaskView): Promise<void> {
    try {
      await updateTask(task.id, { enabled: !task.enabled })
      reload()
      showToast(t('feedback.saved'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function trigger(task: CronTaskView): Promise<void> {
    try {
      await triggerTask(task.id)
      reload()
      showToast(t('feedback.triggered'))
    } catch (e) {
      setError(t('list.triggerFailed', { message: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <div className={css.page}>
      {toastNode}
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
      {view !== 'list' ? (
        <TaskForm
          key={view.mode === 'edit' ? view.task.id : '__new__'}
          draft={view.mode === 'edit' ? view.task : undefined}
          t={formT}
          onSaved={handleSaved}
          onCancel={() => { setView('list') }}
        />
      ) : (
        <>
          <div className={css.toolbar}>
            <Button variant="primary" className={css.createButton}
              onClick={() => { setConfirmDeleteId(null); setView({ mode: 'create' }) }}>
              {t('list.create')}
            </Button>
          </div>
          {state.kind === 'loading' && <p>{t('list.loading')}</p>}
          {state.kind === 'error' && <p>{t('list.error')}</p>}
          {state.kind === 'ok' && state.data.length === 0 && <p>{t('list.empty')}</p>}
          {state.kind === 'ok' && state.data.map((task) => {
            const expanded = expandedId === task.id
            return (
              <div key={task.id} className={css.taskBlock}>
                <div className={css.row}>
                  <Switch
                    checked={task.enabled}
                    label={task.name}
                    onChange={() => { void toggleEnabled(task) }}
                  />
                  <button type="button" className={css.main} aria-expanded={expanded}
                    onClick={() => { setConfirmDeleteId(null); setExpandedId(expanded ? null : task.id) }}>
                    <span className={css.name}>{task.name}</span>
                    <span className={css.meta}>
                      <span>{describeSchedule(task, t)}</span>
                      {' · '}
                      <span>{scheduleSummary(task)}</span>
                      {' · '}
                      <span>{task.target.kind === 'main' ? t('list.targetMain') : t('list.targetRole', { roleId: task.target.roleId })}</span>
                      {' · '}
                      <span>{task.enabled && task.nextRunAt !== null
                        ? t('list.nextRun', { time: new Date(task.nextRunAt).toLocaleString() })
                        : t('list.noNextRun')}</span>
                    </span>
                  </button>
                  {task.lastRun !== undefined && <Pill className={css.badge}>{t(RUN_STATUS_KEY[task.lastRun.status])}</Pill>}
                  <button type="button" className={css.action}
                    onClick={() => { setConfirmDeleteId(null); setView({ mode: 'edit', task }) }}>
                    {t('list.edit')}
                  </button>
                  <button type="button" className={css.action} onClick={() => { void trigger(task) }}>{t('list.trigger')}</button>
                  <button type="button" className={clsx(css.action, css.actionDanger)} onClick={() => { void remove(task) }}>
                    {confirmDeleteId === task.id ? t('list.confirmDelete') : t('list.delete')}
                  </button>
                </div>
                {expanded && <RunHistory taskId={task.id} openSession={openSession} t={t} />}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

function RunHistory({ taskId, openSession, t }: { taskId: string; openSession: (id: string) => void; t: ScheduleT }): ReactNode {
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
          {run.error !== undefined && <span className={css.runError}>{run.error}</span>}
          {run.sessionId !== undefined && (
            <button type="button" className={css.action} onClick={() => { openSession(run.sessionId as string) }}>
              {t('run.openSession')}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
