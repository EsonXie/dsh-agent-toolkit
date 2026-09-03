/** 浏览器半 RPC：单前缀路由 /dsh-agent-toolkit/api/bots + 内部路径分发。 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { BotRuntime } from '../channels/runtime.ts'
import type { RegisterAppService } from './register-app.ts'
import { BOT_ID_RE, BotRecordSchema, FEISHU_APP_ID_RE, type BotRecord } from './store.ts'

/** 一个可选的 provider 路由（id = agentOptions.provider 的值）。 */
export interface ProviderOption { id: string; name: string }
/** 一个可选的模型条目（id = agentOptions.model 的值）。 */
export interface ModelOption { id: string; name: string }

export interface ApiDeps {
  bots: KvTable<string, BotRecord>
  runtime: BotRuntime
  registerApp: RegisterAppService
  listTools(): string[]
  listProviders(): ProviderOption[]
  /** 失败由调用方（路由）兜底为空数组，不抛错。 */
  listModels(provider: string): Promise<ModelOption[]>
  /** 密钥入 credentials，返回 CredentialRef 字符串。 */
  storeSecret(key: string, secret: string): Promise<string>
  deleteSecret(ref: string): Promise<void>
  validateProject(path: string): boolean
  now(): number
}

const MAX_BODY_BYTES = 64 * 1024

const CreateBodySchema = z.object({
  /** 缺省时后端自动生成（bot-<8 位随机小写字母数字>）。 */
  id: z.string().regex(BOT_ID_RE).optional(),
  name: z.string().min(1).max(64),
  project: z.string().min(1),
  persona: z.string().max(8000).optional(),
  /** 绑定的 Agent（'main' 或注册表角色 id；缺省 = main）。 */
  agentRef: z.string().min(1).optional(),
  tools: z.array(z.string().min(1)).min(1).optional(),
  agentOptions: z.object({ provider: z.string().min(1).optional(), model: z.string().min(1).optional() }).optional(),
  feishu: z.object({
    appId: z.string().regex(FEISHU_APP_ID_RE),
    /** 手动填写路径：明文密钥（立即入 credentials，不落表）。 */
    appSecret: z.string().min(1).optional(),
    /** 扫码路径：registerApp 已入库，直接给引用。 */
    appSecretRef: z.string().optional(),
  }),
})

const UpdateBodySchema = z.object({
  name: z.string().min(1).max(64).optional(),
  project: z.string().min(1).optional(),
  persona: z.string().max(8000).nullable().optional(),
  agentRef: z.string().min(1).nullable().optional(),
  tools: z.array(z.string().min(1)).min(1).nullable().optional(),
  agentOptions: z.object({ provider: z.string().min(1).optional(), model: z.string().min(1).optional() }).nullable().optional(),
  /** 重绑：明文新密钥（立即入 credentials）或扫码引用（已入库）；null = 解绑渠道（删密钥、保留会话绑定）。 */
  feishu: z.object({
    appId: z.string().regex(FEISHU_APP_ID_RE),
    appSecret: z.string().min(1).optional(),
    appSecretRef: z.string().min(1).optional(),
  }).refine((f) => f.appSecret !== undefined || f.appSecretRef !== undefined, { message: '缺少 appSecret 或 appSecretRef' })
    .nullable().optional(),
})

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** 生成 bot-<8 位随机小写字母数字>（符合 BOT_ID_RE）；与现有 id 冲突时重试。 */
function generateBotId(occupied: (id: string) => boolean): string {
  for (;;) {
    const bytes = randomBytes(8)
    let id = 'bot-'
    for (let i = 0; i < 8; i++) id += ID_CHARS[bytes[i] % ID_CHARS.length]
    if (!occupied(id)) return id
  }
}

/** 读 JSON body；超限 413 / 非法 JSON 400（已写响应时返回 undefined）。 */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_BODY_BYTES) {
      json(res, 413, { error: 'body too large' })
      req.destroy()
      return undefined
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    json(res, 400, { error: 'invalid JSON body' })
    return undefined
  }
}

