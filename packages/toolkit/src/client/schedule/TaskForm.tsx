/** 定时任务创建/编辑表单：名称/提示词/项目下拉/目标 radio/调度三选一（cron 预览经内联 croner 计算）/catchup/enabled。 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Cron } from 'croner'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useLoadState } from '../shared/load-state.ts'
import { createTask, fetchAgents, fetchProjects, updateTask, type CronTaskInput } from './api.ts'
import type { CronSchedule, CronTarget } from '../../schedule/store.ts'
import type { NS } from './locales.ts'
import type { ScheduleTaskDraft } from './TaskForm.types.ts'
import css from './schedule.module.css'

type T = PropsLocale<typeof NS>['t']

export interface TaskFormProps {
  /** 编辑 = 既有任务；undefined = 新建。 */
  draft: ScheduleTaskDraft | undefined
  t: T
  onSaved: () => void
  onCancel: () => void
}

type ScheduleKind = CronSchedule['kind']

/** cron 未来 3 次触发预览（内联 croner；非法表达式返回空数组）。 */
function previewCron(expr: string, timeZone: string): number[] {
  if (expr.trim().split(/\s+/).length !== 5) return []
  try {
    return new Cron(expr, { paused: true, ...(timeZone !== '' ? { timezone: timeZone } : {}) })
      .nextRuns(3)
      .map((d) => d.getTime())
  } catch {
    return []
  }
}

