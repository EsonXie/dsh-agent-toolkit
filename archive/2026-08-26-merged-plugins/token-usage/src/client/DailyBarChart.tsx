/** 单日 24 小时堆叠柱状图：下段「新增」+ 上段「缓存」，shadcn 风格（极简轴、圆角柱、自定义 tooltip）。 */
import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatTokens } from '../aggregate.ts'
import { cacheSplit } from '../heatmap.ts'
import type { DailyRecord } from '../store.ts'
import css from './chart.module.css'

interface HourRow { hour: number; fresh: number; cached: number; calls: number }

interface ChartTooltipProps { active?: boolean; label?: number; payload?: { payload: HourRow }[] }

function ChartTooltip({ active, label, payload }: ChartTooltipProps): ReactNode {
  if (!active || payload === undefined || payload.length === 0) return null
  const row = payload[0].payload
  return (
    <div className={css.tooltip}>
      <div className={css.tooltipTitle}>{label}:00</div>
      <div>新增 {formatTokens(row.fresh)}</div>
      <div>缓存 {formatTokens(row.cached)}</div>
      <div className={css.tooltipTotal}>合计 {formatTokens(row.fresh + row.cached)} · {row.calls} 次</div>
    </div>
  )
}

export function DailyBarChart({ record }: { record: DailyRecord }): ReactNode {
  const data: HourRow[] = record.hours.map((b, hour) => ({ hour, ...cacheSplit(b), calls: b.calls }))
  return (
    <div className={css.chartTheme}>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke="var(--chart-label)" strokeOpacity={0.2} strokeDasharray="3 3" />
          <XAxis
            dataKey="hour"
            tickLine={false}
            axisLine={false}
            ticks={[0, 6, 12, 18]}
            tickFormatter={(h: number) => `${h}:00`}
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
