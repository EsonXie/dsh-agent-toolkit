/** 13 周活动热力图：7 行（周日在上）× 13 列；格子按钮可点击跳单日，悬停显示自定义 tooltip 卡片。 */
import { useState, type ReactNode } from 'react'
import { formatTokens } from '../../usage/aggregate.ts'
import { heatmapGrid, type HeatmapDay } from '../../usage/heatmap.ts'
import theme from './chart.module.css'
import css from './ActivityHeatmap.module.css'

export interface ActivityHeatmapProps {
  today: string
  days: HeatmapDay[]
  /** 点击非未来格回调该日期（模态框跳趋势 tab 单日视图）。 */
  onSelectDay: (date: string) => void
}

/** 行索引（周日=0）→ 星期标签；只标一/三/五行。 */
const WEEKDAYS: Record<number, string> = { 1: '一', 3: '三', 5: '五' }

export function ActivityHeatmap({ today, days, onSelectDay }: ActivityHeatmapProps): ReactNode {
  const columns = heatmapGrid(today, days)
  const [hover, setHover] = useState<string | null>(null)
  return (
    <div className={theme.chartTheme}>
      <div className={css.body}>
        <div className={css.weekdays}>
          {Array.from({ length: 7 }, (_, r) => <span key={r}>{WEEKDAYS[r] ?? ''}</span>)}
        </div>
        <div className={css.main}>
          <div className={css.months}>
            {columns.map((col, c) => {
              const first = col.find((cell) => cell.date.endsWith('-01'))
              return <span key={c}>{first === undefined ? '' : `${Number(first.date.slice(5, 7))}月`}</span>
            })}
          </div>
          <div className={css.grid}>
            {columns.map((col, c) => (
              <div key={c} className={css.week}>
                {col.map((cell) => (
                  <span key={cell.date} className={css.cellWrap}>
                    <button
                      type="button"
                      data-date={cell.date}
                      className={css[`level${cell.level}`]}
                      disabled={cell.future}
                      aria-label={cell.future ? undefined : `${cell.date} 用量`}
                      onClick={() => { onSelectDay(cell.date) }}
                      onMouseEnter={() => { if (!cell.future) setHover(cell.date) }}
                      onMouseLeave={() => { setHover(null) }}
                      onFocus={() => { if (!cell.future) setHover(cell.date) }}
                      onBlur={() => { setHover(null) }}
                    />
                    {hover === cell.date && (
                      <span className={css.tip} role="tooltip">
                        <span className={css.tipDate}>{cell.date}</span>
                        <span>{formatTokens(cell.day?.billed ?? 0)} · {cell.day?.calls ?? 0} 次</span>
                      </span>
                    )}
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div className={css.scale}>
            <span>少</span>
            {[0, 1, 2, 3, 4].map((n) => <i key={n} className={css[`level${n}`]} />)}
            <span>多</span>
          </div>
        </div>
      </div>
    </div>
  )
}
