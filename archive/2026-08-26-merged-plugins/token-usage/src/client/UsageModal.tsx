/** Token 用量模态框：活动热力图（近 13 周）与单日详情双 tab，tab 完全独立切换。 */
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
  /** 初始日期 YYYY-MM-DD；非 null = 默认打开单日 tab 并定位到该日；null = 默认活动 tab。 */
  initialDate: string | null
}

type Tab = 'activity' | 'day'

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
  const [tab, setTab] = useState<Tab>(initialDate === null ? 'activity' : 'day')
  /** 单日 tab 的日期；null = 未定（跟随 today）。 */
  const [date, setDate] = useState<string | null>(initialDate)
  const [range, setRange] = useState<LoadState<RangePayload>>({ status: 'loading' })
  const [day, setDay] = useState<LoadState<DayPayload>>({ status: 'loading' })

  useEffect(() => {
    if (!open) return
    setTab(initialDate === null ? 'activity' : 'day')
    setDate(initialDate)
  }, [open, initialDate])
  // 打开即取 91 天范围数据；缓存在 state，tab 来回切换不重取。
  useEffect(() => {
    if (!open) return
    let stale = false
    setRange({ status: 'loading' })
    void fetchJson<RangePayload>('/token-usage/api/range?days=91').then((s) => { if (!stale) setRange(s) })
    return () => { stale = true }
  }, [open])

  const today = range.status === 'ok' ? range.value.today
    : day.status === 'ok' ? day.value.today : undefined
  /** 单日 tab 当前日期：pager 选过的日期优先，否则 today（等 range/day payload 到达）。 */
  const dayDate = date ?? today

  useEffect(() => {
    if (!open || dayDate === undefined) return
    let stale = false
    setDay({ status: 'loading' })
    void fetchJson<DayPayload>(`/token-usage/api/daily?date=${dayDate}`).then((s) => { if (!stale) setDay(s) })
    return () => { stale = true }
  }, [open, dayDate])

  const record = dayDate !== undefined && day.status === 'ok' ? day.value.record : undefined
  const hit = record === undefined ? null : cacheHitRate(record.totals)

  return (
    <Modal open={open} onClose={onClose} title="Token 用量" closeLabel="关闭" className={css.dialog}>
      <div className={css.tabs} role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'activity'}
          className={tab === 'activity' ? `${css.tab} ${css.tabActive}` : css.tab}
          onClick={() => { setTab('activity') }}>活动</button>
        <button type="button" role="tab" aria-selected={tab === 'day'}
          className={tab === 'day' ? `${css.tab} ${css.tabActive}` : css.tab}
          onClick={() => { setTab('day') }}>单日</button>
      </div>
      {tab === 'activity' ? (
        <>
          {range.status === 'loading' && <p>加载中…</p>}
          {range.status === 'error' && <p>加载失败，请重试</p>}
          {range.status === 'ok' && (
            <>
              <h3 className={css.sectionTitle}>近 13 周活动</h3>
              <ActivityHeatmap today={range.value.today} days={range.value.days} />
            </>
          )}
        </>
      ) : (
        <>
          {dayDate !== undefined && (
            <div className={css.pager}>
              <button type="button" className={css.pagerButton} aria-label="前一天" onClick={() => { setDate(shiftDate(dayDate, -1)) }}>←</button>
              <span className={css.dateLabel}>{dayDate}</span>
              <button type="button" className={css.pagerButton} aria-label="后一天" disabled={today === undefined || shiftDate(dayDate, 1) > today}
                onClick={() => { setDate(shiftDate(dayDate, 1)) }}>→</button>
            </div>
          )}
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
