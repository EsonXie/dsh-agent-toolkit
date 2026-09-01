/** usage 模块：per-day token 用量采集、/token-usage 命令与 /dsh-agent-toolkit/api/usage JSON 路由。 */
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

const METER_OWNER_KEY = 'meter_owner'

/** storage-domain 对已在进程内打开的域抛 DomainError(code='already-open')：双装时后到实例据此停用。 */
function isAlreadyOpen(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'already-open'
}

export function setupUsage(ctx: Context, config: { timezone: string }, owner: string): void {
  let daily: KvTable<string, DailyRecord> | undefined
  let meta: KvTable<string, { value: string }> | undefined
  // 写串行化：session/event 监听可并发触发，所有聚合写排进同一条 tail 链，
  // 之后 get+put 才不会互相覆盖（KvTable 不串行化并发读改写）。
  let tail: Promise<unknown> = Promise.resolve()
  // open 失败（version-mismatch/malformed-medium/invalid-record）时创建即挂
  // rejection handler：避免 unhandled rejection 崩掉宿主进程（Node 默认 throw）。
  // domainReady 仍保持 reject，命令/路由注册收窄到 open 成功后（见 openSucceeded），
  // 写链（tail 吞掉）/卸载（cordis 记录）感知失败而不次生崩溃。
  const domainReady = openDomainSafely(
    ctx,
    tokenUsageDomain,
    (msg) => ctx.logger.warn(msg),
    // 卸载前排空本模块写链：close 一旦开始（disposing=true）就拒绝新入队的写，
    // 未落队的采集会被静默丢弃——drain 先于 close 是归档的保证。
    () => tail.then(async () => {
      // 释放计量所有权（仅占位方）；失败不阻断 close。
      if (ownsMeter) await meta?.delete(METER_OWNER_KEY).catch(() => undefined)
    }, () => undefined),
  ).then((domain) => {
    // openDomainSafely 的句柄是类型擦除的 DomainHandle，table 值类型回落 unknown，此处窄化回 DailyRecord。
    daily = domain.table('daily') as KvTable<string, DailyRecord>
    meta = domain.table('meta') as KvTable<string, { value: string }>
    return domain
  })

  // 双装守卫与降级：token 用量功能先到先得。真实宿主里 storage-domain 的 open 对已在
  // 进程内打开的域名抛 code='already-open'（域名互斥），后到实例在拿到域句柄前就被挡下
  // ——此时读不到 meter_owner，只能按 already-open 直接停用；meter_owner meta 守卫保留作
  // 跨场景防御（共享介质/历史版本等），占位方卸载时释放。
  let ownsMeter = false
  const meteringReady = domainReady.then(
    async () => {
      const existing = meta!.get(METER_OWNER_KEY)
      if (existing !== undefined && existing.value !== owner) {
        // 已被他包占用：本实例跳过计量（命令/路由仍在，读同一份数据）。
        ctx.logger.warn(`token 计量已由 ${existing.value} 挂载，本实例（${owner}）跳过计量采集`)
        return false
      }
      if (existing !== undefined) {
        // 同名主残留键：上次进程未干净退出（崩溃/强杀），beforeClose 的释放丢失。
        // 残留键不带活性信息且同一介质不支撑双实例并发计量，按 stale 处理直接接管，
        // 否则该键会把本包的后续所有启动永久锁死（自我锁死，观测为统计恒 0）。
        ctx.logger.warn(`发现本实例（${owner}）上次非正常退出残留的 meter_owner 占位键，接管计量采集`)
      }
      // 占位意图先置位再落盘：即便 put 在途时就卸载，beforeClose 也会释放。真实 KvTable 的
      // put/delete 走同一串行链（host.enqueue），delete 排在 put 之后会观测到落盘再删除。
      // 接管路径同样重 put 一遍：接管不改变值，只是让 ownsMeter/释放语义与首次占位一致。
      ownsMeter = true
      await meta!.put(METER_OWNER_KEY, { value: owner })
      return true
    },
    // open 失败分支：already-open 即双装，后到实例自动停用——不采集、不注册命令/路由；
    // 其余 open 失败维持现状（openDomainSafely 已 warn，这里静默收尾，不次生未处理拒绝）。
    (error) => {
      if (isAlreadyOpen(error)) {
        ctx.logger.warn('token 用量域已被先到实例挂载（storage domain 的 token_usage 域名已打开，无法读取其 meter_owner），本实例停用用量功能：不采集、不注册 /token-usage 命令与路由')
      }
      return false
    },
  )

  // 命令/路由注册收窄到 open 成功后：已停用的后到实例绝不注册重复命令 / 重复 exact 路径
  //（webServer 重复 exact 路径会抛错）。registerOptionalRoutes 的 ctx.inject 惰性语义不变：
  // webServer 挂载后才注册、随父 fiber 清理。
  const openSucceeded = domainReady.then(() => true, () => false)

  // 守卫失败（已有他包采集）时不挂监听，tail 恒为空链；open 失败（domainReady reject）
  // 时这里拒绝吞掉，不次生 unhandled rejection 崩掉宿主（本模块开头的既定不变式）。
  void meteringReady.then((metering) => {
    if (!metering) return
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
  }, () => undefined)

  void openSucceeded.then((ok) => {
    if (!ok) return
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
  })

  // webServer 是可选能力（headless/CLI 无此服务），不进入顶层 inject。经
  // registerOptionalRoutes 子 fiber 等待其挂载后再注册：子 fiber 未激活时惰性、
  // 随父 fiber 卸载而清理；headless 下 webServer 永不出现，任何分支都不注册。
  // 注册走 ctx.effect 接线 disposer（"Registrations are effects"），HMR 重挂不会
  // 因重复 exact 路径抛错。整段只在 open 成功后执行（已停用的后到实例不注册路由）。
  void openSucceeded.then((ok) => {
    if (!ok) return
    registerOptionalRoutes(ctx, (webCtx) => {
      const disposeDaily = webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-agent-toolkit/api/usage/daily',
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
        path: '/dsh-agent-toolkit/api/usage/range',
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
  })
}
