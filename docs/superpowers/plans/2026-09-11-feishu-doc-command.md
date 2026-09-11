# 飞书 /doc 命令实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bot 会话内发送 `/doc <相对路径>`，把项目内文件以飞书文件消息发回会话，用户在飞书内直接打开预览。

**Architecture:** 渠道无关核心新增 `doc-command.ts`（路径解析 + 护栏 + 拒绝文案）；`ReplyHandle` 增加可选能力 `sendFile`（飞书 presenter 经 `FeishuApi.uploadFile` + `sendFile` 实现）；`Inbound` 增 `/doc` 指令分支（不进 turn、不占 in-flight）；`feishu.docMaxBytes` 进 Config 并沿 BotsModuleConfig → BotRuntime → InboundDeps 接线。

**Tech Stack:** TypeScript ESM（仓库约定 `.ts` 扩展名相对导入）、vitest、`@larksuiteoapi/node-sdk`。

**Spec:** `docs/superpowers/specs/2026-09-11-feishu-doc-command-design.md`

## Global Constraints

- 当前分支 `feat/feishu-session-switch` 有未提交的 session-switch 改动（`inbound.ts` / `inbound.test.ts`）。**执行 Task 1 前先确认这些改动已提交**（本计划在其之上叠加；未提交就先由用户处理，不要把别人的改动卷进本计划任何 commit）。
- 每个 Task 的 commit 只 stage 本 Task 触及的文件。
- commit message 风格照仓库现状：`feat(toolkit): …` / `test(toolkit): …` / `docs: …`。
- 单文件测试命令（仓库根执行）：`pnpm --filter dsh-agent-toolkit exec vitest run src/channels/<file>.test.ts`；全量：`pnpm --filter dsh-agent-toolkit test`；类型：`pnpm --filter dsh-agent-toolkit typecheck`；构建：`pnpm --filter dsh-agent-toolkit bundle`。
- 文件末尾恰好一个换行；禁止无注释 `any`；新文件头部一行用途注释（照现有文件风格）。
- 错误文案遵循 2026-09-03 /new 事故教训：摘要必须回传渠道（notice），不只写 warn。

---

### Task 1: directive.ts 支持 /doc 带参指令（路径参数保留大小写）

**Files:**
- Modify: `packages/toolkit/src/channels/directive.ts`
- Test: `packages/toolkit/src/channels/directive.test.ts`

**Interfaces:**
- Produces: `Directive` 联合新增 `'doc'`；`parseDirective('/doc <path>')` 返回 `{ name: 'doc', arg: <原始大小写路径> }`；`/doc` 无参返回 `{ name: 'doc' }`（arg 缺省，由 Inbound 提示用法）。后续 Task 6 的 Inbound 分支消费 `directive.name === 'doc'` 与 `directive.arg`。

- [ ] **Step 1: 写失败测试**

在 `directive.test.ts` 的 `describe('parseDirective')` 内追加：

```ts
  test('/doc 带参：首词判定，路径参数保留原始大小写', () => {
    expect(parseDirective('/doc docs/report.md')).toEqual({ name: 'doc', arg: 'docs/report.md' })
    expect(parseDirective('/DOC  Docs/Report.MD ')).toEqual({ name: 'doc', arg: 'Docs/Report.MD' })
  })

  test('/doc 无参：命中且 arg 缺省（由 Inbound 提示用法）', () => {
    expect(parseDirective('/doc')).toEqual({ name: 'doc' })
  })

  test('/doc 前缀不误伤：/docx 不是指令', () => {
    expect(parseDirective('/docx')).toBeNull()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/directive.test.ts`
Expected: FAIL（`/doc` 相关用例得到 `null`）

- [ ] **Step 3: 实现**

`directive.ts` 修改三处（`Directive` 联合、函数 doc 注释、解析分支）：

```ts
export type Directive = 'new' | 'stop' | 'status' | 'sessions' | 'switch' | 'help' | 'doc'
```

