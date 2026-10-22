# 飞书出站图片正显（200570 断流根治）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飞书渠道出站正文中的本地路径图片引用上传换 img_key 内嵌正显，其余形态降级，根治 200570 导致的流式断流。

**Architecture:** 渠道适配落在 `channels/feishu/`：`images.ts` 新增净化纯函数（sanitizeText/sanitizeSegments/stripImages）+ 上传器 ImageResolver；`FeishuReplyHandle` 持有原始 segments、在 planSync/重放前净化；200570 进 execOne 错误分类走剥离重规划（不 abandon）。Config 新增 `feishu.imageUpload` 开关。

**Tech Stack:** TypeScript ESM（.ts 后缀相对导入）、vitest、@larksuiteoapi/node-sdk、schemastery（z）。

**Spec:** `docs/superpowers/specs/2026-10-21-feishu-outbound-image-design.md`

## Global Constraints

- 仓库约定：可调参数进 Config schema（不硬编码）；注释中文、简洁；文件不新增无关注释。
- 测试命令：`pnpm --filter dsh-agent-toolkit test`；类型检查：`pnpm --filter dsh-agent-toolkit typecheck`；构建：`pnpm --filter dsh-agent-toolkit bundle`（任何 src 改动后必跑）。
- 飞书图片上传平台限制：≤10MB、非空、GIF ≤2000x2000、其他 ≤12000x12000（本计划只卡字节上限与魔数）。
- 占位文案：`🖼 <alt>（图片上传中…）`；降级文案：`🖼 <alt>（图片无法发送）`；alt 为空用 `图片`，alt 截断 50 code point。
- 降级/占位一律纯文本，不用链接语法（飞书链接 url 校验未验证）。
- 既有接受的风险基线：占位 → img_key 升级与 reconcileTrailingText 的尾段替换同款偏移语义（尾元素 update 全量替换安全；跨卡 carry 段在升级与拆卡交叠的极窄窗口有已知偏移风险，与 reconcile 现状同级，不在本期处理）。

---

