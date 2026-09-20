/** 日期范围按天堆叠柱状图：每天一根柱，下段「新增」+ 上段「缓存」，X 轴 MM-DD 稀疏刻度。 */
import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatTokens } from '../../usage/aggregate.ts'
import type { HeatmapDay } from '../../usage/heatmap.ts'
import css from './chart.module.css'

interface DayRow { date: string; label: string; fresh: number; cached: number; calls: number }

interface ChartTooltipProps { active?: boolean; payload?: { payload: DayRow }[] }

function ChartTooltip({ active, payload }: ChartTooltipProps): ReactNode {
  if (!active || payload === undefined || payload.length === 0) return null
  const row = payload[0].payload
  return (
    <div className={css.tooltip}>
      <div className={css.tooltipTitle}>{row.date}</div>
      <div>新增 {formatTokens(row.fresh)}</div>
      <div>缓存 {formatTokens(row.cached)}</div>
      <div className={css.tooltipTotal}>合计 {formatTokens(row.fresh + row.cached)} · {row.calls} 次</div>
    </div>
  )
}

export function RangeBarChart({ days }: { days: HeatmapDay[] }): ReactNode {
  const data: DayRow[] = days.map((d) => ({
    date: d.date, label: d.date.slice(5), fresh: d.fresh, cached: d.cached, calls: d.calls,
  }))
  return (
    <div className={css.chartTheme}>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--chart-label)" strokeOpacity={0.2} strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={24}
            fontSize={11}
            stroke="var(--chart-label)"
          />
          <YAxis hide />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--dsw-alias-interactive-bg-hover)' }} />
          <Bar dataKey="fresh" stackId="t" fill="var(--chart-1)" />
          <Bar dataKey="cached" stackId="t" fill="var(--chart-2)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <div className={css.legend}>
        <span><i className={css.swatchFresh} />新增</span>
        <span><i className={css.swatchCached} />缓存</span>
      </div>
    </div>
  )
}