```ts
/**
 * 精确指令（/new /stop /status /sessions /help）要求整条消息 trim+lowercase 精确匹配，
 * 带参数/前后文按普通消息处理；/switch /doc 为首词判定的带参指令。
 * /doc 的 arg 是文件路径，大小写敏感：取自原始文本切片（tolowerCase 不改变长度，索引对齐）。
 */
export function parseDirective(text: string): ParsedDirective | null {
  const raw = text.trim()
  const t = raw.toLowerCase()
  // ……既有分支原样保留……
  if (t === '/doc') return { name: 'doc' }
  if (t.startsWith('/doc ')) return { name: 'doc', arg: raw.slice('/doc '.length).trim() }
  return null
}
```

注意既有实现里 `const t = text.trim().toLowerCase()` 一行要拆成 `raw` + `t` 两行；其余分支仍用 `t`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/directive.test.ts`
Expected: PASS（含既有用例）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/directive.ts packages/toolkit/src/channels/directive.test.ts
git commit -m "feat(toolkit): parseDirective 新增 /doc 带参指令（路径参数保留大小写）"
```

---

### Task 2: doc-command.ts 路径解析与护栏（渠道无关核心）

**Files:**
- Create: `packages/toolkit/src/channels/doc-command.ts`
- Test: `packages/toolkit/src/channels/doc-command.test.ts`

**Interfaces:**
- Produces（Task 6 消费）:
  - `resolveDocPath(project: string, arg: string, maxBytes: number): Promise<DocResolution>`
  - `type DocResolution = { ok: true; path: string; name: string } | { ok: false; reason: DocReject }`
  - `type DocReject = 'outside' | 'not-found' | 'not-file' | 'too-large'`
  - `readDocFile(path: string): Promise<Uint8Array>`
  - `docRejectText(reason: DocReject, arg: string, maxBytes: number): string`

- [ ] **Step 1: 写失败测试**

新建 `doc-command.test.ts`：

```ts
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { docRejectText, readDocFile, resolveDocPath } from './doc-command.ts'

let root: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dsh-doc-cmd-'))
  await mkdir(path.join(root, 'docs'), { recursive: true })
  await writeFile(path.join(root, 'docs', 'report.md'), '# 报告\n', 'utf8')
  await writeFile(path.join(root, 'big.bin'), Buffer.alloc(16))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveDocPath', () => {
  test('命中：返回绝对路径与文件名', async () => {
    const res = await resolveDocPath(root, 'docs/report.md', 1024)
    expect(res).toEqual({ ok: true, path: path.join(root, 'docs', 'report.md'), name: 'report.md' })
  })

  test('拒绝绝对路径', async () => {
    const abs = path.join(root, 'docs', 'report.md')
    expect(await resolveDocPath(root, abs, 1024)).toEqual({ ok: false, reason: 'outside' })
  })

  test('拒绝 .. 越出项目根', async () => {
    expect(await resolveDocPath(root, '../outside.md', 1024)).toEqual({ ok: false, reason: 'outside' })
    expect(await resolveDocPath(root, 'docs/../../outside.md', 1024)).toEqual({ ok: false, reason: 'outside' })
  })

  test('拒绝不存在的文件', async () => {
    expect(await resolveDocPath(root, 'docs/nope.md', 1024)).toEqual({ ok: false, reason: 'not-found' })
  })

  test('拒绝目录', async () => {
    expect(await resolveDocPath(root, 'docs', 1024)).toEqual({ ok: false, reason: 'not-file' })
  })

  test('拒绝符号链接（lstat 判定，不追随）', async (t) => {
    const link = path.join(root, 'link.md')
    try {
      await symlink(path.join(root, 'docs', 'report.md'), link)
    } catch {
      t.skip('当前环境不允许创建符号链接')
      return
    }
    expect(await resolveDocPath(root, 'link.md', 1024)).toEqual({ ok: false, reason: 'not-file' })
  })

  test('超过大小上限拒绝', async () => {
    expect(await resolveDocPath(root, 'big.bin', 8)).toEqual({ ok: false, reason: 'too-large' })
    expect(await resolveDocPath(root, 'big.bin', 16)).toMatchObject({ ok: true })
  })
})

describe('readDocFile', () => {
  test('读出文件字节', async () => {
    const res = await resolveDocPath(root, 'docs/report.md', 1024)
    if (!res.ok) throw new Error('unreachable')
    expect(new TextDecoder().decode(await readDocFile(res.path))).toBe('# 报告\n')
  })
})

describe('docRejectText', () => {
  test('各拒绝原因的文案', () => {
    expect(docRejectText('outside', 'x', 1024)).toContain('项目目录内')
    expect(docRejectText('not-found', 'a.md', 1024)).toContain('a.md')
    expect(docRejectText('not-file', 'docs', 1024)).toContain('docs')
    expect(docRejectText('too-large', 'b.bin', 1024)).toContain('b.bin')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/doc-command.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `doc-command.ts`：

```ts
/** /doc 指令的路径解析与护栏：仅允许项目目录内、存在的普通文件、大小受控。 */
import type { Stats } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