### Task 1: FeishuApi.uploadImage

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/api.ts`（接口 + 实现）
- Test: `packages/toolkit/src/channels/feishu/feishu-api.test.ts`
- Modify（补假件 stub，接口加成员后 TS 必过）: `packages/toolkit/src/channels/feishu/feishu-reply.test.ts`、`packages/toolkit/src/channels/feishu/feishu-stream-integrity.test.ts`

**Interfaces:**
- Produces: `FeishuApi.uploadImage(data: Uint8Array): Promise<string>`（返回 image_key；信封被 SDK 剥层，与 uploadFile 同款取内层 `image_key`）。

- [ ] **Step 1: 写失败测试**

`feishu-api.test.ts` 追加（照现有 uploadFile 测试的 mock client 写法）：

```ts
describe('FeishuApi.uploadImage', () => {
  test('im/v1 images 上传（image_type=message）并返回 image_key（SDK 剥信封取内层）', async () => {
    const calls: unknown[] = []
    const client = {
      im: { image: { create: async (req: unknown) => { calls.push(req); return { image_key: 'img_v3_x1' } } } },
    }
    const api = createFeishuApi(client as never)
    await expect(api.uploadImage(new Uint8Array([1, 2, 3]))).resolves.toBe('img_v3_x1')
    expect(calls[0]).toMatchObject({ data: { image_type: 'message' } })
    expect(((calls[0] as { data: { image: Buffer } }).data.image)).toBeInstanceOf(Buffer)
  })

  test('未返回 image_key → 抛错（缺权限/超限）', async () => {
    const client = { im: { image: { create: async () => null } } }
    const api = createFeishuApi(client as never)
    await expect(api.uploadImage(new Uint8Array([1]))).rejects.toThrow('image_key')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-api`
Expected: FAIL（uploadImage 不存在）

- [ ] **Step 3: 实现**

`api.ts` 接口加：

```ts
  /** 上传图片到消息资源库（im/v1 images，image_type=message），返回 image_key。 */
  uploadImage(data: Uint8Array): Promise<string>
```

`createFeishuApi` 返回对象加（放 uploadFile 之后）：

```ts
    async uploadImage(data) {
      const res = await client.im.image.create({ data: { image_type: 'message', image: Buffer.from(data) } })
      // 与 uploadFile 同款：SDK 响应拦截器后再剥一层信封，resolve 的是内层 { image_key }。
      const imageKey = res?.image_key
      if (typeof imageKey !== 'string' || imageKey.length === 0) {
        throw new Error('图片上传失败：飞书接口未返回 image_key（可能缺 im:resource 权限、图片超 10 MB 或为空图片）')
      }
      return imageKey
    },
```

- [ ] **Step 4: 补两个 FeishuApi 全实现假件的 stub**

`feishu-reply.test.ts` 假件（calls 记录风格）加：

```ts
    uploadImage: async (...args) => { calls.push({ op: 'uploadImage', args }); return 'img_v3_fake' },
```

`feishu-stream-integrity.test.ts` 假件加：

```ts
    uploadImage: async () => 'img_v3_fake',
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-api`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/channels/feishu/api.ts packages/toolkit/src/channels/feishu/feishu-api.test.ts packages/toolkit/src/channels/feishu/feishu-reply.test.ts packages/toolkit/src/channels/feishu/feishu-stream-integrity.test.ts
git commit -m "feat(feishu): FeishuApi.uploadImage（im/v1 images 上传换 image_key）"
```

---

### Task 2: 净化纯函数（images.ts 上半）

**Files:**
- Create: `packages/toolkit/src/channels/feishu/images.ts`
- Test: `packages/toolkit/src/channels/feishu/feishu-images.test.ts`

**Interfaces:**
- Consumes: `TurnSegment`（`../channel.ts`）。
- Produces（Task 4/5 消费）：
  - `type ImageResolution = { status: 'ready'; imgKey: string } | { status: 'pending' } | { status: 'failed' }`
  - `type ImageLookup = (localPath: string) => ImageResolution`
  - `IMAGE_ALT_MAX_CHARS = 50`
  - `sanitizeText(text: string, lookup: ImageLookup): string`
  - `sanitizeSegments(segments: readonly TurnSegment[], lookup: ImageLookup): TurnSegment[]`
  - `stripImages(text: string): string`

- [ ] **Step 1: 写失败测试**

新建 `feishu-images.test.ts`：

```ts
/** 出站图片净化纯函数契约：完整引用三态转换、img_v* 幂等、外部形态降级、不完整尾部放行。 */
import { describe, expect, test } from 'vitest'
import { sanitizeSegments, sanitizeText, stripImages, type ImageLookup } from './images.ts'

const ready: ImageLookup = () => ({ status: 'ready', imgKey: 'img_v3_ok' })
const pending: ImageLookup = () => ({ status: 'pending' })
const failed: ImageLookup = () => ({ status: 'failed' })

describe('sanitizeText', () => {
  test('无图片文本恒等', () => {
    expect(sanitizeText('普通 **markdown** [链接](https://a.b/c)', ready)).toBe('普通 **markdown** [链接](https://a.b/c)')
  })

  test('本地路径 ready → ![alt](img_key)（尖括号与裸形态）', () => {
    expect(sanitizeText('见下图 ![chart](<C:\\work\\my chart.png>) 完', ready)).toBe('见下图 ![chart](img_v3_ok) 完')
    expect(sanitizeText('![图](out/a.png)', ready)).toBe('![图](img_v3_ok)')
  })

  test('pending → 上传中占位；failed → 无法发送', () => {
    expect(sanitizeText('![chart](a.png)', pending)).toBe('🖼 chart（图片上传中…）')
    expect(sanitizeText('![chart](a.png)', failed)).toBe('🖼 chart（图片无法发送）')
  })

  test('空 alt 用「图片」；alt 截断 50 code point', () => {
    expect(sanitizeText('![](a.png)', pending)).toBe('🖼 图片（图片上传中…）')
    const longAlt = '字'.repeat(60)
    expect(sanitizeText(`![${longAlt}](a.png)`, failed)).toBe(`🖼 ${'字'.repeat(50)}（图片无法发送）`)
  })

  test('img_v* dest 原样保留（幂等）', () => {
    expect(sanitizeText('![chart](img_v3_abc)', ready)).toBe('![chart](img_v3_abc)')
  })

  test('http(s)/data URI 降级为无法发送', () => {
    expect(sanitizeText('![x](https://a.b/c.png)', ready)).toBe('🖼 x（图片无法发送）')
    expect(sanitizeText('![x](data:image/png;base64,AA==)', ready)).toBe('🖼 x（图片无法发送）')
  })

  test('不完整尾部引用原样放行（流式中间态）', () => {
    expect(sanitizeText('正文 ![chart](<C:\\work\\my', pending)).toBe('正文 ![chart](<C:\\work\\my')
    expect(sanitizeText('正文 ![chart]', pending)).toBe('正文 ![chart]')
  })

  test('同段多图各自独立转换', () => {
    expect(sanitizeText('![a](1.png) 中 ![b](2.png)', ready)).toBe('![a](img_v3_ok) 中 ![b](img_v3_ok)')
  })
})

describe('sanitizeSegments', () => {
  test('text 与 process 段同规则净化', () => {
    const out = sanitizeSegments([
      { kind: 'text', content: '![a](1.png)' },
      { kind: 'process', content: '想 ![b](2.png)' },
    ], ready)
    expect(out).toEqual([
      { kind: 'text', content: '![a](img_v3_ok)' },
      { kind: 'process', content: '想 ![b](img_v3_ok)' },
    ])
  })
})

describe('stripImages', () => {
  test('剥离图片语法留 alt 纯文本；不完整引用不动', () => {
    expect(stripImages('见 ![chart](a.png) 完 ![x](<b c.png>)')).toBe('见 chart 完 x')
    expect(stripImages('尾部 ![chart](<C:\\work')).toBe('尾部 ![chart](<C:\\work')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-images`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 images.ts（净化半）**

新建 `packages/toolkit/src/channels/feishu/images.ts`：

```ts
/** 出站图片渠道适配：markdown 图片引用净化（纯函数）+ 本地图片上传换 img_key（ImageResolver）。 */
import type { TurnSegment } from '../channel.ts'

/** 一张图片引用在卡片中的呈现状态。 */
export type ImageResolution =
  | { status: 'ready'; imgKey: string }
  | { status: 'pending' }
  | { status: 'failed' }

/** 净化期查询本地路径解析状态的端口（ImageResolver 实现；imageUpload 关闭时以恒 failed 替代）。 */
export type ImageLookup = (localPath: string) => ImageResolution

/** alt 进占位/降级文案的截断上限（code point）。 */
export const IMAGE_ALT_MAX_CHARS = 50

/** 完整 markdown 图片引用：![alt](dest)，dest 支持尖括号与裸形态；不完整引用（无闭合括号）不匹配、原样放行。 */
const IMAGE_REF = /!\[([^\]\n]*)\]\((<[^>\n]*>|[^)\s]+)\)/g

const truncateAlt = (alt: string): string => {
  const chars = [...alt]
  return chars.length <= IMAGE_ALT_MAX_CHARS ? alt : chars.slice(0, IMAGE_ALT_MAX_CHARS).join('')
}

const uploadingText = (alt: string): string => `🖼 ${truncateAlt(alt) || '图片'}（图片上传中…）`
const failedText = (alt: string): string => `🖼 ${truncateAlt(alt) || '图片'}（图片无法发送）`

/** 把文本中完整图片引用转换为飞书卡片合法形态：img_v* 原样保留；http(s)/data 降级；本地路径按 lookup 三态转换。 */
export function sanitizeText(text: string, lookup: ImageLookup): string {
  return text.replace(IMAGE_REF, (match: string, alt: string, rawDest: string) => {
    const dest = rawDest.startsWith('<') ? rawDest.slice(1, -1) : rawDest
    if (dest.startsWith('img_v')) return match
    if (/^(?:https?:\/\/|data:)/i.test(dest)) return failedText(alt)
    const resolution = lookup(dest)
    if (resolution.status === 'ready') return `![${truncateAlt(alt)}](${resolution.imgKey})`
    if (resolution.status === 'pending') return uploadingText(alt)
    return failedText(alt)
  })
}

/** 200570 兜底：剥离全部完整图片语法，alt 降级为纯文本。 */
export function stripImages(text: string): string {
  return text.replace(IMAGE_REF, (_match: string, alt: string) => alt)
}

/** 段序列净化：text 与 process 段同规则（reasoning 也可能复述图片语法）。 */
export function sanitizeSegments(segments: readonly TurnSegment[], lookup: ImageLookup): TurnSegment[] {
  return segments.map((s) => ({ kind: s.kind, content: sanitizeText(s.content, lookup) }))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-images`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/feishu/images.ts packages/toolkit/src/channels/feishu/feishu-images.test.ts
git commit -m "feat(feishu): 出站图片净化纯函数（sanitizeText/sanitizeSegments/stripImages）"
```

---

### Task 3: ImageResolver（images.ts 下半）

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/images.ts`
- Test: `packages/toolkit/src/channels/feishu/feishu-images.test.ts`

**Interfaces:**
- Consumes: `FeishuApi.uploadImage`（Task 1）、`sniffImageMediaType`（`./api.ts` 已有导出）。
- Produces（Task 4 消费）：
  - `IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024`
  - `class ImageResolver { constructor(api: FeishuApi, projectRoot: string, onSettled: () => void, maxBytes?: number); resolve(localPath: string): ImageResolution }`（实现隐含端口：reply 只依赖 `resolve` 方法签名）

- [ ] **Step 1: 写失败测试**

`feishu-images.test.ts` 追加（fixture 用临时目录真实文件；1x1 PNG 字节常量）：

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageResolver, IMAGE_UPLOAD_MAX_BYTES, type ImageResolution } from './images.ts'
import type { FeishuApi } from './api.ts'

const PNG_1PX = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))

function fakeApi(impl: (data: Uint8Array) => Promise<string>): { api: FeishuApi; uploads: Uint8Array[] } {
  const uploads: Uint8Array[] = []
  const api = { uploadImage: async (data: Uint8Array) => { uploads.push(data); return impl(data) } } as unknown as FeishuApi
  return { api, uploads }
}

// 条件等待：轮询 resolve 直到非 pending（readFile 走线程池，微任务循环不足以等真实 I/O）
const waitSettled = async (r: ImageResolver, path: string): Promise<ImageResolution> => {
  for (let i = 0; i < 100; i++) {
    const s = r.resolve(path)
    if (s.status !== 'pending') return s
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('upload not settled in time')
}

describe('ImageResolver', () => {
  test('首次 resolve 返回 pending 并启动上传；落定后 ready + onSettled 回调', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'img-resolver-'))
    try {
      await writeFile(join(dir, 'a.png'), PNG_1PX)
      let settled = 0
      const { api, uploads } = fakeApi(async () => 'img_v3_up')
      const r = new ImageResolver(api, dir, () => { settled += 1 })
      expect(r.resolve('a.png')).toEqual({ status: 'pending' })
      expect(await waitSettled(r, 'a.png')).toEqual({ status: 'ready', imgKey: 'img_v3_up' })
      expect(uploads.length).toBe(1)
      expect(settled).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('相对路径按项目根解析；绝对路径原样；同路径共享一次上传', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'img-resolver-'))
    try {
      await writeFile(join(dir, 'a.png'), PNG_1PX)
      const { api, uploads } = fakeApi(async () => 'img_v3_up')
      const r = new ImageResolver(api, dir, () => undefined)
      r.resolve('a.png')
      r.resolve(join(dir, 'a.png'))   // 归一化后同键
      await waitSettled(r, 'a.png')
      expect(uploads.length).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('读不到/非图片/上传失败 → failed 永久定格（不重复上传），onSettled 仍回调', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'img-resolver-'))
    try {
      await writeFile(join(dir, 'not-image.txt'), new TextEncoder().encode('hello'))
      await writeFile(join(dir, 'c.png'), PNG_1PX)
      const { api, uploads } = fakeApi(async () => { throw new Error('boom') })
      const r = new ImageResolver(api, dir, () => undefined)
      expect(r.resolve('missing.png')).toEqual({ status: 'pending' })
      expect(r.resolve('not-image.txt')).toEqual({ status: 'pending' })
      expect(r.resolve('c.png')).toEqual({ status: 'pending' })
      expect(await waitSettled(r, 'missing.png')).toEqual({ status: 'failed' })
      expect(await waitSettled(r, 'not-image.txt')).toEqual({ status: 'failed' })
      expect(await waitSettled(r, 'c.png')).toEqual({ status: 'failed' })
      expect(uploads.length).toBe(1)   // missing 读文件失败、not-image 魔数不符，只有 c.png 到达上传
      r.resolve('c.png')
      await waitSettled(r, 'c.png')
      expect(uploads.length).toBe(1)   // failed 定格不重试
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('超过 maxBytes → failed 不上传', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'img-resolver-'))
    try {
      await writeFile(join(dir, 'big.png'), PNG_1PX)
      const { api, uploads } = fakeApi(async () => 'img_v3_up')
      const r = new ImageResolver(api, dir, () => undefined, 4)   // 4 字节上限，1px PNG ~70 字节
      expect(r.resolve('big.png')).toEqual({ status: 'pending' })
      expect(await waitSettled(r, 'big.png')).toEqual({ status: 'failed' })
      expect(uploads.length).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('maxBytes 默认值 = 平台 10MB', () => {
    expect(IMAGE_UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-images`
Expected: FAIL（ImageResolver 未导出）

- [ ] **Step 3: 实现 ImageResolver**

`images.ts` 顶部 import 区加：

```ts
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { sniffImageMediaType, type FeishuApi } from './api.ts'
```

文件末尾加：

```ts
/** 飞书图片上传大小上限（平台限制 10MB）。 */
export const IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024

/** 本地图片 → img_key 上传器：绝对路径归一化做缓存键，三态永久定格，落定回调触发卡片重刷。 */
export class ImageResolver {
  private readonly cache = new Map<string, ImageResolution>()

  constructor(
    private readonly api: FeishuApi,
    /** 相对路径解析基准（bot 项目根）。 */
    private readonly projectRoot: string,
    /** 上传落定（成功或失败）回调（reply 句柄重刷卡片用）。 */
    private readonly onSettled: () => void,
    private readonly maxBytes: number = IMAGE_UPLOAD_MAX_BYTES,
  ) {}

  resolve(localPath: string): ImageResolution {
    const abs = isAbsolute(localPath) ? localPath : resolvePath(this.projectRoot, localPath)
    const hit = this.cache.get(abs)
    if (hit !== undefined) return hit
    const pending: ImageResolution = { status: 'pending' }
    this.cache.set(abs, pending)
    void this.upload(abs)
    return pending
  }

  private async upload(abs: string): Promise<void> {
    let result: ImageResolution
    try {
      const data = new Uint8Array(await readFile(abs))
      if (data.byteLength === 0 || data.byteLength > this.maxBytes) throw new Error(`图片大小越界（${data.byteLength} 字节）`)
      if (sniffImageMediaType(data) === undefined) throw new Error('魔数不是受支持图片')
      result = { status: 'ready', imgKey: await this.api.uploadImage(data) }
    } catch {
      result = { status: 'failed' }
    }
    this.cache.set(abs, result)
    this.onSettled()
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-images`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/feishu/images.ts packages/toolkit/src/channels/feishu/feishu-images.test.ts
git commit -m "feat(feishu): ImageResolver 本地图片上传换 img_key（path 级缓存三态）"
```

---

### Task 4: reply.ts 净化接线 + 上传落定重刷

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/reply.ts`
- Test: `packages/toolkit/src/channels/feishu/feishu-reply.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ImageResolution`/`ImageLookup`/`sanitizeSegments`/`stripImages`，Task 3 的 resolver 形态（`{ resolve(localPath: string): ImageResolution }`）。
- Produces（Task 6 消费）：
  - `FeishuReplyHandle` 构造函数末尾新增可选参数 `resolver?: ImageResolverPort`
  - `FeishuReplyHandle.notifyImageSettled(): void`
  - `ImageResolverPort`（在 images.ts 导出）：`interface ImageResolverPort { resolve(localPath: string): ImageResolution }`

- [ ] **Step 1: images.ts 补 ImageResolverPort 端口 + ImageResolver 显式 implements**

`images.ts` 加（ImageLookup 定义之后）：

```ts
/** reply 句柄消费的上传器窄端口（imageUpload 关闭时缺席 → 恒 failed 降级）。 */
export interface ImageResolverPort {
  resolve(localPath: string): ImageResolution
}
```

`export class ImageResolver implements ImageResolverPort`。

- [ ] **Step 2: 写失败测试**

`feishu-reply.test.ts` 追加。该文件既有模式：顶部 `TUNABLES` 字面量、`vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync(500)` 推节流、构造形如 `new FeishuReplyHandle(api, 'oc_1', undefined, tunables, log)`。新测试用以下辅助（加在文件内）：

```ts
// 推一次节流 flush（本文件既有用法，抽名便于图片用例阅读）
const flushReply = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(500) }

// 最后一次 updateCardElement 的 content（签名 cardId, elementId, content, sequence）
function lastUpdateContent(calls: { op: string; args: unknown[] }[]): string {
  const ups = calls.filter((c) => c.op === 'updateCardElement')
  return String(ups[ups.length - 1]!.args[2])
}

// 构造带 resolver 的 reply（TUNABLES 复用文件顶部常量）
function makeReplyWithResolver(resolver?: ImageResolverPort): { reply: FeishuReplyHandle; calls: { op: string; args: unknown[] }[] } {
  const calls: { op: string; args: unknown[] }[] = []
  const api = fakeApi(calls)   // 沿用文件既有 fakeApi 工厂名（若实际名不同，以本文件既有工厂为准）
  const reply = new FeishuReplyHandle(api, 'oc_1', undefined, TUNABLES, () => undefined, undefined, resolver)
  return { reply, calls }
}
```

```ts
describe('出站图片净化', () => {
  const fakeResolver = (states: Record<string, ImageResolution>): ImageResolverPort => ({
    resolve: (p) => states[p] ?? { status: 'failed' },
  })

  test('ready 引用进卡为 img_key；failed 降级纯文本；无 resolver 全降级', async () => {
    const ready = makeReplyWithResolver(fakeResolver({ 'a.png': { status: 'ready', imgKey: 'img_v3_ok' } }))
    await ready.reply.update([{ kind: 'text', content: '见 ![chart](a.png) 完' }])
    await flushReply()
    expect(lastUpdateContent(ready.calls)).toBe('见 ![chart](img_v3_ok) 完')

    const failed = makeReplyWithResolver(fakeResolver({}))
    await failed.reply.update([{ kind: 'text', content: '![chart](a.png)' }])
    await flushReply()
    expect(lastUpdateContent(failed.calls)).toBe('🖼 chart（图片无法发送）')

    const none = makeReplyWithResolver(undefined)
    await none.reply.update([{ kind: 'text', content: '![chart](a.png)' }])
    await flushReply()
    expect(lastUpdateContent(none.calls)).toBe('🖼 chart（图片无法发送）')
  })

  test('notifyImageSettled：上传落定后触发 flush，占位刷为 img_key；finalize 后空操作', async () => {
    const states: Record<string, ImageResolution> = { 'a.png': { status: 'pending' } }
    const { reply, calls } = makeReplyWithResolver(fakeResolver(states))
    await reply.update([{ kind: 'text', content: '![chart](a.png)' }])
    await flushReply()
    expect(lastUpdateContent(calls)).toBe('🖼 chart（图片上传中…）')
    states['a.png'] = { status: 'ready', imgKey: 'img_v3_late' }
    reply.notifyImageSettled()
    await flushReply()
    expect(lastUpdateContent(calls)).toBe('![chart](img_v3_late)')

    await reply.finalize('done')
    const before = calls.length
    reply.notifyImageSettled()
    await flushReply()
    expect(calls.length).toBe(before)
  })

  test('整卡重放（finalize replace）用净化后内容', async () => {
    const { reply, calls } = makeReplyWithResolver(fakeResolver({ 'a.png': { status: 'ready', imgKey: 'img_v3_ok' } }))
    await reply.update([{ kind: 'text', content: '见 ![chart](a.png)' }])
    await flushReply()
    await reply.finalize('done')
    const replace = calls.find((c) => c.op === 'replaceCard')
    expect(JSON.stringify(replace?.args)).toContain('img_v3_ok')
    expect(JSON.stringify(replace?.args)).not.toContain('a.png')
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-reply`
Expected: FAIL（构造参数/方法不存在）

- [ ] **Step 4: 实现 reply.ts 接线**

import 区加：

```ts
import { sanitizeSegments, stripImages, type ImageLookup, type ImageResolverPort } from './images.ts'
```

构造函数末尾加参数：

```ts
    /** 出站图片上传器（缺席 = 图片引用一律降级文案）。 */
    private readonly resolver?: ImageResolverPort,
```

类内加：

```ts
  /** 200570 兜底：命中后本句柄余下输出一律剥离图片语法（净化层漏网的防御纵深）。 */
  private stripAllImages = false

  /** 卡片用段序列：原始 segments 经净化（200570 命中后整体剥离）。 */
  private sanitizedSegments(): readonly TurnSegment[] {
    if (this.stripAllImages) return this.segments.map((s) => ({ ...s, content: stripImages(s.content) }))
    const lookup: ImageLookup = (p) => this.resolver?.resolve(p) ?? { status: 'failed' }
    return sanitizeSegments(this.segments, lookup)
  }

  /** 图片上传落定回调（resolver 传入）：未 finalize 时触发一次 flush，占位刷为正显/降级。 */
  notifyImageSettled(): void {
    if (this.finalized) return
    this.flush()
  }
```

改三处规划点的 segments 来源：

- `flush()`：`planSync(this.state, this.sanitizedSegments(), ...)`
- `exec()` 重规划行：`pending = planSync(this.state, this.sanitizedSegments(), ...).ops`
- `finalize()`：`planFinalize(this.state, status, this.sanitizedSegments(), this.tunables.processMaxBytes)`
- `breakCard()`：`buildClosedCardJson(cardSegs, this.sanitizedSegments(), tail, STATUS_BREAK, this.tunables.processMaxBytes)`

（`this.segments` 始终存 outbound 给的原始段；`closeCard` 内 `buildClosedCardJson` 用的 segments 是 planSync 入参即净化后内容，天然一致。）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-reply`
Expected: PASS（含既有全部用例——净化对无图片文本恒等）

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/channels/feishu/reply.ts packages/toolkit/src/channels/feishu/images.ts packages/toolkit/src/channels/feishu/feishu-reply.test.ts
git commit -m "feat(feishu): reply 净化接线 + 上传落定重刷（占位→img_key）"
```

---

### Task 5: 200570 兜底（剥离重规划，不 abandon）

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/reply.ts`
- Test: `packages/toolkit/src/channels/feishu/feishu-reply.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `stripAllImages`/`sanitizedSegments`、`feishuErrorCode`。
- Produces: `execOne` 返回值联合加 `'replan'`（reply.ts 内部类型，不外泄）。

- [ ] **Step 1: 写失败测试**

`feishu-reply.test.ts` 追加（`makeReplyWithResolver`/`flushReply`/`lastUpdateContent` 为 Task 4 引入的辅助；axios 形态错误与 `feishuErrorCode` 提取对齐）：

```ts
function feishuError(code: number): Error {
  const e = new Error(`feishu ${code}`)
  ;(e as unknown as { response: { data: { code: number } } }).response = { data: { code } }
  return e
}

test('200570：剥离图片语法重规划，不 abandon 不建新卡，流式继续', async () => {
  // 净化层漏网形态 = img_v* 原样放行但 key 非法（幂等规则的固有缝隙）。
  // fake api：update/insert 内容含 "img_v3_bogus" 时抛 200570，其余正常
  const calls: { op: string; args: unknown[] }[] = []
  const api = fakeApi(calls)
  const guard = (content: unknown): void => {
    if (typeof content === 'string' && content.includes('img_v3_bogus')) throw feishuError(200570)
  }
  const guarded: FeishuApi = {
    ...api,
    updateCardElement: async (cardId, elementId, content, sequence) => { guard(content); await api.updateCardElement(cardId, elementId, content, sequence) },
    insertElement: async (cardId, elementJson, target, sequence) => { guard(elementJson); await api.insertElement(cardId, elementJson, target, sequence) },
  }
  const reply = new FeishuReplyHandle(guarded, 'oc_1', undefined, TUNABLES, () => undefined)
  await reply.update([{ kind: 'text', content: '前文 ![chart](img_v3_bogus) 后文' }])
  await flushReply()
  await reply.update([{ kind: 'text', content: '前文 ![chart](img_v3_bogus) 后文 追加' }])
  await flushReply()
  // 无新卡（createCard 只调一次）、无废弃提示、最终卡内容无图片语法
  expect(calls.filter((c) => c.op === 'createCard').length).toBe(1)
  expect(calls.some((c) => c.op === 'sendText' && String(c.args[1]).includes('卡片输出异常'))).toBe(false)
  const last = lastUpdateContent(calls)
  expect(last).not.toContain('![')
  expect(last).not.toContain('img_v3_bogus')
  expect(last).toContain('chart')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-reply`
Expected: FAIL（现状走未知错误重放 → abandon → 新卡）

- [ ] **Step 3: 实现**

`execOne` 返回类型改 `Promise<'ok' | 'abandoned' | 'replan'>`；catch 内 200860 分支之后、未知错误兜底之前加：

```ts
      if (code === 200570 && !this.stripAllImages) {
        // 确定性内容校验失败（非法 image key）：op 未被应用；净化层漏网才走到这。
        // 剥离图片语法从确认点重规划——不 abandon：换卡重放同样内容必然再失败。
        this.stripAllImages = true
        this.log('[project-bot] 卡片内容含非法图片引用，已剥离图片语法继续（200570）')
        return 'replan'
      }
```

`exec()` 循环改为把 `'replan'` 与 `'abandoned'` 同等触发重规划（重规划行已在 Task 4 换成 `sanitizedSegments()`；计数上限沿用 MAX_ABANDON_PER_FLUSH 兜底防死循环）：

```ts
      for (const planned of pending) {
        const outcome = await this.execOne(planned)
        if (outcome === 'abandoned' || outcome === 'replan') {
          abandoned = true
          break
        }
      }
```

`finalize()` 定格批的早退条件同步扩：`(await this.execOne(...)) === 'abandoned'` 保持原样即可（定格批 op 为 status/settings/replace，replace 走独立分支已带 notice 兜底；'replan' 落在 for 循环里自然继续下一个 op，不影响）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- feishu-reply feishu-stream-integrity`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/feishu/reply.ts packages/toolkit/src/channels/feishu/feishu-reply.test.ts
git commit -m "fix(feishu): 200570 剥离图片语法重规划，根治非法图片引用断流循环"
```

---

### Task 6: Config/tunables/渠道接线

**Files:**
- Modify: `packages/toolkit/src/channels/channel.ts`（ChannelTunables 加字段）
- Modify: `packages/toolkit/src/channels/feishu/index.ts`（构造 resolver 注入 reply）
- Modify: `packages/toolkit/src/bots/index.ts`（BotsModuleConfig + tunables 接线）
- Modify: `packages/toolkit/src/index.ts`（Config schema + 默认字面量）
- Modify（tunables 字面量补字段）: `packages/toolkit/src/bots/index.test.ts`、`packages/toolkit/src/bots/smoke.test.ts`、`packages/toolkit/src/channels/runtime.test.ts`、`packages/toolkit/src/channels/feishu/feishu-reply.test.ts`、`packages/toolkit/src/channels/feishu/feishu-stream-integrity.test.ts`

**Interfaces:**
- Consumes: Task 3 `ImageResolver`、Task 4 reply 构造参数。
- Produces: `ChannelTunables.imageUpload: boolean`（必填）；`BotsModuleConfig.imageUpload: boolean`；Config `feishu.imageUpload`（默认 true）。

- [ ] **Step 1: 写失败测试**

`feishu-reply.test.ts` 已有覆盖无 resolver 降级；本任务新增渠道接线测试（`feishu-stream-integrity.test.ts` 或新 describe）：`imageUpload:false` 时 reply 行为 = 全降级（覆盖构造分支）。另 `index.test.ts` 加 Config 默认值断言：

```ts
test('Config 默认值含 feishu.imageUpload=true', () => {
  const config = Config({}) as { feishu: { imageUpload: boolean } }
  expect(config.feishu.imageUpload).toBe(true)
})
```

（先读 `index.test.ts` 既有 Config 断言写法并对齐。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- index.test`
Expected: FAIL

- [ ] **Step 3: 实现接线**

`channel.ts` ChannelTunables 加：

```ts
  /** 出站图片上传正显开关（false = 图片引用一律降级文案；见 Config feishu.imageUpload）。 */
  imageUpload: boolean
```

`bots/index.ts` BotsModuleConfig 加：

```ts
  /** 出站图片上传正显（本地路径图片上传飞书换 img_key 内嵌卡片；false 降级文案）。 */
  imageUpload: boolean
```

tunables 构造加 `imageUpload: config.imageUpload,`。

`src/index.ts` feishu schema 加（debugLogRetentionDays 后）：

```ts
    /** 出站图片上传正显开关（false = 一律降级文案，无 im:resource 权限的应用可关）。 */
    imageUpload: z.boolean().default(true),
```

默认字面量加 `imageUpload: true,`；schema 注释串「18 个全局可调参数」改「19 个」。

`feishu/index.ts` dispatcher 内构造 reply 处改：

```ts
        let reply!: FeishuReplyHandle
        const resolver = tunables.imageUpload
          ? new ImageResolver(api, bot.record.project, () => reply.notifyImageSettled())
          : undefined
        reply = new FeishuReplyHandle(api, parsed.chatId, parsed.threadId !== undefined ? parsed.messageId : undefined, tunables, log, tunables.debugLog, resolver)
```

（import 加 `ImageResolver`；`let reply!` 延迟赋值：onSettled 回调只会异步触发，构造期不调用。）

- [ ] **Step 4: 修 tunables 字面量测试文件**

五个测试文件的 ChannelTunables/BotsModuleConfig 字面量各加 `imageUpload: true`（feishu-reply 既有用例不需要上传行为时用 true 配无 resolver 即可——无 resolver 恒降级，与旧行为等价）。

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `pnpm --filter dsh-agent-toolkit test; pnpm --filter dsh-agent-toolkit typecheck`
Expected: 全 PASS + typecheck 干净

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src
git commit -m "feat(feishu): feishu.imageUpload 配置接线（resolver 注入 reply）"
```

---

### Task 7: 文档与全量门禁

**Files:**
- Modify: `docs/domains/feishu.md`

- [ ] **Step 1: 域文档更新**

`docs/domains/feishu.md` 出站段落追加一条事实（照该文件现有行文风格）：

- 出站图片渠道适配（0.4.x 起）：正文/过程区 markdown 图片引用出站前经净化——本地路径经 `ImageResolver` 上传飞书换 img_key 内嵌正显（流式期先占位「🖼 上传中…」，上传落定触发 flush 刷新）；http(s)/data URI/上传失败一律降级纯文本「🖼 无法发送」；`feishu.imageUpload` 开关默认 true（无 im:resource 权限可关）。错误治理补 200570（非法 image key）：剥离图片语法从确认点重规划，不 abandon（换卡重放同内容必再失败）。

- [ ] **Step 2: 全量门禁**

Run:
```
pnpm --filter dsh-agent-toolkit test
pnpm --filter dsh-agent-toolkit typecheck
pnpm --filter dsh-agent-toolkit bundle
```
Expected: 测试全绿（907+ 新增）、typecheck 干净、bundle 成功

- [ ] **Step 3: 实机验收（手动，用户参与）**

dev 回路（`pnpm dsh web --patch cordis.yml`，插件 link 已装）让 bot 产一张 PNG 并在正文输出 `![chart](<路径>)`：
1. 飞书端先看到「🖼 chart（图片上传中…）」占位
2. 1-2 秒后占位刷为内嵌图片
3. 流式全程不中断，定格 ✅ 输出完成
4. `~/.dsh/logs/feishu-debug/` 当天 jsonl 无 200570

- [ ] **Step 4: Commit**

```bash
git add docs/domains/feishu.md
git commit -m "docs(feishu): 出站图片渠道适配与 200570 治理"
```
