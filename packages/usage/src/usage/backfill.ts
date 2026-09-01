/** token-usage 历史扫描：共享日志聚合核、一次性启动回填（策略 A）与手动范围刷新（整日重建）。 */
import type { Message } from '@deepseek-ai/dsh-llm/types'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { addSample, emptyDaily, sampleFromEvent, shiftDate } from './aggregate.ts'
import type { DailyRecord } from './store.ts'

export const BACKFILL_DONE_KEY = 'backfill_done'

/** ctx.sessionPersistence 的最小消费面（结构子类型，详见 dsh-session-persistence 的 Service Definition）。 */
export interface BackfillPersistence {
  list(signal?: AbortSignal): Promise<SessionHeader[]>
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }>
}

/**
 * 扫描全部会话日志聚合为按日记录：list → 逐会话 readFrom → 逐事件 sampleFromEvent/addSample。
 * 尽力而为：list 整体失败 warn 并返回 undefined（调用方据此决定是否落地完成标记/是否报失败）。
 * 单会话 readFrom 失败 warn 跳过该会话并把 readFailed 置 true，把「聚合结果不完整」传给调用方
 *（对会做删除语义的调用方这是关键信号：读不出的日期看起来"无事件"）。本函数不抛错。
 */
export async function aggregateLogs(
  persistence: BackfillPersistence,
  timezone: string,
  estimate: (message: Message) => number,
  warn: (msg: string) => void,
): Promise<{ byDate: Map<string, DailyRecord>; readFailed: boolean } | undefined> {
  let headers: SessionHeader[]
  try {
    headers = await persistence.list()
  } catch (error) {
    warn(`用量日志列表读取失败：${String(error)}`)
    return undefined
  }
  const byDate = new Map<string, DailyRecord>()
  let readFailed = false
  for (const header of headers) {
    let events: readonly SessionEvent[]
    try {
      events = (await persistence.readFrom(header.id, 0)).events
    } catch (error) {
      warn(`用量日志扫描跳过会话 ${String(header.id)}：读取失败 ${String(error)}`)
      readFailed = true
      continue
    }
    // sampleFromEvent 只读 session.header 的 id/cwd：给最小会话形态。
    const stub = { header } as unknown as Session
    for (const event of events) {
      const sample = sampleFromEvent(stub, event, timezone, estimate)
      if (sample === undefined) continue
      byDate.set(sample.date, addSample(byDate.get(sample.date) ?? emptyDaily(sample.date), sample))
    }
  }
  return { byDate, readFailed }
}

export interface BackfillDeps {
  persistence: BackfillPersistence
  timezone: string
  daily: KvTable<string, DailyRecord>
  meta: KvTable<string, { value: string }>
  estimate: (message: Message) => number
  /** 把读改写排进与实时采集共享的串行链；返回该次写入的完成 promise。 */
  enqueue: (job: () => Promise<unknown>) => Promise<unknown>
  warn: (msg: string) => void
}

/**
 * 一次性补齐 daily 表完全缺失的日期：已有记录的日期视为权威（策略 A），跳过即幂等。
 * 尽力而为：单会话异常 warn 跳过（aggregateLogs 报 readFailed，回填只补缺失、不做删除，
 * 因此聚合不完整不影响其语义）；扫描未完整走完（aggregateLogs 返回 undefined）
 * 不落地 backfill_done，下次启动重试。本函数永不 reject（不次生 unhandled rejection 不变式）。
 */
export async function backfillMissingDays(deps: BackfillDeps): Promise<void> {
  const { persistence, timezone, daily, meta, estimate, enqueue, warn } = deps
  if (meta.get(BACKFILL_DONE_KEY) !== undefined) return
  try {
    const result = await aggregateLogs(persistence, timezone, estimate, warn)
    if (result === undefined) {
      warn('历史用量回填未完成（下次启动重试）')
      return
    }
    const { byDate } = result
    // 写入前再查一次：扫描期间被实时采集创建的日期（如今日）跳过，天然防双计。
    for (const [date, record] of byDate) {
      await enqueue(async () => {
        if (daily.get(date) === undefined) await daily.put(date, record)
      })
    }
    await enqueue(() => meta.put(BACKFILL_DONE_KEY, { value: new Date().toISOString() }))
  } catch (error) {
    warn(`历史用量回填未完成（下次启动重试）：${String(error)}`)
  }
}

export interface RefreshDeps {
  persistence: BackfillPersistence
  timezone: string
  daily: KvTable<string, DailyRecord>
  estimate: (message: Message) => number
  /** 把读改写排进与实时采集共享的串行链；返回该次写入的完成 promise。 */
  enqueue: (job: () => Promise<unknown>) => Promise<unknown>
  warn: (msg: string) => void
}

/** 刷新对照行：before/after 为该日 totals.calls。 */
export interface RefreshDayChange { date: string; before: number; after: number }

export interface RefreshResult {
  /** calls 数有变化或被删除的日期（按日期升序）。 */
  changed: RefreshDayChange[]
  /** 范围内被重建的 calls 数不变的日期数（内部明细不同的行仍已替换）。 */
  unchanged: number
  /** 整体失败（list 抛错 / 写入抛错）：已 warn，数据尽力保留。 */
  failed: boolean
}

/**
 * 以会话日志为权威，整日重建 [today-(days-1) .. today] 范围内的 daily 记录。
 * 范围内日志有事件的日期整体替换；范围内已有记录但日志无事件的日期删除
 *（KvTable 无键枚举，按日期区间逐日 get 探测）。范围外一律不动。
 * 有会话读失败（聚合不完整）时跳过整个删除 pass：读不出的日期会被误判为"无事件"而整删，
 * 保守保留这些行的既有记录；重建 pass 保持尽力而为，failed 仅表示 list/写入层面的整体失败。
 * 本函数永不 reject（命令 handler 的 failed 分支据此回报）。
 */
export async function refreshUsageRange(deps: RefreshDeps, days: number, today: string): Promise<RefreshResult> {
  const { persistence, timezone, daily, estimate, enqueue, warn } = deps
  try {
    const result = await aggregateLogs(persistence, timezone, estimate, warn)
    if (result === undefined) return { changed: [], unchanged: 0, failed: true }
    const { byDate, readFailed } = result
    const from = shiftDate(today, -(days - 1))
    const changed: RefreshDayChange[] = []
    let unchanged = 0
    for (const [date, record] of byDate) {
      if (date < from || date > today) continue
      const before = daily.get(date)?.totals.calls ?? 0
      await enqueue(() => daily.put(date, record))
      if (before === record.totals.calls) unchanged++
      else changed.push({ date, before, after: record.totals.calls })
    }
    // 范围内已有记录但日志无事件的日期：删除（日志即事实——会话被删则用量随之消失）。
    if (!readFailed) {
      for (let i = 0; i < days; i++) {
        const date = shiftDate(from, i)
        if (byDate.has(date)) continue
        const existing = daily.get(date)
        if (existing === undefined) continue
        await enqueue(() => daily.delete(date))
        changed.push({ date, before: existing.totals.calls, after: 0 })
      }
    }
    changed.sort((a, b) => (a.date < b.date ? -1 : 1))
    return { changed, unchanged, failed: false }
  } catch (error) {
    warn(`用量刷新失败：${String(error)}`)
    return { changed: [], unchanged: 0, failed: true }
  }
}