export type DocReject = 'outside' | 'not-found' | 'not-file' | 'too-large'

export type DocResolution =
  | { ok: true; path: string; name: string }
  | { ok: false; reason: DocReject }

/** 相对项目根解析 arg；绝对路径与 .. 越界一律拒绝；符号链接按 lstat 拒绝（不追随）。 */
export async function resolveDocPath(project: string, arg: string, maxBytes: number): Promise<DocResolution> {
  if (path.isAbsolute(arg)) return { ok: false, reason: 'outside' }
  const abs = path.resolve(project, arg)
  const rel = path.relative(project, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'outside' }
  let st: Stats
  try {
    st = await lstat(abs)
  } catch {
    // lstat 失败（不存在/不可读/悬空链接）统一按 not-found 提示，不区分原因。
    return { ok: false, reason: 'not-found' }
  }
  if (!st.isFile()) return { ok: false, reason: 'not-file' }
  if (st.size > maxBytes) return { ok: false, reason: 'too-large' }
  return { ok: true, path: abs, name: path.basename(abs) }
}

/** 读入文件字节（调用方已完成护栏判定；大小已受 maxBytes 约束，可安全入内存）。 */
export async function readDocFile(filePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(filePath))
}

/** 拒绝原因 → 回传渠道的用户文案。 */
export function docRejectText(reason: DocReject, arg: string, maxBytes: number): string {
  switch (reason) {
    case 'outside': return `仅支持发送项目目录内的文件（相对路径，不越出项目根）：${arg}`
    case 'not-found': return `文件不存在：${arg}`
    case 'not-file': return `不支持发送目录或链接：${arg}`
    case 'too-large': return `文件超过大小上限 ${Math.floor(maxBytes / 1024 / 1024)} MiB：${arg}`
    default: {
      const never: never = reason
      throw new Error(`未知拒绝原因：${String(never)}`)
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/doc-command.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/doc-command.ts packages/toolkit/src/channels/doc-command.test.ts
git commit -m "feat(toolkit): doc-command 路径解析与护栏（项目根内相对路径、lstat 拒绝链接、大小上限）"
```

---

### Task 3: FeishuApi 新增 uploadFile / sendFile

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/api.ts`
- Test: `packages/toolkit/src/channels/feishu/feishu-api.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 `createFeishuApi(client)` 与 `FeishuApi` 接口。
- Produces（Task 4 消费）:
  - `FeishuApi.uploadFile(name: string, data: Uint8Array): Promise<string>` — 返回 `file_key`；SDK 响应缺 `file_key` 时抛 `文件上传失败：code=… msg=…`。
  - `FeishuApi.sendFile(chatId: string, fileKey: string): Promise<void>` — `msg_type: 'file'`，content `{ file_key }`。

- [ ] **Step 1: 写失败测试**

新建 `feishu-api.test.ts`（mock lark.Client 形态，与 api.ts 的薄封装测试同款思路）：

```ts
import { describe, expect, test, vi } from 'vitest'
import type * as lark from '@larksuiteoapi/node-sdk'
import { createFeishuApi } from './api.ts'

function mockClient() {
  const fileCreate = vi.fn(async () => ({ code: 0, msg: 'success', data: { file_key: 'file_v3_xxx' } }))
  const messageCreate = vi.fn(async () => ({ code: 0, msg: 'success', data: {} }))
  const client = { im: { file: { create: fileCreate }, message: { create: messageCreate } } }
  return { client: client as unknown as lark.Client, fileCreate, messageCreate }
}

describe('FeishuApi.uploadFile / sendFile', () => {
  test('uploadFile：stream 类型上传并返回 file_key', async () => {
    const { client, fileCreate } = mockClient()
    const api = createFeishuApi(client)
    const key = await api.uploadFile('report.md', new TextEncoder().encode('# 报告'))
    expect(key).toBe('file_v3_xxx')
    const call = fileCreate.mock.calls[0][0] as { data: { file_type: string; file_name: string; file: Buffer } }
    expect(call.data.file_type).toBe('stream')
    expect(call.data.file_name).toBe('report.md')
    expect(Buffer.isBuffer(call.data.file)).toBe(true)
  })

  test('uploadFile：缺 file_key 抛 code/msg', async () => {
    const { client, fileCreate } = mockClient()
    fileCreate.mockResolvedValueOnce({ code: 230002, msg: 'denied', data: {} })
    const api = createFeishuApi(client)
    await expect(api.uploadFile('a.md', new Uint8Array(1))).rejects.toThrow('文件上传失败：code=230002 msg=denied')
  })

  test('sendFile：msg_type=file 且 content 携带 file_key', async () => {
    const { client, messageCreate } = mockClient()
    const api = createFeishuApi(client)
    await api.sendFile('oc_1', 'file_v3_xxx')
    expect(messageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_1', msg_type: 'file', content: JSON.stringify({ file_key: 'file_v3_xxx' }) },
    })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-api.test.ts`
Expected: FAIL（`api.uploadFile is not a function`）

- [ ] **Step 3: 实现**

`api.ts` 的 `FeishuApi` 接口追加（放在 `downloadImage` 声明之后）：

```ts
  /** 上传文件到消息资源库（im/v1 files，file_type=stream），返回 file_key。 */
  uploadFile(name: string, data: Uint8Array): Promise<string>
  /** 发送文件消息（msg_type=file）。 */
  sendFile(chatId: string, fileKey: string): Promise<void>
```

`createFeishuApi` 返回对象追加两个方法：

```ts
    async uploadFile(name, data) {
      const res = await client.im.file.create({ data: { file_type: 'stream', file_name: name, file: Buffer.from(data) } })
      const fileKey = res.data?.file_key
      if (typeof fileKey !== 'string' || fileKey.length === 0) {
        throw new Error(`文件上传失败：code=${res.code} msg=${res.msg}`)
      }
      return fileKey
    },
    async sendFile(chatId, fileKey) {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
      })
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-api.test.ts`
Expected: PASS。注意：SDK 类型若与 `client.im.file.create` 实参不完全吻合，以编译器报错为准微调（保持行为断言不变）；typecheck 在 Task 7 统一过。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/feishu/api.ts packages/toolkit/src/channels/feishu/feishu-api.test.ts
git commit -m "feat(toolkit): FeishuApi 新增 uploadFile/sendFile（im/v1 files + file 消息）"
```

---

### Task 4: ReplyHandle 可选能力 sendFile + 飞书实现

**Files:**
- Modify: `packages/toolkit/src/channels/channel.ts`（`ReplyHandle` 接口）
- Modify: `packages/toolkit/src/channels/feishu/reply.ts`（`FeishuReplyHandle`）
- Test: `packages/toolkit/src/channels/feishu/feishu-reply.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `FeishuApi.uploadFile` / `sendFile`。
- Produces（Task 6 消费）: `ReplyHandle.sendFile?(name: string, data: Uint8Array): Promise<void>`（可选；缺席 = 渠道不支持发文件，由核心降级提示）。飞书实现**直接调用、不进 enqueue 串行链**（文件消息与卡片序列无关），错误向调用方传播。

- [ ] **Step 1: 写失败测试 + 编译连带修复**

`FeishuApi` 接口加必填方法后，两处全量对象字面量 fake 会编译失败，须同步补桩：`feishu-reply.test.ts` 的 `fakeApi()`（line 17 块）与 `feishu-stream-integrity.test.ts` 的同款字面量（line 31 块），各加两行：

```ts
    uploadFile: vi.fn(async (name: string) => { calls.push({ op: 'uploadFile', args: [name] }); return 'file_v3_xxx' }),
    sendFile: vi.fn(async (...args) => { calls.push({ op: 'sendFile', args }) }),
```

（`feishu-stream-integrity.test.ts` 的 fake 若无 `calls` 数组则用 `async () => 'file_v3_xxx'` / `async () => undefined` 简单桩，先读文件确认。）

`feishu-reply.test.ts` 末尾追加（`fakeApi()` 返回 `{ api, calls }`、`make(api)` 返回 `{ reply, logs }`，签名已确认）：

```ts
test('sendFile：上传后经 chatId 发文件消息，不走卡片串行链', async () => {
  const { api, calls } = fakeApi()
  const { reply } = make(api)
  await reply.sendFile!('report.md', new TextEncoder().encode('# 报告'))
  expect(calls.map((c) => c.op)).toEqual(['uploadFile', 'sendFile'])
  expect(calls[0].args[0]).toBe('report.md')
  expect(calls[1].args).toEqual(['oc_1', 'file_v3_xxx'])
})

test('sendFile：上传失败向调用方传播（重试耗尽后抛最后一次错误）', async () => {
  const { api } = fakeApi()
  vi.mocked(api.uploadFile).mockRejectedValue(new Error('网络错误'))
  const { reply } = make(api)
  await expect(reply.sendFile!('a.md', new Uint8Array(1))).rejects.toThrow('网络错误')
})
```

注意：`beforeEach` 已启用 fake timers——`withRetry` 的退避用 `setTimeout`，第二条用例需在断言前推进计时器：把 `await expect(...)` 改为：

```ts
  const pending = reply.sendFile!('a.md', new Uint8Array(1))
  const assertion = expect(pending).rejects.toThrow('网络错误')
  await vi.advanceTimersByTimeAsync(3000)
  await assertion
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-reply.test.ts`
Expected: FAIL（`reply.sendFile is not a function`）

- [ ] **Step 3: 实现**

`channel.ts` 的 `ReplyHandle` 接口追加：

```ts
  /** 发送文件消息（可选能力；渠道不支持时缺省，由核心降级提示）。错误向调用方传播。 */
  sendFile?(name: string, data: Uint8Array): Promise<void>
```

`reply.ts` 的 `FeishuReplyHandle` 类追加（放在 `notice` 之后）：

```ts
  /** 文件消息与卡片序列无关：直接调用（不进 enqueue 串行链），带重试，错误传播给调用方。 */
  async sendFile(name: string, data: Uint8Array): Promise<void> {
    await withRetry(async () => {
      const fileKey = await this.api.uploadFile(name, data)
      await this.api.sendFile(this.chatId, fileKey)
    })
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-reply.test.ts`
Expected: PASS（含既有用例——`ReplyHandle` 加的是可选成员，既有 fake 不受影响）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/channel.ts packages/toolkit/src/channels/feishu/reply.ts packages/toolkit/src/channels/feishu/feishu-reply.test.ts
git commit -m "feat(toolkit): ReplyHandle 可选能力 sendFile，飞书实现上传+文件消息（带重试、错误传播）"
```

---

### Task 5: Config 接线（feishu.docMaxBytes 全链路）

**Files:**
- Modify: `packages/toolkit/src/index.ts`（feishu schema + 默认值对象 + 注释「9 个」→「10 个」）
- Modify: `packages/toolkit/src/bots/index.ts`（`BotsModuleConfig` + `BotRuntime` 构造传参）
- Modify: `packages/toolkit/src/channels/runtime.ts`（`BotRuntime` deps + 传 `Inbound`）
- Modify: `packages/toolkit/src/channels/inbound.ts`（仅 `InboundDeps` 接口加字段，行为在 Task 6）
- Test: `packages/toolkit/src/bots/smoke.test.ts`、`packages/toolkit/src/index.test.ts`、`packages/toolkit/src/channels/runtime.test.ts`、`packages/toolkit/src/channels/inbound.test.ts`（harness 补字段）

**Interfaces:**
- Consumes: 无（纯接线）。
- Produces（Task 6 消费）: `InboundDeps.docMaxBytes: number`（必填）；Config `feishu.docMaxBytes` 默认 `31457280`（30 MiB）。

- [ ] **Step 1: 写失败测试**

`smoke.test.ts` 现钉「九字段」——改为十字段。先读该文件，将字段名列表加 `'docMaxBytes'`，测试名与注释中「九字段/9 个」改「十字段/10 个」。

`index.test.ts` 的 Config 默认值断言（约 line 134 `cardMaxBytes: 26_000` 所在对象）加一行 `docMaxBytes: 31_457_280`。

`runtime.test.ts` 的 deps 对象（约 line 61-62）加 `docMaxBytes: 1024`。

`inbound.test.ts` 的 `new Inbound({...})`（约 line 57-64）加 `docMaxBytes: 1024 * 1024`。

- [ ] **Step 2: 跑类型检查确认失败**

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: FAIL（`BotsModuleConfig` 缺 `docMaxBytes` 等连锁报错）

- [ ] **Step 3: 实现接线**

`index.ts` feishu schema（两处同步）：

```ts
    approval: z.boolean().default(true),
    /** /doc 发送文件的大小上限（字节）。 */
    docMaxBytes: z.number().default(30 * 1024 * 1024),
  }).default({
    // ……既有字段原样……
    approval: true,
    docMaxBytes: 30 * 1024 * 1024,
  }),
```

注释「feishu 9 个全局可调参数」改「10 个」。

`bots/index.ts` `BotsModuleConfig` 追加：

```ts
  /** /doc 发送文件的大小上限（字节）。 */
  docMaxBytes: number
```

`BotRuntime` 构造（bots/index.ts:168 块）加一行：

```ts
      maxErrorDetailChars: config.errorDetailMaxChars,
      docMaxBytes: config.docMaxBytes,
```

`runtime.ts`：`BotRuntime` deps 接口加 `docMaxBytes: number`；`new Inbound({...})` 加 `docMaxBytes: deps.docMaxBytes`。

`inbound.ts` `InboundDeps` 接口加：

```ts
  /** /doc 发送文件的大小上限（字节）。 */
  docMaxBytes: number
```

- [ ] **Step 4: 跑类型检查 + 相关测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/bots/smoke.test.ts src/index.test.ts src/channels/runtime.test.ts src/channels/inbound.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/index.ts packages/toolkit/src/bots/index.ts packages/toolkit/src/channels/runtime.ts packages/toolkit/src/channels/inbound.ts packages/toolkit/src/bots/smoke.test.ts packages/toolkit/src/index.test.ts packages/toolkit/src/channels/runtime.test.ts packages/toolkit/src/channels/inbound.test.ts
git commit -m "feat(toolkit): feishu.docMaxBytes 配置项全链路接线（schema → BotsModuleConfig → BotRuntime → InboundDeps）"
```

---

### Task 6: Inbound /doc 分支 + /help 文案

**Files:**
- Modify: `packages/toolkit/src/channels/inbound.ts`
- Test: `packages/toolkit/src/channels/inbound.test.ts`

**Interfaces:**
- Consumes: Task 1 `parseDirective` 的 `{ name: 'doc', arg }`；Task 2 `resolveDocPath` / `readDocFile` / `docRejectText`；Task 4 `ReplyHandle.sendFile?`；Task 5 `InboundDeps.docMaxBytes`。
- Produces: `/doc` 用户可见行为（spec 错误文案表）。

- [ ] **Step 1: 写失败测试**

`inbound.test.ts` 追加。`fakeReply` 不动（`sendFile` 可选缺省 = 渠道不支持分支）；支持发文件的 reply 在用例内联构造。

`msg()` 工厂改为支持覆盖 reply（在 `loadImages` 参数后加第四参）：

```ts
  function msg(text: string, chatId = 'oc_1', loadImages?: InboundMessage['loadImages'], reply?: ReplyHandle): InboundMessage {
    return {
      botId: BOT.id, chatId, userId: 'ou_u1', messageId: `om_${Math.random()}`,
      text,
      ...(loadImages !== undefined ? { loadImages } : {}),
      reply: reply ?? fakeReply(rec),
      ackProcessing: async (): Promise<Disposer> => {
        rec.acked += 1
        return () => undefined
      },
    }
  }
```

harness 的 `BOT.project` 需可被覆盖：给 `harness(opts)` 的 opts 加 `project?: string`，内部 BOT 改为：

```ts
  const bot: BotRecord = { ...BOT, ...(opts.project !== undefined ? { project: opts.project } : {}) }
```

并把 `bots: { get: (id) => (id === BOT.id ? BOT : undefined) }` 改为 `bots: { get: (id) => (id === bot.id ? bot : undefined) }`。

```ts
describe('/doc 指令', () => {
  let project: string
  beforeAll(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'dsh-doc-inbound-'))
    await writeFile(path.join(project, 'report.md'), '# 报告\n', 'utf8')
  })
  afterAll(async () => { await rm(project, { recursive: true, force: true }) })

  function fileReply(rec: Recorded) {
    const files: { name: string; data: Uint8Array }[] = []
    const reply: ReplyHandle = { ...fakeReply(rec), sendFile: async (name, data) => { files.push({ name, data }) } }
    return { reply, files }
  }

  test('/doc 发送项目内文件', async () => {
    const { rec, inbound, msg } = harness({ project })
    const { reply, files } = fileReply(rec)
    inbound.onMessage(msg('/doc report.md', 'oc_1', undefined, reply))
    await vi.waitFor(() => { expect(files).toHaveLength(1) })
    expect(files[0].name).toBe('report.md')
    expect(new TextDecoder().decode(files[0].data)).toBe('# 报告\n')
    expect(rec.followups).toHaveLength(0)  // 不进会话 turn
  })

  test('/doc 无参提示用法', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/doc'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('用法：/doc'))).toBe(true) })
  })

  test('/doc 越界路径拒绝', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/doc ../secret.md'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('项目目录内'))).toBe(true) })
  })

  test('/doc 文件不存在', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/doc nope.md'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('文件不存在'))).toBe(true) })
  })

  test('/doc 渠道不支持 sendFile 时降级提示', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/doc report.md'))  // fakeReply 无 sendFile
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('不支持发送文件'))).toBe(true) })
  })

  test('/doc 上传失败 notice 摘要', async () => {
    const { rec, inbound, msg } = harness({ project })
    const reply: ReplyHandle = { ...fakeReply(rec), sendFile: async () => { throw new Error('上传失败：code=230002') } }
    inbound.onMessage(msg('/doc report.md', 'oc_1', undefined, reply))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('发送文件失败'))).toBe(true) })
  })
})
```

文件头 import 补 `mkdtemp/rm/writeFile`、`tmpdir`、`path`（照 Task 2 测试同款）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/inbound.test.ts`
Expected: FAIL（/doc 走普通消息路径进了 followup / 无对应 notice）

