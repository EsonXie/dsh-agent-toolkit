/** usage 模块：per-day token 用量采集、/token-usage 命令与 JSON 路由。 */
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
// Type-only 激活对应包对 cordis Context 的声明合并（inject 的 service 属性）。
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-commands'
import { openDomainSafely } from '../shared/storage.ts'
import { registerOptionalRoutes } from '../shared/webserver.ts'
import { addSample, dayParts, emptyDaily, sampleFromEvent } from './aggregate.ts'
import { parseDaysParam, rangeSummaries } from './heatmap.ts'
import { renderDay, renderWeek } from './render.ts'
import { tokenUsageDomain, type DailyRecord } from './store.ts'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function setupUsage(ctx: Context, config: { timezone: string }): void {
  let daily: KvTable<string, DailyRecord> | undefined
  // 写串行化：session/event 监听可并发触发，所有聚合写排进同一条 tail 链，
  // 之后 get+put 才不会互相覆盖（KvTable 不串行化并发读改写）。
  let tail: Promise<unknown> = Promise.resolve()
  // open 失败（version-mismatch/malformed-medium/invalid-record）时创建即挂
  // rejection handler：避免 unhandled rejection 崩掉宿主进程（Node 默认 throw）。
  // domainReady 仍保持 reject，写链（tail 吞掉）/命令（宿主转 kind:'error'）/
  // 端点（宿主 500）/卸载（cordis 记录）均感知失败而不次生崩溃。
  const domainReady = openDomainSafely(ctx, tokenUsageDomain, (msg) => ctx.logger.warn(msg)).then((domain) => {
    // openDomainSafely 的句柄是类型擦除的 DomainHandle，table 值类型回落 unknown，此处窄化回 DailyRecord。
    daily = domain.table('daily') as KvTable<string, DailyRecord>
    return domain
  })

  ctx.on('session/event', (session, event) => {
    const sample = sampleFromEvent(session, event, config.timezone, (m) => ctx.tokenMeter.estimateMessage(m))
    if (sample === undefined) return
    // 链到前一条写上，使读改写按序执行；单次失败被吞掉，不中断后续写（采集尽力而为）。
    const write = tail.then(() => domainReady).then(() => {
      const table = daily!
      return table.put(sample.date, addSample(table.get(sample.date) ?? emptyDaily(sample.date), sample))
    })
    tail = write.then(() => undefined, () => undefined)
  })

  ctx.commands.register({
    name: 'token-usage',
    description: '查看 token 用量（今日+近7日，或指定日期）',
    input: { hint: 'YYYY-MM-DD，可空' },
    handler: async ({ rawInput }) => {
      const table = await domainReady.then(() => daily!)
      const arg = rawInput.trim()
      const today = dayParts(Date.now(), config.timezone).date
      if (arg !== '' && !DATE_RE.test(arg)) {
        return { kind: 'error' as const, text: '用法：/token-usage [YYYY-MM-DD]' }
      }
      if (arg !== '') {
        return { kind: 'success' as const, text: renderDay(table.get(arg) ?? emptyDaily(arg)) }
      }
      const days = Array.from({ length: 7 }, (_, i) => {
        const date = dayParts(Date.now() - i * 86_400_000, config.timezone).date
        return table.get(date) ?? emptyDaily(date)
      })
      void today
      return { kind: 'success' as const, text: renderWeek(days[0].date, days) }
    },
  })

  // webServer 是可选能力（headless/CLI 无此服务），不进入顶层 inject。经
  // registerOptionalRoutes 子 fiber 等待其挂载后再注册：子 fiber 未激活时惰性、
  // 随父 fiber 卸载而清理；headless 下 webServer 永不出现，任何分支都不注册。
  // 注册走 ctx.effect 接线 disposer（"Registrations are effects"），HMR 重挂不会
  // 因重复 exact 路径抛错。
  registerOptionalRoutes(ctx, (webCtx) => {
    const disposeDaily = webCtx.webServer.register({
      kind: 'exact',
      path: '/token-usage/api/daily',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405).end()
          return
        }
        const date = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('date')
        if (date !== null && !DATE_RE.test(date)) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad date, want YYYY-MM-DD' }))
          return
        }
        const table = await domainReady.then(() => daily!)
        const today = dayParts(Date.now(), config.timezone).date
        const key = date ?? today
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ today, record: table.get(key) ?? emptyDaily(key) }))
      },
    })

    const disposeRange = webCtx.webServer.register({
      kind: 'exact',
      path: '/token-usage/api/range',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405).end()
          return
        }
        const days = parseDaysParam(new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('days'))
        if (days === null) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad days, want integer 1..366' }))
          return
        }
        const table = await domainReady.then(() => daily!)
        const today = dayParts(Date.now(), config.timezone).date
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ today, days: rangeSummaries((d) => table.get(d), today, days) }))
      },
    })

    return () => {
      disposeDaily()
      disposeRange()
    }
  })

  ctx.effect(() => async () => {
    await tail.catch(() => undefined) // 排空的写链落到后端后再关 domain
    await domainReady.then((domain) => domain.close())
  })
}
