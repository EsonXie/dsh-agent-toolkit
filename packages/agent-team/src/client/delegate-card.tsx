/** 委派卡：team_delegate 的 keyed tool.call.toolview 渲染器。 */
import type { SessionId, SubagentAddress, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { MarkdownText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import clsx from 'clsx'
import { useState } from 'react'
import css from './delegate-card.module.css'
import type { NS } from './locales.ts'

/** 经 slots.register 的 inject 面注入的回调。 */
export interface DelegateCardInjected {
  readonly openChild: (address: SubagentAddress) => void
}

interface DelegateMeta {
  readonly childSessionId?: SessionId
}

interface DelegateArgs {
  readonly role?: string
  readonly description?: string
  readonly prompt?: string
}

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
  const state = !settled ? 'ongoing' as const : isError ? 'error' as const : 'done' as const
  return (
    <div className={css.root} data-state={!settled ? 'running' : isError ? 'error' : 'ok'}>
      <div
        className={css.row}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(v => !v) } }}
      >
        <StateDot state={state} />
        {args.role !== undefined && <span className={css.chip}>{args.role}</span>}
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
