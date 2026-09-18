/** 分层提示词设置页：顶部四层心智模型说明区 + 纵向四卡（identity/模型层/persona/动态层）+ 底部 SaveBar。 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLoadState } from '../shared/load-state.ts'
import { SaveBar, useToast } from '../shared/feedback.tsx'
import { fetchPromptLayers, resetLayers, saveLayers, type NativeProbe, type PromptLayersPayload } from './api.ts'
import type { LayerConfig, RuleMatch } from '../../prompt/types.ts'
import type { ToolkitKey } from '../settings/locales.ts'
import css from './prompt.module.css'

/** 原生身份段名（与 dsh system-prompt 宿主一致），identity 卡只读回显用。 */
const IDENTITY_SECTION = 'harness:identity'

export interface PromptPageProps {
  /** 键域为 agent-toolkit 词典；Task 12 壳传入 ctx.locale.bind(NS)。 */
  t: (key: ToolkitKey) => string
}

function sortedLayers(layers: LayerConfig[]): LayerConfig[] {
  return [...layers].sort((a, b) => a.order - b.order)
}

function nativeText(native: NativeProbe, name: string): string {
  return native.sections.find(s => s.name === name)?.text ?? ''
}

/** 规则匹配条件 → tab 标签（provider/model 带字段前缀，modelPattern 原样；多字段 ' + ' 连接）。 */
function formatMatch(match: RuleMatch): string {
  const parts: string[] = []
  if (match.provider !== undefined) parts.push(`provider: ${match.provider}`)
  if (match.model !== undefined) parts.push(`model: ${match.model}`)
  if (match.modelPattern !== undefined) parts.push(match.modelPattern)
  return parts.join(' + ')
}

/** 规则查看 tab 项：标签（匹配条件或「内置默认」）+ 只读文本。 */
interface RuleTabItem { label: string; text: string }

/** 只读规则 tab 栏 + 文本框：内部自持选中态（默认第一页），随 key 重挂载复位。
 *  提供 source 时，在文本上方渲染当前命中来源注（模型层显式来源）。 */
function RuleTabs({ tabs, textLabel, emptyLabel, source }: {
  tabs: RuleTabItem[]
  textLabel: string
  emptyLabel: string
  source?: (current: RuleTabItem, index: number) => string
}): ReactNode {
  const [index, setIndex] = useState(0)
  const current = tabs[index] ?? tabs[0]
  if (tabs.length === 0) {
    return (
      <>
        <p className={css.hint}>{emptyLabel}</p>
        <textarea className={css.textarea} readOnly aria-label={textLabel} rows={6} value="" />
      </>
    )
  }
  return (
    <>
      <div className={css.tabs} role="tablist">
        {tabs.map((tab, i) => (
          <button key={`${i}:${tab.label}`} type="button" role="tab" aria-selected={i === index}
            className={clsx(css.tab, i === index && css.tabActive)}
            onClick={() => { setIndex(i) }}>{tab.label}</button>
        ))}
      </div>
      {source !== undefined && current !== undefined && <p className={css.hint}>{source(current, index)}</p>}
      <textarea className={css.textarea} readOnly aria-label={textLabel} rows={6}
        value={current?.text ?? ''} />
    </>
  )
}

/** 单张层卡：卡头（标题 + 只读/可编辑徽标）+ 一句话说明 + 内容。 */
function LayerCard({ id, title, badge, desc, children }: {
  id: string
  title: string
  badge: string
  desc: string
  children: ReactNode
}): ReactNode {
  return (
    <section className={css.card} data-testid={`prompt-card-${id}`}>
      <div className={css.cardHead}>
        <span className={css.cardTitle} data-testid="prompt-card-title">{title}</span>
        <span className={css.badge}>{badge}</span>
      </div>
      <p className={css.hint}>{desc}</p>
      {children}
    </section>
  )
}

