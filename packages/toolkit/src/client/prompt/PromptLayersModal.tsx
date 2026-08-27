/** 分层提示词管理面板：左侧层列表（order 升序、增删/上移下移）+ 右侧编辑器 + 规则只读折叠视图。 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLoadState } from '../shared/load-state.ts'
import { fetchPromptLayers, resetLayers, saveLayers } from './api.ts'
import type { LayerConfig, Rule } from '../../prompt/types.ts'
import css from './prompt.module.css'

export interface PromptLayersModalProps {
  open: boolean
  onClose: () => void
}

export function PromptLayersModal({ open, onClose }: PromptLayersModalProps): ReactNode {
  return (
    <Modal open={open} onClose={onClose} title="分层提示词" closeLabel="关闭" className={css.dialog}>
      {open && <PromptLayersBody />}
    </Modal>
  )
}

function nextOrder(layers: LayerConfig[]): number {
  return layers.reduce((min, layer) => Math.min(min, layer.order), 0) - 10
}

function sortedLayers(layers: LayerConfig[]): LayerConfig[] {
  return [...layers].sort((a, b) => a.order - b.order)
}

function matchSummary(rule: Rule): string {
  const parts: string[] = []
  const m = rule.match
  if (m.provider !== undefined) parts.push(`provider=${m.provider}`)
  if (m.model !== undefined) parts.push(`model=${m.model}`)
  if (m.modelPattern !== undefined) parts.push(`modelPattern=${m.modelPattern}`)
  return parts.join(' AND ')
}

function PromptLayersBody(): ReactNode {
  const { state, reload } = useLoadState<{ layers: LayerConfig[]; rules: Rule[]; seedLayers: LayerConfig[] }>(fetchPromptLayers, [])
  const [layers, setLayers] = useState<LayerConfig[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRules, setShowRules] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)

  useEffect(() => {
    if (state.kind !== 'ok' || loaded) return
    setLayers(sortedLayers(state.data.layers))
    setRules(state.data.rules)
    setLoaded(true)
  }, [state, loaded])

  const ordered = sortedLayers(layers)
  const selected = ordered[Math.min(selectedIndex, ordered.length - 1)]
  const layerNames = new Set(ordered.map(l => l.name))

  function updateSelected(patch: Partial<LayerConfig>): void {
    if (selected === undefined) return
    const next = layers.map(l => (l.name === selected.name && l.order === selected.order ? { ...l, ...patch } : l))
    setLayers(next)
    setDirty(true)
  }

  function addLayer(): void {
    const layer: LayerConfig = { name: '', order: nextOrder(layers), text: '' }
    setLayers([...layers, layer])
    setSelectedIndex(0)
    setDirty(true)
  }

  function deleteSelected(): void {
    if (selected === undefined) return
    const next = layers.filter(l => !(l.name === selected.name && l.order === selected.order))
    setLayers(next)
    setSelectedIndex(Math.max(0, selectedIndex - 1))
    setDirty(true)
  }

  function moveSelected(dir: -1 | 1): void {
    if (selected === undefined) return
    const index = ordered.findIndex(l => l.name === selected.name && l.order === selected.order)
    const target = index + dir
    if (index < 0 || target < 0 || target >= ordered.length) return
    const a = ordered[index]
    const b = ordered[target]
    const next = ordered.map((l, i) =>
      i === index ? { ...b, order: a.order } : i === target ? { ...a, order: b.order } : l)
    setLayers(next)
    setSelectedIndex(target)
    setDirty(true)
  }

  async function save(): Promise<void> {
    setError(null)
    setSaving(true)
    try {
      await saveLayers(sortedLayers(layers))
      setDirty(false)
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
      setSelectedIndex(0)
      setDirty(false)
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={css.split}>
      <div className={css.listPane}>
        {state.kind === 'loading' && <p className={css.hint}>加载中…</p>}
        {state.kind === 'error' && <p className={css.hint}>加载失败，请重试</p>}
        {state.kind === 'ok' && ordered.map((layer, index) => (
          <button key={`${layer.name}-${layer.order}`} type="button"
            className={clsx(css.layerRow, index === selectedIndex && css.layerRowActive)}
            onClick={() => { setSelectedIndex(index) }}>
            <span className={css.layerName}>{layer.name || '(未命名)'}</span>
            <span className={css.layerOrder}>order {layer.order}</span>
          </button>
        ))}
        <Button variant="primary" className={css.createButton} onClick={addLayer}>新建层</Button>
      </div>
      <div className={css.editorPane}>
        {state.kind === 'ok' && selected !== undefined ? (
          <div className={css.editor}>
            <label className={css.field}>
              层名
              <Input value={selected.name} aria-label="层名" className={css.input}
                onChange={(e) => { updateSelected({ name: e.target.value }) }} />
            </label>
            <label className={css.field}>
              order
              <Input value={String(selected.order)} aria-label="order" className={css.input}
                onChange={(e) => {
                  const parsed = Number(e.target.value)
                  if (Number.isFinite(parsed)) updateSelected({ order: parsed })
                }} />
            </label>
            <label className={css.field}>
              层文本
              <textarea className={css.textarea} value={selected.text} aria-label="层文本" rows={8}
                onChange={(e) => { updateSelected({ text: e.target.value }) }} />
            </label>

            <div className={css.rowActions}>
              <Button variant="outline" onClick={() => { moveSelected(-1) }}>上移</Button>
              <Button variant="outline" onClick={() => { moveSelected(1) }}>下移</Button>
              <Button variant="outline" className={css.dangerButton} onClick={deleteSelected}>删除层</Button>
            </div>

            <div className={css.actions}>
              {error !== null && <p role="alert" className={css.error}>{error}</p>}
              {confirmingReset ? (
                <>
                  <span className={css.hint}>确认用默认层覆盖当前层？</span>
                  <Button variant="outline" disabled={saving} onClick={() => { setConfirmingReset(false) }}>取消</Button>
                  <Button variant="primary" disabled={saving} onClick={() => { void reset() }}>确认重置</Button>
                </>
              ) : (
                <Button variant="outline" disabled={saving} onClick={() => { setConfirmingReset(true) }}>重置为默认层</Button>
              )}
              <Button variant="primary" disabled={saving || !dirty} onClick={() => { void save() }}>保存</Button>
            </div>
          </div>
        ) : (
          <p className={css.hint}>{state.kind === 'loading' ? '加载中…' : state.kind === 'error' ? '加载失败，请重试' : '请选择层'}</p>
        )}
      </div>
      <div className={css.rulesPane}>
        <Button variant="outline" onClick={() => { setShowRules(!showRules) }}>规则（只读）</Button>
        {showRules && (
          <ul className={css.ruleList}>
            {rules.map((rule, index) => {
              const dangling = Object.keys(rule.overrides ?? {}).filter(k => !layerNames.has(k))
              return (
                <li key={index} className={css.ruleItem}>
                  <span className={css.ruleMatch}>{matchSummary(rule)}</span>
                  {Object.keys(rule.overrides ?? {}).length > 0 && (
                    <span className={css.ruleOverrides}>
                      overrides: {Object.entries(rule.overrides ?? {}).map(([k, v]) =>
                        <span key={k} className={dangling.includes(k) ? css.dangling : undefined}>{k}</span>).join(', ')}
                    </span>
                  )}
                  {rule.append !== undefined && <span className={css.ruleAppend}>append: {rule.append}</span>}
                  {dangling.length > 0 && <span className={css.error}>悬空层引用：{dangling.join(', ')}</span>}
                </li>
              )
            })}
            {rules.length === 0 && <li className={css.hint}>无规则（rules 由 cordis.yml 配置）</li>}
          </ul>
        )}
      </div>
    </div>
  )
}
