/** 机器人创建/编辑表单：两步向导——基本信息 → 飞书渠道绑定。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { toCanvas } from 'qrcode'
import {
  Button, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createBot, fetchModels, fetchProviders, pollRegisterApp, startRegisterApp, updateBot,
  type BotListItem,
} from './api.ts'
import type { UseWorkspaces } from './BotsModal.tsx'
import css from './bots.module.css'

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

  const [step, setStep] = useState<1 | 2>(1)
  const [name, setName] = useState(bot?.name ?? '')
  const [project, setProject] = useState(bot?.project ?? workspaces[0]?.path ?? '')
  const [persona, setPersona] = useState(bot?.persona ?? '')
  const [provider, setProvider] = useState(bot?.agentOptions?.provider ?? '')
  const [model, setModel] = useState(bot?.agentOptions?.model ?? '')
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])
  const [providersLoaded, setProvidersLoaded] = useState(false)
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [tab, setTab] = useState<BindTab>('scan')
  const [appId, setAppId] = useState(bot?.feishu.appId ?? '')
  const [appSecret, setAppSecret] = useState('')
  const [scan, setScan] = useState<ScanState>({ status: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  // 第一步渲染时各取一次 providers；初始选中第一项（编辑模式若 bot 的 provider 在清单内则保留）；models 随 provider 变更重取，失败静默降级为手填。
  useEffect(() => {
    let stale = false
    fetchProviders().then((ps) => {
      if (stale) return
      setProviders(ps)
      setProvidersLoaded(true)
      setProvider((current) => {
        if (editing && current !== '' && ps.some((p) => p.id === current)) return current
        return ps[0]?.id ?? ''
      })
    }).catch(() => { if (!stale) setProvidersLoaded(true) })
    return () => { stale = true }
  }, [editing])

  useEffect(() => {
    let stale = false
    if (provider.trim().length === 0) {
      setModels([])
      return () => { stale = true }
    }
    fetchModels(provider.trim())
      .then((ms) => {
        if (stale) return
        setModels(ms)
        setModel((current) => {
          if (editing && current !== '' && ms.some((m) => m.id === current)) return current
          return ms[0]?.id ?? current
        })
      })
      .catch(() => { if (!stale) setModels([]) })
    return () => { stale = true }
  }, [provider, editing])

  useEffect(() => () => { if (pollTimer.current !== undefined) clearInterval(pollTimer.current) }, [])

  useEffect(() => {
    if (scan.status === 'waiting' && canvasRef.current !== null) {
      void toCanvas(canvasRef.current, scan.url, { width: 200 }).catch(() => undefined)
    }
  }, [scan])

  /** 第一步放行条件：名称与绑定项目均非空。 */
  const canAdvance = name.trim().length > 0 && project.trim().length > 0

  function nextStep(): void {
    setError(null)
    if (!canAdvance) {
      setError('请填写名称与绑定项目')
      return
    }
    setStep(2)
  }

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

  // 创建模式进入第二步自动发起扫码：仅当尚未发起（idle）时触发，避免重复 beginScan。
  useEffect(() => {
    if (step === 2 && !editing && scan.status === 'idle') {
      void beginScan()
    }
  }, [step, scan.status, editing])

  async function save(): Promise<void> {
    setError(null)
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
    const providerValue = provider.trim()
    const modelValue = model.trim()
    if (providerValue.length === 0) {
      setError('请选择 Provider')
      return
    }
    if (modelValue.length === 0) {
      setError('请选择或填写模型')
      return
    }
    const agentOptions = { provider: providerValue, model: modelValue }
    setSaving(true)
    try {
      const payload = {
        name: name.trim(),
        project: project.trim(),
        ...(persona.trim() ? { persona } : {}),
        agentOptions,
      }
      if (editing) {
        await updateBot(bot.id, payload)
      } else {
        await createBot({ ...payload, feishu: feishu! })
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const showModelSelect = provider.trim().length > 0 && models.length > 0

  return (
    <div>
      <div className={css.steps} aria-label="创建步骤">
        <span className={clsx(css.step, step === 1 && css.stepActive)}>1 基本信息</span>
        <span className={css.stepSeparator}>·</span>
        <span className={clsx(css.step, step === 2 && css.stepActive)}>2 飞书渠道绑定</span>
      </div>

      {step === 1 && (
        <>
          <label className={css.field}>
            名称
            <Input value={name} onChange={(e) => { setName(e.target.value) }} aria-label="名称" className={css.input} />
          </label>
          <label className={css.field}>
            绑定项目
            <select className={css.select} value={project} onChange={(e) => { setProject(e.target.value) }} aria-label="绑定项目">
              {workspaces.map((w) => <option key={w.path} value={w.path}>{w.title}（{w.path}）</option>)}
            </select>
          </label>
          <label className={css.field}>
            提示词
            <textarea className={css.textarea} value={persona} onChange={(e) => { setPersona(e.target.value) }} aria-label="提示词" rows={4} />
          </label>
          <label className={css.field}>
            Provider
            <select className={css.select} value={provider} aria-label="Provider" disabled={providers.length === 0}
              onChange={(e) => { setProvider(e.target.value); setModel(''); setModels([]) }}>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {providersLoaded && providers.length === 0 && <p role="alert" className={css.error}>未发现可用 Provider</p>}
          <label className={css.field}>
            模型
            {showModelSelect ? (
              <select className={css.select} value={model} aria-label="模型" onChange={(e) => { setModel(e.target.value) }}>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            ) : (
              <Input value={model} onChange={(e) => { setModel(e.target.value) }} aria-label="模型" className={css.input} />
            )}
          </label>

          {error !== null && <p role="alert" className={css.error}>{error}</p>}
          <div className={css.formActions}>
            <Button variant="outline" onClick={onCancel}>取消</Button>
            <Button variant="primary" onClick={nextStep}>下一步</Button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          {!editing && (
            <section className={css.scanSection}>
              <div role="tablist" className={css.tabs}>
                <button type="button" role="tab" aria-selected={tab === 'scan'}
                  className={clsx(css.tab, tab === 'scan' && css.tabActive)}
                  onClick={() => { setTab('scan') }}>扫码一键创建</button>
                <button type="button" role="tab" aria-selected={tab === 'manual'}
                  className={clsx(css.tab, tab === 'manual' && css.tabActive)}
                  onClick={() => { setTab('manual') }}>手动填写</button>
              </div>
              {tab === 'scan' ? (
                <div>
                  {scan.status === 'idle' && <Button variant="outline" onClick={() => { void beginScan() }}>生成二维码</Button>}
                  {scan.status === 'waiting' && (
                    <>
                      <canvas ref={canvasRef} />
                      <p>等待扫码确认…</p>
                      <p>（或用飞书打开链接：<a href={scan.url}>{scan.url}</a>）</p>
                    </>
                  )}
                  {scan.status === 'done' && <p>已创建应用：{scan.appId}（密钥已安全保存）</p>}
                  {scan.status === 'error' && (
                    <p>扫码创建失败：{scan.message} <Button variant="ghost" onClick={() => { void beginScan() }}>重试</Button></p>
                  )}
                </div>
              ) : (
                <>
                  <label className={css.field}>
                    App ID
                    <Input value={appId} onChange={(e) => { setAppId(e.target.value) }} aria-label="App ID" placeholder="cli_…" className={css.input} />
                  </label>
                  <label className={css.field}>
                    App Secret
                    <Input type="password" value={appSecret} onChange={(e) => { setAppSecret(e.target.value) }} aria-label="App Secret" className={css.input} />
                  </label>
                </>
              )}
            </section>
          )}
          {editing && <p>当前应用：{bot.feishu.appId}（如需换绑请删除后重建）</p>}

          {error !== null && <p role="alert" className={css.error}>{error}</p>}
          <div className={css.formActions}>
            <Button variant="outline" onClick={() => { setError(null); setStep(1) }}>上一步</Button>
            <Button variant="outline" onClick={onCancel}>取消</Button>
            <Button variant="primary" disabled={saving} onClick={() => { void save() }}>保存</Button>
          </div>
        </>
      )}
    </div>
  )
}