export function PromptPage(props: PromptPageProps): ReactNode {
  const { t } = props
  const { showToast, toastNode } = useToast()
  const { state, reload } = useLoadState<PromptLayersPayload>(fetchPromptLayers, [])
  const [layers, setLayers] = useState<LayerConfig[]>([])
  const [native, setNative] = useState<NativeProbe>({ sections: [], contexts: [] })
  const [modelFallbackText, setModelFallbackText] = useState('')
  const [identityOverride, setIdentityOverride] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [introOpen, setIntroOpen] = useState(true)
  const [dynamicOpen, setDynamicOpen] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)

  useEffect(() => {
    if (state.kind !== 'ok' || loaded) return
    setLayers(sortedLayers(state.data.layers))
    setNative(state.data.native ?? { sections: [], contexts: [] })
    setModelFallbackText(state.data.modelFallbackText)
    setIdentityOverride(state.data.identityOverride)
    setLoaded(true)
  }, [state, loaded])

  const ordered = sortedLayers(layers)
  const rules = state.kind === 'ok' ? state.data.rules : []
  const persona = ordered[0]
  const modelTabs: RuleTabItem[] = [
    { label: t('prompt.model.builtin'), text: modelFallbackText },
    ...rules.flatMap(r => r.overrides?.base === undefined ? [] : [{ label: formatMatch(r.match), text: r.overrides.base }]),
  ]
  const notesTabs: RuleTabItem[] = rules.flatMap(r =>
    r.append === undefined ? [] : [{ label: formatMatch(r.match), text: r.append }])

  function updatePersonaText(text: string): void {
    if (persona === undefined) return
    setLayers(layers.map(l => (l.name === persona.name ? { ...l, text } : l)))
    setDirty(true)
    setSaved(false)
  }

  function updateIdentity(text: string): void {
    setIdentityOverride(text)
    setDirty(true)
    setSaved(false)
  }

  async function save(): Promise<void> {
    setError(null)
    setSaving(true)
    try {
      await saveLayers(sortedLayers(layers), identityOverride)
      setDirty(false)
      setSaved(true)
      showToast(t('feedback.saved'))
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function reset(): Promise<void> {
    setError(null)
    setSaving(true)
    try {
      await resetLayers()
      setConfirmingReset(false)
      setLoaded(false)
      setDirty(false)
      setSaved(false)
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (state.kind === 'loading') return <p className={css.hint}>{t('prompt.loading')}</p>
  if (state.kind === 'error') return <p className={css.hint}>{t('prompt.loadError')}</p>

  return (
    <div className={css.page}>
      {toastNode}

      <section className={css.intro}>
        <button type="button" className={css.introHead} aria-expanded={introOpen}
          onClick={() => { setIntroOpen(!introOpen) }}>
          {t('prompt.introTitle')}
        </button>
        {introOpen && <p className={css.introBody}>{t('prompt.intro')}</p>}
      </section>

      <LayerCard id="identity" title={t('prompt.card.identity')} badge={t('prompt.badge.editable')} desc={t('prompt.identity.desc')}>
        <label className={css.field}>
          {t('prompt.identity.nativeLabel')}
          <textarea className={css.textarea} readOnly rows={4}
            aria-label={t('prompt.identity.nativeLabel')} value={nativeText(native, IDENTITY_SECTION)} />
        </label>
        <label className={css.field}>
          {t('prompt.identity.overrideLabel')}
          <textarea className={css.textarea} rows={4}
            aria-label={t('prompt.identity.overrideLabel')} value={identityOverride}
            placeholder={nativeText(native, IDENTITY_SECTION)}
            onChange={(e) => { updateIdentity(e.target.value) }} />
        </label>
        <p className={css.hint}>{t('prompt.identity.note')}</p>
      </LayerCard>

      <LayerCard id="model" title={t('prompt.card.model')} badge={t('prompt.badge.readonly')} desc={t('prompt.model.desc')}>
        <RuleTabs tabs={modelTabs} textLabel={t('prompt.model.textLabel')} emptyLabel={t('prompt.model.builtin')}
          source={(current, index) => index === 0
            ? t('prompt.model.sourceBuiltin')
            : `${t('prompt.model.sourceRule')}（${current.label}）`} />
      </LayerCard>

      <LayerCard id="persona" title={t('prompt.card.persona')} badge={t('prompt.badge.editable')} desc={t('prompt.persona.desc')}>
        <p className={css.hint}>{t('prompt.guide')}</p>
        <div className={css.examples}>
          <Button variant="outline" onClick={() => { updatePersonaText(t('prompt.exampleReviewer')) }}>
            {t('prompt.exampleReviewerName')}
          </Button>
          <Button variant="outline" onClick={() => { updatePersonaText(t('prompt.exampleOps')) }}>
            {t('prompt.exampleOpsName')}
          </Button>
        </div>
        <label className={css.field}>
          {t('prompt.persona.label')}
          <textarea className={css.textarea} rows={6}
            aria-label={t('prompt.persona.label')} value={persona?.text ?? ''}
            placeholder={t('prompt.persona.placeholder')}
            onChange={(e) => { updatePersonaText(e.target.value) }} />
        </label>
      </LayerCard>

      <LayerCard id="dynamic" title={t('prompt.card.dynamic')} badge={t('prompt.badge.readonly')} desc={t('prompt.dynamic.desc')}>
        <button type="button" className={css.disclosure} aria-expanded={dynamicOpen}
          onClick={() => { setDynamicOpen(!dynamicOpen) }}>
          {dynamicOpen ? t('prompt.dynamic.collapse') : t('prompt.dynamic.expand')}
        </button>
        {dynamicOpen && (
          <RuleTabs tabs={notesTabs} textLabel={t('prompt.dynamic.textLabel')} emptyLabel={t('prompt.dynamic.empty')} />
        )}
      </LayerCard>

      {confirmingReset ? (
        <div className={css.resetBar}>
          <span className={css.hint}>{t('prompt.resetHint')}</span>
          <Button variant="outline" disabled={saving} onClick={() => { setConfirmingReset(false) }}>
            {t('prompt.resetCancel')}
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => { void reset() }}>
            {t('prompt.resetConfirm')}
          </Button>
        </div>
      ) : (
        <div className={css.resetBar}>
          <Button variant="outline" disabled={saving} onClick={() => { setConfirmingReset(true) }}>
            {t('prompt.reset')}
          </Button>
        </div>
      )}

      <SaveBar
        labels={{ save: t('prompt.save'), cancel: t('prompt.cancel'), saved: t('feedback.saved') }}
        dirty={dirty}
        saving={saving}
        saved={saved}
        error={error}
        onSave={() => { void save() }}
        onCancel={() => { setConfirmingReset(false) }}
      />
    </div>
  )
}
