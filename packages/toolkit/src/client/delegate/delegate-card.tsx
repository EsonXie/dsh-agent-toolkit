/** 委派卡：team_delegate 的 keyed tool.call.toolview 渲染器。 */
import type { SessionId, SubagentAddress, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { useEffect, useState } from 'react'
import { fetchActiveRoute, type DelegateRoute } from './api.ts'
import css from './delegate-card.module.css'
import type { NS } from './locales.ts'

/** 经 slots.register 的 inject 面注入的回调。 */
export interface DelegateCardInjected {
  readonly openChild: (address: SubagentAddress) => void
}

interface DelegateMeta {
  readonly childSessionId?: SessionId
  readonly provider?: string
  readonly model?: string
}

interface DelegateArgs {
  readonly role?: string
  readonly description?: string
  readonly prompt?: string
}

/** 运行中轮询间隔（命中/settled/卸载即停）。 */
const ACTIVE_POLL_MS = 1500

function argsOf(block: ToolCallBlock): DelegateArgs {
  const raw = 'kind' in block && block.kind === 'tool-result' ? block.call?.argsRaw : (block as { argsRaw?: string }).argsRaw
  if (typeof raw !== 'string') return {}
  try {
    return JSON.parse(raw) as DelegateArgs
  } catch {
    return {}
  }
}

function resultText(block: ToolCallBlock): string {
  if (!('kind' in block) || block.kind !== 'tool-result') return ''
  return block.content
    .filter((b): b is { type: 'text'; text: string } => (b as { type: string }).type === 'text')
    .map(b => b.text).join('')
}

export type DelegateCardProps = ToolCallViewProps & DelegateCardInjected & PropsLocale<typeof NS>

export function DelegateCard(props: DelegateCardProps) {
  const { block, sessionId, openChild, t } = props
  const settled = 'kind' in block && block.kind === 'tool-result'
  const isError = settled && block.isError
  const args = argsOf(block)
  const meta = settled ? (block.meta as DelegateMeta | undefined) : undefined
  const [expanded, setExpanded] = useState(false)
  const role = args.role
  const [activeRoute, setActiveRoute] = useState<DelegateRoute | null>(null)
  useEffect(() => {
    if (settled || role === undefined) return
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined
    const pull = (): void => {
      void fetchActiveRoute(String(sessionId), role).then((route) => {
        if (cancelled || route === null) return
        setActiveRoute(route)
        if (timer !== undefined) clearInterval(timer)
      }).catch(() => undefined)
    }
    pull()
    timer = setInterval(pull, ACTIVE_POLL_MS)
    return () => { cancelled = true; if (timer !== undefined) clearInterval(timer) }
  }, [settled, sessionId, role])

  // settled 时取 meta，运行中取在途结果；error 无 meta → null：
  const route: DelegateRoute | null = settled
    ? (typeof meta?.provider === 'string' && typeof meta?.model === 'string'
      ? { provider: meta.provider, model: meta.model }
      : null)
    : activeRoute
  const state = !settled ? 'ongoing' as const : isError ? 'error' as const : 'done' as const
  return (
    <div className={css.root} data-state={!settled ? 'running' : isError ? 'error' : 'ok'}>
      <div
        className={css.row}
        role="button"
        tabIndex={0}
        aria-expanded={expanded || settled}
        onClick={() => setExpanded(v => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v) } }}
      >
        <StateDot state={state} />
        {args.role !== undefined && <span className={css.chip}>{args.role}</span>}
        {route !== null && (
          <span className={css.chip} aria-label={t('card.modelAria', { route: `${route.provider} / ${route.model}` })}>
            {route.provider} / {route.model}
          </span>
        )}
        <span className={css.summary}>{args.description ?? ''}</span>
        <span className={css.visuallyHidden}>
          {!settled ? t('card.running') : isError ? t('card.failed') : ''}
        </span>
      </div>
      {(settled || expanded) && (
        <div className={css.body}>
          {expanded && args.prompt !== undefined && <pre className={css.prompt}>{args.prompt}</pre>}
          {settled && resultText(block) !== '' && (
            <div className={css.result}><MarkdownText text={resultText(block)} /></div>
          )}
          {settled && !isError && meta?.childSessionId !== undefined && (
            <button
              type="button"
              className={css.childLink}
              onClick={(e) => {
                e.stopPropagation()
                openChild({ parentSessionId: sessionId, childSessionId: meta.childSessionId!, mode: 'one-shot' })
              }}
            >
              {t('card.viewChild')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
