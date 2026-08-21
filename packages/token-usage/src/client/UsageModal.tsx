/** Token 用量模态框：活动热力图（近 13 周）与单日详情双视图。 */
import { useEffect, useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { billedOf, formatTokens, shiftDate } from '../aggregate.ts'
import { cacheHitRate, type HeatmapDay } from '../heatmap.ts'
import type { Bucket, DailyRecord } from '../store.ts'
import { ActivityHeatmap } from './ActivityHeatmap.tsx'
import { DailyBarChart } from './DailyBarChart.tsx'
import css from './UsageModal.module.css'

export interface UsageModalProps {
  open: boolean
  onClose: () => void
  /** 初始日期 YYYY-MM-DD；null = 打开活动视图。 */
  initialDate: string | null
}

type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; value: T }

interface RangePayload { today: string; days: HeatmapDay[] }
interface DayPayload { today: string; record: DailyRecord }

async function fetchJson<T>(url: string): Promise<LoadState<T>> {
  try {
    const res = await fetch(url)
    if (!res.ok) return { status: 'error' }
    return { status: 'ok', value: await res.json() as T }
  } catch {
    return { status: 'error' }
  }
}

function Breakdown({ title, rows }: { title: string; rows: [string, Bucket][] }) {
  if (rows.length === 0) return null
  return (
    <section>
      <h3 className={css.sectionTitle}>{title}</h3>
      {rows.map(([name, b]) => (
        <div key={name} className={css.row}>
          <span className={css.rowName}>{name}</span>
          <span>{formatTokens(billedOf(b))}</span>
          <span className={css.rowCalls}>{b.calls} 次</span>
        </div>
      ))}
    </section>
  )
}

export function UsageModal({ open, onClose, initialDate }: UsageModalProps): ReactNode {
  /** null = 活动视图；否则为单日视图日期。 */
  const [date, setDate] = useState<string | null>(initialDate)
  const [range, setRange] = useState<LoadState<RangePayload>>({ status: 'loading' })
  const [day, setDay] = useState<LoadState<DayPayload>>({ status: 'loading' })

  useEffect(() => { if (open) setDate(initialDate) }, [open, initialDate])
  // 打开即取 91 天范围数据；缓存在 state，活动/单日来回切换不重取。
  useEffect(() => {
    if (!open) return
    let stale = false
    setRange({ status: 'loading' })
    void fetchJson<RangePayload>('/token-usage/api/range?days=91').then((s) => { if (!stale) setRange(s) })
    return () => { stale = true }
  }, [open])
  useEffect(() => {
    if (!open || date === null) return
    let stale = false
    setDay({ status: 'loading' })
    void fetchJson<DayPayload>(`/token-usage/api/daily?date=${date}`).then((s) => { if (!stale) setDay(s) })
    return () => { stale = true }
  }, [open, date])

  const today = range.status === 'ok' ? range.value.today
    : day.status === 'ok' ? day.value.today : undefined
  const record = date !== null && day.status === 'ok' ? day.value.record : undefined
  const hit = record === undefined ? null : cacheHitRate(record.totals)

  return (
    <Modal open={open} onClose={onClose} title="Token 用量" closeLabel="关闭" className={css.dialog}>
      {date === null ? (
        <>
          {range.status === 'loading' && <p>加载中…</p>}
          {range.status === 'error' && <p>加载失败，请重试</p>}
          {range.status === 'ok' && (
            <>
              <h3 className={css.sectionTitle}>近 13 周活动</h3>
              <ActivityHeatmap today={range.value.today} days={range.value.days} onSelect={(d) => { setDate(d) }} />
            </>
          )}
        </>
      ) : (
        <>
          <div className={css.pager}>
            <button type="button" className={css.backButton} aria-label="返回活动视图" onClick={() => { setDate(null) }}>活动</button>
            <button type="button" className={css.pagerButton} aria-label="前一天" onClick={() => { setDate(shiftDate(date, -1)) }}>←</button>
            <span className={css.dateLabel}>{date}</span>
            <button type="button" className={css.pagerButton} aria-label="后一天" disabled={today === undefined || shiftDate(date, 1) > today}
              onClick={() => { setDate(shiftDate(date, 1)) }}>→</button>
          </div>
          {day.status === 'loading' && <p>加载中…</p>}
          {day.status === 'error' && <p>加载失败，请重试</p>}
          {record !== undefined && (
            <>
              <DailyBarChart record={record} />
              <p className={css.total}>
                当日总量 {formatTokens(billedOf(record.totals))} · {record.totals.calls} 次调用
                {record.totals.estimated > 0 && `（含估算 ${formatTokens(record.totals.estimated)}）`}
                {hit !== null && `（缓存命中率 ${Math.round(hit * 100)}%）`}
                {record.totals.calls === 0 && ' · 当日无用量'}
              </p>
              <Breakdown title="按模型" rows={Object.entries(record.byModel).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
              <Breakdown title="按项目" rows={Object.entries(record.byProject).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
              {record.compaction.calls > 0 && (
                <p className={css.compaction}>上下文压缩 {formatTokens(billedOf(record.compaction))} · {record.compaction.calls} 次</p>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  )
}
