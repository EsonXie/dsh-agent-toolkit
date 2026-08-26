/** /token-usage 命令的文本视图（纯函数）。 */
import { billedOf, formatTokens } from './aggregate.ts'
import type { Bucket, DailyRecord } from './store.ts'

function line(name: string, b: Bucket): string {
  return `  ${name}  ${formatTokens(billedOf(b))}  ${b.calls} 次调用`
}

/** 当日详情：总量（含估算标注）+ 模型/项目二维细分 + compaction 单列。 */
export function renderDay(rec: DailyRecord): string {
  const est = rec.totals.estimated > 0 ? `（含估算 ${formatTokens(rec.totals.estimated)}）` : ''
  const rows: string[] = [
    `${rec.date} 用量：${formatTokens(billedOf(rec.totals))} ${rec.totals.calls} 次调用${est}`,
  ]
  const models = Object.entries(rec.byModel).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))
  if (models.length > 0) rows.push('按模型：', ...models.map(([k, v]) => line(k, v)))
  const projects = Object.entries(rec.byProject).sort((a, b) => billedOf(b[1]) - billedOf(a[1]))
  if (projects.length > 0) rows.push('按项目：', ...projects.map(([k, v]) => line(k, v)))
  if (rec.compaction.calls > 0) rows.push(`上下文压缩：${formatTokens(billedOf(rec.compaction))} ${rec.compaction.calls} 次调用`)
  return rows.join('\n')
}

/** 今日详情 + 近 7 日逐日摘要行（days[0] 为今日）。 */
export function renderWeek(today: string, days: readonly DailyRecord[]): string {
  const lines = days.map((d) => `${d.date}  ${formatTokens(billedOf(d.totals))}  ${d.totals.calls} 次调用`)
  return `${renderDay(days[0])}\n\n近 7 日：\n${lines.join('\n')}`
}