- [ ] **Step 3: 实现**

`inbound.ts`：

1. import 补 `import { docRejectText, readDocFile, resolveDocPath } from './doc-command.ts'`
2. `HELP_TEXT` 数组加一行 `'/doc <相对路径> 发送项目内文件（如对话产出的 Markdown 文档）',`（放在 `/help` 行之前）
3. 指令分支链中（`/help` 分支之后、`router.ensure` 之前）加：

```ts
    if (directive?.name === 'doc') {
      await this.sendDoc(bot, msg, directive.arg)
      return
    }
```

4. 类内加私有方法（放在 `switchSession` 之后）：

```ts
  private async sendDoc(bot: BotRecord, msg: InboundMessage, arg: string | undefined): Promise<void> {
    if (arg === undefined || arg.length === 0) {
      await msg.reply.notice('用法：/doc <相对路径>（相对项目目录，如 docs/report.md）')
      return
    }
    const sendFile = msg.reply.sendFile?.bind(msg.reply)
    if (sendFile === undefined) {
      await msg.reply.notice('当前渠道不支持发送文件')
      return
    }
    const res = await resolveDocPath(bot.project, arg, this.deps.docMaxBytes)
    if (!res.ok) {
      await msg.reply.notice(docRejectText(res.reason, arg, this.deps.docMaxBytes))
      return
    }
    // 护栏判定后的读取失败（如竞态删除）抛给 onMessage 统一错误路径。
    const data = await readDocFile(res.path)
    try {
      await sendFile(res.name, data)
    } catch (error) {
      const detail = truncateDetail(error instanceof Error ? error.message : String(error), this.deps.maxErrorDetailChars)
      await msg.reply.notice(`发送文件失败：${detail}`)
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/inbound.test.ts`
Expected: PASS（含既有所用例）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/inbound.ts packages/toolkit/src/channels/inbound.test.ts
git commit -m "feat(toolkit): /doc 指令——项目内文件以飞书文件消息直发会话"
```

---

### Task 7: 全量门禁 + 文档同步

**Files:**
- Modify: `docs/domains/feishu.md`
- Modify: `docs/usage/` 飞书章节（bots 命令/权限所在文件，先 glob 定位）
- Modify: `packages/toolkit/src/channels/feishu/index.ts`（仅当 typecheck 暴露 SDK 类型问题时的微调，预期不动）

**Interfaces:**
- Consumes: Task 1-6 全部。

- [ ] **Step 1: 全量测试**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（621 + 新增用例全绿）

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS（若 Task 3 的 SDK 实参类型有出入，此处收敛：以编译器报错为准微调 `uploadFile` 实参写法，不改行为断言）

- [ ] **Step 3: 构建**

Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 成功产出 lib/index.js + lib/client.js

- [ ] **Step 4: 文档**

`docs/domains/feishu.md` 的指令能力处补一句：`/doc <相对路径>` 把项目内文件以飞书文件消息发回会话（护栏：项目根内相对路径、lstat 拒绝链接、`feishu.docMaxBytes` 上限默认 30 MiB；应用需 `im:resource` 权限）。

`docs/usage/` 飞书使用手册：指令表补 `/doc` 用法一行；权限清单补 `im:resource`（上传文件，/doc 需要；存量应用开发者后台补开并发布）。

- [ ] **Step 5: Commit**

```bash
git add docs/domains/feishu.md docs/usage/
git commit -m "docs: 飞书 /doc 指令用法与 im:resource 权限说明"
```

- [ ] **Step 6: 真实环境验证（开发回路）**

```bash
cd deepseek-harness && pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml
```

飞书 bot 会话发送 `/doc <项目内某 md 文件>`，确认：收到文件消息、点击可预览；发 `/doc ../x` 与 `/doc 不存在.md` 确认护栏文案。
