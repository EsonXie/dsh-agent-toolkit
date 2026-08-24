/** 机器人创建/编辑表单：扫码一键创建（registerApp）或手动填写 app 信息。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toCanvas } from 'qrcode'
import {
  createBot, fetchTools, pollRegisterApp, startRegisterApp, updateBot,
  type BotListItem,
} from './api.ts'
import type { UseWorkspaces } from './BotsModal.tsx'

export interface BotFormProps {
  bot?: BotListItem
  useWorkspaces: UseWorkspaces
  onSaved(): void
  onCancel(): void
}

type BindTab = 'scan' | 'manual'

type ScanState =
  | { status: 'idle' }
  | { status: 'waiting'; url: string }
  | { status: 'done'; appId: string; credentialRef: string }
  | { status: 'error'; message: string }

const POLL_INTERVAL_MS = 200

export function BotForm({ bot, useWorkspaces, onSaved, onCancel }: BotFormProps): ReactNode {
  const workspaces = useWorkspaces((s) => s.items) as { path: string; title: string }[]
  const editing = bot !== undefined

  const [name, setName] = useState(bot?.name ?? '')
  const [id, setId] = useState(bot?.id ?? '')
  const [project, setProject] = useState(bot?.project ?? workspaces[0]?.path ?? '')
  const [persona, setPersona] = useState(bot?.persona ?? '')
  const [provider, setProvider] = useState(bot?.agentOptions?.provider ?? '')
  const [model, setModel] = useState(bot?.agentOptions?.model ?? '')
  const [toolNames, setToolNames] = useState<string[]>([])
  const [selectedTools, setSelectedTools] = useState<Set<string> | null>(bot?.tools !== undefined ? new Set(bot.tools) : null)
  const [tab, setTab] = useState<BindTab>('manual')
  const [appId, setAppId] = useState(bot?.feishu.appId ?? '')
  const [appSecret, setAppSecret] = useState('')
  const [scan, setScan] = useState<ScanState>({ status: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  useEffect(() => {
    let stale = false
    fetchTools().then((tools) => { if (!stale) setToolNames(tools) }).catch(() => undefined)
    return () => { stale = true }
  }, [])

  useEffect(() => () => { if (pollTimer.current !== undefined) clearInterval(pollTimer.current) }, [])

  useEffect(() => {
    if (scan.status === 'waiting' && canvasRef.current !== null) {
      void toCanvas(canvasRef.current, scan.url, { width: 200 }).catch(() => undefined)
    }
  }, [scan])

  async function beginScan(): Promise<void> {
    setError(null)
    try {
      const { id: regId } = await startRegisterApp()
      pollTimer.current = setInterval(() => {
        void pollRegisterApp(regId).then((state) => {
          if (state.status === 'pending' && state.url !== undefined) {
            setScan({ status: 'waiting', url: state.url })
          } else if (state.status === 'done') {
            if (pollTimer.current !== undefined) clearInterval(pollTimer.current)
            setScan({ status: 'done', appId: state.appId, credentialRef: state.credentialRef })
          } else if (state.status === 'error') {
            if (pollTimer.current !== undefined) clearInterval(pollTimer.current)
            setScan({ status: 'error', message: state.description ?? state.code })
          }
        }).catch(() => undefined)
      }, POLL_INTERVAL_MS)
    } catch (e) {
      setScan({ status: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  async function save(): Promise<void> {
    setError(null)
    if (name.trim().length === 0 || (!editing && id.trim().length === 0)) {
      setError('请填写名称与机器人 ID')
      return
    }
    if (project.trim().length === 0) {
      setError('请选择绑定项目')
      return
    }
    const feishu = editing
      ? undefined
      : tab === 'scan'
        ? scan.status === 'done'
          ? { appId: scan.appId, appSecretRef: scan.credentialRef }
          : undefined
        : appId.trim().length > 0 && appSecret.trim().length > 0
          ? { appId: appId.trim(), appSecret: appSecret.trim() }
          : undefined
    if (!editing && feishu === undefined) {
      setError('请填写 App ID 与 App Secret，或先完成扫码创建')
      return
    }
    const agentOptions = provider.trim().length > 0 || model.trim().length > 0
      ? { ...(provider.trim() ? { provider: provider.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}) }
      : undefined
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        project: project.trim(),
        ...(persona.trim() ? { persona } : {}),
        ...(selectedTools !== null ? { tools: [...selectedTools] } : {}),
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      }
      if (editing) {
        await updateBot(bot.id, payload)
      } else {
        await createBot({ ...payload, id: id.trim(), feishu: feishu! })
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <label>
        名称
        <input value={name} onChange={(e) => { setName(e.target.value) }} aria-label="名称" />
      </label>
      {!editing && (
        <label>
          机器人 ID
          <input value={id} onChange={(e) => { setId(e.target.value) }} aria-label="机器人 ID"
            placeholder="小写字母/数字/连字符" />
        </label>
      )}
      <label>
        绑定项目
        <select value={project} onChange={(e) => { setProject(e.target.value) }} aria-label="绑定项目">
          {workspaces.map((w) => <option key={w.path} value={w.path}>{w.title}（{w.path}）</option>)}
        </select>
      </label>
      <label>
        提示词
        <textarea value={persona} onChange={(e) => { setPersona(e.target.value) }} aria-label="提示词" rows={4} />
      </label>
      <fieldset>
        <legend>可用工具（不选 = 全部可用）</legend>
        {toolNames.map((tool) => (
          <label key={tool}>
            <input
              type="checkbox"
              aria-label={tool}
              checked={selectedTools?.has(tool) ?? false}
              onChange={(e) => {
                const next = new Set(selectedTools ?? [])
                if (e.target.checked) next.add(tool)
                else next.delete(tool)
                setSelectedTools(next)
              }}
            />
            {tool}
          </label>
        ))}
      </fieldset>
      <label>
        Provider（可选）
        <input value={provider} onChange={(e) => { setProvider(e.target.value) }} aria-label="Provider（可选）" />
      </label>
      <label>
        模型（可选）
        <input value={model} onChange={(e) => { setModel(e.target.value) }} aria-label="模型（可选）" />
      </label>

      {!editing && (
        <section>
          <div role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'scan'} onClick={() => { setTab('scan') }}>扫码一键创建</button>
            <button type="button" role="tab" aria-selected={tab === 'manual'} onClick={() => { setTab('manual') }}>手动填写</button>
          </div>
          {tab === 'scan' ? (
            <div>
              {scan.status === 'idle' && <button type="button" onClick={() => { void beginScan() }}>生成二维码</button>}
              {scan.status === 'waiting' && (
                <>
                  <canvas ref={canvasRef} />
                  <p>等待扫码确认…</p>
                  <p>（或用飞书打开链接：<a href={scan.url}>{scan.url}</a>）</p>
                </>
              )}
              {scan.status === 'done' && <p>已创建应用：{scan.appId}（密钥已安全保存）</p>}
              {scan.status === 'error' && (
                <p>扫码创建失败：{scan.message} <button type="button" onClick={() => { setScan({ status: 'idle' }) }}>重试</button></p>
              )}
            </div>
          ) : (
            <>
              <label>
                App ID
                <input value={appId} onChange={(e) => { setAppId(e.target.value) }} aria-label="App ID" placeholder="cli_…" />
              </label>
              <label>
                App Secret
                <input type="password" value={appSecret} onChange={(e) => { setAppSecret(e.target.value) }} aria-label="App Secret" />
              </label>
            </>
          )}
        </section>
      )}
      {editing && <p>当前应用：{bot.feishu.appId}（如需换绑请删除后重建）</p>}

      {error !== null && <p role="alert">{error}</p>}
      <div>
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" disabled={saving} onClick={() => { void save() }}>保存</button>
      </div>
    </div>
  )
}
