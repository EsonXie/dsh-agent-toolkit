/** 扫码一键创建飞书应用：lark.registerApp（OAuth 2.0 Device Authorization Grant）的状态机封装。 */
import { randomUUID } from 'node:crypto'

/** 扫码创建应用时申请的权限/事件（流式卡片 + 收发消息 + 表情 + 通讯录基础信息）。
 * 故意不加 as const：readonly 元组不可赋值给 SDK AppAddons 的 mutable string[]，
 * 否则 bots/index.ts 的 lark.registerApp(options) 透传会 typecheck 失败。 */
export const FEISHU_REGISTER_APP_ADDONS = {
  scopes: {
    tenant: [
      'im:message',
      'im:message:send_as_bot',
      'cardkit:card:write',
      'contact:user.base:readonly',
    ],
  },
  events: {
    items: { tenant: ['im.message.receive_v1'] },
  },
}

export interface QRInfo {
  url: string
  expireIn: number
}

/** lark.registerApp 的结构化签名（便于 fake 注入）。 */
export type RegisterAppFn = (options: {
  signal: AbortSignal
  addons: typeof FEISHU_REGISTER_APP_ADDONS
  onQRCodeReady(info: QRInfo): void
}) => Promise<{ client_id: string; client_secret: string }>

export type RegisterState =
  | { status: 'pending'; url?: string; expireIn?: number }
  | { status: 'done'; appId: string; credentialRef: string }
  | { status: 'error'; code: string; description?: string }

export interface RegisterAppDeps {
  registerApp: RegisterAppFn
  /** 把 appSecret 存进 credentials，返回 CredentialRef 字符串。 */
  storeSecret(appId: string, secret: string): Promise<string>
  timeoutMs: number
  newId?: () => string
}

export class RegisterAppService {
  private readonly sessions = new Map<string, {
    state: RegisterState
    controller: AbortController
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(private readonly deps: RegisterAppDeps) {}

  /** 发起一轮扫码创建；返回轮询 id。 */
  start(): string {
    const id = (this.deps.newId ?? randomUUID)()
    const controller = new AbortController()
    const entry = {
      state: { status: 'pending' } as RegisterState,
      controller,
      timer: setTimeout(() => { controller.abort() }, this.deps.timeoutMs),
    }
    this.sessions.set(id, entry)
    void this.deps.registerApp({
      signal: controller.signal,
      addons: FEISHU_REGISTER_APP_ADDONS,
      onQRCodeReady: (info) => {
        entry.state = { status: 'pending', url: info.url, expireIn: info.expireIn }
      },
    }).then(async (result) => {
      const credentialRef = await this.deps.storeSecret(result.client_id, result.client_secret)
      entry.state = { status: 'done', appId: result.client_id, credentialRef }
    }).catch((error: unknown) => {
      const e = error as { code?: unknown; description?: unknown }
      entry.state = {
        status: 'error',
        code: typeof e.code === 'string' ? e.code : 'unknown',
        ...(typeof e.description === 'string' ? { description: e.description } : {}),
      }
    }).finally(() => {
      clearTimeout(entry.timer)
    })
    return id
  }

  get(id: string): RegisterState | undefined {
    return this.sessions.get(id)?.state
  }

  /** 卸载：中断全部进行中的轮询。 */
  dispose(): void {
    for (const entry of this.sessions.values()) {
      entry.controller.abort()
      clearTimeout(entry.timer)
    }
    this.sessions.clear()
  }
}
