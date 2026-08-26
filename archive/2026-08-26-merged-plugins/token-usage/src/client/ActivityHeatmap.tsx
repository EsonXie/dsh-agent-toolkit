/** 13 周活动热力图：7 行（周日在上）× 13 列；格子颜色 = 当日计费总量档位；纯展示，title tooltip 显示当日用量。 */
import type { ReactNode } from 'react'
import { formatTokens } from '../aggregate.ts'
import { heatmapGrid, type HeatmapDay } from '../heatmap.ts'
import theme from './chart.module.css'
import css from './ActivityHeatmap.module.css'

export interface ActivityHeatmapProps {
  today: string
  days: HeatmapDay[]
}

export function ActivityHeatmap({ today, days }: ActivityHeatmapProps): ReactNode {
  const columns = heatmapGrid(today, days)
  return (
    <div className={theme.chartTheme}>
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
              <div
                key={cell.date}
                className={css[`level${cell.level}`]}
                aria-disabled={cell.future || undefined}
                title={cell.future ? undefined : `${cell.date}  ${formatTokens(cell.day?.billed ?? 0)} · ${cell.day?.calls ?? 0} 次`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
