/** Agent 编辑器：基本信息 + 提示词（persona）+ 模型（级联下拉）+ 工具白名单 四区块。 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentRecord } from '../../agents/store.ts'
import { deleteAgent, fetchModels, fetchProviders, fetchTools, saveAgent, type ModelOption, type ProviderOption, type ToolsCatalog } from './api.ts'
import { SaveBar, type SaveBarLabels } from '../shared/feedback.tsx'
import css from './agents.module.css'

/** Agent id 约束（与 src/agents/store.ts 的 AGENT_ID_RE 保持一致，客户端前置校验用）。 */
const AGENT_ID_RE = /^(?:main|[a-z][a-z0-9-]{0,31})$/

export interface AgentEditorProps {
  /** undefined = 新建模式（id 可编辑）。 */
  agent?: AgentRecord
  /** 提供时底部渲染共享 SaveBar（设置页内联编辑）；缺省保留旧 actions 行（AgentsModal）。 */
  labels?: SaveBarLabels
  onSaved(saved: AgentRecord): void
  onDeleted?(id: string): void
  onCancel?(): void
}

export function AgentEditor({ agent, labels, onSaved, onDeleted, onCancel }: AgentEditorProps): ReactNode {
  const creating = agent === undefined
  const locked = agent !== undefined && (agent.id === 'main' || agent.builtin === true)

  const [id, setId] = useState(agent?.id ?? '')
  const [name, setName] = useState(agent?.name ?? '')
  const [description, setDescription] = useState(agent?.description ?? '')
  const [persona, setPersona] = useState(agent?.persona ?? '')
  const [provider, setProvider] = useState(agent?.model?.provider ?? '')
  const [model, setModel] = useState(agent?.model?.model ?? '')
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [tools, setTools] = useState<string[]>(agent?.tools?.allow ?? [])
  // 工具模式：不限制（省略 tools 字段）/ 自定义白名单。编辑态按记录有无 tools 派生；新建默认自定义（名册到达后全勾）。
  const [toolsMode, setToolsMode] = useState<'unrestricted' | 'custom'>(
    agent === undefined || agent.tools !== undefined ? 'custom' : 'unrestricted',
  )
  // 团队可见性：省略/true = 可见（checkbox 勾选）；false = 隐藏。保存时勾选省略字段、不勾选写 false。
  const [visibleInTeam, setVisibleInTeam] = useState(agent?.visibleInTeam !== false)
  const [catalog, setCatalog] = useState<ToolsCatalog>({ preset: [], global: [] })
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 字段快照对比驱动 SaveBar 的 dirty（仅 SaveBar 模式消费；初始快照随重挂复位）。
  const [initialSnapshot] = useState(() => JSON.stringify({ id, name, description, persona, provider, model, tools, toolsMode, visibleInTeam }))
  const dirty = JSON.stringify({ id, name, description, persona, provider, model, tools, toolsMode, visibleInTeam }) !== initialSnapshot

  // 打开即取 providers 与工具名册；模型随 provider 变更级联重取，失败静默降级为空列表。
  useEffect(() => {
    let stale = false
    fetchProviders().then((ps) => { if (!stale) setProviders(ps) }).catch(() => undefined)
    fetchTools().then((c) => {
      if (stale) return
      setCatalog(c)
      setCatalogLoaded(true)
      // 新建模式默认全勾（preset + 全局）；编辑模式以记录 allow 为准
      if (creating) setTools([...c.preset, ...c.global])
    }).catch(() => undefined)
    return () => { stale = true }
  }, [])

  useEffect(() => {
    let stale = false
    if (provider.trim().length === 0) {
      setModels([])
      setModel('')
      return () => { stale = true }
    }
    fetchModels(provider.trim())
      .then((ms) => { if (!stale) setModels(ms) })
      .catch(() => { if (!stale) setModels([]) })
    return () => { stale = true }
  }, [provider])

  function toggleTool(tool: string, checked: boolean): void {
    setTools(checked ? [...tools, tool] : tools.filter((t) => t !== tool))
  }

  async function save(): Promise<void> {
    setError(null)
    const trimmedId = id.trim()
    const trimmedName = name.trim()
    if (creating && trimmedId.length === 0) { setError('请填写角色 ID'); return }
    if (creating && !AGENT_ID_RE.test(trimmedId)) { setError('ID 需以小写字母开头，仅含小写字母/数字/连字符'); return }
    if (trimmedName.length === 0) { setError('请填写角色名称'); return }
    // SaveBar 模式无按钮级禁用守卫，这里兜住「名册未到 / 自定义全不勾」两条静默降级路径。
    if (creating && !catalogLoaded) { setError('工具名册加载中，请稍候'); return }
    if (toolsMode === 'custom' && tools.length === 0) { setError('自定义白名单至少勾选一个工具，或改选不限制'); return }
    const record: AgentRecord = {
      id: trimmedId,
      name: trimmedName,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(persona.trim() ? { persona: persona.trim() } : {}),
      ...(provider.trim().length > 0 && model.trim().length > 0 ? { model: { provider: provider.trim(), model: model.trim() } } : {}),
      ...(toolsMode === 'custom' && tools.length > 0 ? { tools: { allow: tools } } : {}),
      ...(visibleInTeam ? {} : { visibleInTeam: false }),
    }
    setSaving(true)
    try {
      await saveAgent(record)
      onSaved(record)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function remove(): Promise<void> {
    if (agent === undefined) return
    setError(null)
    setSaving(true)
    try {
      await deleteAgent(agent.id)
      onDeleted?.(agent.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={css.editor}>
      <section className={css.block}>
        <h3 className={css.blockTitle}>基本信息</h3>
        {creating ? (
          <label className={css.field}>
            ID
            <Input value={id} onChange={(e) => { setId(e.target.value) }} aria-label="ID" className={css.input} placeholder="小写字母开头，如 ops" />
          </label>
        ) : (
          <p className={css.readonlyId}>ID：{agent.id}</p>
        )}
        <label className={css.field}>
          名称
          {/* main 的 name 服务端不可改（registry 守卫 409），与之一致的只读呈现 */}
          <Input value={name} onChange={(e) => { setName(e.target.value) }} aria-label="名称" className={css.input} disabled={agent?.id === 'main'} />
        </label>
        <label className={css.field}>
          描述
          <textarea className={css.textarea} value={description} onChange={(e) => { setDescription(e.target.value) }} aria-label="描述" rows={2} />
        </label>
        <label className={css.toolCheck}>
          <input type="checkbox" checked={visibleInTeam} aria-label="在 Agent 团队中可见"
            onChange={(e) => { setVisibleInTeam(e.target.checked) }} />
          在 Agent 团队中可见
        </label>
      </section>

      <section className={css.block}>
        <h3 className={css.blockTitle}>提示词</h3>
        <textarea
          className={css.textarea} value={persona} aria-label="提示词" rows={6}
          placeholder="角色人设与职责（固定分层中唯一可自定义的 persona 层）"
          onChange={(e) => { setPersona(e.target.value) }}
        />
      </section>

      <section className={css.block}>
        <h3 className={css.blockTitle}>模型</h3>
        <label className={css.field}>
          Provider
          <select className={css.select} value={provider} aria-label="Provider"
            onChange={(e) => { setProvider(e.target.value); setModel(''); setModels([]) }}>
            <option value="">跟随默认</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className={css.field}>
          模型
          <select className={css.select} value={model} aria-label="模型" disabled={provider === '' || models.length === 0}
            onChange={(e) => { setModel(e.target.value) }}>
            <option value="">跟随默认</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      </section>

      <section className={css.block}>
        <h3 className={css.blockTitle}>工具白名单</h3>
        <div className={css.toolMode}>
          <label className={css.toolCheck}>
            <input type="radio" name="agent-tools-mode" checked={toolsMode === 'unrestricted'}
              aria-label="不限制（继承会话全部工具）" onChange={() => { setToolsMode('unrestricted') }} />
            不限制（继承会话全部工具）
          </label>
          <label className={css.toolCheck}>
            <input type="radio" name="agent-tools-mode" checked={toolsMode === 'custom'}
              aria-label="自定义白名单" onChange={() => { setToolsMode('custom') }} />
            自定义白名单
          </label>
        </div>
        {catalog.preset.length === 0 && catalog.global.length === 0 ? (
          <p className={css.hint}>暂无可用工具</p>
        ) : (
          <fieldset className={css.toolGroupSet} disabled={toolsMode !== 'custom'}>
            <p className={css.toolGroupTitle}>团队 preset 工具</p>
            <div className={css.toolGrid}>
              {catalog.preset.map((t) => (
                <label key={t} className={css.toolCheck}>
                  <input type="checkbox" checked={tools.includes(t)} aria-label={`工具 ${t}`} disabled={toolsMode !== 'custom'}
                    onChange={(e) => { toggleTool(t, e.target.checked) }} />
                  {t}
                </label>
              ))}
            </div>
            {catalog.global.length > 0 && (
              <>
                <p className={css.toolGroupTitle}>全局工具</p>
                <div className={css.toolGrid}>
                  {catalog.global.map((t) => (
                    <label key={t} className={css.toolCheck}>
                      <input type="checkbox" checked={tools.includes(t)} aria-label={`工具 ${t}`} disabled={toolsMode !== 'custom'}
                        onChange={(e) => { toggleTool(t, e.target.checked) }} />
                      {t}
                    </label>
                  ))}
                </div>
              </>
            )}
          </fieldset>
        )}
        {toolsMode === 'custom' && tools.length === 0 && catalogLoaded && (
          <p className={css.hint}>自定义白名单至少勾选一个工具，或改选不限制</p>
        )}
      </section>

      {labels === undefined && error !== null && <p role="alert" className={css.error}>{error}</p>}
      {labels === undefined ? (
        <div className={css.actions}>
          {onCancel !== undefined && <Button variant="outline" onClick={onCancel}>取消</Button>}
          {onDeleted !== undefined && !creating && !locked && (
            <Button variant="outline" className={css.dangerButton} disabled={saving} onClick={() => { void remove() }}>删除</Button>
          )}
          <Button variant="primary" disabled={saving || (creating && !catalogLoaded) || (toolsMode === 'custom' && tools.length === 0)} onClick={() => { void save() }}>保存</Button>
        </div>
      ) : (
        <SaveBar
          labels={labels}
          dirty={dirty}
          saving={saving}
          saved={false}
          error={error}
          onSave={() => { void save() }}
          onCancel={onCancel ?? (() => undefined)}
        />
      )}
    </div>
  )
}
