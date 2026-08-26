/** Token 用量模态框：活动热力图（近 13 周）与单日详情双 tab，tab 完全独立切换。 */
import { useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { billedOf, formatTokens, shiftDate } from '../../usage/aggregate.ts'
import { cacheHitRate, type HeatmapDay } from '../../usage/heatmap.ts'
import type { Bucket, DailyRecord } from '../../usage/store.ts'
import { useLoadState } from '../shared/load-state.ts'
import { ActivityHeatmap } from './ActivityHeatmap.tsx'
import { DailyBarChart } from './DailyBarChart.tsx'
import css from './UsageModal.module.css'

export interface UsageModalProps {
  open: boolean
  onClose: () => void
  /** 初始日期 YYYY-MM-DD；非 null = 默认打开单日 tab 并定位到该日；缺省/null = 默认活动 tab。 */
  initialDate?: string | null
}

type Tab = 'activity' | 'day'

interface RangePayload { today: string; days: HeatmapDay[] }
interface DayPayload { today: string; record: DailyRecord }

/** fetch JSON：非 2xx 与网络错误都抛错（useLoadState 转 error 态）。 */
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as T
}

/** 永不落定的占位 promise：dayDate 未定时跳过拉取（保持 loading，dayDate 落定后 deps 变化重拉）。 */
const PENDING = new Promise<never>(() => {})

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
  // 数据拉取只在打开时发生（关着就 unmount，与归档的 `if (!open) return` 守卫等价）。
  // 打开时 body 全新挂载，tab/date 状态天然以 initialDate 初始化，无需复位 effect。
  return (
    <Modal open={open} onClose={onClose} title="Token 用量" closeLabel="关闭" className={css.dialog}>
      {open && <UsageModalBody initialDate={initialDate ?? null} />}
    </Modal>
  )
}

function UsageModalBody({ initialDate }: { initialDate: string | null }): ReactNode {
  const [tab, setTab] = useState<Tab>(initialDate === null ? 'activity' : 'day')
  /** 单日 tab 的日期；null = 未定（跟随 today）。 */
  const [date, setDate] = useState<string | null>(initialDate)
  /** 打开即取 91 天范围数据；缓存在 state，tab 来回切换不重取。 */
  const range = useLoadState<RangePayload>(
    () => fetchJson<RangePayload>('/dsh-agent-toolkit/api/usage/range?days=91'),
    [])
  const today = range.state.kind === 'ok' ? range.state.data.today : undefined
  /** 单日 tab 当前日期：pager 选过的日期优先，否则 today（等 range payload 到达）。 */
  const dayDate = date ?? today
  /** date 未定时（等 today）不拉取：挂 PENDING 保持 loading，dayDate 落定后 deps 变化重拉。 */
  const day = useLoadState<DayPayload>(() => {
    if (dayDate === undefined) return PENDING
    return fetchJson<DayPayload>(`/dsh-agent-toolkit/api/usage/daily?date=${dayDate}`)
  }, [dayDate])

  const record = dayDate !== undefined && day.state.kind === 'ok' ? day.state.data.record : undefined
  const hit = record === undefined ? null : cacheHitRate(record.totals)

  return (
    <>
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
          {range.state.kind === 'loading' && <p>加载中…</p>}
          {range.state.kind === 'error' && <p>加载失败，请重试</p>}
          {range.state.kind === 'ok' && (
            <>
              <h3 className={css.sectionTitle}>近 13 周活动</h3>
              <ActivityHeatmap today={range.state.data.today} days={range.state.data.days} />
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
          {day.state.kind === 'loading' && <p>加载中…</p>}
          {day.state.kind === 'error' && <p>加载失败，请重试</p>}
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
    </>
  )
}
