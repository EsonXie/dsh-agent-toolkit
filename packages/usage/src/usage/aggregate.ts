/** dsh-agent-toolkit 纯函数：日期换算、K/M/B 格式化、聚合。无运行时依赖，浏览器半可内联。 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Message } from '@deepseek-ai/dsh-llm/types'
// 激活 @deepseek-ai/dsh-compaction 对 SessionEventMap 的声明合并（compaction/summary 等事件类型）。
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { Bucket, DailyRecord } from './store.ts'

/** 一条待聚合样本；每个样本隐含 calls=1。 */
export interface UsageSample {
  date: string
  hour: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 估算样本的计费 token 量；真实样本为 0。 */
  estimated: number
  estimatedCall: boolean
  /** 'provider/model'；compaction 样本无。 */
  model?: string
  sessionId?: string
  cwd?: string
  compaction: boolean
}

/** 桶的计费总量（含估算）。 */
export function billedOf(b: Bucket): number {
  return b.input + b.output + b.cacheRead + b.cacheWrite + b.estimated
}

export function emptyBucket(): Bucket {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, estimated: 0 }
}

export function emptyDaily(date: string): DailyRecord {
  return {
    date,
    totals: { ...emptyBucket(), estimatedCalls: 0 },
    hours: Array.from({ length: 24 }, emptyBucket),
    byModel: {},
    bySession: {},
    byProject: {},
    compaction: emptyBucket(),
  }
}

function addToBucket(b: Bucket, s: UsageSample): Bucket {
  return {
    input: b.input + s.input, output: b.output + s.output,
    cacheRead: b.cacheRead + s.cacheRead, cacheWrite: b.cacheWrite + s.cacheWrite,
    calls: b.calls + 1, estimated: b.estimated + s.estimated,
  }
}

/** 把一条样本并入日记录，返回新对象（存储记录禁止就地修改）。 */
export function addSample(rec: DailyRecord, s: UsageSample): DailyRecord {
  const totals = { ...addToBucket(rec.totals, s), estimatedCalls: rec.totals.estimatedCalls + (s.estimatedCall ? 1 : 0) }
  const hours = rec.hours.slice()
  hours[s.hour] = addToBucket(hours[s.hour], s)
  const byModel = { ...rec.byModel }
  if (s.model !== undefined) byModel[s.model] = addToBucket(byModel[s.model] ?? emptyBucket(), s)
  const bySession = { ...rec.bySession }
  if (s.sessionId !== undefined && s.cwd !== undefined) {
    bySession[s.sessionId] = { ...addToBucket(bySession[s.sessionId] ?? { ...emptyBucket(), cwd: s.cwd }, s), cwd: s.cwd }
  }
  const byProject = { ...rec.byProject }
  if (s.cwd !== undefined && !s.compaction) byProject[s.cwd] = addToBucket(byProject[s.cwd] ?? emptyBucket(), s)
  const compaction = s.compaction ? addToBucket(rec.compaction, s) : rec.compaction
  return { ...rec, totals, hours, byModel, bySession, byProject, compaction }
}

/** 从 session 事件提取样本；不相关事件与无 usage 的 compaction 返回 undefined。 */
export function sampleFromEvent(
  session: Session,
  event: SessionEvent,
  timeZone: string,
  estimate: (message: Message) => number,
): UsageSample | undefined {
  const { date, hour } = dayParts(event.time, timeZone)
  if (event.type === 'assistant/message') {
    const { message, usage } = event.data
    const base = { date, hour, model: `${message.source.provider}/${message.source.model}`, sessionId: String(session.header.id), cwd: session.header.cwd, compaction: false }
    if (usage === undefined) {
      return { ...base, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimated: estimate(message), estimatedCall: true }
    }
    return {
      ...base, estimated: 0, estimatedCall: false,
      input: usage.inputTokens, output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0,
    }
  }
  if (event.type === 'compaction/summary') {
    const { usage } = event.data
    if (usage === undefined) return undefined // 摘要块不是 Message，不做启发式估算
    return {
      date, hour, model: undefined, estimated: 0, estimatedCall: false, compaction: true,
      input: usage.inputTokens, output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheWriteTokens ?? 0,
    }
  }
  return undefined
}

/** 把 UTC 毫秒换算成指定时区的日期串与小时序号。 */
export function dayParts(time: number, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(time)
  const get = (type: string): string => parts.find((p) => p.type === type)!.value
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24, // 部分 ICU 版本午夜给 24
  }
}

/** 日期串加减天数（锚 UTC 正午，避开 DST）。 */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** 计费 token 数自动换算 K/M/B（10 进制，1 位小数）。 */
export function formatTokens(n: number): string {
  const units = ['', 'K', 'M', 'B'] as const
  let value = n
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return unit === 0 ? String(n) : `${value.toFixed(1)}${units[unit]}`
}
