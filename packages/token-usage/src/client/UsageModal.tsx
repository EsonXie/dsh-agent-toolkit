/** Token 用量模态框：翻页头 + 24 小时柱状图 + 总量 + 模型/项目二维细分。 */
import { useEffect, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { billedOf, formatTokens, shiftDate } from '../aggregate.ts'
import type { Bucket, DailyRecord } from '../store.ts'
import css from './UsageModal.module.css'

export interface UsageModalProps {
  open: boolean
  onClose: () => void
  /** 初始日期 YYYY-MM-DD；null = 今天（以端点 today 为准）。 */
  initialDate: string | null
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; today: string; record: DailyRecord }

async function fetchDay(date: string | null): Promise<LoadState> {
  try {
    const res = await fetch(date === null ? '/token-usage/api/daily' : `/token-usage/api/daily?date=${date}`)
    if (!res.ok) return { status: 'error' }
    const body = await res.json() as { today: string; record: DailyRecord }
    return { status: 'ok', today: body.today, record: body.record }
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

export function UsageModal({ open, onClose, initialDate }: UsageModalProps) {
  const [date, setDate] = useState<string | null>(initialDate)
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => { if (open) setDate(initialDate) }, [open, initialDate])
  useEffect(() => {
    if (!open) return
    let stale = false
    setState({ status: 'loading' })
    void fetchDay(date).then((s) => { if (!stale) setState(s) })
    return () => { stale = true }
  }, [open, date])

  const record = state.status === 'ok' ? state.record : undefined
  const today = state.status === 'ok' ? state.today : undefined
  const current = record?.date ?? initialDate ?? ''
  const peak = record === undefined ? 1 : Math.max(1, ...record.hours.map(billedOf))

  return (
    <Modal open={open} onClose={onClose} title="Token 用量" closeLabel="关闭" className={css.dialog}>
      <div className={css.pager}>
        <button type="button" className={css.pagerButton} aria-label="前一天" disabled={current === ''} onClick={() => setDate(shiftDate(current, -1))}>←</button>
        <span className={css.dateLabel}>{current}</span>
        <button type="button" className={css.pagerButton} aria-label="后一天" disabled={today === undefined || shiftDate(current, 1) > today}
          onClick={() => setDate(shiftDate(current, 1))}>→</button>
      </div>
      {state.status === 'loading' && <p>加载中…</p>}
      {state.status === 'error' && <p>加载失败，请重试</p>}
      {record !== undefined && (
        <>
          <div className={css.chart}>
            {record.hours.map((b, h) => (
              <div key={h} className={css.barSlot} title={`${h}:00  ${formatTokens(billedOf(b))}  ${b.calls} 次`}>
                <div className={css.bar} style={{ height: `${(billedOf(b) / peak) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className={css.hourLabels}>
            {[0, 6, 12, 18].map((h) => <span key={h}>{h}:00</span>)}
          </div>
          <p className={css.total}>
            当日总量 {formatTokens(billedOf(record.totals))} · {record.totals.calls} 次调用
            {record.totals.estimated > 0 && `（含估算 ${formatTokens(record.totals.estimated)}）`}
            {record.totals.calls === 0 && ' · 当日无用量'}
          </p>
          <Breakdown title="按模型" rows={Object.entries(record.byModel).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
          <Breakdown title="按项目" rows={Object.entries(record.byProject).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))} />
          {record.compaction.calls > 0 && (
            <p className={css.compaction}>上下文压缩 {formatTokens(billedOf(record.compaction))} · {record.compaction.calls} 次</p>
          )}
        </>
      )}
    </Modal>
  )
}
