/** Token 用量模态框：活动热力图（近 13 周）与趋势范围查询双 tab；趋势 tab 单日按小时、多日按天。 */
import { useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { billedOf, formatTokens } from '../../usage/aggregate.ts'
import { cacheHitRate, type HeatmapDay, type RangeAggregate } from '../../usage/heatmap.ts'
import type { Bucket } from '../../usage/store.ts'
import { useLoadState } from '../shared/load-state.ts'
import { ActivityHeatmap } from './ActivityHeatmap.tsx'
import { DailyBarChart } from './DailyBarChart.tsx'
import { RangeBarChart } from './RangeBarChart.tsx'
import css from './UsageModal.module.css'

export interface UsageModalProps {
  open: boolean
  onClose: () => void
  /** 初始日期 YYYY-MM-DD；非 null = 默认打开趋势 tab 并定位到该单日；缺省/null = 默认活动 tab。 */
  initialDate?: string | null
}

type Tab = 'activity' | 'trend'
type Preset = 7 | 30 | 90

interface HeatmapPayload { today: string; days: HeatmapDay[] }
interface RangePayload {
  today: string
  from: string
  to: string
  days: HeatmapDay[]
  aggregate: RangeAggregate
  /** 仅 from === to 时携带：24 小时桶。 */
  hours?: Bucket[]
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json() as T
}

const PENDING = new Promise<never>(() => {})
const DAY_MS = 86_400_000

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
  return (
    <Modal open={open} onClose={onClose} title="Token 用量" closeLabel="关闭" className={css.dialog}>
      {open && <UsageModalBody initialDate={initialDate ?? null} />}
    </Modal>
  )
}

function UsageModalBody({ initialDate }: { initialDate: string | null }): ReactNode {
  const [tab, setTab] = useState<Tab>(initialDate === null ? 'activity' : 'trend')
  const [preset, setPreset] = useState<Preset | 'custom'>(initialDate === null ? 30 : 'custom')
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(
    initialDate === null ? null : { from: initialDate, to: initialDate })

  const heatmap = useLoadState<HeatmapPayload>(
    () => fetchJson<HeatmapPayload>('/dsh-agent-toolkit/api/usage/range?days=91'),
    [])

  /** 自定义区间非法（缺值/倒置/超 366 天）时不发请求，内联提示。 */
  const customInvalid = custom !== null
    && (custom.from === '' || custom.to === ''
      || custom.from > custom.to
      || (Date.parse(`${custom.to}T12:00:00Z`) - Date.parse(`${custom.from}T12:00:00Z`)) / DAY_MS + 1 > 366)
  const query = preset === 'custom'
    ? (custom === null || customInvalid ? null : `from=${custom.from}&to=${custom.to}`)
    : `days=${preset}`
  const range = useLoadState<RangePayload>(() => {
    if (query === null) return PENDING
    return fetchJson<RangePayload>(`/dsh-agent-toolkit/api/usage/range?${query}`)
  }, [query])

  const payload = range.state.kind === 'ok' ? range.state.data : undefined
  const singleDay = payload !== undefined && payload.from === payload.to && payload.hours !== undefined
  const hit = payload === undefined ? null : cacheHitRate(payload.aggregate.totals)

  /** 热力图点击某天：跳趋势 tab 并定位该单日。 */
  const selectDay = (date: string) => {
    setPreset('custom')
    setCustom({ from: date, to: date })
    setTab('trend')
  }

  return (
    <>
      <div className={css.tabs} role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'activity'}
          className={tab === 'activity' ? `${css.tab} ${css.tabActive}` : css.tab}
          onClick={() => { setTab('activity') }}>活动</button>
        <button type="button" role="tab" aria-selected={tab === 'trend'}
          className={tab === 'trend' ? `${css.tab} ${css.tabActive}` : css.tab}
          onClick={() => { setTab('trend') }}>趋势</button>
      </div>
      {tab === 'activity' ? (
        <>
          {heatmap.state.kind === 'loading' && <p>加载中…</p>}
          {heatmap.state.kind === 'error' && <p>加载失败，请重试</p>}
          {heatmap.state.kind === 'ok' && (
            <>
              <h3 className={css.sectionTitle}>近 13 周活动</h3>
              <ActivityHeatmap today={heatmap.state.data.today} days={heatmap.state.data.days} onSelectDay={selectDay} />
            </>
          )}
        </>
      ) : (
        <>
          <div className={css.rangeBar}>
            {([7, 30, 90] as const).map((n) => (
              <button key={n} type="button"
                className={preset === n ? `${css.preset} ${css.presetActive}` : css.preset}
                onClick={() => { setPreset(n); setCustom(null) }}>近 {n} 天</button>
            ))}
            <input type="date" aria-label="起始日期" className={css.dateInput}
              value={preset === 'custom' ? custom?.from ?? '' : ''}
              onChange={(e) => {
                const from = e.target.value
                setPreset('custom')
                setCustom((c) => ({ from, to: c?.to ?? from }))
              }} />
            <span className={css.rangeSep}>至</span>
            <input type="date" aria-label="截止日期" className={css.dateInput}
              value={preset === 'custom' ? custom?.to ?? '' : ''}
              onChange={(e) => {
                const to = e.target.value
                setPreset('custom')
                setCustom((c) => ({ from: c?.from ?? to, to }))
              }} />
          </div>
          {preset === 'custom' && customInvalid && <p className={css.rangeError}>请填写起止日期，且起始日期不能晚于截止日期、跨度不超过 366 天</p>}
          {range.state.kind === 'loading' && !(preset === 'custom' && customInvalid) && <p>加载中…</p>}
          {range.state.kind === 'error' && <p>加载失败，请重试</p>}
          {payload !== undefined && (
            <>
              {singleDay ? <DailyBarChart hours={payload.hours!} /> : <RangeBarChart days={payload.days} />}
              <p className={css.total}>
                {singleDay ? '当日总量' : '范围总量'} {formatTokens(billedOf(payload.aggregate.totals))} · {payload.aggregate.totals.calls} 次调用
                {payload.aggregate.totals.estimated > 0 && `（含估算 ${formatTokens(payload.aggregate.totals.estimated)}）`}
                {hit !== null && `（缓存命中率 ${Math.round(hit * 100)}%）`}
                {payload.aggregate.totals.calls === 0 && ' · 无用量'}
              </p>
              <Breakdown title="按模型" rows={Object.entries(payload.aggregate.byModel).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
              <Breakdown title="按项目" rows={Object.entries(payload.aggregate.byProject).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
              {payload.aggregate.compaction.calls > 0 && (
                <p className={css.compaction}>上下文压缩 {formatTokens(billedOf(payload.aggregate.compaction))} · {payload.aggregate.compaction.calls} 次</p>
              )}
            </>
          )}
        </>
      )}
    </>
  )
}
