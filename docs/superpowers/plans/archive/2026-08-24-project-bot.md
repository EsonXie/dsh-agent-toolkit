# project-bot（项目机器人）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `@dsh-agent-toolkit/project-bot` 插件：多飞书机器人作为项目 Agent 的交互入口（一 bot 一项目、一项目多 bot），turn 级流式卡片回复 + 处理中表情回复，侧边栏配置 UI（列表/表单/扫码一键创建飞书应用）。

**Architecture:** 单包内渠道抽象——核心（名册/绑定路由/入站准入/出站 turn 归集）与渠道（飞书 WS 长连接 + CardKit 流式卡片）经 `BotChannel` 接口隔离；配置存 storage domain（UI 可写），密钥走 `ctx.credentials`；浏览器半照 token-usage 模式（sidebar.footer.action 入口 → 自持 Modal → webServer HTTP 路由 RPC）。

**Tech Stack:** TypeScript、Cordis/dsh 插件体系、`@larksuiteoapi/node-sdk`（≥1.61.1，WSClient + CardKit + registerApp）、zod（存储 schema）、schemastery（Config）、vitest + @testing-library/react、tsdown（双半 bundle）。

**Spec:** `docs/superpowers/specs/2026-08-24-project-bot-design.md`（设计唯一权威；代码与 spec 语义冲突时以 spec 为准）。

## Global Constraints

- dsh 宿主源码 `deepseek-harness/` **只读**，不修改其中任何文件。
- 插件为命名导出 `name` / `inject` / `Config` / `apply`，**无 default export**。
- 存储记录 schema 用 **zod**；插件 Config 用 **schemastery**；domain 名匹配 `^[a-z][a-z0-9_]*$`（本插件用 `project_bot`）。
- 密钥只经 `ctx.credentials.set(...)` 存储；存储表/日志/API 响应中**永不出现明文 appSecret**。
- 可调参数全部进 Config schema，无硬编码；无效 Config 加载时响亮失败。
- 通过 `ctx` 注册的一切自动清理；手动资源（WS 连接、domain 句柄、定时器）必须 `ctx.effect` 返回 disposer。
- 浏览器半纯净度门禁：禁止跨插件值导入；跨包/跨层类型一律 `import type`（type-only 会被擦除）。
- 开发命令：`pnpm --filter @dsh-agent-toolkit/project-bot test` / `typecheck` / `bundle`；src 改动后进开发回路前必须跑 `bundle`。
- 提交信息格式：`feat(project-bot): …` / `test(project-bot): …` / `chore(project-bot): …`。
- 飞书硬性参数（已核实）：卡片 ≤ 30KB（默认阈值 28000 字节）；cardkit 操作 sequence 同卡严格递增；一个卡片实体只能发送一次；WS 事件 handler 须 3 秒内返回；emoji_type 默认 `OneSecond`。
- dsh API 关键事实（已核实，勿再猜）：turn 事件为 `turn/start` / `turn/end`（reason: completed/aborted/blocked/error/max-tokens/interrupted）；`agents.create` 无 persona 参数，persona/工具白名单走 `setup(agentCtx)`（`agentCtx.systemPrompt.section({ name, order, text })` + `agentCtx.tools.restrict({ allow })`）；`WSClient.close({ force })` 存在；`ctx.credentials.set(ref, value)` 编程式存密钥。

---

### Task 1: 包脚手架

**Files:**
- Create: `packages/project-bot/package.json`
- Create: `packages/project-bot/tsconfig.json`
- Create: `packages/project-bot/tsdown.config.ts`
- Create: `packages/project-bot/vitest.config.ts`
- Create: `packages/project-bot/cordis.patch.yml`
- Create: `packages/project-bot/src/index.ts`（临时最小实现，Task 14 替换）
- Test: `packages/project-bot/tests/smoke.test.ts`

**Interfaces:**
- Produces: 包名 `@dsh-agent-toolkit/project-bot`；脚本 `test`/`typecheck`/`bundle`；`lib/index.js`（Node 半）+ `lib/client.js`（浏览器半）双产出。

- [ ] **Step 1: 写脚手架文件**

`packages/project-bot/package.json`：

```json
{
  "name": "@dsh-agent-toolkit/project-bot",
  "version": "0.1.0",
  "description": "DeepSeek Harness plugin: project-bound message bots (Feishu channel) — streaming card replies as agent entry points",
  "license": "MIT",
  "keywords": ["deepseek-harness", "dsh", "dsh-plugin", "feishu", "bot"],
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-sidebar"]
    }
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "bundle": "tsdown",
    "watch": "tsdown --watch",
    "prepack": "pnpm run bundle"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.1",
    "@larksuiteoapi/node-sdk": "^1.73.0",
    "clsx": "^2.0.0",
    "qrcode": "^1.5.4",
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "link:../../deepseek-harness/vendor/cordis",
    "@deepseek-ai/dsh-agent": "link:../../deepseek-harness/packages/core/agent",
    "@deepseek-ai/dsh-client-runtime": "link:../../deepseek-harness/packages/client/runtime",
    "@deepseek-ai/dsh-client-ui-primitives": "link:../../deepseek-harness/packages/client/ui-primitives",
    "@deepseek-ai/dsh-client-ui-sidebar": "link:../../deepseek-harness/packages/client/ui-sidebar",
    "@deepseek-ai/dsh-client-ui-slots": "link:../../deepseek-harness/packages/client/ui-slots",
    "@deepseek-ai/dsh-credentials": "link:../../deepseek-harness/packages/credentials/credentials",
    "@deepseek-ai/dsh-host-webserver": "link:../../deepseek-harness/packages/host/webserver",
    "@deepseek-ai/dsh-llm": "link:../../deepseek-harness/packages/llm/llm",
    "@deepseek-ai/dsh-session": "link:../../deepseek-harness/packages/core/session",
    "@deepseek-ai/dsh-storage-domain": "link:../../deepseek-harness/packages/storage/storage-domain",
    "@deepseek-ai/dsh-system-prompt": "link:../../deepseek-harness/packages/core/system-prompt",
    "@deepseek-ai/dsh-tools": "link:../../deepseek-harness/packages/core/tools",
    "@testing-library/react": "^16.1.0",
    "@types/node": "^22.20.1",
    "@types/qrcode": "^1.5.5",
    "@types/react": "~18.3.1",
    "@types/react-dom": "~18.3.0",
    "jsdom": "^26.1.0",
    "lightningcss": "^1.30.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "tsdown": "^0.22.2",
    "typescript": "^6.0.3",
    "vitest": "^3.0.0"
  }
}
```

`packages/project-bot/tsconfig.json`（与 token-usage 完全一致）：

```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "noImplicitAny": true,
    "jsx": "react-jsx",
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "tsdown.config.ts"]
}
```