export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sub = url.pathname.replace(/^\/dsh-agent-toolkit\/api\/bots/, '') || '/'
    const method = req.method ?? 'GET'

    if (sub === '/bots' && method === 'GET') {
      const bots = [...deps.bots.entries()].map(([, record]) => ({ ...record, status: deps.runtime.statusOf(record.id) }))
      json(res, 200, { bots })
      return
    }

    if (sub === '/bots' && method === 'POST') {
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const parsed = CreateBodySchema.safeParse(body)
      if (!parsed.success) {
        json(res, 400, { error: parsed.error.issues[0]?.message ?? 'invalid body' })
        return
      }
      const input = parsed.data
      const id = input.id ?? generateBotId((candidate) => deps.bots.get(candidate) !== undefined)
      if (deps.bots.get(id) !== undefined) {
        json(res, 409, { error: `bot id "${id}" 已存在` })
        return
      }
      for (const [, existing] of deps.bots.entries()) {
        if (existing.feishu !== undefined && existing.feishu.appId === input.feishu.appId) {
          json(res, 409, { error: `appId 已被 bot "${existing.id}" 使用` })
          return
        }
      }
      if (!deps.validateProject(input.project)) {
        json(res, 400, { error: `项目路径不可用：${input.project}` })
        return
      }
      let appSecretRef = input.feishu.appSecretRef
      if (appSecretRef === undefined) {
        if (input.feishu.appSecret === undefined) {
          json(res, 400, { error: '缺少 appSecret 或 appSecretRef' })
          return
        }
        appSecretRef = await deps.storeSecret(id, input.feishu.appSecret)
      }
      const record = BotRecordSchema.parse({
        id, name: input.name, channel: 'feishu',
        feishu: { appId: input.feishu.appId, appSecretRef },
        project: input.project,
        ...(input.persona !== undefined ? { persona: input.persona } : {}),
        ...(input.agentRef !== undefined ? { agentRef: input.agentRef } : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        createdAt: deps.now(), updatedAt: deps.now(),
      } satisfies BotRecord)
      await deps.bots.put(record.id, record)
      await deps.runtime.reconcile(record.id)
      json(res, 200, { bot: { ...record, status: deps.runtime.statusOf(record.id) } })
      return
    }

    if (sub === '/bots' && method === 'PUT') {
      const id = url.searchParams.get('id') ?? ''
      const existing = deps.bots.get(id)
      if (existing === undefined) {
        json(res, 404, { error: `bot "${id}" 不存在` })
        return
      }
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const parsed = UpdateBodySchema.safeParse(body)
      if (!parsed.success) {
        json(res, 400, { error: parsed.error.issues[0]?.message ?? 'invalid body' })
        return
      }
      const input = parsed.data
      const project = input.project ?? existing.project
      if (!deps.validateProject(project)) {
        json(res, 400, { error: `项目路径不可用：${project}` })
        return
      }
      // 重绑路径：appId 先查冲突（未绑定 bot 不占 appId），再做任何副作用。
      if (input.feishu !== null && input.feishu !== undefined) {
        for (const [, other] of deps.bots.entries()) {
          if (other.id !== id && other.feishu?.appId === input.feishu.appId) {
            json(res, 409, { error: `appId 已被 bot "${other.id}" 使用` })
            return
          }
        }
      }
      // 渠道副作用：null 解绑（停渠道 + 删旧密钥）；对象重绑（新密钥入库或引用 + 旧 ref ≠ 新 ref 时清旧密钥）。
      let appSecretRef: string | undefined
      if (input.feishu === null) {
        await deps.runtime.unbindBot(id)
        if (existing.feishu !== undefined) await deps.deleteSecret(existing.feishu.appSecretRef)
      } else if (input.feishu !== undefined) {
        if (input.feishu.appSecret !== undefined) {
          appSecretRef = await deps.storeSecret(id, input.feishu.appSecret)
        } else {
          appSecretRef = input.feishu.appSecretRef
        }
        if (existing.feishu !== undefined && existing.feishu.appSecretRef !== appSecretRef) {
          await deps.deleteSecret(existing.feishu.appSecretRef)
        }
      }
      const merged: Record<string, unknown> = { ...existing }
      if (input.name !== undefined) merged.name = input.name
      merged.project = project
      if (input.feishu === null) {
        delete merged.channel
        delete merged.feishu
      } else if (input.feishu !== undefined && appSecretRef !== undefined) {
        merged.channel = 'feishu'
        merged.feishu = { appId: input.feishu.appId, appSecretRef }
      }
      if (input.persona === null) delete merged.persona
      else if (input.persona !== undefined) merged.persona = input.persona
      if (input.agentRef === null) delete merged.agentRef
      else if (input.agentRef !== undefined) merged.agentRef = input.agentRef
      if (input.tools === null) delete merged.tools
      else if (input.tools !== undefined) merged.tools = input.tools
      if (input.agentOptions === null) delete merged.agentOptions
      else if (input.agentOptions !== undefined) merged.agentOptions = input.agentOptions
      const record = BotRecordSchema.parse(merged)
      await deps.bots.put(id, record)
      await deps.runtime.reconcile(id)
      json(res, 200, { bot: { ...record, status: deps.runtime.statusOf(id) } })
      return
    }

    if (sub === '/bots' && method === 'DELETE') {
      const id = url.searchParams.get('id') ?? ''
      const existing = deps.bots.get(id)
      if (existing === undefined) {
        json(res, 404, { error: `bot "${id}" 不存在` })
        return
      }
      await deps.runtime.stopBot(id)
      await deps.bots.delete(id)
      if (existing.feishu !== undefined) await deps.deleteSecret(existing.feishu.appSecretRef)
      json(res, 200, { ok: true })
      return
    }

    if (sub === '/register-app' && method === 'POST') {
      json(res, 200, { id: deps.registerApp.start() })
      return
    }

    if (sub === '/register-app/status' && method === 'GET') {
      const id = url.searchParams.get('id') ?? ''
      const state = deps.registerApp.get(id)
      if (state === undefined) {
        json(res, 404, { error: 'register session 不存在' })
        return
      }
      json(res, 200, { state })
      return
    }

    if (sub === '/tools' && method === 'GET') {
      json(res, 200, { tools: deps.listTools() })
      return
    }

    if (sub === '/providers' && method === 'GET') {
      json(res, 200, { providers: deps.listProviders() })
      return
    }

    if (sub === '/models' && method === 'GET') {
      // 模型列举可能走网络（adapter 探测），失败静默降级为空数组。
      let models: ModelOption[] = []
      try {
        models = await deps.listModels(url.searchParams.get('provider') ?? '')
      } catch {
        models = []
      }
      json(res, 200, { models })
      return
    }

    if (['/bots', '/register-app', '/register-app/status', '/tools', '/providers', '/models'].includes(sub)) {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    json(res, 404, { error: 'not found' })
  }
}