export function TaskForm({ draft, t, onSaved, onCancel }: TaskFormProps): ReactNode {
  const [name, setName] = useState(draft?.name ?? '')
  const [prompt, setPrompt] = useState(draft?.prompt ?? '')
  const [cwd, setCwd] = useState(draft?.cwd ?? '')
  const [targetKind, setTargetKind] = useState<CronTarget['kind']>(draft?.target.kind ?? 'main')
  const [roleId, setRoleId] = useState(draft?.target.kind === 'role' ? draft.target.roleId : '')
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(draft?.schedule.kind ?? 'cron')
  const [cronExpr, setCronExpr] = useState(draft?.schedule.kind === 'cron' ? draft.schedule.expr : '0 9 * * *')
  const [timeZone, setTimeZone] = useState(draft?.schedule.kind === 'cron' ? (draft.schedule.timeZone ?? '') : '')
  const [atTime, setAtTime] = useState(draft?.schedule.kind === 'at' ? draft.schedule.at.slice(0, 16) : '')
  const [everySeconds, setEverySeconds] = useState(draft?.schedule.kind === 'every' ? String(draft.schedule.seconds) : '3600')
  const [catchup, setCatchup] = useState(draft?.catchup ?? true)
  const [enabled, setEnabled] = useState(draft?.enabled ?? true)
  const [error, setError] = useState<string | null>(null)

  const { state: projectsState } = useLoadState<string[]>(() => fetchProjects(), [])
  const { state: agentsState } = useLoadState(() => fetchAgents(), [])
  const projects = projectsState.kind === 'ok' ? projectsState.data : []
  const roles = (agentsState.kind === 'ok' ? agentsState.data : []).filter((a) => a.id !== 'main')

  // 项目下拉缺省选中第一项（新建时）。
  useEffect(() => {
    if (cwd === '' && projects.length > 0) setCwd(projects[0])
  }, [projects, cwd])

  const preview = useMemo(
    () => (scheduleKind === 'cron' ? previewCron(cronExpr, timeZone) : []),
    [scheduleKind, cronExpr, timeZone],
  )

  function buildInput(): CronTaskInput {
    const schedule: CronSchedule =
      scheduleKind === 'cron'
        ? { kind: 'cron', expr: cronExpr, ...(timeZone !== '' ? { timeZone } : {}) }
        : scheduleKind === 'at'
          ? { kind: 'at', at: new Date(atTime).toISOString() }
          : { kind: 'every', seconds: Number(everySeconds) }
    const target: CronTarget = targetKind === 'role' ? { kind: 'role', roleId } : { kind: 'main' }
    return { name, prompt, cwd, schedule, target, catchup, enabled }
  }

  async function save(): Promise<void> {
    setError(null)
    try {
      const input = buildInput()
      if (draft === undefined) await createTask(input)
      else await updateTask(draft.id, input)
      onSaved()
    } catch (e) {
      setError(t('form.saveFailed', { message: e instanceof Error ? e.message : String(e) }))
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save() }}>
      <label className={css.field}>
        {t('form.name')}
        <input value={name} onChange={(e) => { setName(e.target.value) }} required />
      </label>
      <label className={css.field}>
        {t('form.prompt')}
        <textarea value={prompt} onChange={(e) => { setPrompt(e.target.value) }} rows={5} required />
      </label>
      <label className={css.field}>
        {t('form.project')}
        <select value={cwd} onChange={(e) => { setCwd(e.target.value) }}>
          {projects.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <fieldset className={css.field}>
        <legend>{t('form.target')}</legend>
        <label>
          <input type="radio" name="target" checked={targetKind === 'main'} onChange={() => { setTargetKind('main') }} />
          {t('form.targetMain')}
        </label>
        <label>
          <input type="radio" name="target" checked={targetKind === 'role'} onChange={() => { setTargetKind('role') }} />
          {t('form.targetRole')}
        </label>
        {targetKind === 'role' && (
          <select aria-label={t('form.targetRole')} value={roleId} onChange={(e) => { setRoleId(e.target.value) }}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
      </fieldset>
      <fieldset className={css.field}>
        <legend>{t('form.schedule')}</legend>
        <label>
          <input type="radio" name="schedule" checked={scheduleKind === 'cron'} onChange={() => { setScheduleKind('cron') }} />
          {t('form.scheduleCron')}
        </label>
        <label>
          <input type="radio" name="schedule" checked={scheduleKind === 'at'} onChange={() => { setScheduleKind('at') }} />
          {t('form.scheduleAt')}
        </label>
        <label>
          <input type="radio" name="schedule" checked={scheduleKind === 'every'} onChange={() => { setScheduleKind('every') }} />
          {t('form.scheduleEvery')}
        </label>
        {scheduleKind === 'cron' && (
          <>
            <label className={css.field}>
              {t('form.cronExpr')}
              <input value={cronExpr} onChange={(e) => { setCronExpr(e.target.value) }} />
            </label>
            <label className={css.field}>
              {t('form.timeZone')}
              <input value={timeZone} onChange={(e) => { setTimeZone(e.target.value) }} placeholder="Asia/Shanghai" />
            </label>
            {preview.length > 0 && (
              <div data-testid="cron-preview">
                {t('form.preview')}
                <ul>
                  {preview.map((ms) => <li key={ms}>{new Date(ms).toLocaleString()}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
        {scheduleKind === 'at' && (
          <label className={css.field}>
            {t('form.atTime')}
            <input type="datetime-local" value={atTime} onChange={(e) => { setAtTime(e.target.value) }} />
          </label>
        )}
        {scheduleKind === 'every' && (
          <label className={css.field}>
            {t('form.everySeconds')}
            <input type="number" min={60} value={everySeconds} onChange={(e) => { setEverySeconds(e.target.value) }} />
          </label>
        )}
      </fieldset>
      <label>
        <input type="checkbox" checked={catchup} onChange={(e) => { setCatchup(e.target.checked) }} />
        {t('form.catchup')}
      </label>
      <label>
        <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked) }} />
        {t('form.enabled')}
      </label>
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
      <div className={css.actions}>
        <Button type="button" onClick={onCancel}>{t('form.cancel')}</Button>
        <Button variant="primary" type="submit">{t('form.save')}</Button>
      </div>
    </form>
  )
}

export type { ScheduleTaskDraft } from './TaskForm.types.ts'