`packages/project-bot/vitest.config.ts`（与 token-usage 相同）：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
})
```

`packages/project-bot/tsdown.config.ts`：从 `packages/token-usage/tsdown.config.ts` 原样复制，仅改两处：

- `const ID = '@dsh-agent-toolkit/project-bot'`
- nodeConfig 的 `deps.neverBundle: [/^@deepseek-ai\//, '@larksuiteoapi/node-sdk', 'clsx', 'zod']`（`qrcode` 仅浏览器半使用，落在 clientConfig 的 alwaysBundle 内）

`packages/project-bot/cordis.patch.yml`（照 token-usage 同款 bundle 层）：

```yaml
# project-bot 组合包层：profile 的 dsh.profile.bundles 列出本包时应用。
# name 用包名，Node 模块解析以 profile 目录为锚点；config 不写（全部走 Config schema 默认值）。
- insert:
    - id: project-bot
      name: '@dsh-agent-toolkit/project-bot'
```

`packages/project-bot/src/index.ts`（临时最小实现）：

```ts
/** project-bot 插件：项目机器人（飞书渠道）。Task 14 替换为完整组装。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  /** 卡片流式更新节流间隔（毫秒）。 */
  cardUpdateThrottleMs: number
  /** 单张卡片内容字节上限（飞书硬上限 30KB，留余量）。 */
  cardMaxBytes: number
  /** 扫码创建应用的轮询超时（毫秒）。 */
  registerAppTimeoutMs: number
  /** 「处理中」表情回复的 emoji_type。 */
  processingReactionEmoji: string
}

export const Config: z<Config> = z.object({
  cardUpdateThrottleMs: z.number().default(500),
  cardMaxBytes: z.number().default(28_000),
  registerAppTimeoutMs: z.number().default(600_000),
  processingReactionEmoji: z.string().default('OneSecond'),
})

export const name = 'project-bot'

export const inject = ['agents', 'credentials', 'storageDomain', 'tools']

export function apply(_ctx: Context, _config: Config): void {
  // Task 14 填充
}
```

- [ ] **Step 2: 写测试**

`packages/project-bot/tests/smoke.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { Config, inject, name } from '../src/index.ts'

describe('project-bot 插件导出', () => {
  test('导出名与依赖声明', () => {
    expect(name).toBe('project-bot')
    expect(inject).toEqual(['agents', 'credentials', 'storageDomain', 'tools'])
  })

  test('Config 默认值', () => {
    const config = Config.parse({})
    expect(config.cardUpdateThrottleMs).toBe(500)
    expect(config.cardMaxBytes).toBe(28_000)
    expect(config.registerAppTimeoutMs).toBe(600_000)
    expect(config.processingReactionEmoji).toBe('OneSecond')
  })
})
```

- [ ] **Step 3: 安装依赖并跑测试**

Run: `pnpm install; pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS（2 个用例）

- [ ] **Step 4: Commit**

```bash
git add packages/project-bot pnpm-lock.yaml
git commit -m "chore(project-bot): 包脚手架（tsdown 双半 bundle + vitest + bundle patch 层）"
```

---

### Task 2: 存储层（bots + bindings 表）

**Files:**
- Create: `packages/project-bot/src/store.ts`
- Test: `packages/project-bot/tests/store.test.ts`

**Interfaces:**
- Produces（后续所有任务依赖）：`BotRecord` / `BotRecordSchema` / `Binding` / `BindingSchema` / `projectBotDomain` / `bindingKey(botId, chatId)` / `FEISHU_APP_ID_RE` / `BOT_ID_RE` / `CREDENTIAL_REF_RE`。

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/store.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { BotRecordSchema, bindingKey, projectBotDomain, type BotRecord } from '../src/store.ts'

const validBot: BotRecord = {
  id: 'reviewer',
  name: '评审机器人',
  channel: 'feishu',
  feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
  project: 'D:\\work\\demo',
  persona: '你是评审助手',
  tools: ['bash', 'fs_read'],
  agentOptions: { provider: 'deepseek', model: 'deepseek-v4' },
  createdAt: 1,
  updatedAt: 1,
}

describe('projectBotDomain', () => {
  test('域名、版本与表清单', () => {
    expect(projectBotDomain.name).toBe('project_bot')
    expect(projectBotDomain.version).toBe(1)
    expect(Object.keys(projectBotDomain.tables).sort()).toEqual(['bindings', 'bots'])
  })
})

describe('BotRecordSchema', () => {
  test('接受完整合法记录', () => {
    expect(BotRecordSchema.safeParse(validBot).success).toBe(true)
  })

  test('接受省略可选字段的最小记录', () => {
    const minimal = {
      id: 'ops', name: '运维', channel: 'feishu',
      feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_ops' },
      project: '/tmp/x', createdAt: 0, updatedAt: 0,
    }
    expect(BotRecordSchema.safeParse(minimal).success).toBe(true)
  })

  test('拒绝非法 appId / 非法 id / 空工具白名单', () => {
    expect(BotRecordSchema.safeParse({ ...validBot, feishu: { ...validBot.feishu, appId: 'bad' } }).success).toBe(false)
    expect(BotRecordSchema.safeParse({ ...validBot, id: '1bad' }).success).toBe(false)
    expect(BotRecordSchema.safeParse({ ...validBot, tools: [] }).success).toBe(false)
  })
})

test('bindingKey 拼接', () => {
  expect(bindingKey('reviewer', 'oc_abc')).toBe('reviewer:oc_abc')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（`../src/store.ts` 不存在）

- [ ] **Step 3: 实现 store.ts**

`packages/project-bot/src/store.ts`：

```ts
/** project-bot 存储域声明：身份、版本、记录 zod schema 的单一来源。 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 飞书自建应用 appId 形态（WSClient 同款校验）。 */
export const FEISHU_APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/
/** CredentialRef 字符集（credentials 服务 credentialRef() 的校验规则）。 */
export const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** bot id：小写 slug。 */
export const BOT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/

export const FeishuConfigSchema = z.object({
  appId: z.string().regex(FEISHU_APP_ID_RE),
  appSecretRef: z.string().regex(CREDENTIAL_REF_RE),
})
export type FeishuConfig = z.infer<typeof FeishuConfigSchema>

export const BotRecordSchema = z.object({
  id: z.string().regex(BOT_ID_RE),
  name: z.string().min(1).max(64),
  channel: z.literal('feishu'),
  feishu: FeishuConfigSchema,
  /** 绑定项目（agent 的 cwd，绝对路径）。一 bot 一项目。 */
  project: z.string().min(1),
  /** 透传到 agent 创作期的 persona 提示段。 */
  persona: z.string().max(8000).optional(),
  /** 可用工具白名单（缺省 = 不限制）；空数组无意义，直接拒绝。 */
  tools: z.array(z.string().min(1)).min(1).optional(),
  agentOptions: z.object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  }).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type BotRecord = z.infer<typeof BotRecordSchema>

export const BindingSchema = z.object({ sessionId: z.string().min(1) })
export type Binding = z.infer<typeof BindingSchema>

/** domain 名受 UNIT_NAME_RE 约束（^[a-z][a-z0-9_]*$），不允许连字符。 */
export const projectBotDomain = defineDomain({
  name: 'project_bot',
  version: 1,
  tables: {
    bots: domainTable<string, BotRecord>(BotRecordSchema),
    bindings: domainTable<string, Binding>(BindingSchema),
  },
})

/** bindings 表 key：(botId, chatId) → sessionId。 */
export function bindingKey(botId: string, chatId: string): string {
  return `${botId}:${chatId}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/store.ts packages/project-bot/tests/store.test.ts
git commit -m "feat(project-bot): 存储域——bots/bindings 表与 zod 记录 schema"
```

---

### Task 3: 渠道接口与核心端口类型 + 指令解析

**Files:**
- Create: `packages/project-bot/src/core/channel.ts`
- Create: `packages/project-bot/src/core/ports.ts`
- Create: `packages/project-bot/src/core/directive.ts`
- Test: `packages/project-bot/tests/directive.test.ts`

**Interfaces:**
- Produces（全部后续任务依赖，签名冻结）：
  - `channel.ts`：`Disposer`、`TurnStatus`、`ReplyHandle`、`InboundMessage`、`ChannelIO`、`ChannelStatus`、`ChannelHandle`、`ChannelTunables`、`ResolvedBot`、`BotChannel`
  - `ports.ts`：`AgentPort`、`AgentsPort`、`AgentHooks`、`BindingStore`、`SessionRuntime`、`hooksOf`
  - `directive.ts`：`parseDirective(text)` / `stripMentionPlaceholders(text)`

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/directive.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { parseDirective, stripMentionPlaceholders } from '../src/core/directive.ts'

describe('parseDirective', () => {
  test('识别三个指令（忽略大小写与首尾空白）', () => {
    expect(parseDirective('/new')).toBe('new')
    expect(parseDirective('  /Stop ')).toBe('stop')
    expect(parseDirective('/STATUS')).toBe('status')
  })

  test('普通文本与带参数的指令都不算', () => {
    expect(parseDirective('你好')).toBeNull()
    expect(parseDirective('/new 请重来')).toBeNull()
    expect(parseDirective('/unknown')).toBeNull()
  })
})

describe('stripMentionPlaceholders', () => {
  test('剥掉群消息里的 @ 占位符', () => {
    expect(stripMentionPlaceholders('@_user_1 帮我看看')).toBe('帮我看看')
    expect(stripMentionPlaceholders('@_user_1 @_user_2 在吗')).toBe('在吗')
  })

  test('无占位符时原样（trim 后）', () => {
    expect(stripMentionPlaceholders('  hello  ')).toBe('hello')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（`../src/core/directive.ts` 不存在）

- [ ] **Step 3: 实现三个文件**

`packages/project-bot/src/core/directive.ts`：

```ts
/** 飞书内的运维文本指令（不走模型）。 */
export type Directive = 'new' | 'stop' | 'status'

/** 仅当整条消息就是一个指令时命中；带参数/前后文的按普通消息处理。 */
export function parseDirective(text: string): Directive | null {
  const t = text.trim().toLowerCase()
  if (t === '/new') return 'new'
  if (t === '/stop') return 'stop'
  if (t === '/status') return 'status'
  return null
}

/** 群消息正文中的 @ 占位符（@_user_1 等）剥掉，得到纯净指令文本。 */
export function stripMentionPlaceholders(text: string): string {
  return text.replace(/@_user_\d+\s*/g, '').trim()
}
```

`packages/project-bot/src/core/channel.ts`：

```ts
/** 渠道抽象：飞书是第一个实现；核心只依赖本文件，不感知任何飞书 SDK 类型。 */
import type { BotRecord } from '../store.ts'

export type Disposer = () => void | Promise<void>

export type TurnStatus = 'done' | 'error' | 'cancelled'

/** 一次回复的出站句柄（chat 作用域；turn 级卡片流 + 普通文本通知）。 */
export interface ReplyHandle {
  /** 开新一轮 turn 的卡片（惰性实现允许空操作，首次 update 建卡）。 */
  beginTurn(): Promise<void>
  /** 全量替换当前卡片正文（渠道内部节流、拆卡）。 */
  update(markdown: string): Promise<void>
  /** turn 定格：关闭流式、按状态着色；无卡且带 detail 时降级为文本。 */
  finalize(status: TurnStatus, detail?: string): Promise<void>
  /** 普通文本消息（准入拒绝、/status 应答等）。 */
  notice(text: string): Promise<void>
}

/** 一条入站消息（渠道已解析成渠道无关形态）。 */
export interface InboundMessage {
  botId: string
  chatId: string
  userId: string
  messageId: string
  text: string
  reply: ReplyHandle
  /** 给该用户消息加「处理中」表情回复；返回的 disposer 删除表情。失败返回 undefined。 */
  ackProcessing(): Promise<Disposer | undefined>
}

export interface ChannelIO {
  /** fire-and-forget：渠道 handler 须快速返回（飞书 WS 3 秒限制），业务异步消化。 */
  onMessage(msg: InboundMessage): void
}

export type ChannelStatus = 'connected' | 'connecting' | 'reconnecting' | 'idle' | 'failed'

export interface ChannelHandle {
  close(): Promise<void>
  status(): ChannelStatus
}

/** 全局可调参数（Config 快照，渠道层只读消费）。 */
export interface ChannelTunables {
  cardUpdateThrottleMs: number
  cardMaxBytes: number
  processingReactionEmoji: string
}

/** 密钥已现场解析的 bot 配置。 */
export interface ResolvedBot {
  record: BotRecord
  secret: string
}

export interface BotChannel {
  readonly type: string
  start(bot: ResolvedBot, io: ChannelIO, tunables: ChannelTunables, log: (message: string) => void): Promise<ChannelHandle>
}
```

`packages/project-bot/src/core/ports.ts`：

```ts
/** 核心对宿主 agents 服务 / 绑定表的结构化端口（测试用 fake 注入）。 */
import type { BotRecord } from '../store.ts'
import type { Disposer, ReplyHandle } from './channel.ts'

export interface AgentPort {
  readonly sessionId: string
  followup(message: unknown): void
  cancel(): void
  whenIdle(): Promise<void>
}

/** 创作期注入（真实适配器里映射为 setup(agentCtx) 内的 section/restrict）。 */
export interface AgentHooks {
  persona?: string
  tools?: readonly string[]
}

export interface AgentsPort {
  create(input: {
    sessionId: string
    cwd: string
    agentOptions?: { provider?: string; model?: string }
    hooks: AgentHooks
  }): Promise<AgentPort>
  resume(input: {
    sessionId: string
    agentOptions?: { provider?: string; model?: string }
    hooks: AgentHooks
  }): Promise<AgentPort>
}

export interface BindingStore {
  get(botId: string, chatId: string): string | undefined
  set(botId: string, chatId: string, sessionId: string): Promise<void>
  delete(botId: string, chatId: string): Promise<void>
  /** 删除某 bot 的全部绑定（bot 被删除时）。 */
  deleteBot(botId: string): Promise<void>
}

/** 一个活跃会话的运行时状态（inbound/outbound 共享）。 */
export interface SessionRuntime {
  readonly botId: string
  readonly chatId: string
  readonly sessionId: string
  agent: AgentPort
  /** 最近一次入站消息携带的回复句柄（回复永远回到 chat）。 */
  reply: ReplyHandle | undefined
  /** 单会话单 in-flight 槽；ack = 表情回复的 disposer。 */
  inflight: { ack: Disposer | undefined } | undefined
  /** 出站操作串行化 Promise 链（保序）。 */
  tail: Promise<unknown>
  /** 当前 turn 归集状态；无进行中 turn 为 undefined。 */
  turn: { n: number; buffer: string; began: boolean } | undefined
}

/** 从 bot 记录提取创作期注入。 */
export function hooksOf(bot: BotRecord): AgentHooks {
  return {
    ...(bot.persona !== undefined ? { persona: bot.persona } : {}),
    ...(bot.tools !== undefined ? { tools: bot.tools } : {}),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/core packages/project-bot/tests/directive.test.ts
git commit -m "feat(project-bot): 渠道抽象接口、核心端口类型与指令解析"
```

---

### Task 4: Router——绑定路由与 agent 获取

**Files:**
- Create: `packages/project-bot/src/core/router.ts`
- Test: `packages/project-bot/tests/router.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `AgentsPort` / `BindingStore` / `SessionRuntime` / `ReplyHandle` / `hooksOf`；Task 2 的 `BotRecord`。
- Produces: `Router`——`ensure(bot, chatId, reply)` / `reset(bot, chatId, reply)` / `lookup(botId, chatId)`。

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/router.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest'
import type { ReplyHandle } from '../src/core/channel.ts'
import type { AgentPort, AgentsPort, BindingStore, SessionRuntime } from '../src/core/ports.ts'
import { Router } from '../src/core/router.ts'
import type { BotRecord } from '../src/store.ts'

function fakeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: 'reviewer', name: '评审', channel: 'feishu',
    feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
    project: 'D:\\work\\demo', persona: '你是评审助手', tools: ['bash'],
    createdAt: 0, updatedAt: 0, ...overrides,
  }
}

function fakeAgent(sessionId: string) {
  return { sessionId, followup: vi.fn(), cancel: vi.fn(), whenIdle: vi.fn(async () => undefined) }
}

function fakeBindings(): BindingStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: (b, c) => map.get(`${b}:${c}`),
    set: async (b, c, s) => { map.set(`${b}:${c}`, s) },
    delete: async (b, c) => { map.delete(`${b}:${c}`) },
    deleteBot: async (b) => { for (const k of [...map.keys()]) if (k.startsWith(`${b}:`)) map.delete(k) },
  }
}

const reply = {} as ReplyHandle

function setup() {
  const created: { input: Record<string, unknown>; agent: AgentPort }[] = []
  const resumed: { input: Record<string, unknown>; agent: AgentPort }[] = []
  const agents: AgentsPort = {
    create: async (input) => { const agent = fakeAgent(input.sessionId); created.push({ input: input as unknown as Record<string, unknown>, agent }); return agent },
    resume: async (input) => { const agent = fakeAgent(input.sessionId); resumed.push({ input: input as unknown as Record<string, unknown>, agent }); return agent },
  }
  const bindings = fakeBindings()
  const sessions = new Map<string, SessionRuntime>()
  return { agents, bindings, sessions, router: new Router(agents, bindings, sessions), created, resumed }
}

describe('Router.ensure', () => {
  test('无绑定：create 新 agent 并写绑定，persona/tools/cwd 透传', async () => {
    const { router, bindings, created } = setup()
    const rt = await router.ensure(fakeBot(), 'oc_1', reply)
    expect(created).toHaveLength(1)
    expect(created[0].input.cwd).toBe('D:\\work\\demo')
    expect(created[0].input.hooks).toEqual({ persona: '你是评审助手', tools: ['bash'] })
    expect(bindings.get('reviewer', 'oc_1')).toBe(rt.sessionId)
    expect(rt.reply).toBe(reply)
  })

  test('有绑定且进程内有 runtime：直接复用并刷新 reply', async () => {
    const { router, created, resumed } = setup()
    const first = await router.ensure(fakeBot(), 'oc_1', reply)
    const reply2 = {} as ReplyHandle
    const second = await router.ensure(fakeBot(), 'oc_1', reply2)
    expect(second).toBe(first)
    expect(first.reply).toBe(reply2)
    expect(created).toHaveLength(1)
    expect(resumed).toHaveLength(0)
  })

  test('有绑定但进程内无 runtime（重启后）：resume 恢复', async () => {
    const { router, bindings, resumed } = setup()
    await bindings.set('reviewer', 'oc_1', 'sess-old')
    const rt = await router.ensure(fakeBot(), 'oc_1', reply)
    expect(resumed).toHaveLength(1)
    expect(resumed[0].input.sessionId).toBe('sess-old')
    expect(rt.sessionId).toBe('sess-old')
  })
})

describe('Router.reset（/new）', () => {
  test('取消旧 agent、清绑定、开新会话', async () => {
    const { router, bindings, created } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply)
    const next = await router.reset(fakeBot(), 'oc_1', reply)
    expect(old.agent.cancel).toHaveBeenCalledOnce()
    expect(next.sessionId).not.toBe(old.sessionId)
    expect(bindings.get('reviewer', 'oc_1')).toBe(next.sessionId)
    expect(created).toHaveLength(2)
  })

  test('无旧绑定时直接开新会话', async () => {
    const { router, created } = setup()
    await router.reset(fakeBot(), 'oc_9', reply)
    expect(created).toHaveLength(1)
  })
})

test('Router.lookup 按绑定反查 runtime', async () => {
  const { router } = setup()
  expect(router.lookup('reviewer', 'oc_1')).toBeUndefined()
  const rt = await router.ensure(fakeBot(), 'oc_1', reply)
  expect(router.lookup('reviewer', 'oc_1')).toBe(rt)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（`../src/core/router.ts` 不存在）

- [ ] **Step 3: 实现 router.ts**

`packages/project-bot/src/core/router.ts`：

```ts
/** 绑定路由：(botId, chatId) → 长期会话；create / resume / reset。 */
import { randomUUID } from 'node:crypto'
import type { BotRecord } from '../store.ts'
import type { ReplyHandle } from './channel.ts'
import { hooksOf, type AgentsPort, type BindingStore, type SessionRuntime } from './ports.ts'

export class Router {
  constructor(
    private readonly agents: AgentsPort,
    private readonly bindings: BindingStore,
    /** sessionId → runtime（进程内活跃会话表，与 bindings 持久表互补）。 */
    private readonly sessions: Map<string, SessionRuntime>,
  ) {}

  /** 取（或建/恢复）该 chat 的会话 runtime；reply 刷新为最近一次入站携带的句柄。 */
  async ensure(bot: BotRecord, chatId: string, reply: ReplyHandle): Promise<SessionRuntime> {
    const bound = this.bindings.get(bot.id, chatId)
    if (bound !== undefined) {
      const existing = this.sessions.get(bound)
      if (existing !== undefined) {
        existing.reply = reply
        return existing
      }
      const agent = await this.agents.resume({ sessionId: bound, agentOptions: bot.agentOptions, hooks: hooksOf(bot) })
      return this.adopt(bot.id, chatId, bound, agent, reply)
    }
    const sessionId = randomUUID()
    const agent = await this.agents.create({ sessionId, cwd: bot.project, agentOptions: bot.agentOptions, hooks: hooksOf(bot) })
    await this.bindings.set(bot.id, chatId, sessionId)
    return this.adopt(bot.id, chatId, sessionId, agent, reply)
  }

  /** /new：取消旧会话、清绑定、开新会话。 */
  async reset(bot: BotRecord, chatId: string, reply: ReplyHandle): Promise<SessionRuntime> {
    const bound = this.bindings.get(bot.id, chatId)
    if (bound !== undefined) {
      this.sessions.get(bound)?.agent.cancel()
      this.sessions.delete(bound)
      await this.bindings.delete(bot.id, chatId)
    }
    return this.ensure(bot, chatId, reply)
  }

  lookup(botId: string, chatId: string): SessionRuntime | undefined {
    const bound = this.bindings.get(botId, chatId)
    return bound === undefined ? undefined : this.sessions.get(bound)
  }

  private adopt(botId: string, chatId: string, sessionId: string, agent: SessionRuntime['agent'], reply: ReplyHandle): SessionRuntime {
    const rt: SessionRuntime = {
      botId, chatId, sessionId, agent, reply,
      inflight: undefined, tail: Promise.resolve(), turn: undefined,
    }
    this.sessions.set(sessionId, rt)
    return rt
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/core/router.ts packages/project-bot/tests/router.test.ts
git commit -m "feat(project-bot): Router——chat 绑定路由与 agent create/resume/reset"
```

---

### Task 5: Inbound——指令分流、准入、表情回复、投递

**Files:**
- Create: `packages/project-bot/src/core/inbound.ts`
- Test: `packages/project-bot/tests/inbound.test.ts`

**Interfaces:**
- Consumes: `Router`（Task 4）、`InboundMessage` / `ReplyHandle` / `Disposer`（Task 3）、`parseDirective`（Task 3）、`createUserMessage`（`@deepseek-ai/dsh-llm`）。
- Produces: `Inbound`——`onMessage(msg: InboundMessage): void`（fire-and-forget）；`MessageSourceMap` 的 `'project-bot'` 扩展声明（本文件内 `declare module`）。

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/inbound.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest'
import type { Disposer, InboundMessage, ReplyHandle } from '../src/core/channel.ts'
import { Inbound } from '../src/core/inbound.ts'
import type { AgentPort, AgentsPort, BindingStore, SessionRuntime } from '../src/core/ports.ts'
import { Router } from '../src/core/router.ts'
import type { BotRecord } from '../src/store.ts'

const BOT: BotRecord = {
  id: 'reviewer', name: '评审', channel: 'feishu',
  feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
  project: 'D:\\work\\demo', createdAt: 0, updatedAt: 0,
}

interface Recorded {
  notices: string[]
  acked: number
  followups: { text: string; source: Record<string, unknown> }[]
  cancels: number
}

function harness() {
  const rec: Recorded = { notices: [], acked: 0, followups: [], cancels: 0 }
  const agents: AgentsPort = {
    create: async (input) => fakeAgent(input.sessionId, rec),
    resume: async (input) => fakeAgent(input.sessionId, rec),
  }
  const map = new Map<string, string>()
  const bindings: BindingStore = {
    get: (b, c) => map.get(`${b}:${c}`),
    set: async (b, c, s) => { map.set(`${b}:${c}`, s) },
    delete: async (b, c) => { map.delete(`${b}:${c}`) },
    deleteBot: async () => undefined,
  }
  const sessions = new Map<string, SessionRuntime>()
  const router = new Router(agents, bindings, sessions)
  const inbound = new Inbound({
    router,
    bots: { get: (id) => (id === BOT.id ? BOT : undefined) },
    onError: () => undefined,
  })
  function msg(text: string, chatId = 'oc_1'): InboundMessage {
    return {
      botId: BOT.id, chatId, userId: 'ou_u1', messageId: `om_${Math.random()}`,
      text,
      reply: fakeReply(rec),
      ackProcessing: async (): Promise<Disposer> => {
        rec.acked += 1
        return () => undefined
      },
    }
  }
  return { rec, inbound, sessions, msg }
}

function fakeAgent(sessionId: string, rec: Recorded): AgentPort {
  return {
    sessionId,
    followup: (m) => {
      const message = m as { content: { type: string; text?: string }[]; source: Record<string, unknown> }
      rec.followups.push({ text: message.content[0].text ?? '', source: message.source })
    },
    cancel: () => { rec.cancels += 1 },
    whenIdle: async () => undefined,
  }
}

function fakeReply(rec: Recorded): ReplyHandle {
  return {
    beginTurn: async () => undefined,
    update: async () => undefined,
    finalize: async () => undefined,
    notice: async (text) => { rec.notices.push(text) },
  }
}

test('普通消息：建会话、表情回复、followup 携带 project-bot source', async () => {
  const { rec, inbound, sessions, msg } = harness()
  inbound.onMessage(msg('帮我评审这段代码'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  expect(rec.acked).toBe(1)
  expect(rec.followups[0].text).toBe('帮我评审这段代码')
  expect(rec.followups[0].source).toMatchObject({ kind: 'project-bot', channel: 'feishu', botId: 'reviewer', chatId: 'oc_1', userId: 'ou_u1' })
  expect(sessions.size).toBe(1)
})

test('in-flight 占用期间第二条消息被拒并提示', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('第一条'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('第二条'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('上一条还在处理中'))).toBe(true) })
  expect(rec.followups).toHaveLength(1)
})

test('/new：重置会话并确认', async () => {
  const { rec, inbound, sessions, msg } = harness()
  inbound.onMessage(msg('触发建会话'))
  await vi.waitFor(() => { expect(sessions.size).toBe(1) })
  const oldSessionId = [...sessions.keys()][0]
  inbound.onMessage(msg('/new'))
  await vi.waitFor(() => { expect(rec.notices).toContain('已开启新会话') })
  expect(rec.cancels).toBe(1)
  expect([...sessions.keys()][0]).not.toBe(oldSessionId)
})

test('/stop：无任务时提示；有任务时取消', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('/stop'))
  await vi.waitFor(() => { expect(rec.notices).toContain('当前没有进行中的任务') })

  inbound.onMessage(msg('跑个任务'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })   // inflight 未释放
  inbound.onMessage(msg('/stop'))
  await vi.waitFor(() => { expect(rec.notices).toContain('已请求停止当前任务') })
  expect(rec.cancels).toBe(1)
})

test('/status：汇报项目与会话状态', async () => {
  const { rec, inbound, msg } = harness()
  inbound.onMessage(msg('/status'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('未创建'))).toBe(true) })
  inbound.onMessage(msg('建会话'))
  await vi.waitFor(() => { expect(rec.followups).toHaveLength(1) })
  inbound.onMessage(msg('/status'))
  await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('D:\\work\\demo') && n.includes('处理中'))).toBe(true) })
})

test('未知 botId 的消息直接丢弃', async () => {
  const { rec, inbound, msg } = harness()
  const m = msg('hello')
  m.botId = 'ghost'
  inbound.onMessage(m)
  await new Promise((r) => setTimeout(r, 20))
  expect(rec.followups).toHaveLength(0)
  expect(rec.notices).toHaveLength(0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（`../src/core/inbound.ts` 不存在）

- [ ] **Step 3: 实现 inbound.ts**

`packages/project-bot/src/core/inbound.ts`：

```ts
/** 入站：指令分流 → 路由 → 单 in-flight 准入 → 表情回复 → followup 投递。 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { BotRecord } from '../store.ts'
import type { InboundMessage } from './channel.ts'
import { parseDirective } from './directive.ts'
import type { Router } from './router.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'project-bot': { kind: 'project-bot'; channel: string; botId: string; chatId: string; userId: string }
  }
}

export interface InboundDeps {
  router: Router
  bots: { get(botId: string): BotRecord | undefined }
  onError(message: string): void
}

export class Inbound {
  constructor(private readonly deps: InboundDeps) {}

  onMessage(msg: InboundMessage): void {
    void this.handle(msg).catch(async (error) => {
      this.deps.onError(`[project-bot] 入站处理失败：${error instanceof Error ? error.message : String(error)}`)
      await msg.reply.notice('处理失败，请稍后再试').catch(() => undefined)
    })
  }

  private async handle(msg: InboundMessage): Promise<void> {
    const bot = this.deps.bots.get(msg.botId)
    if (bot === undefined) return

    const directive = parseDirective(msg.text)
    if (directive === 'new') {
      await this.deps.router.reset(bot, msg.chatId, msg.reply)
      await msg.reply.notice('已开启新会话')
      return
    }
    if (directive === 'stop') {
      const rt = this.deps.router.lookup(bot.id, msg.chatId)
      if (rt?.inflight !== undefined) {
        rt.agent.cancel()
        await msg.reply.notice('已请求停止当前任务')
      } else {
        await msg.reply.notice('当前没有进行中的任务')
      }
      return
    }
    if (directive === 'status') {
      const rt = this.deps.router.lookup(bot.id, msg.chatId)
      await msg.reply.notice(rt === undefined
        ? `项目：${bot.project}\n会话：未创建（发送消息即创建）`
        : `项目：${bot.project}\n会话：${rt.sessionId}\n状态：${rt.inflight !== undefined ? '处理中' : '空闲'}`)
      return
    }

    const rt = await this.deps.router.ensure(bot, msg.chatId, msg.reply)
    if (rt.inflight !== undefined) {
      await msg.reply.notice('上一条还在处理中，请稍候（或发送 /stop 取消）')
      return
    }
    // 准入：先占槽再异步；表情回复失败不阻塞处理。
    rt.inflight = { ack: undefined }
    rt.inflight.ack = (await msg.ackProcessing().catch(() => undefined)) ?? undefined
    const message = createUserMessage({
      content: [{ type: 'text', text: msg.text }],
      source: { kind: 'project-bot', channel: bot.channel, botId: bot.id, chatId: msg.chatId, userId: msg.userId },
    })
    try {
      rt.agent.followup(message)
    } catch (error) {
      const ack = rt.inflight.ack
      rt.inflight = undefined
      await ack?.()
      throw error
    }
  }
}
```

注：`inflight` 的释放与表情删除在 Task 6 的 Outbound（`turn/end` 时）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/core/inbound.ts packages/project-bot/tests/inbound.test.ts
git commit -m "feat(project-bot): Inbound——指令分流、in-flight 准入、处理中表情回复与投递"
```

---

### Task 6: Outbound——turn 事件归集与回复驱动

**Files:**
- Create: `packages/project-bot/src/core/outbound.ts`
- Test: `packages/project-bot/tests/outbound.test.ts`

**Interfaces:**
- Consumes: `SessionRuntime` / `TurnStatus` / `ReplyHandle`（Task 3）。
- Produces: `Outbound`——`handleSessionEvent(sessionId: string, event: SessionEventLike): void`；`textOf(content)`；`mapTurnEnd(reason)`；`SessionEventLike`。

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/outbound.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest'
import type { ReplyHandle, TurnStatus } from '../src/core/channel.ts'
import { Outbound, mapTurnEnd, textOf } from '../src/core/outbound.ts'
import type { SessionRuntime } from '../src/core/ports.ts'

function fakeRuntime(reply: ReplyHandle): SessionRuntime {
  return {
    botId: 'b', chatId: 'oc_1', sessionId: 's1',
    agent: { sessionId: 's1', followup: vi.fn(), cancel: vi.fn(), whenIdle: async () => undefined },
    reply, inflight: { ack: undefined }, tail: Promise.resolve(), turn: undefined,
  }
}

function recorder() {
  const calls: { op: string; arg?: string }[] = []
  const reply: ReplyHandle = {
    beginTurn: async () => { calls.push({ op: 'beginTurn' }) },
    update: async (md) => { calls.push({ op: 'update', arg: md }) },
    finalize: async (status: TurnStatus, detail?: string) => { calls.push({ op: 'finalize', arg: `${status}${detail ? `:${detail}` : ''}` }) },
    notice: async (text) => { calls.push({ op: 'notice', arg: text }) },
  }
  return { calls, reply }
}

async function drain(rt: SessionRuntime): Promise<void> { await rt.tail }

describe('textOf / mapTurnEnd', () => {
  test('textOf 只取 text 块并拼接', () => {
    expect(textOf([{ type: 'text', text: 'a' }, { type: 'tool-call', id: 'x' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(textOf([])).toBe('')
  })

  test('mapTurnEnd 状态映射', () => {
    expect(mapTurnEnd('completed')).toBe('done')
    expect(mapTurnEnd('aborted')).toBe('cancelled')
    expect(mapTurnEnd('interrupted')).toBe('cancelled')
    expect(mapTurnEnd('error')).toBe('error')
    expect(mapTurnEnd('max-tokens')).toBe('error')
    expect(mapTurnEnd('blocked')).toBe('error')
  })
})

describe('Outbound.handleSessionEvent', () => {
  test('turn 全流程：beginTurn 一次 → 全量 update → turn/end 定格并释放 inflight + 删除表情', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const ack = vi.fn()
    rt.inflight = { ack }
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)

    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '你好' }] } } })
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '，世界' }] } } })
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
    await drain(rt)

    expect(calls).toEqual([
      { op: 'beginTurn' },
      { op: 'update', arg: '你好' },
      { op: 'update', arg: '你好，世界' },
      { op: 'finalize', arg: 'done' },
    ])
    expect(ack).toHaveBeenCalledOnce()
    expect(rt.inflight).toBeUndefined()
    expect(rt.turn).toBeUndefined()
  })

  test('无文本输出的 turn：不建卡，仍释放 inflight 与表情', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const ack = vi.fn()
    rt.inflight = { ack }
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('s1', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'turn/end', data: { turn: 1, reason: 'error' } })
    await drain(rt)
    expect(calls).toEqual([])
    expect(ack).toHaveBeenCalledOnce()
    expect(rt.inflight).toBeUndefined()
  })

  test('非本插件 session 与错序 turn 的事件被忽略', async () => {
    const { calls, reply } = recorder()
    const rt = fakeRuntime(reply)
    const outbound = new Outbound(new Map([['s1', rt]]), () => undefined)
    outbound.handleSessionEvent('other-session', { type: 'turn/start', data: { turn: 1 } })
    outbound.handleSessionEvent('s1', { type: 'assistant/message', data: { turn: 9, message: { content: [{ type: 'text', text: 'x' }] } } })
    await drain(rt)
    expect(calls).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（`../src/core/outbound.ts` 不存在）

- [ ] **Step 3: 实现 outbound.ts**

`packages/project-bot/src/core/outbound.ts`：

```ts
/** 出站：持久会话事件 → turn 级回复驱动（per-session Promise 链保序）。 */
import type { TurnStatus } from './channel.ts'
import type { SessionRuntime } from './ports.ts'

/** 窄化的事件信封：核心只读 type/data。 */
export interface SessionEventLike {
  type: string
  data: Record<string, unknown>
}

/** 从 assistant 消息内容块提取纯文本（只取 text 块；工具调用等不进卡片）。 */
export function textOf(content: readonly unknown[]): string {
  return (content as readonly { type?: unknown; text?: unknown }[])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

export function mapTurnEnd(reason: string): TurnStatus {
  if (reason === 'completed') return 'done'
  if (reason === 'aborted' || reason === 'interrupted') return 'cancelled'
  return 'error'
}

export class Outbound {
  constructor(
    private readonly sessions: Map<string, SessionRuntime>,
    private readonly onError: (message: string) => void,
  ) {}

  handleSessionEvent(sessionId: string, event: SessionEventLike): void {
    const rt = this.sessions.get(sessionId)
    if (rt === undefined) return

    if (event.type === 'turn/start') {
      rt.turn = { n: event.data.turn as number, buffer: '', began: false }
      return
    }

    if (event.type === 'assistant/message') {
      const turn = rt.turn
      if (turn === undefined || turn.n !== (event.data.turn as number)) return
      const text = textOf((event.data.message as { content: readonly unknown[] }).content)
      if (text.length === 0) return
      turn.buffer += text
      this.enqueue(rt, async () => {
        if (rt.reply === undefined) return
        if (!turn.began) {
          await rt.reply.beginTurn()
          turn.began = true
        }
        await rt.reply.update(turn.buffer)
      })
      return
    }

    if (event.type === 'turn/end') {
      const turn = rt.turn
      if (turn === undefined || turn.n !== (event.data.turn as number)) return
      const status = mapTurnEnd(event.data.reason as string)
      this.enqueue(rt, async () => {
        if (turn.began && rt.reply !== undefined) await rt.reply.finalize(status)
        const ack = rt.inflight?.ack
        rt.inflight = undefined
        if (ack !== undefined) await ack()
      })
      rt.turn = undefined
    }
  }

  private enqueue(rt: SessionRuntime, task: () => Promise<void>): void {
    rt.tail = rt.tail.then(task).catch((error) => {
      this.onError(`[project-bot] 出站处理失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/core/outbound.ts packages/project-bot/tests/outbound.test.ts
git commit -m "feat(project-bot): Outbound——turn 归集、per-session 保序链与状态映射"
```

---

### Task 7: BotRuntime——bot 生命周期编排

**Files:**
- Create: `packages/project-bot/src/core/runtime.ts`
- Test: `packages/project-bot/tests/runtime.test.ts`

**Interfaces:**
- Consumes: 前序全部 core 类型 + `BotChannel` / `ChannelHandle` / `ChannelStatus`（Task 3）、KvTable（`@deepseek-ai/dsh-storage-domain`，type-only）、`bindingKey`（Task 2）。
- Produces（Task 13/14 消费）：`BotRuntime`——`startAll()` / `reconcile(botId)` / `stopBot(botId)` / `stopAll()` / `statusOf(botId): ChannelStatus | 'not-running'`；公开 `router` / `inbound` / `outbound` / `sessions`；`RuntimeDeps`。

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/runtime.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest'
import type { BotChannel, ChannelHandle } from '../src/core/channel.ts'
import { BotRuntime, type RuntimeDeps } from '../src/core/runtime.ts'
import type { BotRecord } from '../src/store.ts'

const BOT: BotRecord = {
  id: 'reviewer', name: '评审', channel: 'feishu',
  feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
  project: 'D:\\work\\demo', createdAt: 0, updatedAt: 0,
}

function fakeTable<V>(initial: Record<string, V> = {}) {
  const map = new Map<string, V>(Object.entries(initial))
  return {
    map,
    get: (k: string) => map.get(k),
    put: async (k: string, v: V) => { map.set(k, v) },
    delete: async (k: string) => map.delete(k),
    entries: () => map.entries(),
    keys: () => map.keys(),
  }
}

function harness(overrides: Partial<RuntimeDeps> = {}) {
  const started: string[] = []
  const closed: string[] = []
  const warns: string[] = []
  const channel: BotChannel = {
    type: 'feishu',
    start: async (bot) => {
      started.push(bot.record.id)
      const handle: ChannelHandle = {
        close: async () => { closed.push(bot.record.id) },
        status: () => 'connected',
      }
      return handle
    },
  }
  const deps: RuntimeDeps = {
    bots: fakeTable<BotRecord>({ reviewer: BOT }) as unknown as RuntimeDeps['bots'],
    bindings: fakeTable() as unknown as RuntimeDeps['bindings'],
    agents: { create: vi.fn(), resume: vi.fn() } as unknown as RuntimeDeps['agents'],
    channels: new Map([['feishu', channel]]),
    tunables: { cardUpdateThrottleMs: 10, cardMaxBytes: 1024, processingReactionEmoji: 'OneSecond' },
    resolveSecret: async () => 'secret',
    validateProject: () => true,
    log: { warn: (m) => { warns.push(m) }, info: () => undefined },
    ...overrides,
  }
  return { deps, started, closed, warns, runtime: new BotRuntime(deps) }
}

test('startAll 为每个合法 bot 启动渠道', async () => {
  const { runtime, started } = harness()
  await runtime.startAll()
  expect(started).toEqual(['reviewer'])
  expect(runtime.statusOf('reviewer')).toBe('connected')
})

test('密钥缺失：不启动并告警', async () => {
  const { runtime, started, warns } = harness({ resolveSecret: async () => undefined })
  await runtime.startAll()
  expect(started).toEqual([])
  expect(warns.some((w) => w.includes('reviewer'))).toBe(true)
  expect(runtime.statusOf('reviewer')).toBe('not-running')
})

test('项目路径非法：不启动并告警', async () => {
  const { runtime, started, warns } = harness({ validateProject: () => false })
  await runtime.startAll()
  expect(started).toEqual([])
  expect(warns.some((w) => w.includes('项目'))).toBe(true)
})

test('reconcile 重连：先停旧渠道再按最新记录启动', async () => {
  const { runtime, started, closed, deps } = harness()
  await runtime.startAll()
  await deps.bots.put('reviewer', { ...BOT, name: '评审v2' })
  await runtime.reconcile('reviewer')
  expect(closed).toEqual(['reviewer'])
  expect(started).toEqual(['reviewer', 'reviewer'])
})

test('stopBot 停渠道并清理该 bot 的绑定与会话', async () => {
  const { runtime, closed, deps } = harness()
  await runtime.startAll()
  await deps.bindings.put('reviewer:oc_1', { sessionId: 's1' })
  await deps.bindings.put('other:oc_2', { sessionId: 's2' })
  await runtime.stopBot('reviewer')
  expect(closed).toEqual(['reviewer'])
  expect(deps.bindings.get('reviewer:oc_1')).toBeUndefined()
  expect(deps.bindings.get('other:oc_2')).toEqual({ sessionId: 's2' })
})

test('stopAll 取消在飞会话并关闭全部渠道（幂等）', async () => {
  const { runtime, closed } = harness()
  await runtime.startAll()
  await runtime.stopAll()
  await runtime.stopAll()
  expect(closed).toEqual(['reviewer'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（`../src/core/runtime.ts` 不存在）

- [ ] **Step 3: 实现 runtime.ts**

`packages/project-bot/src/core/runtime.ts`：

```ts
/** BotRuntime：bot 名册 → 渠道生命周期；聚合 router/inbound/outbound。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { bindingKey, type Binding, type BotRecord } from '../store.ts'
import type { BotChannel, ChannelHandle, ChannelStatus, ChannelTunables } from './channel.ts'
import { Inbound } from './inbound.ts'
import { Outbound } from './outbound.ts'
import type { AgentsPort, BindingStore, SessionRuntime } from './ports.ts'
import { Router } from './router.ts'

export interface RuntimeDeps {
  bots: KvTable<string, BotRecord>
  bindings: KvTable<string, Binding>
  agents: AgentsPort
  channels: ReadonlyMap<string, BotChannel>
  tunables: ChannelTunables
  resolveSecret(ref: string): Promise<string | undefined>
  validateProject(path: string): boolean
  log: { warn(message: string): void; info(message: string): void }
}

export type BotStatus = ChannelStatus | 'not-running'

export class BotRuntime {
  readonly sessions = new Map<string, SessionRuntime>()
  readonly router: Router
  readonly inbound: Inbound
  readonly outbound: Outbound
  private readonly handles = new Map<string, ChannelHandle>()

  constructor(private readonly deps: RuntimeDeps) {
    const bindingStore = this.bindingStore()
    this.router = new Router(deps.agents, bindingStore, this.sessions)
    this.inbound = new Inbound({ router: this.router, bots: deps.bots, onError: (m) => deps.log.warn(m) })
    this.outbound = new Outbound(this.sessions, (m) => deps.log.warn(m))
  }

  async startAll(): Promise<void> {
    for (const botId of [...this.deps.bots.keys()]) await this.reconcile(botId)
  }

  /** 按最新记录重建该 bot 的渠道（创建/更新后调用；记录已删则纯停止）。 */
  async reconcile(botId: string): Promise<void> {
    await this.stopChannel(botId)
    const record = this.deps.bots.get(botId)
    if (record === undefined) return
    if (!this.deps.validateProject(record.project)) {
      this.deps.log.warn(`[project-bot] bot "${botId}" 的项目路径不可用：${record.project}`)
      return
    }
    const secret = await this.deps.resolveSecret(record.feishu.appSecretRef)
    if (secret === undefined) {
      this.deps.log.warn(`[project-bot] bot "${botId}" 的密钥 ${record.feishu.appSecretRef} 未配置`)
      return
    }
    const channel = this.deps.channels.get(record.channel)
    if (channel === undefined) {
      this.deps.log.warn(`[project-bot] bot "${botId}" 的渠道 "${record.channel}" 未实现`)
      return
    }
    try {
      const handle = await channel.start(
        { record, secret },
        { onMessage: (msg) => this.inbound.onMessage(msg) },
        this.deps.tunables,
        (m) => this.deps.log.warn(m),
      )
      this.handles.set(botId, handle)
    } catch (error) {
      this.deps.log.warn(`[project-bot] bot "${botId}" 渠道启动失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 删除 bot：停渠道、取消会话、清绑定。 */
  async stopBot(botId: string): Promise<void> {
    await this.stopChannel(botId)
    for (const [sessionId, rt] of [...this.sessions]) {
      if (rt.botId === botId) {
        rt.agent.cancel()
        this.sessions.delete(sessionId)
      }
    }
    await this.bindingStore().deleteBot(botId)
  }

  statusOf(botId: string): BotStatus {
    return this.handles.get(botId)?.status() ?? 'not-running'
  }

  /** 卸载时序：取消在飞会话 → 等 idle → drain 出站链（卡片定格）→ 断全部渠道。 */
  async stopAll(): Promise<void> {
    for (const rt of this.sessions.values()) rt.agent.cancel()
    await Promise.allSettled([...this.sessions.values()].map(async (rt) => {
      await rt.agent.whenIdle().catch(() => undefined)
      await rt.tail
    }))
    await Promise.allSettled([...this.handles.values()].map((h) => h.close()))
    this.handles.clear()
  }

  private async stopChannel(botId: string): Promise<void> {
    const handle = this.handles.get(botId)
    if (handle === undefined) return
    this.handles.delete(botId)
    await handle.close().catch((error) => {
      this.deps.log.warn(`[project-bot] bot "${botId}" 渠道关闭异常：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private bindingStore(): BindingStore {
    const { bindings } = this.deps
    return {
      get: (b, c) => bindings.get(bindingKey(b, c))?.sessionId,
      set: async (b, c, s) => { await bindings.put(bindingKey(b, c), { sessionId: s }) },
      delete: async (b, c) => { await bindings.delete(bindingKey(b, c)) },
      deleteBot: async (b) => {
        for (const key of [...bindings.keys()]) {
          if (key.startsWith(`${b}:`)) await bindings.delete(key)
        }
      },
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/core/runtime.ts packages/project-bot/tests/runtime.test.ts
git commit -m "feat(project-bot): BotRuntime——渠道生命周期编排与卸载时序"
```

---

### Task 8: 飞书卡片纯函数（构建 / 字节切分 / 操作规划）

**Files:**
- Create: `packages/project-bot/src/channels/feishu/cards.ts`
- Test: `packages/project-bot/tests/feishu-cards.test.ts`

**Interfaces:**
- Consumes: `TurnStatus`（Task 3）。
- Produces（Task 10 消费，签名冻结）：
  - `CARD_ELEMENT_ID = 'md'`、`PENDING_CARD_ID = '__pending__'`
  - `sliceByBytes(text, maxBytes): string`
  - `buildCardJson({ title, content, streaming, template }): string`、`CardTemplate`
  - `StreamState` / `initialStreamState()`
  - `CardOp = { type: 'create'; cardJson } | { type: 'send' } | { type: 'update'; content; sequence } | { type: 'settings'; streaming; sequence } | { type: 'replace'; cardJson; sequence }`
  - `planSync(state, fullText, maxBytes, title): { state; ops }`
  - `planFinalize(state, currentContent, status, title): { ops }`

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/feishu-cards.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import {
  buildCardJson, CARD_ELEMENT_ID, initialStreamState, PENDING_CARD_ID,
  planFinalize, planSync, sliceByBytes, type StreamState,
} from '../src/channels/feishu/cards.ts'

describe('sliceByBytes', () => {
  test('短文本原样返回', () => {
    expect(sliceByBytes('abc', 10)).toBe('abc')
  })

  test('按 UTF-8 字节截断且不劈开多字节字符', () => {
    // '中' = 3 字节：maxBytes=4 只能容纳 1 个
    expect(sliceByBytes('中中', 4)).toBe('中')
    expect(sliceByBytes('中中', 6)).toBe('中中')
  })

  test('不劈开代理对（emoji）', () => {
    const s = 'ab😀cd'   // 😀 = 2 个 code unit / 4 字节
    expect(sliceByBytes(s, 6)).toBe('ab😀')   // 2 + 4 恰好容下
    expect(sliceByBytes(s, 5)).toBe('ab')     // 容不下时整对移除
  })
})

describe('buildCardJson', () => {
  test('JSON 2.0 流式卡片结构', () => {
    const json = JSON.parse(buildCardJson({ title: '评审', content: '正文', streaming: true, template: 'blue' }))
    expect(json.schema).toBe('2.0')
    expect(json.header).toEqual({ template: 'blue', title: { content: '评审', tag: 'plain_text' } })
    expect(json.config.streaming_mode).toBe(true)
    expect(json.config.streaming_config.print_strategy).toBe('fast')
    expect(json.body.elements).toEqual([{ tag: 'markdown', content: '正文', element_id: CARD_ELEMENT_ID }])
  })

  test('非流式不带 streaming_config', () => {
    const json = JSON.parse(buildCardJson({ title: 't', content: 'c', streaming: false, template: 'green' }))
    expect(json.config.streaming_mode).toBe(false)
    expect(json.config.streaming_config).toBeUndefined()
  })
})

describe('planSync', () => {
  test('首次更新：create + send', () => {
    const { state, ops } = planSync(initialStreamState(), '你好', 100, 't')
    expect(ops).toEqual([
      { type: 'create', cardJson: buildCardJson({ title: 't', content: '你好', streaming: true, template: 'blue' }) },
      { type: 'send' },
    ])
    expect(state.cardId).toBe(PENDING_CARD_ID)
    expect(state.shownLen).toBe(2)
  })

  test('增量更新：全量替换当前卡内容，sequence 递增', () => {
    const first = planSync(initialStreamState(), '你好', 100, 't')
    const { state, ops } = planSync({ ...first.state, cardId: 'card_1' }, '你好，世界', 100, 't')
    expect(ops).toEqual([{ type: 'update', content: '你好，世界', sequence: 1 }])
    expect(state.shownLen).toBe(5)
  })

  test('无新内容：空 ops', () => {
    const first = planSync(initialStreamState(), 'abc', 100, 't')
    expect(planSync(first.state, 'abc', 100, 't').ops).toEqual([])
  })

  test('超长拆卡：满卡关流 → 新卡 create+send 承接剩余（新卡 sequence 从 1 重新计）', () => {
    // maxBytes=6：每张卡最多 2 个汉字
    const { state, ops } = planSync(initialStreamState(), '一二三四五', 6, 't')
    expect(ops).toEqual([
      { type: 'create', cardJson: buildCardJson({ title: 't', content: '一二', streaming: true, template: 'blue' }) },
      { type: 'send' },
      { type: 'settings', streaming: false, sequence: 1 },
      { type: 'create', cardJson: buildCardJson({ title: 't', content: '三四', streaming: true, template: 'blue' }) },
      { type: 'send' },
      { type: 'settings', streaming: false, sequence: 1 },
      { type: 'create', cardJson: buildCardJson({ title: 't', content: '五', streaming: true, template: 'blue' }) },
      { type: 'send' },
    ])
    expect(state.cardId).toBe(PENDING_CARD_ID)
    expect(state.offset).toBe(4)
    expect(state.shownLen).toBe(5)
  })
})

describe('planFinalize', () => {
  test('关流式 + 按状态换头色全量替换（sequence 接续）', () => {
    const state: StreamState = { cardId: 'card_1', seq: 3, offset: 0, shownLen: 2 }
    const { ops } = planFinalize(state, '你好', 'done', 't')
    expect(ops).toEqual([
      { type: 'settings', streaming: false, sequence: 4 },
      { type: 'replace', cardJson: buildCardJson({ title: 't', content: '你好', streaming: false, template: 'green' }), sequence: 5 },
    ])
  })

  test('error → red，cancelled → grey；从未建卡 → 空 ops', () => {
    const state: StreamState = { cardId: 'c', seq: 0, offset: 0, shownLen: 1 }
    const errorOps = planFinalize(state, 'x', 'error', 't').ops
    const replace = errorOps.find((op) => op.type === 'replace')
    expect(JSON.parse(replace!.type === 'replace' ? replace.cardJson : '').header.template).toBe('red')
    const cancelledOps = planFinalize(state, 'x', 'cancelled', 't').ops
    const replace2 = cancelledOps.find((op) => op.type === 'replace')
    expect(JSON.parse(replace2!.type === 'replace' ? replace2.cardJson : '').header.template).toBe('grey')
    expect(planFinalize(initialStreamState(), '', 'done', 't').ops).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（`../src/channels/feishu/cards.ts` 不存在）

- [ ] **Step 3: 实现 cards.ts**

`packages/project-bot/src/channels/feishu/cards.ts`：

```ts
/** 飞书卡片纯函数：JSON 2.0 构建、UTF-8 字节切分、流式操作规划（拆卡决策全在这里）。 */
import type { TurnStatus } from '../../core/channel.ts'

export const CARD_ELEMENT_ID = 'md'

/** create 未返回真实 card_id 前的占位哨兵（executor 赋值；防并发 flush 重复建卡）。 */
export const PENDING_CARD_ID = '__pending__'

/** 按 UTF-8 字节上限截断，不劈开多字节字符与代理对。 */
export function sliceByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid
    else hi = mid - 1
  }
  let cut = lo
  if (cut > 0) {
    const code = text.charCodeAt(cut - 1)
    if (code >= 0xd8_00 && code <= 0xdb_ff) cut -= 1   // 高位代理在末尾：整对移除
  }
  return text.slice(0, cut)
}

export type CardTemplate = 'blue' | 'green' | 'red' | 'grey'

export function buildCardJson(opts: { title: string; content: string; streaming: boolean; template: CardTemplate }): string {
  return JSON.stringify({
    schema: '2.0',
    header: { template: opts.template, title: { content: opts.title, tag: 'plain_text' } },
    config: {
      streaming_mode: opts.streaming,
      ...(opts.streaming
        ? { summary: { content: '生成中…' }, streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: 'fast' } }
        : {}),
    },
    body: { elements: [{ tag: 'markdown', content: opts.content, element_id: CARD_ELEMENT_ID }] },
  })
}

export interface StreamState {
  /** 当前卡片 id（PENDING_CARD_ID = 创建中）；null = 下一张卡待创建。 */
  cardId: string | null
  /** 当前卡片已消耗的 sequence 计数（create/send 不占）。 */
  seq: number
  /** 当前卡片内容在 fullText 中的起始偏移（跨卡累计）。 */
  offset: number
  /** fullText 已提交到卡片的前缀长度（跨卡累计）。 */
  shownLen: number
}

export const initialStreamState = (): StreamState => ({ cardId: null, seq: 0, offset: 0, shownLen: 0 })

export type CardOp =
  | { type: 'create'; cardJson: string }
  | { type: 'send' }
  | { type: 'update'; content: string; sequence: number }
  | { type: 'settings'; streaming: boolean; sequence: number }
  | { type: 'replace'; cardJson: string; sequence: number }

/** 把 fullText 的新增部分同步到卡片；满卡自动关流并开续卡。 */
export function planSync(state: StreamState, fullText: string, maxBytes: number, title: string): { state: StreamState; ops: CardOp[] } {
  if (fullText.length <= state.shownLen) return { state, ops: [] }
  const ops: CardOp[] = []
  let { cardId, seq, offset, shownLen } = state
  while (shownLen < fullText.length) {
    const capacity = sliceByBytes(fullText.slice(offset), maxBytes).length
    if (capacity <= 0) throw new Error(`cardMaxBytes=${maxBytes} 过小，连一个字符都容纳不了`)
    const fits = fullText.length - offset <= capacity
    const content = fits ? fullText.slice(offset) : fullText.slice(offset, offset + capacity)
    if (cardId === null) {
      ops.push({ type: 'create', cardJson: buildCardJson({ title, content, streaming: true, template: 'blue' }) })
      ops.push({ type: 'send' })
      cardId = PENDING_CARD_ID
      seq = 0
    } else if (content.length > shownLen - offset) {
      seq += 1
      ops.push({ type: 'update', content, sequence: seq })
    }
    shownLen = offset + content.length
    if (fits) break
    seq += 1
    ops.push({ type: 'settings', streaming: false, sequence: seq })
    cardId = null
    offset = shownLen
  }
  return { state: { cardId, seq, offset, shownLen }, ops }
}

/** 定格：关流式 + 按状态换头色（全量替换保持正文不变）。 */
export function planFinalize(state: StreamState, currentContent: string, status: TurnStatus, title: string): { ops: CardOp[] } {
  if (state.cardId === null) return { ops: [] }
  const template: CardTemplate = status === 'done' ? 'green' : status === 'error' ? 'red' : 'grey'
  return {
    ops: [
      { type: 'settings', streaming: false, sequence: state.seq + 1 },
      { type: 'replace', cardJson: buildCardJson({ title, content: currentContent, streaming: false, template }), sequence: state.seq + 2 },
    ],
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/channels/feishu/cards.ts packages/project-bot/tests/feishu-cards.test.ts
git commit -m "feat(project-bot): 飞书卡片纯函数——JSON 2.0 构建、字节切分与拆卡规划"
```

---

### Task 9: 飞书事件解析纯函数

**Files:**
- Create: `packages/project-bot/src/channels/feishu/parse.ts`
- Test: `packages/project-bot/tests/feishu-parse.test.ts`

**Interfaces:**
- Consumes: `stripMentionPlaceholders`（Task 3）。
- Produces（Task 11 消费）：`ParsedMessage` / `parseMessageEvent(data)` / `MessageDedup`（`check(id): boolean`，true = 新消息）。

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/feishu-parse.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { MessageDedup, parseMessageEvent } from '../src/channels/feishu/parse.ts'

function event(overrides: Record<string, unknown> = {}): unknown {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_u1' } },
    message: {
      message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p',
      message_type: 'text', content: JSON.stringify({ text: '你好' }),
      mentions: [],
    },
    ...overrides,
  }
}

function groupEvent(mentions: unknown[], text: string): unknown {
  return event({
    message: {
      message_id: 'om_g', chat_id: 'oc_g', chat_type: 'group',
      message_type: 'text', content: JSON.stringify({ text }), mentions,
    },
  })
}

describe('parseMessageEvent', () => {
  test('p2p 文本消息解析成功', () => {
    expect(parseMessageEvent(event())).toEqual({
      messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u1', text: '你好',
    })
  })

  test('群消息：未 @机器人 → null；@人不算；@机器人 → 剥占位符', () => {
    expect(parseMessageEvent(groupEvent([], '你好'))).toBeNull()
    expect(parseMessageEvent(groupEvent([{ mentioned_type: 'user' }], '@_user_1 你好'))).toBeNull()
    expect(parseMessageEvent(groupEvent([{ mentioned_type: 'bot' }], '@_user_1 帮我看看')))
      .toMatchObject({ text: '帮我看看', chatType: 'group' })
  })

  test('机器人自己的消息 / 非文本消息 / 坏 content → null', () => {
    expect(parseMessageEvent(event({ sender: { sender_type: 'bot', sender_id: { open_id: 'ou_b' } } }))).toBeNull()
    expect(parseMessageEvent(event({
      message: { message_id: 'om_3', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'image', content: '{}', mentions: [] },
    }))).toBeNull()
    expect(parseMessageEvent(event({
      message: { message_id: 'om_4', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: 'not-json', mentions: [] },
    }))).toBeNull()
  })

  test('空文本（只有 @ 占位符）→ null', () => {
    expect(parseMessageEvent(groupEvent([{ mentioned_type: 'bot' }], '@_user_1'))).toBeNull()
  })
})

describe('MessageDedup', () => {
  test('重复 message_id 拒绝；超容量 FIFO 淘汰最旧', () => {
    const dedup = new MessageDedup(2)
    expect(dedup.check('a')).toBe(true)
    expect(dedup.check('a')).toBe(false)
    expect(dedup.check('b')).toBe(true)
    expect(dedup.check('c')).toBe(true)   // 淘汰 a
    expect(dedup.check('a')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（`../src/channels/feishu/parse.ts` 不存在）

- [ ] **Step 3: 实现 parse.ts**

`packages/project-bot/src/channels/feishu/parse.ts`：

```ts
/** im.message.receive_v1 事件解析：窄化为渠道无关的 ParsedMessage；message_id 去重。 */
import { stripMentionPlaceholders } from '../../core/directive.ts'

export interface ParsedMessage {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  userId: string
  text: string
}

interface RawEvent {
  sender?: { sender_type?: unknown; sender_id?: { open_id?: unknown } }
  message?: {
    message_id?: unknown
    chat_id?: unknown
    chat_type?: unknown
    message_type?: unknown
    content?: unknown
    mentions?: readonly { mentioned_type?: unknown }[]
  }
}

/**
 * SDK handler 收到的 data 即事件体（README 示例 `data.message` 直接解构）；
 * 兼容包一层 { event } 的形态。过滤：机器人消息、非文本、群内未 @机器人、空文本。
 */
export function parseMessageEvent(data: unknown): ParsedMessage | null {
  const wrapped = data as { event?: RawEvent } & RawEvent
  const event: RawEvent = wrapped.event ?? wrapped
  if (event.sender?.sender_type !== 'user') return null
  const userId = event.sender.sender_id?.open_id
  const msg = event.message
  if (typeof userId !== 'string' || msg === undefined) return null
  if (msg.message_type !== 'text' || typeof msg.content !== 'string') return null
  if (typeof msg.message_id !== 'string' || typeof msg.chat_id !== 'string') return null
  if (msg.chat_type !== 'p2p' && msg.chat_type !== 'group') return null
  if (msg.chat_type === 'group' && !(msg.mentions ?? []).some((m) => m.mentioned_type === 'bot')) return null

  let text: string
  try {
    const parsed = JSON.parse(msg.content) as { text?: unknown }
    if (typeof parsed.text !== 'string') return null
    text = stripMentionPlaceholders(parsed.text)
  } catch {
    return null
  }
  if (text.length === 0) return null

  return { messageId: msg.message_id, chatId: msg.chat_id, chatType: msg.chat_type, userId, text }
}

/** message_id 去重（飞书会重推）；FIFO 容量淘汰。 */
export class MessageDedup {
  private readonly seen = new Set<string>()
  private readonly order: string[] = []

  constructor(private readonly cap = 1000) {}

  /** true = 新消息。 */
  check(id: string): boolean {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    this.order.push(id)
    if (this.order.length > this.cap) this.seen.delete(this.order.shift()!)
    return true
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/channels/feishu/parse.ts packages/project-bot/tests/feishu-parse.test.ts
git commit -m "feat(project-bot): 飞书事件解析——@识别、文本窄化与 message_id 去重"
```

---

### Task 10: 飞书出站——FeishuApi 端口与 FeishuReplyHandle

**Files:**
- Create: `packages/project-bot/src/channels/feishu/api.ts`
- Create: `packages/project-bot/src/channels/feishu/reply.ts`
- Test: `packages/project-bot/tests/feishu-reply.test.ts`

**Interfaces:**
- Consumes: Task 8 全部（`planSync` / `planFinalize` / `StreamState` / `CardOp` / `PENDING_CARD_ID` / `CARD_ELEMENT_ID`）、Task 3（`ReplyHandle` / `TurnStatus` / `ChannelTunables` / `Disposer`）。
- Produces（Task 11 消费）：
  - `FeishuApi` 接口 + `createFeishuApi(client)`（SDK 薄封装）
  - `FeishuReplyHandle implements ReplyHandle`：`constructor(api, chatId, tunables, title, log)`
  - `withRetry(fn, attempts?, baseDelayMs?)`
  - `makeAck(api, messageId, emojiType): () => Promise<Disposer | undefined>`

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/feishu-reply.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { FeishuApi } from '../src/channels/feishu/api.ts'
import { FeishuReplyHandle, makeAck, withRetry } from '../src/channels/feishu/reply.ts'

const TUNABLES = { cardUpdateThrottleMs: 500, cardMaxBytes: 100, processingReactionEmoji: 'OneSecond' }

interface Call { op: string; args: unknown[] }

function fakeApi() {
  const calls: Call[] = []
  let cardSeq = 0
  const api: FeishuApi = {
    createCard: async () => { calls.push({ op: 'createCard', args: [] }); return `card_${++cardSeq}` },
    sendCardMessage: async (...args) => { calls.push({ op: 'sendCardMessage', args }) },
    updateCardElement: async (...args) => { calls.push({ op: 'updateCardElement', args }) },
    setCardStreaming: async (...args) => { calls.push({ op: 'setCardStreaming', args }) },
    replaceCard: async (...args) => { calls.push({ op: 'replaceCard', args }) },
    sendText: async (...args) => { calls.push({ op: 'sendText', args }) },
    addReaction: async (...args) => { calls.push({ op: 'addReaction', args }); return 'reaction_1' },
    removeReaction: async (...args) => { calls.push({ op: 'removeReaction', args }) },
  }
  return { api, calls }
}

function make(api: FeishuApi) {
  const logs: string[] = []
  const reply = new FeishuReplyHandle(api, 'oc_1', TUNABLES, '评审', (m) => { logs.push(m) })
  return { reply, logs }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('FeishuReplyHandle', () => {
  test('首次 update 建卡并发卡；节流窗口内多次 update 只同步最新内容', async () => {
    const { api, calls } = fakeApi()
    const { reply } = make(api)
    await reply.update('你好')
    await reply.update('你好，世界')
    await vi.advanceTimersByTimeAsync(500)
    expect(calls.map((c) => c.op)).toEqual(['createCard', 'sendCardMessage'])
    // 下一次节流窗口：全量替换为最新内容
    await reply.update('你好，世界！')
    await vi.advanceTimersByTimeAsync(500)
    const updates = calls.filter((c) => c.op === 'updateCardElement')
    expect(updates).toHaveLength(1)
    expect(updates[0].args[2]).toBe('你好，世界！')
    expect(updates[0].args[3]).toBe(1)   // sequence
  })

  test('finalize：冲刷尾部 → 关流式 → 换头色全量替换', async () => {
    const { api, calls } = fakeApi()
    const { reply } = make(api)
    await reply.update('结论')
    await reply.finalize('done')
    const ops = calls.map((c) => c.op)
    expect(ops.slice(0, 2)).toEqual(['createCard', 'sendCardMessage'])
    expect(ops).toContain('setCardStreaming')
    expect(ops[ops.length - 1]).toBe('replaceCard')
    const replace = calls[calls.length - 1]
    expect(JSON.parse(replace.args[1] as string).header.template).toBe('green')
  })

  test('建卡失败：重试耗尽只记日志不抛出，状态回到未建卡', async () => {
    const { api, calls } = fakeApi()
    api.createCard = async () => { calls.push({ op: 'createCard', args: [] }); throw new Error('rate limited') }
    const { reply, logs } = make(api)
    await reply.update('内容')
    await vi.advanceTimersByTimeAsync(500)
    await vi.advanceTimersByTimeAsync(5000)   // 退避窗口（300+600ms + 余量）
    await reply.finalize('error', '出错了')
    expect(calls.filter((c) => c.op === 'createCard').length).toBe(3)   // withRetry 默认 3 次
    expect(logs.length).toBeGreaterThan(0)
    // 失败后降级文本（无卡片 + detail）
    expect(calls.some((c) => c.op === 'sendText' && String(c.args[1]).includes('出错了'))).toBe(true)
  })

  test('无卡片输出的 error finalize 降级为文本通知', async () => {
    const { api, calls } = fakeApi()
    const { reply } = make(api)
    await reply.finalize('error', '模型服务不可用')
    expect(calls.some((c) => c.op === 'sendText' && String(c.args[1]).includes('模型服务不可用'))).toBe(true)
  })

  test('notice 走普通文本', async () => {
    const { api, calls } = fakeApi()
    const { reply } = make(api)
    await reply.notice('上一条还在处理中')
    expect(calls).toEqual([{ op: 'sendText', args: ['oc_1', '上一条还在处理中'] }])
  })
})

describe('makeAck', () => {
  test('加表情返回删除 disposer；删除失败静默', async () => {
    const { api, calls } = fakeApi()
    const ack = await makeAck(api, 'om_1', 'OneSecond')()
    expect(calls).toEqual([{ op: 'addReaction', args: ['om_1', 'OneSecond'] }])
    await ack?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls[1]).toEqual({ op: 'removeReaction', args: ['om_1', 'reaction_1'] })
  })

  test('加表情失败返回 undefined', async () => {
    const { api } = fakeApi()
    api.addReaction = async () => { throw new Error('forbidden') }
    expect(await makeAck(api, 'om_1', 'OneSecond')()).toBeUndefined()
  })
})

describe('withRetry', () => {
  test('成功后立即返回；耗尽后抛最后错误', async () => {
    let n = 0
    expect(await withRetry(async () => (++n === 2 ? 'ok' : Promise.reject<string>(new Error('x'))), 3, 1)).toBe('ok')
    await expect(withRetry(async () => { throw new Error('boom') }, 2, 1)).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（`reply.ts` / `api.ts` 不存在）

- [ ] **Step 3: 实现 api.ts 与 reply.ts**

`packages/project-bot/src/channels/feishu/api.ts`：

```ts
/** 飞书 OpenAPI 的结构化端口：reply/channel 只依赖本接口，SDK 类型不外泄。 */
import type * as lark from '@larksuiteoapi/node-sdk'

export interface FeishuApi {
  createCard(cardJson: string): Promise<string>
  sendCardMessage(chatId: string, cardId: string): Promise<void>
  updateCardElement(cardId: string, elementId: string, content: string, sequence: number): Promise<void>
  setCardStreaming(cardId: string, streaming: boolean, sequence: number): Promise<void>
  replaceCard(cardId: string, cardJson: string, sequence: number): Promise<void>
  sendText(chatId: string, text: string): Promise<void>
  addReaction(messageId: string, emojiType: string): Promise<string>
  removeReaction(messageId: string, reactionId: string): Promise<void>
}

/** SDK 薄封装：tenant_access_token 由 SDK 自动管理；错误带 code/msg 上下文。 */
export function createFeishuApi(client: lark.Client): FeishuApi {
  return {
    async createCard(cardJson) {
      const res = await client.cardkit.v1.card.create({ data: { type: 'card_json', data: cardJson } })
      const cardId = res.data?.card_id
      if (typeof cardId !== 'string' || cardId.length === 0) {
        throw new Error(`cardkit 建卡失败：code=${res.code} msg=${res.msg}`)
      }
      return cardId
    },
    async sendCardMessage(chatId, cardId) {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: cardId } }) },
      })
    },
    async updateCardElement(cardId, elementId, content, sequence) {
      await client.cardkit.v1.cardElement.content({ path: { card_id: cardId, element_id: elementId }, data: { content, sequence } })
    },
    async setCardStreaming(cardId, streaming, sequence) {
      await client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: { settings: JSON.stringify({ config: { streaming_mode: streaming } }), sequence },
      })
    },
    async replaceCard(cardId, cardJson, sequence) {
      await client.cardkit.v1.card.update({ path: { card_id: cardId }, data: { card: { type: 'card_json', data: cardJson }, sequence } })
    },
    async sendText(chatId, text) {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
      })
    },
    async addReaction(messageId, emojiType) {
      const res = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
      const reactionId = res.data?.reaction_id
      if (typeof reactionId !== 'string') throw new Error(`加表情失败：code=${res.code} msg=${res.msg}`)
      return reactionId
    },
    async removeReaction(messageId, reactionId) {
      await client.im.messageReaction.delete({ path: { message_id: messageId, reaction_id: reactionId } })
    },
  }
}
```

`packages/project-bot/src/channels/feishu/reply.ts`：

```ts
/** 出站句柄：turn 级流式卡片（节流合并 + 拆卡 + 定格着色）与表情回复。 */
import type { ChannelTunables, Disposer, ReplyHandle, TurnStatus } from '../../core/channel.ts'
import type { FeishuApi } from './api.ts'
import {
  CARD_ELEMENT_ID, initialStreamState, PENDING_CARD_ID,
  planFinalize, planSync, type CardOp, type StreamState,
} from './cards.ts'

/** 指数退避重试（默认 3 次，300ms 起）。 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 300): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** i))
    }
  }
  throw lastError
}

export class FeishuReplyHandle implements ReplyHandle {
  private state: StreamState = initialStreamState()
  private buffer = ''
  private tail: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private finalized = false

  constructor(
    private readonly api: FeishuApi,
    private readonly chatId: string,
    private readonly tunables: ChannelTunables,
    private readonly title: string,
    private readonly log: (message: string) => void,
  ) {}

  /** 惰性建卡：无文本输出的 turn 不产生空卡片。 */
  beginTurn(): Promise<void> {
    return Promise.resolve()
  }

  update(markdown: string): Promise<void> {
    if (this.finalized) return Promise.resolve()
    this.buffer = markdown
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, this.tunables.cardUpdateThrottleMs)
    }
    return Promise.resolve()
  }

  async finalize(status: TurnStatus, detail?: string): Promise<void> {
    if (this.finalized) {
      await this.tail
      return
    }
    this.finalized = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.flush()
    const content = this.buffer.slice(this.state.offset, this.state.shownLen)
    const { ops } = planFinalize(this.state, content, status, this.title)
    this.enqueue(() => this.exec(ops))
    if (this.state.cardId === null && detail !== undefined) {
      this.enqueue(() => withRetry(() => this.api.sendText(this.chatId, detail)).then(() => undefined))
    }
    await this.tail
  }

  notice(text: string): Promise<void> {
    this.enqueue(() => withRetry(() => this.api.sendText(this.chatId, text)).then(() => undefined))
    return this.tail.then(() => undefined)
  }

  private flush(): void {
    if (this.buffer.length <= this.state.shownLen) return
    const planned = planSync(this.state, this.buffer, this.tunables.cardMaxBytes, this.title)
    this.state = planned.state
    this.enqueue(() => this.exec(planned.ops))
  }

  private enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((error) => {
      // 建卡链路失败：回到未建卡状态，让下一次 flush 重新创建。
      if (this.state.cardId === PENDING_CARD_ID) this.state = { ...this.state, cardId: null }
      this.log(`[project-bot] 卡片操作失败：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  private async exec(ops: readonly CardOp[]): Promise<void> {
    for (const op of ops) {
      if (op.type === 'create') {
        this.state.cardId = await withRetry(() => this.api.createCard(op.cardJson))
      } else if (op.type === 'send') {
        await withRetry(() => this.api.sendCardMessage(this.chatId, this.state.cardId!))
      } else if (op.type === 'update') {
        await withRetry(() => this.api.updateCardElement(this.state.cardId!, CARD_ELEMENT_ID, op.content, op.sequence))
      } else if (op.type === 'settings') {
        await withRetry(() => this.api.setCardStreaming(this.state.cardId!, op.streaming, op.sequence))
      } else {
        await withRetry(() => this.api.replaceCard(this.state.cardId!, op.cardJson, op.sequence))
      }
    }
  }
}

/** 「处理中」表情：加上后返回删除 disposer；加/删失败都静默（表情残留无害）。 */
export function makeAck(api: FeishuApi, messageId: string, emojiType: string): () => Promise<Disposer | undefined> {
  return async () => {
    try {
      const reactionId = await api.addReaction(messageId, emojiType)
      return () => {
        void api.removeReaction(messageId, reactionId).catch(() => undefined)
      }
    } catch {
      return undefined
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS（若节流/假定时器时序有偏差，微调测试推进量，不改实现语义）

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/channels/feishu/api.ts packages/project-bot/src/channels/feishu/reply.ts packages/project-bot/tests/feishu-reply.test.ts
git commit -m "feat(project-bot): 飞书出站——FeishuApi 端口、节流卡片流与表情回复"
```

---

### Task 11: 飞书渠道入口（WS 长连接）

**Files:**
- Create: `packages/project-bot/src/channels/feishu/index.ts`

**Interfaces:**
- Consumes: Task 3（`BotChannel` / `ChannelHandle`）、Task 9（`parseMessageEvent` / `MessageDedup`）、Task 10（`createFeishuApi` / `FeishuReplyHandle` / `makeAck`）。
- Produces: `feishuChannel: BotChannel`（Task 14 消费）。

本任务是 SDK 交互薄壳，无单测；由 typecheck 与 Task 17 真机验证兜底。

- [ ] **Step 1: 实现 index.ts**

`packages/project-bot/src/channels/feishu/index.ts`：

```ts
/** 飞书渠道：WSClient 长连接收事件 → 解析 → 核心；出站走 FeishuReplyHandle。 */
import * as lark from '@larksuiteoapi/node-sdk'
import type { BotChannel, ChannelHandle } from '../../core/channel.ts'
import { createFeishuApi } from './api.ts'
import { MessageDedup, parseMessageEvent } from './parse.ts'
import { FeishuReplyHandle, makeAck } from './reply.ts'

export const feishuChannel: BotChannel = {
  type: 'feishu',

  async start(bot, io, tunables, log): Promise<ChannelHandle> {
    const { appId } = bot.record.feishu
    const client = new lark.Client({ appId, appSecret: bot.secret })
    const api = createFeishuApi(client)
    const dedup = new MessageDedup()

    const dispatcher = new lark.EventDispatcher({}).register({
      // WS 事件须 3 秒内返回：解析同步完成，业务投递 fire-and-forget。
      'im.message.receive_v1': async (data: unknown) => {
        const parsed = parseMessageEvent(data)
        if (parsed === null || !dedup.check(parsed.messageId)) return
        const reply = new FeishuReplyHandle(api, parsed.chatId, tunables, bot.record.name, log)
        io.onMessage({
          botId: bot.record.id,
          chatId: parsed.chatId,
          userId: parsed.userId,
          messageId: parsed.messageId,
          text: parsed.text,
          reply,
          ackProcessing: makeAck(api, parsed.messageId, tunables.processingReactionEmoji),
        })
      },
    })

    const ws = new lark.WSClient({ appId, appSecret: bot.secret, loggerLevel: lark.LoggerLevel.warn })
    await ws.start({ eventDispatcher: dispatcher })

    return {
      close: () => {
        ws.close({ force: true })
        return Promise.resolve()
      },
      status: () => ws.getConnectionStatus().state,
    }
  },
}
```

注意：SDK 生成类型与上面调用若有出入（如 `EventDispatcher.register` 参数类型、`getConnectionStatus().state` 联合类型与 `ChannelStatus` 的字面对齐），以 SDK d.ts 为准微调本文件，**不得**改 `BotChannel` 接口迁就 SDK。

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot typecheck; pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: 双双 PASS

- [ ] **Step 3: Commit**

```bash
git add packages/project-bot/src/channels/feishu/index.ts
git commit -m "feat(project-bot): 飞书渠道入口——WS 长连接与事件分发"
```

---

### Task 12: 扫码创建应用（registerApp 流程）

**Files:**
- Create: `packages/project-bot/src/register-app.ts`
- Test: `packages/project-bot/tests/register-app.test.ts`

**Interfaces:**
- Produces（Task 13/14 消费）：`RegisterAppFn` / `RegisterState` / `RegisterAppService`（`start(): string`、`get(id): RegisterState | undefined`、`dispose()`）。

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/register-app.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest'
import { RegisterAppService, type RegisterAppFn } from '../src/register-app.ts'

function harness(registerApp: RegisterAppFn, timeoutMs = 60_000) {
  const stored: { appId: string; secret: string }[] = []
  let n = 0
  const svc = new RegisterAppService({
    registerApp,
    storeSecret: async (appId, secret) => {
      stored.push({ appId, secret })
      return `project_bot_${appId.slice(4, 12)}`
    },
    timeoutMs,
    newId: () => `reg_${++n}`,
  })
  return { svc, stored }
}

describe('RegisterAppService', () => {
  test('完整流程：pending(带 url) → done(凭证已入库)', async () => {
    const registerApp: RegisterAppFn = async (options) => {
      options.onQRCodeReady({ url: 'https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH', expireIn: 600 })
      return { client_id: 'cli_a1b2c3d4e5f60718', client_secret: 's3cret' }
    }
    const { svc, stored } = harness(registerApp)
    const id = svc.start()
    await vi.waitFor(() => { expect(svc.get(id)).toMatchObject({ status: 'pending', url: 'https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH' }) })
    await vi.waitFor(() => { expect(svc.get(id)?.status).toBe('done') })
    expect(svc.get(id)).toMatchObject({ status: 'done', appId: 'cli_a1b2c3d4e5f60718', credentialRef: 'project_bot_a1b2c3d4' })
    expect(stored).toEqual([{ appId: 'cli_a1b2c3d4e5f60718', secret: 's3cret' }])
    svc.dispose()
  })

  test('用户拒绝 → error（code 透传）', async () => {
    const registerApp: RegisterAppFn = async () => {
      throw Object.assign(new Error('denied'), { code: 'access_denied' })
    }
    const { svc } = harness(registerApp)
    const id = svc.start()
    await vi.waitFor(() => { expect(svc.get(id)).toMatchObject({ status: 'error', code: 'access_denied' }) })
    svc.dispose()
  })

  test('超时自动 abort → error', async () => {
    const registerApp: RegisterAppFn = (options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'abort' })))
    })
    const { svc } = harness(registerApp, 50)
    const id = svc.start()
    await vi.waitFor(() => { expect(svc.get(id)).toMatchObject({ status: 'error', code: 'abort' }) }, { timeout: 2000 })
    svc.dispose()
  })

  test('dispose 中断进行中的轮询', async () => {
    let aborted = false
    const registerApp: RegisterAppFn = (options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('x'), { code: 'abort' })) })
    })
    const { svc } = harness(registerApp)
    svc.start()
    svc.dispose()
    await vi.waitFor(() => { expect(aborted).toBe(true) })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（`../src/register-app.ts` 不存在）

- [ ] **Step 3: 实现 register-app.ts**

`packages/project-bot/src/register-app.ts`：

```ts
/** 扫码一键创建飞书应用：lark.registerApp（OAuth 2.0 Device Authorization Grant）的状态机封装。 */
import { randomUUID } from 'node:crypto'

export interface QRInfo {
  url: string
  expireIn: number
}

/** lark.registerApp 的结构化签名（便于 fake 注入）。 */
export type RegisterAppFn = (options: {
  createOnly: true
  signal: AbortSignal
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
      createOnly: true,
      signal: controller.signal,
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/register-app.ts packages/project-bot/tests/register-app.test.ts
git commit -m "feat(project-bot): 扫码创建飞书应用——registerApp 状态机"
```

---

### Task 13: HTTP API 路由

**Files:**
- Create: `packages/project-bot/src/api.ts`
- Test: `packages/project-bot/tests/api.test.ts`

**Interfaces:**
- Consumes: `BotRuntime`（Task 7）、`RegisterAppService`（Task 12）、`BotRecordSchema` / `BOT_ID_RE` / `FEISHU_APP_ID_RE`（Task 2）、KvTable。
- Produces（Task 14 消费）：`ApiDeps` / `createApiHandler(deps): (req: IncomingMessage, res: ServerResponse) => Promise<void>`；路由清单（挂在前缀 `/project-bot/api` 下）：
  - `GET /bots` / `POST /bots` / `PUT /bots?id=` / `DELETE /bots?id=`
  - `POST /register-app` / `GET /register-app/status?id=`
  - `GET /tools`

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/api.test.ts`：

```ts
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'
import { createApiHandler, type ApiDeps } from '../src/api.ts'
import { RegisterAppService } from '../src/register-app.ts'
import type { BotRecord } from '../src/store.ts'

const BOT: BotRecord = {
  id: 'reviewer', name: '评审', channel: 'feishu',
  feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
  project: 'D:\\work\\demo', createdAt: 1, updatedAt: 1,
}

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  req.method = method
  req.url = url
  req.headers = {}
  return req
}

type MockRes = ServerResponse & { status: number; body: string }

function mockRes(): MockRes {
  const res = { status: 0, body: '' } as MockRes
  res.writeHead = ((code: number) => { res.status = code; return res }) as unknown as MockRes['writeHead']
  res.end = ((chunk?: unknown) => { if (typeof chunk === 'string') res.body = chunk; return res }) as unknown as MockRes['end']
  return res
}

function harness() {
  const bots = new Map<string, BotRecord>([['reviewer', BOT]])
  const reconciled: string[] = []
  const stopped: string[] = []
  const deletedSecrets: string[] = []
  const storedSecrets: { key: string; secret: string }[] = []
  const registerApp = new RegisterAppService({
    registerApp: async (options) => {
      options.onQRCodeReady({ url: 'https://example/qr', expireIn: 600 })
      return { client_id: 'cli_ffffffffffffffff', client_secret: 'sec' }
    },
    storeSecret: async () => 'project_bot_ffffffff',
    timeoutMs: 60_000,
  })
  const deps: ApiDeps = {
    bots: {
      get: (k: string) => bots.get(k),
      put: async (k: string, v: BotRecord) => { bots.set(k, v) },
      delete: async (k: string) => bots.delete(k),
      entries: () => bots.entries(),
      keys: () => bots.keys(),
    } as unknown as ApiDeps['bots'],
    runtime: {
      reconcile: async (id: string) => { reconciled.push(id) },
      stopBot: async (id: string) => { stopped.push(id) },
      statusOf: () => 'connected',
    } as unknown as ApiDeps['runtime'],
    registerApp,
    listTools: () => ['bash', 'fs_read', 'fs_write'],
    storeSecret: async (key, secret) => { storedSecrets.push({ key, secret }); return `project_bot_${key}` },
    deleteSecret: async (ref) => { deletedSecrets.push(ref) },
    validateProject: () => true,
    now: () => 1000,
  }
  return { deps, bots, reconciled, stopped, deletedSecrets, storedSecrets, handler: createApiHandler(deps), registerApp }
}

describe('GET /bots', () => {
  test('返回列表与运行状态（不含明文密钥）', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('GET', '/project-bot/api/bots'), res)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.bots).toHaveLength(1)
    expect(body.bots[0]).toMatchObject({ id: 'reviewer', status: 'connected' })
    expect(res.body).not.toContain('secret')
  })
})

describe('POST /bots', () => {
  test('合法创建：密钥入库、记录落表、reconcile', async () => {
    const { handler, bots, reconciled, storedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('POST', '/project-bot/api/bots', {
      id: 'ops', name: '运维', project: 'D:\\work\\ops',
      feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' },
    }), res)
    expect(res.status).toBe(200)
    expect(bots.get('ops')).toMatchObject({ feishu: { appSecretRef: 'project_bot_ops' } })
    expect(storedSecrets).toEqual([{ key: 'ops', secret: 'plain-secret' }])
    expect(reconciled).toEqual(['ops'])
  })

  test('扫码路径：直接携带 appSecretRef，不再入库', async () => {
    const { handler, bots, storedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('POST', '/project-bot/api/bots', {
      id: 'scan-bot', name: '扫码', project: 'D:\\work\\ops',
      feishu: { appId: 'cli_ffffffffffffffff', appSecretRef: 'project_bot_ffffffff' },
    }), res)
    expect(res.status).toBe(200)
    expect(bots.get('scan-bot')).toMatchObject({ feishu: { appSecretRef: 'project_bot_ffffffff' } })
    expect(storedSecrets).toEqual([])
  })

  test('非法 appId → 400；重复 appId → 409；重复 id → 409', async () => {
    const { handler } = harness()
    const bad = mockRes()
    await handler(mockReq('POST', '/project-bot/api/bots', { id: 'ops', name: 'x', project: 'p', feishu: { appId: 'bad', appSecret: 's' } }), bad)
    expect(bad.status).toBe(400)

    const dup = mockRes()
    await handler(mockReq('POST', '/project-bot/api/bots', { id: 'ops', name: 'x', project: 'p', feishu: { appId: BOT.feishu.appId, appSecret: 's' } }), dup)
    expect(dup.status).toBe(409)

    const dupId = mockRes()
    await handler(mockReq('POST', '/project-bot/api/bots', { id: 'reviewer', name: 'x', project: 'p', feishu: { appId: 'cli_000000000000000c', appSecret: 's' } }), dupId)
    expect(dupId.status).toBe(409)
  })
})

describe('PUT /bots', () => {
  test('更新 persona/工具并 reconcile；密钥引用不变', async () => {
    const { handler, bots, reconciled } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/project-bot/api/bots?id=reviewer', { persona: '新人设', tools: ['bash'] }), res)
    expect(res.status).toBe(200)
    expect(bots.get('reviewer')).toMatchObject({ persona: '新人设', tools: ['bash'], feishu: { appSecretRef: 'project_bot_reviewer' } })
    expect(reconciled).toEqual(['reviewer'])
  })

  test('不存在 → 404', async () => {
    const { handler } = harness()
    const res = mockRes()
    await handler(mockReq('PUT', '/project-bot/api/bots?id=ghost', { name: 'x' }), res)
    expect(res.status).toBe(404)
  })
})

describe('DELETE /bots', () => {
  test('stopBot → 删记录 → 删密钥', async () => {
    const { handler, bots, stopped, deletedSecrets } = harness()
    const res = mockRes()
    await handler(mockReq('DELETE', '/project-bot/api/bots?id=reviewer'), res)
    expect(res.status).toBe(200)
    expect(stopped).toEqual(['reviewer'])
    expect(bots.has('reviewer')).toBe(false)
    expect(deletedSecrets).toEqual(['project_bot_reviewer'])
  })
})

describe('register-app 流程', () => {
  test('start 返回 id；status 轮询到 done', async () => {
    const { handler } = harness()
    const startRes = mockRes()
    await handler(mockReq('POST', '/project-bot/api/register-app'), startRes)
    expect(startRes.status).toBe(200)
    const { id } = JSON.parse(startRes.body) as { id: string }
    await vi.waitFor(async () => {
      const statusRes = mockRes()
      await handler(mockReq('GET', `/project-bot/api/register-app/status?id=${id}`), statusRes)
      expect((JSON.parse(statusRes.body) as { state: { status: string } }).state.status).toBe('done')
    })
    const finalRes = mockRes()
    await handler(mockReq('GET', `/project-bot/api/register-app/status?id=${id}`), finalRes)
    expect(JSON.parse(finalRes.body)).toMatchObject({ state: { status: 'done', appId: 'cli_ffffffffffffffff', credentialRef: 'project_bot_ffffffff' } })
  })
})

test('GET /tools 返回已注册工具名', async () => {
  const { handler } = harness()
  const res = mockRes()
  await handler(mockReq('GET', '/project-bot/api/tools'), res)
  expect(JSON.parse(res.body)).toEqual({ tools: ['bash', 'fs_read', 'fs_write'] })
})

test('未知路径 404；已知路径错误方法 405', async () => {
  const { handler } = harness()
  const res404 = mockRes()
  await handler(mockReq('GET', '/project-bot/api/nope'), res404)
  expect(res404.status).toBe(404)
  const res405 = mockRes()
  await handler(mockReq('PATCH', '/project-bot/api/bots'), res405)
  expect(res405.status).toBe(405)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（`../src/api.ts` 不存在）

- [ ] **Step 3: 实现 api.ts**

`packages/project-bot/src/api.ts`：

```ts
/** 浏览器半 RPC：单前缀路由 /project-bot/api + 内部路径分发。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { BotRuntime } from './core/runtime.ts'
import type { RegisterAppService } from './register-app.ts'
import { BOT_ID_RE, BotRecordSchema, FEISHU_APP_ID_RE, type BotRecord } from './store.ts'

export interface ApiDeps {
  bots: KvTable<string, BotRecord>
  runtime: BotRuntime
  registerApp: RegisterAppService
  listTools(): string[]
  /** 密钥入 credentials，返回 CredentialRef 字符串。 */
  storeSecret(key: string, secret: string): Promise<string>
  deleteSecret(ref: string): Promise<void>
  validateProject(path: string): boolean
  now(): number
}

const MAX_BODY_BYTES = 64 * 1024

const CreateBodySchema = z.object({
  id: z.string().regex(BOT_ID_RE),
  name: z.string().min(1).max(64),
  project: z.string().min(1),
  persona: z.string().max(8000).optional(),
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
  tools: z.array(z.string().min(1)).min(1).nullable().optional(),
  agentOptions: z.object({ provider: z.string().min(1).optional(), model: z.string().min(1).optional() }).nullable().optional(),
  /** 换绑应用：明文新密钥（立即入 credentials）。 */
  feishu: z.object({ appId: z.string().regex(FEISHU_APP_ID_RE), appSecret: z.string().min(1) }).optional(),
})

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
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
    const sub = url.pathname.replace(/^\/project-bot\/api/, '') || '/'
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
      if (deps.bots.get(input.id) !== undefined) {
        json(res, 409, { error: `bot id "${input.id}" 已存在` })
        return
      }
      for (const [, existing] of deps.bots.entries()) {
        if (existing.feishu.appId === input.feishu.appId) {
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
        appSecretRef = await deps.storeSecret(input.id, input.feishu.appSecret)
      }
      const record = BotRecordSchema.parse({
        id: input.id, name: input.name, channel: 'feishu',
        feishu: { appId: input.feishu.appId, appSecretRef },
        project: input.project,
        ...(input.persona !== undefined ? { persona: input.persona } : {}),
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
      let feishu = existing.feishu
      if (input.feishu !== undefined) {
        feishu = { appId: input.feishu.appId, appSecretRef: await deps.storeSecret(id, input.feishu.appSecret) }
      }
      const project = input.project ?? existing.project
      if (!deps.validateProject(project)) {
        json(res, 400, { error: `项目路径不可用：${project}` })
        return
      }
      const merged: Record<string, unknown> = {
        ...existing,
        ...(input.name !== undefined ? { name: input.name } : {}),
        project,
        feishu,
        updatedAt: deps.now(),
      }
      const persona = input.persona === null ? undefined : input.persona ?? existing.persona
      const tools = input.tools === null ? undefined : input.tools ?? existing.tools
      const agentOptions = input.agentOptions === null ? undefined : input.agentOptions ?? existing.agentOptions
      if (persona !== undefined) merged.persona = persona
      if (tools !== undefined) merged.tools = tools
      if (agentOptions !== undefined) merged.agentOptions = agentOptions
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
      await deps.deleteSecret(existing.feishu.appSecretRef)
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

    if (['/bots', '/register-app', '/register-app/status', '/tools'].includes(sub)) {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    json(res, 404, { error: 'not found' })
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/api.ts packages/project-bot/tests/api.test.ts
git commit -m "feat(project-bot): HTTP API——bots CRUD、扫码状态轮询与工具清单路由"
```

---

### Task 14: 插件组装（index.ts 完整实现）

**Files:**
- Modify: `packages/project-bot/src/index.ts`（整体替换 Task 1 的临时实现）

**Interfaces:**
- Consumes: 全部前序产物 + 宿主服务 `ctx.agents` / `ctx.credentials` / `ctx.storageDomain` / `ctx.tools` / `ctx.webServer`（可选，走 `ctx.inject` 子 fiber）。
- Produces: 可加载的完整插件；`name`/`inject`/`Config` 签名不变（smoke 测试保持绿）。

- [ ] **Step 1: 替换 index.ts 为完整组装**

`packages/project-bot/src/index.ts`：

```ts
/** project-bot 插件：项目机器人（飞书渠道）——多 bot 作为项目 agent 的交互入口。 */
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
// type-only 导入激活各包对 cordis Context 的声明合并（inject 的服务属性）。
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createApiHandler } from './api.ts'
import { feishuChannel } from './channels/feishu/index.ts'
import type { BotChannel, ChannelTunables } from './core/channel.ts'
import type { AgentHooks, AgentPort, AgentsPort } from './core/ports.ts'
import { BotRuntime } from './core/runtime.ts'
import { RegisterAppService } from './register-app.ts'
import { projectBotDomain, type Binding, type BotRecord } from './store.ts'

export interface Config {
  /** 卡片流式更新节流间隔（毫秒）。 */
  cardUpdateThrottleMs: number
  /** 单张卡片内容字节上限（飞书硬上限 30KB，留余量）。 */
  cardMaxBytes: number
  /** 扫码创建应用的轮询超时（毫秒）。 */
  registerAppTimeoutMs: number
  /** 「处理中」表情回复的 emoji_type。 */
  processingReactionEmoji: string
}

export const Config: z<Config> = z.object({
  cardUpdateThrottleMs: z.number().default(500),
  cardMaxBytes: z.number().default(28_000),
  registerAppTimeoutMs: z.number().default(600_000),
  processingReactionEmoji: z.string().default('OneSecond'),
})

export const name = 'project-bot'

export const inject = ['agents', 'credentials', 'storageDomain', 'tools']

export function apply(ctx: Context, config: Config): void {
  const log = { warn: (m: string) => ctx.logger.warn(m), info: (m: string) => ctx.logger.info(m) }
  const channels: ReadonlyMap<string, BotChannel> = new Map([['feishu', feishuChannel]])
  const tunables: ChannelTunables = {
    cardUpdateThrottleMs: config.cardUpdateThrottleMs,
    cardMaxBytes: config.cardMaxBytes,
    processingReactionEmoji: config.processingReactionEmoji,
  }

  const storeSecret = async (key: string, secret: string): Promise<string> => {
    const ref = `project_bot_${key.replace(/[^A-Za-z0-9_]/g, '_')}`
    await ctx.credentials.set(credentialRef(ref), secret)
    return ref
  }

  /** 创作期注入：persona 提示段（order 0 惯例）+ 工具白名单（未命中已注册名时 restrict 响亮失败）。 */
  const applyHooks = (agentCtx: Context, hooks: AgentHooks): void => {
    if (hooks.persona !== undefined) {
      agentCtx.systemPrompt.section({ name: 'project-bot:persona', order: 0, text: hooks.persona })
    }
    if (hooks.tools !== undefined) {
      agentCtx.tools.restrict({ allow: hooks.tools })
    }
  }

  const agentsPort: AgentsPort = {
    async create(input) {
      const handle: AgentHandle = await ctx.agents.create({
        sessionId: SessionId(input.sessionId),
        meta: { cwd: input.cwd },
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        setup: (agentCtx) => applyHooks(agentCtx, input.hooks),
      })
      return adaptAgent(handle)
    },
    async resume(input) {
      const handle: AgentHandle = await ctx.agents.resume({
        resumeSessionId: SessionId(input.sessionId),
        ...(input.agentOptions !== undefined ? { agentOptions: input.agentOptions } : {}),
        setup: (agentCtx) => applyHooks(agentCtx, input.hooks),
      })
      return adaptAgent(handle)
    },
  }

  function adaptAgent(handle: AgentHandle): AgentPort {
    const { agent } = handle
    return {
      sessionId: String(agent.id),
      followup: (message) => agent.followup(message as Parameters<typeof agent.followup>[0]),
      cancel: () => agent.cancel({ kind: 'user' }),
      whenIdle: () => agent.whenIdle(),
    }
  }

  // 存储域：open 失败挂 rejection handler 防次生崩溃，调用方仍感知失败（token-usage 同款）。
  let botsTable: import('@deepseek-ai/dsh-storage-domain').KvTable<string, BotRecord> | undefined
  let bindingsTable: import('@deepseek-ai/dsh-storage-domain').KvTable<string, Binding> | undefined
  const domainReady = ctx.storageDomain.open(projectBotDomain).then((domain) => {
    botsTable = domain.table('bots')
    bindingsTable = domain.table('bindings')
    return domain
  })
  domainReady.catch((error) => {
    log.warn(`[project-bot] 存储域打开失败，插件不可用：${error instanceof Error ? error.message : String(error)}`)
  })

  let runtime: BotRuntime | undefined
  const registerAppService = new RegisterAppService({
    registerApp: (options) => import('@larksuiteoapi/node-sdk').then((lark) => lark.registerApp(options)),
    storeSecret,
    timeoutMs: config.registerAppTimeoutMs,
  })

  const started = domainReady.then(() => {
    runtime = new BotRuntime({
      bots: botsTable!,
      bindings: bindingsTable!,
      agents: agentsPort,
      channels,
      tunables,
      resolveSecret: async (ref) => (await ctx.credentials.resolve(credentialRef(ref)))?.value,
      validateProject: (path) => existsSync(path),
      log,
    })
    return runtime.startAll()
  })
  started.catch((error) => {
    log.warn(`[project-bot] 启动失败：${error instanceof Error ? error.message : String(error)}`)
  })

  // 出站：持久会话事件 → runtime.outbound（session id 匹配自有 runtime，其余忽略）。
  ctx.on('session/event', (session, event) => {
    runtime?.outbound.handleSessionEvent(String(session.header.id), event as { type: string; data: Record<string, unknown> })
  })

  // webServer 是可选能力（headless 无此服务）：ctx.inject 子 fiber + effect 接线 disposer（token-usage 同款）。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/project-bot/api',
      handler: async (req, res) => {
        try {
          await started
          if (runtime === undefined) throw new Error('runtime unavailable')
          await createApiHandler({
            bots: botsTable!,
            runtime,
            registerApp: registerAppService,
            listTools: () => ctx.tools.schemas().map((s) => s.name),
            storeSecret,
            deleteSecret: async (ref) => ctx.credentials.unset(credentialRef(ref)),
            validateProject: (path) => existsSync(path),
            now: () => Date.now(),
          })(req, res)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      },
    }), 'project-bot: /project-bot/api route')
  })

  // 卸载：取消在飞会话 → 定格卡片 → 断渠道 → 中断扫码轮询 → 关存储域。
  ctx.effect(() => async () => {
    registerAppService.dispose()
    if (runtime !== undefined) await runtime.stopAll()
    await started.catch(() => undefined)
    await domainReady.then((domain) => domain.close()).catch(() => undefined)
  })
}
```

实现注意（typecheck 出错时按真实 d.ts 微调，禁止改 core/channels 的已冻结接口）：

- `ctx.tools.schemas()` 返回 `ToolSchema[]`，取 `.name`；若 `schemas()` 需参数或无此签名，改用它提供的等价"全局工具名列表"API（`deepseek-harness/packages/core/tools/src/index.ts` 公共方法区）。
- `session.header.id` 为 SessionId brand，`String(...)` 转字符串与 Router 的 `randomUUID()` 对齐。
- `ctx.logger` 若无 `warn/info` 同形方法，按实际 logger 接口适配。

- [ ] **Step 2: 类型检查 + 全量测试 + bundle**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot typecheck; pnpm --filter @dsh-agent-toolkit/project-bot test; pnpm --filter @dsh-agent-toolkit/project-bot bundle`
Expected: 三者全 PASS；`lib/index.js` + `lib/index.d.ts` 产出

- [ ] **Step 3: Commit**

```bash
git add packages/project-bot/src/index.ts
git commit -m "feat(project-bot): 插件组装——agents 适配、session/event 接线、API 路由与卸载时序"
```

---

### Task 15: 浏览器半——入口按钮与机器人列表

**Files:**
- Create: `packages/project-bot/src/client/api.ts`
- Create: `packages/project-bot/src/client/index.ts`
- Create: `packages/project-bot/src/client/BotsEntry.tsx`
- Create: `packages/project-bot/src/client/BotsModal.tsx`
- Create: `packages/project-bot/src/client/bots.module.css`
- Test: `packages/project-bot/tests/bots-entry.client.spec.tsx`
- Test: `packages/project-bot/tests/bots-modal.client.spec.tsx`

**Interfaces:**
- Consumes: slot `sidebar.footer.action`（owner prop `wide` + 框架注入的 `useWorkspaces` prop）；`Modal`（`@deepseek-ai/dsh-client-ui-primitives`）；Task 13 的 HTTP 路由。
- Produces（Task 16 消费）：
  - `client/api.ts`：`BotListItem = BotRecord & { status: string }`、`BotInput`、`fetchBots()` / `fetchTools()` / `createBot(input)` / `updateBot(id, input)` / `deleteBot(id)` / `startRegisterApp()` / `pollRegisterApp(id)`（`RegisterState` 从 `../register-app.ts` **import type**）
  - `BotsModal` 的视图状态机：`view: 'list' | { mode: 'create' } | { mode: 'edit'; bot: BotListItem }`，列表页点机器人/新建按钮切换视图（表单由 Task 16 填入 `BotForm`）
  - `BotsEntry`：`{ wide, useWorkspaces }` props

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/bots-entry.client.spec.tsx`：

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BotsEntry } from '../src/client/BotsEntry.tsx'

const BOTS = {
  bots: [{
    id: 'reviewer', name: '评审机器人', channel: 'feishu',
    feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
    project: 'D:\\work\\demo', status: 'connected', createdAt: 1, updatedAt: 1,
  }],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.startsWith('/project-bot/api/bots') ? BOTS : { tools: ['bash'] }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const useWorkspaces = <S,>(selector: (s: { items: unknown[] }) => S): S => selector({ items: [] })

test('宽栏：图标 + 文字标签；窄栏：仅图标', () => {
  const { unmount } = render(<BotsEntry wide useWorkspaces={useWorkspaces} />)
  expect(screen.getByRole('button', { name: '消息机器人' }).textContent).toContain('消息机器人')
  unmount()
  render(<BotsEntry wide={false} useWorkspaces={useWorkspaces} />)
  expect(screen.getByRole('button', { name: '消息机器人' }).textContent).not.toContain('消息机器人')
})

test('点击打开机器人列表模态框并拉取列表', async () => {
  render(<BotsEntry wide useWorkspaces={useWorkspaces} />)
  screen.getByRole('button', { name: '消息机器人' }).click()
  expect(await screen.findByText('评审机器人')).toBeTruthy()
  expect(vi.mocked(fetch)).toHaveBeenCalledWith('/project-bot/api/bots')
})
```

`packages/project-bot/tests/bots-modal.client.spec.tsx`：

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { BotsModal } from '../src/client/BotsModal.tsx'

const BOTS = {
  bots: [
    {
      id: 'reviewer', name: '评审机器人', channel: 'feishu',
      feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'r1' },
      project: 'D:\\work\\demo', status: 'connected', createdAt: 1, updatedAt: 1,
    },
    {
      id: 'ops', name: '运维机器人', channel: 'feishu',
      feishu: { appId: 'cli_000000000000000a', appSecretRef: 'r2' },
      project: 'D:\\work\\demo', status: 'failed', createdAt: 1, updatedAt: 1,
    },
    {
      id: 'docs', name: '文档机器人', channel: 'feishu',
      feishu: { appId: 'cli_000000000000000b', appSecretRef: 'r3' },
      project: 'D:\\work\\other', status: 'not-running', createdAt: 1, updatedAt: 1,
    },
  ],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(BOTS), { status: 200, headers: { 'content-type': 'application/json' } })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const useWorkspaces = <S,>(selector: (s: { items: unknown[] }) => S): S => selector({ items: [] })

test('列表按项目分组，显示渠道标记与运行状态', async () => {
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces} onEdit={() => undefined} />)
  expect(await screen.findByText('评审机器人')).toBeTruthy()
  expect(screen.getByText('运维机器人')).toBeTruthy()
  expect(screen.getByText('文档机器人')).toBeTruthy()
  // 分组标题：两个项目
  expect(screen.getByText('D:\\work\\demo')).toBeTruthy()
  expect(screen.getByText('D:\\work\\other')).toBeTruthy()
  // 渠道标记
  expect(screen.getAllByText('飞书').length).toBe(3)
  // 状态
  expect(screen.getByText('已连接')).toBeTruthy()
  expect(screen.getByText('连接失败')).toBeTruthy()
  expect(screen.getByText('未运行')).toBeTruthy()
})

test('点击机器人行触发 onEdit；新建按钮触发 onCreate', async () => {
  const edits: string[] = []
  let created = 0
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces}
    onEdit={(bot) => { edits.push(bot.id) }} onCreate={() => { created += 1 }} />)
  ;(await screen.findByText('评审机器人')).click()
  expect(edits).toEqual(['reviewer'])
  screen.getByRole('button', { name: '新建机器人' }).click()
  expect(created).toBe(1)
})

test('加载失败显示错误态', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })))
  render(<BotsModal open onClose={() => undefined} useWorkspaces={useWorkspaces} />)
  expect(await screen.findByText('加载失败，请重试')).toBeTruthy()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（client 文件不存在）

- [ ] **Step 3: 实现 client 文件**

`packages/project-bot/src/client/api.ts`：

```ts
/** 浏览器半 RPC 封装（fetch → Node 半 webServer 路由）。类型全部 import type，不进 bundle。 */
import type { RegisterState } from '../register-app.ts'
import type { BotRecord } from '../store.ts'

export type BotListItem = BotRecord & { status: string }

export interface BotInput {
  id?: string
  name: string
  project: string
  persona?: string
  tools?: string[]
  agentOptions?: { provider?: string; model?: string }
  feishu?: { appId: string; appSecret?: string; appSecretRef?: string }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init === undefined ? undefined : {
    ...init,
    headers: { 'content-type': 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const fetchBots = () => request<{ bots: BotListItem[] }>('/project-bot/api/bots').then((r) => r.bots)

export const fetchTools = () => request<{ tools: string[] }>('/project-bot/api/tools').then((r) => r.tools)

export function createBot(input: BotInput): Promise<unknown> {
  return request('/project-bot/api/bots', { method: 'POST', body: JSON.stringify(input) })
}

export function updateBot(id: string, input: Partial<BotInput>): Promise<unknown> {
  return request(`/project-bot/api/bots?id=${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) })
}

export function deleteBot(id: string): Promise<unknown> {
  return request(`/project-bot/api/bots?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export const startRegisterApp = () => request<{ id: string }>('/project-bot/api/register-app', { method: 'POST' })

export const pollRegisterApp = (id: string) =>
  request<{ state: RegisterState }>(`/project-bot/api/register-app/status?id=${encodeURIComponent(id)}`).then((r) => r.state)
```

`packages/project-bot/src/client/index.ts`：

```tsx
/** project-bot 浏览器半：注册侧边栏底栏「消息机器人」入口。 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// 触发 ui-sidebar 对 SlotMap 的声明合并（sidebar.footer.action 键）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BotsEntry } from './BotsEntry.tsx'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'project-bot', order: 1 },
      BotsEntry,
    ))
}
```

`packages/project-bot/src/client/BotsEntry.tsx`：

```tsx
/** 侧边栏底栏入口：宽栏图标+文字 / 窄栏仅图标；点击开机器人管理模态框。 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { IconAgentPresetOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { BotsModal, type BotsModalProps } from './BotsModal.tsx'
import css from './bots.module.css'

export interface BotsEntryProps {
  /** slot owner share：宽栏内容 vs 56px 窄栏。 */
  wide: boolean
  /** 框架注入的 workspace 列表 hook（PropsRuntime 派生）。 */
  useWorkspaces: BotsModalProps['useWorkspaces']
}

export function BotsEntry({ wide, useWorkspaces }: BotsEntryProps): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip label="消息机器人" delayMs={500} disabled={wide}>
        <button
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-label="消息机器人"
          onClick={() => { setOpen(true) }}
        >
          <IconAgentPresetOutline16 size={wide ? 16 : 18} />
          {wide && <span className={css.triggerLabel}>消息机器人</span>}
        </button>
      </Tooltip>
      <BotsModal open={open} onClose={() => { setOpen(false) }} useWorkspaces={useWorkspaces} />
    </>
  )
}
```

`packages/project-bot/src/client/BotsModal.tsx`：

```tsx
/** 机器人管理模态框：列表视图（按项目分组）+ 创建/编辑表单视图。 */
import { useEffect, useState, type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchBots, type BotListItem } from './api.ts'
import { BotForm } from './BotForm.tsx'
import css from './bots.module.css'

/** useWorkspaces 的窄化类型（框架注入；selector 读 WorkspaceListState）。 */
export type UseWorkspaces = <S>(selector: (state: { items: readonly { path: string; title: string }[] }) => S) => S

export interface BotsModalProps {
  open: boolean
  onClose: () => void
  useWorkspaces: UseWorkspaces
  /** 测试注入点；缺省走内部视图状态机。 */
  onEdit?: (bot: BotListItem) => void
  onCreate?: () => void
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; bots: BotListItem[] }

type View = 'list' | { mode: 'create' } | { mode: 'edit'; bot: BotListItem }

const STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  idle: '空闲',
  failed: '连接失败',
  'not-running': '未运行',
}

export function BotsModal({ open, onClose, useWorkspaces, onEdit, onCreate }: BotsModalProps): ReactNode {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [view, setView] = useState<View>('list')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (!open) return
    setView('list')
  }, [open])

  useEffect(() => {
    if (!open) return
    let stale = false
    setState({ status: 'loading' })
    fetchBots()
      .then((bots) => { if (!stale) setState({ status: 'ok', bots }) })
      .catch(() => { if (!stale) setState({ status: 'error' }) })
    return () => { stale = true }
  }, [open, reload])

  const groups = new Map<string, BotListItem[]>()
  if (state.status === 'ok') {
    for (const bot of state.bots) {
      const list = groups.get(bot.project) ?? []
      list.push(bot)
      groups.set(bot.project, list)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="消息机器人" closeLabel="关闭" className={css.dialog}>
      {view === 'list' ? (
        <>
          {state.status === 'loading' && <p>加载中…</p>}
          {state.status === 'error' && <p>加载失败，请重试</p>}
          {state.status === 'ok' && state.bots.length === 0 && <p>还没有机器人，点击「新建机器人」开始。</p>}
          {state.status === 'ok' && [...groups.entries()].map(([project, bots]) => (
            <section key={project} className={css.group}>
              <h3 className={css.groupTitle}>{project}</h3>
              {bots.map((bot) => (
                <button key={bot.id} type="button" className={css.botRow}
                  onClick={() => { onEdit !== undefined ? onEdit(bot) : setView({ mode: 'edit', bot }) }}>
                  <span className={css.botName}>{bot.name}</span>
                  <span className={css.channelBadge}>飞书</span>
                  <span className={css.status}>{STATUS_LABEL[bot.status] ?? bot.status}</span>
                </button>
              ))}
            </section>
          ))}
          <button type="button" className={css.createButton}
            onClick={() => { onCreate !== undefined ? onCreate() : setView({ mode: 'create' }) }}>
            新建机器人
          </button>
        </>
      ) : (
        <BotForm
          useWorkspaces={useWorkspaces}
          bot={view.mode === 'edit' ? view.bot : undefined}
          onSaved={() => { setReload((n) => n + 1); setView('list') }}
          onCancel={() => { setView('list') }}
        />
      )}
    </Modal>
  )
}
```

`packages/project-bot/src/client/bots.module.css`：

```css
.trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: none;
  cursor: pointer;
  font: inherit;
  color: inherit;
  border-radius: 6px;
}
.trigger:hover { background: var(--dsh-hover, rgba(0, 0, 0, 0.06)); }
.rail { justify-content: center; padding: 6px 0; }
.triggerLabel { font-size: 13px; }
.dialog { width: 560px; }
.group { margin-bottom: 12px; }
.groupTitle { font-size: 12px; opacity: 0.6; margin: 0 0 4px; word-break: break-all; }
.botRow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--dsh-border, rgba(0, 0, 0, 0.12));
  border-radius: 6px;
  background: none;
  cursor: pointer;
  font: inherit;
  color: inherit;
  margin-bottom: 4px;
  text-align: left;
}
.botName { flex: 1; }
.channelBadge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: rgba(30, 100, 220, 0.12); }
.status { font-size: 12px; opacity: 0.7; }
.createButton { margin-top: 8px; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: PASS（`BotForm` 此任务尚不存在——BotsModal 的 import 先注释掉、表单视图渲染占位 `<p>表单</p>`，Task 16 恢复；或先建空 `BotForm.tsx` 导出占位组件。二选一，保持一致即可）

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/client packages/project-bot/tests/bots-entry.client.spec.tsx packages/project-bot/tests/bots-modal.client.spec.tsx
git commit -m "feat(project-bot): 浏览器半——侧边栏入口与机器人列表模态框"
```

---

### Task 16: 浏览器半——编辑/创建表单与扫码流程

**Files:**
- Create: `packages/project-bot/src/client/BotForm.tsx`
- Test: `packages/project-bot/tests/bot-form.client.spec.tsx`

**Interfaces:**
- Consumes: `client/api.ts` 全部、`UseWorkspaces`（Task 15）、`qrcode`（`QRCode.toCanvas`）。
- Produces: `BotForm`——`{ bot?: BotListItem; useWorkspaces: UseWorkspaces; onSaved(): void; onCancel(): void }`。

- [ ] **Step 1: 写失败测试**

`packages/project-bot/tests/bot-form.client.spec.tsx`：

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// jsdom 无 canvas：QR 渲染打桩，只断言被调用。
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) }, toCanvas: vi.fn(async () => undefined) }))

import { BotForm } from '../src/client/BotForm.tsx'

const useWorkspaces = <S,>(selector: (s: { items: { path: string; title: string }[] }) => S): S =>
  selector({ items: [{ path: 'D:\\work\\demo', title: 'demo' }, { path: 'D:\\work\\ops', title: 'ops' }] })

interface FetchCall { url: string; method: string; body?: unknown }

function stubFetch(routes: Record<string, (body?: unknown) => unknown>) {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init?.method ?? 'GET', body })
    const handler = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1]
    if (handler === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(handler(body)), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

beforeEach(() => { /* 各测试内 stubFetch */ })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('手动填写创建：提交名称/项目/persona/工具/密钥', async () => {
  const calls = stubFetch({
    '/project-bot/api/tools': () => ({ tools: ['bash', 'fs_read'] }),
    '/project-bot/api/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '运维机器人' } })
  fireEvent.change(screen.getByLabelText('机器人 ID'), { target: { value: 'ops' } })
  fireEvent.change(screen.getByLabelText('绑定项目'), { target: { value: 'D:\\work\\ops' } })
  fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '你是运维助手' } })
  fireEvent.click(screen.getByLabelText('bash'))
  // 默认手动填写 tab
  fireEvent.change(screen.getByLabelText('App ID'), { target: { value: 'cli_000000000000000a' } })
  fireEvent.change(screen.getByLabelText('App Secret'), { target: { value: 'plain-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const create = calls.find((c) => c.url === '/project-bot/api/bots' && c.method === 'POST')
  expect(create?.body).toMatchObject({
    id: 'ops', name: '运维机器人', project: 'D:\\work\\ops',
    persona: '你是运维助手', tools: ['bash'],
    feishu: { appId: 'cli_000000000000000a', appSecret: 'plain-secret' },
  })
})

test('扫码创建：生成二维码 → 轮询 → 完成后自动回填 appId 与 credentialRef', async () => {
  let polls = 0
  const calls = stubFetch({
    '/project-bot/api/tools': () => ({ tools: [] }),
    '/project-bot/api/register-app/status': () => {
      polls += 1
      return polls < 2
        ? { state: { status: 'pending', url: 'https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH', expireIn: 600 } }
        : { state: { status: 'done', appId: 'cli_ffffffffffffffff', credentialRef: 'project_bot_ffffffff' } }
    },
    '/project-bot/api/register-app': () => ({ id: 'reg_1' }),
    '/project-bot/api/bots': () => ({ bot: {} }),
  })
  const saved = vi.fn()
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={saved} onCancel={() => undefined} />)

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '扫码机器人' } })
  fireEvent.change(screen.getByLabelText('机器人 ID'), { target: { value: 'scan-bot' } })
  fireEvent.click(screen.getByRole('tab', { name: '扫码一键创建' }))
  fireEvent.click(screen.getByRole('button', { name: '生成二维码' }))

  expect(await screen.findByText('等待扫码确认…')).toBeTruthy()
  expect(await screen.findByText(/已创建应用/), { timeout: 3000 }).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await vi.waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const create = calls.find((c) => c.url === '/project-bot/api/bots' && c.method === 'POST')
  expect(create?.body).toMatchObject({
    id: 'scan-bot',
    feishu: { appId: 'cli_ffffffffffffffff', appSecretRef: 'project_bot_ffffffff' },
  })
})

test('必填校验：缺名称/App ID 时不提交并提示', async () => {
  const calls = stubFetch({ '/project-bot/api/tools': () => ({ tools: [] }) })
  render(<BotForm useWorkspaces={useWorkspaces} onSaved={() => undefined} onCancel={() => undefined} />)
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  expect(await screen.findByText(/请填写/)).toBeTruthy()
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test`
Expected: FAIL（`BotForm.tsx` 不存在）

- [ ] **Step 3: 实现 BotForm.tsx（并恢复 Task 15 中 BotsModal 对 BotForm 的真实引用）**

`packages/project-bot/src/client/BotForm.tsx`：

```tsx
/** 机器人创建/编辑表单：扫码一键创建（registerApp）或手动填写 app 信息。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import QRCode from 'qrcode'
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

const POLL_INTERVAL_MS = 2000

export function BotForm({ bot, useWorkspaces, onSaved, onCancel }: BotFormProps): ReactNode {
  const workspaces = useWorkspaces((s) => s.items)
  const editing = bot !== undefined

  const [name, setName] = useState(bot?.name ?? '')
  const [id, setId] = useState(bot?.id ?? '')
  const [project, setProject] = useState(bot?.project ?? workspaces[0]?.path ?? '')
  const [persona, setPersona] = useState(bot?.persona ?? '')
  const [provider, setProvider] = useState(bot?.agentOptions?.provider ?? '')
  const [model, setModel] = useState(bot?.agentOptions?.model ?? '')
  const [toolNames, setToolNames] = useState<string[]>([])
  const [selectedTools, setSelectedTools] = useState<Set<string> | null>(bot?.tools !== undefined ? new Set(bot.tools) : null)
  const [tab, setTab] = useState<BindTab>('scan')
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

  async function beginScan(): Promise<void> {
    setError(null)
    try {
      const { id: regId } = await startRegisterApp()
      pollTimer.current = setInterval(() => {
        void pollRegisterApp(regId).then((state) => {
          if (state.status === 'pending' && state.url !== undefined) {
            setScan((prev) => {
              if (prev.status !== 'waiting') {
                void QRCode.toCanvas(canvasRef.current, state.url!, { width: 200 }).catch(() => undefined)
              }
              return { status: 'waiting', url: state.url! }
            })
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
                const next = new Set(selectedTools ?? toolNames)
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
                  <p>等待扫码确认…（或用飞书打开链接：<a href={scan.url}>{scan.url}</a>）</p>
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
```

实现注意：

- `QRCode.toCanvas` 的导入形态以 `qrcode` 包 d.ts 为准（`import QRCode from 'qrcode'` 或 `import { toCanvas } from 'qrcode'`）。
- 若 Task 15 里 BotsModal 用了占位表单，本任务恢复为真实 `BotForm` 引用。

- [ ] **Step 4: 跑测试确认通过 + typecheck + bundle**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test; pnpm --filter @dsh-agent-toolkit/project-bot typecheck; pnpm --filter @dsh-agent-toolkit/project-bot bundle`
Expected: 三者全 PASS；`lib/client.js` 产出（bundle 内不应包含 `@deepseek-ai/` 跨插件值导入——纯净度门禁会响亮失败）

- [ ] **Step 5: Commit**

```bash
git add packages/project-bot/src/client packages/project-bot/tests/bot-form.client.spec.tsx
git commit -m "feat(project-bot): 浏览器半——机器人表单与扫码创建流程"
```

---

### Task 17: 开发回路真机验证与文档收尾

**Files:**
- Modify: `cordis.yml`（仓库根，开发 patch）
- Create: `packages/project-bot/README.md`
- Modify: `AGENTS.md`（仓库根）
- Modify: `docs/superpowers/specs/2026-08-24-project-bot-design.md`（若实现与 spec 有偏差，回写）

**Interfaces:**
- Consumes: 全部前序任务；用户提供的测试机器人 / 辅助机器人 / 测试群。

- [ ] **Step 1: 安装进开发 profile 并挂 patch**

根 `cordis.yml` 的 `insert` 列表追加一行（插件须先 `dsh plugin --profile web add link:<包路径>` 装进 profile，与 token-usage/prompt-stack 同流程）：

```yaml
    - id: project-bot
      name: '@dsh-agent-toolkit/project-bot'
```

- [ ] **Step 2: 启动开发回路**

Run: `cd deepseek-harness; pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml`
Expected: Web UI 启动；侧边栏底栏出现「消息机器人」按钮

- [ ] **Step 3: 真机验证清单（逐项过）**

- 侧边栏点「消息机器人」→ 空列表 → 新建 → 扫码一键创建：飞书扫码确认后表单回填 appId，保存后列表出现该 bot 且状态为「已连接」
- 手动填写路径：用用户提供的测试机器人 appId/appSecret 再建一个 bot，绑定同一项目（验证一项目多 bot）
- 单聊测试机器人：发消息 → 消息上出现「处理中」表情 → 流式卡片打字机输出 → 完成后表情消失、卡片头变绿
- 测试群：不 @ 机器人无响应；@ 机器人正常回复
- 长回复（诱导模型输出超长内容，如"写一份 5000 字文档"）→ 自动拆多张续卡
- `/status`、`/stop`（长任务中停止 → 卡片变灰）、`/new`（新会话无旧上下文）
- 处理中发第二条消息 → 收到"上一条还在处理中"提示
- 改 `cordis.yml` 的 `cardUpdateThrottleMs` → HMR 热替换后新值生效（卡片更新节奏变化）
- 重启 dsh → 原 chat 发消息 → 会话恢复（有上下文记忆）

- [ ] **Step 4: 写 README.md**

`packages/project-bot/README.md`（照 token-usage/prompt-stack 风格）：安装命令、配置 UI 使用说明（扫码/手动）、飞书内指令（/new /stop /status）、Config 字段表、已知局限（v1 无审批按钮/无消息排队/群内需 @机器人）。

- [ ] **Step 5: 更新 AGENTS.md**

在「目录结构」的 `packages/` 清单加 `project-bot`（双半 bundle 插件，包名 `@dsh-agent-toolkit/project-bot`）；「开发命令」段补 `pnpm --filter @dsh-agent-toolkit/project-bot test` / `typecheck` / `bundle`。

- [ ] **Step 6: 最终门禁 + Commit**

Run: `pnpm --filter @dsh-agent-toolkit/project-bot test; pnpm --filter @dsh-agent-toolkit/project-bot typecheck; pnpm --filter @dsh-agent-toolkit/project-bot bundle`
Expected: 三者全 PASS

```bash
git add cordis.yml packages/project-bot/README.md AGENTS.md
git commit -m "docs(project-bot): README 与仓库文档；开发回路 patch 挂载"
```

---

## Self-Review 记录（计划落盘前已执行）

- **Spec 覆盖**：需求 1（一项目多 bot）→ Task 2 数据模型 + Task 7 多 bot 生命周期；需求 2（prompt-stack）→ Task 14 `setup` 内 persona section（prompt-stack 不动，正交叠加）；需求 3（卡片交互）→ Task 8/10；表情回复 → Task 5/10；配置 UI → Task 13/15/16；扫码创建 → Task 12/16。
- **占位符扫描**：无 TBD/TODO；Task 11/14 对 SDK/宿主类型的出入给了"以 d.ts 为准微调"的明确边界（类型适配，非逻辑占位）。
- **类型一致性**：`StreamState`/`CardOp`（Task 8）↔ executor（Task 10）↔ 测试断言一致；`RegisterState`（Task 12）↔ API（Task 13）↔ client（Task 15/16）一致；`hooksOf`/`AgentHooks`（Task 3）↔ Router（Task 4）↔ index.ts（Task 14）一致。
