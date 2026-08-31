/** 分层提示词管理面板：固定层栈（只读原生行 + 可编辑层，仅文本可改）。 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLoadState } from '../shared/load-state.ts'
import { fetchPromptLayers, resetLayers, saveLayers, type NativeProbe, type PromptLayersPayload } from './api.ts'
import type { LayerConfig } from '../../prompt/types.ts'
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

/** 原生段名：identity 行与 model-notes 只读行的 section 名（与 dsh system-prompt / prompt 模块一致）。 */
const IDENTITY_SECTION = 'harness:identity'
const MODEL_NOTES_SECTION = 'prompt-stack:model-notes'
/** 内置模型层段名（prompt-stack 内置 base，只读展示）。 */
const MODEL_SECTION = 'prompt-stack:base'

function sortedLayers(layers: LayerConfig[]): LayerConfig[] {
  return [...layers].sort((a, b) => a.order - b.order)
}

function nativeText(native: NativeProbe, name: string): string {
  return native.sections.find(s => s.name === name)?.text ?? ''
}

function PromptLayersBody(): ReactNode {
  const { state, reload } = useLoadState<PromptLayersPayload>(fetchPromptLayers, [])
  const [layers, setLayers] = useState<LayerConfig[]>([])
  const [native, setNative] = useState<NativeProbe>({ sections: [], contexts: [] })
  const [modelFallbackText, setModelFallbackText] = useState('')
  const [identityOverride, setIdentityOverride] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
  const selected = ordered.find(l => l.name === selectedKey) ?? ordered[0]
  const isReadonlyRow = selectedKey === MODEL_NOTES_SECTION || selectedKey === MODEL_SECTION
  const isIdentityRow = selectedKey === IDENTITY_SECTION

  function updateSelectedText(text: string): void {
    if (selected === undefined) return
    setLayers(layers.map(l => (l.name === selected.name ? { ...l, text } : l)))
    setDirty(true)
  }

  async function save(): Promise<void> {
    setError(null)
    setSaving(true)
    try {
      await saveLayers(sortedLayers(layers), identityOverride)
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
      setSelectedKey(null)
      setDirty(false)
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const readonlyRow = (section: string, label: string, note: string): ReactNode => (
    <button key={section} type="button"
      className={clsx(css.layerRow, selectedKey === section && css.layerRowActive)}
      onClick={() => { setSelectedKey(section) }}>
      <span className={css.layerName}>
        {label}
        <span className={css.readonlyTag}>只读</span>
      </span>
      <span className={css.layerOrder}>{note}</span>
    </button>
  )

  const actions = (
    <div className={css.actions}>
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
      {confirmingReset ? (
        <>
          <span className={css.hint}>确认用默认层覆盖当前层（连带清空 identity 覆盖）？</span>
          <Button variant="outline" disabled={saving} onClick={() => { setConfirmingReset(false) }}>取消</Button>
          <Button variant="primary" disabled={saving} onClick={() => { void reset() }}>确认重置</Button>
        </>
      ) : (
        <Button variant="outline" disabled={saving} onClick={() => { setConfirmingReset(true) }}>重置为默认层</Button>
      )}
      <Button variant="primary" disabled={saving || !dirty} onClick={() => { void save() }}>保存</Button>
    </div>
  )

  return (
    <div className={css.split}>
      <div className={css.listPane}>
        {state.kind === 'loading' && <p className={css.hint}>加载中…</p>}
        {state.kind === 'error' && <p className={css.hint}>加载失败，请重试</p>}
        {state.kind === 'ok' && (
          <>
            <button type="button"
              className={clsx(css.layerRow, isIdentityRow && css.layerRowActive)}
              onClick={() => { setSelectedKey(IDENTITY_SECTION) }}>
              <span className={css.layerName}>harness:identity</span>
              <span className={css.layerOrder}>原生身份段 · 可覆盖</span>
            </button>
            {readonlyRow(MODEL_SECTION, '模型层', '内置 · 按模型命中规则覆盖')}
            {ordered.map((layer) => (
              <button key={layer.name} type="button"
                className={clsx(css.layerRow, (selectedKey === null || selectedKey === layer.name) && selected === layer && css.layerRowActive)}
                onClick={() => { setSelectedKey(layer.name) }}>
                <span className={css.layerName}>{layer.name}</span>
                <span className={css.layerOrder}>order {layer.order}</span>
              </button>
            ))}
            {readonlyRow(MODEL_NOTES_SECTION, 'model-notes', '由规则 append 渲染')}
          </>
        )}
      </div>
      <div className={css.editorPane}>
        {state.kind === 'ok' && isIdentityRow ? (
          <div className={css.editor}>
            <p className={css.hint}>
              harness:identity 是 dsh 原生身份段：填写则整份覆盖原生文本，留空则还原原生。仅主 Agent 生效（委派子 Agent 仍用原生）。
            </p>
            <textarea className={css.textarea} aria-label="身份段覆盖文本" rows={8}
              placeholder={nativeText(native, IDENTITY_SECTION)}
              value={identityOverride}
              onChange={(e) => { setIdentityOverride(e.target.value); setDirty(true) }} />
            {actions}
          </div>
        ) : state.kind === 'ok' && isReadonlyRow ? (
          <div className={css.editor}>
            <p className={css.hint}>
              {selectedKey === MODEL_SECTION
                ? '模型层是内置提示词：运行时按当前模型命中规则整份覆盖，不可编辑。'
                : 'model-notes 是保留层：规则命中时以其 append 文本渲染，不可直接编辑。'}
            </p>
            <textarea className={css.textarea} readOnly aria-label="只读段文本" rows={8}
              value={selectedKey === MODEL_SECTION ? modelFallbackText : nativeText(native, selectedKey ?? '')} />
          </div>
        ) : state.kind === 'ok' && selected !== undefined ? (
          <div className={css.editor}>
            <label className={css.field}>
              层文本
              <textarea className={css.textarea} value={selected.text} aria-label="层文本" rows={8}
                onChange={(e) => { updateSelectedText(e.target.value) }} />
            </label>
            {actions}
          </div>
        ) : (
          <p className={css.hint}>{state.kind === 'loading' ? '加载中…' : state.kind === 'error' ? '加载失败，请重试' : '请选择层'}</p>
        )}
      </div>
    </div>
  )
}
