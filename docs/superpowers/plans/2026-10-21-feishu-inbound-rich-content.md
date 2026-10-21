# 飞书入站富文本内容保真实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飞书 post 富文本不再丢失代码块/链接 URL/标题/附件，不支持的消息类型回提示，全部丢弃行为写 debugLog。

**Architecture:** 转换逻辑内聚在 `packages/toolkit/src/channels/feishu/parse.ts`（纯函数 + 可选 DebugSink）；`parseMessageEvent` 返回三态联合 `ParseResult`；渠道层 `feishu/index.ts` 对 `unsupported` 直接回文本提示，核心层（Inbound/Router）零改动。

**Tech Stack:** TypeScript + Vitest（pnpm --filter dsh-agent-toolkit）。

**Spec:** `docs/superpowers/specs/2026-10-21-feishu-inbound-rich-content-design.md`

## Global Constraints

- 解析层保持纯函数：无副作用、可注入 sink，测试全部落在 `feishu-parse.test.ts`
- debugLog 事件名：`feishu.parse.skip-tag` / `feishu.parse.unsupported` / `feishu.parse.ignored`
- 不支持类型提示文案（逐字）：file →「暂不支持文件消息，请发送文字或截图」；media →「暂不支持视频消息」；audio →「暂不支持语音消息」；merge_forward →「暂不支持合并转发消息」；未知 →「暂不支持该类型消息（<messageType>）」
- sticker 静默跳过（只写 `feishu.parse.ignored`），不回提示
- 代码不改 `packages/toolkit/src/channels/` 下除 `feishu/parse.ts`、`feishu/index.ts` 外的文件；核心层接口不动
- 每任务完成后跑 `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-parse.test.ts`；收尾跑全量 `pnpm --filter dsh-agent-toolkit test`、`pnpm --filter dsh-agent-toolkit typecheck`、`pnpm --filter dsh-agent-toolkit bundle`

---

### Task 1: ParseResult 三态联合 + sink 参数 + unsupported/sticker 分派

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/parse.ts`
- Test: `packages/toolkit/src/channels/feishu/feishu-parse.test.ts`

**Interfaces:**
- Produces（后续任务依赖）：
  - `export type ParseResult = { kind: 'message'; message: ParsedMessage } | { kind: 'unsupported'; unsupported: ParsedUnsupported }`
  - `export interface ParsedUnsupported { messageId: string; chatId: string; chatType: 'p2p' | 'group'; userId: string; messageType: string; threadId?: string }`
  - `export function parseMessageEvent(data: unknown, botOpenId: string, sink?: DebugSink): ParseResult | null`
  - `export function unsupportedNoticeText(messageType: string): string`
- Consumes：`DebugSink` 类型来自 `../channel.ts`

- [ ] **Step 1: 先更新既有测试适配新返回类型（此时实现未改，测试应全红）**

`feishu-parse.test.ts` 顶部加解包助手，既有断言统一改为经它取值：

```ts
import { describe, expect, test } from 'vitest'
import { MessageDedup, parseMessageEvent, parseRecallEvent } from './parse.ts'
import type { ParsedMessage, ParseResult } from './parse.ts'

/** 断言结果是 message 形态并取出。 */
function expectMessage(result: ParseResult | null): ParsedMessage {
  if (result === null || result.kind !== 'message') {
    throw new Error(`expected message, got ${JSON.stringify(result)}`)
  }
  return result.message
}
```

既有断言的机械改造规则（全文件适用）：
- `expect(parseMessageEvent(e, BOT)).toEqual({...})` → `expect(expectMessage(parseMessageEvent(e, BOT))).toEqual({...})`
- `expect(parseMessageEvent(e, BOT)).toMatchObject({...})` → 同样包 `expectMessage(...)`
- `.toBeNull()` 断言不变
- 文件末尾两个 threadId 测试：`const parsed = parseMessageEvent(event, BOT)` → `const parsed = expectMessage(parseMessageEvent(event, BOT))`，后续 `parsed?.threadId` 改 `parsed.threadId`

注意「图片+文字（post）」用例（当前断言 `text: '帮我看 链接文字\n第二段'`、title 被忽略）在 Task 2 会再改，本任务先按现状期望值适配。

- [ ] **Step 2: 写 unsupported / sticker 的失败测试**

追加到 `describe('parseMessageEvent')` 内：

```ts
  test('不支持的消息类型 → unsupported 标记（字段完整，threadId 透传）', () => {
    for (const messageType of ['file', 'media', 'audio', 'merge_forward']) {
      const result = parseMessageEvent(event({
        message: {
          message_id: `om_${messageType}`, chat_id: 'oc_1', chat_type: 'p2p',
          message_type: messageType, content: '{}', mentions: [],
        },
      }), BOT)
      expect(result).toEqual({
        kind: 'unsupported',
        unsupported: {
          messageId: `om_${messageType}`, chatId: 'oc_1', chatType: 'p2p',
          userId: 'ou_u1', messageType,
        },
      })
    }
    // 未知类型同样 unsupported
    const unknown = parseMessageEvent(event({
      message: { message_id: 'om_u', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'hongbao', content: '{}', mentions: [] },
    }), BOT)
    expect(unknown).toMatchObject({ kind: 'unsupported', unsupported: { messageType: 'hongbao' } })
    // 话题内 unsupported 透传 threadId
    const threaded = parseMessageEvent(event({
      message: {
        message_id: 'om_ut', chat_id: 'oc_g', chat_type: 'group', message_type: 'file',
        thread_id: 'omt_1', content: '{}', mentions: [mention('bot', BOT)],
      },
    }), BOT)
    expect(threaded).toMatchObject({ kind: 'unsupported', unsupported: { threadId: 'omt_1' } })
  })

  test('群消息未 @机器人：unsupported 类型也不回提示（null）', () => {
    expect(parseMessageEvent(event({
      message: { message_id: 'om_f', chat_id: 'oc_g', chat_type: 'group', message_type: 'file', content: '{}', mentions: [] },
    }), BOT)).toBeNull()
  })

  test('sticker → null + feishu.parse.ignored 日志', () => {
    const events: { event: string; [key: string]: unknown }[] = []
    const sink = (e: { event: string; [key: string]: unknown }): void => { events.push(e) }
    const result = parseMessageEvent(event({
      message: { message_id: 'om_s', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'sticker', content: '{}', mentions: [] },
    }), BOT, sink)
    expect(result).toBeNull()
    expect(events).toEqual([{ event: 'feishu.parse.ignored', reason: 'sticker', messageId: 'om_s', chatId: 'oc_1' }])
  })

  test('群消息未 @机器人：sticker 也不写 ignored 日志（先过滤）', () => {
    const events: { event: string; [key: string]: unknown }[] = []
    parseMessageEvent(event({
      message: { message_id: 'om_s2', chat_id: 'oc_g', chat_type: 'group', message_type: 'sticker', content: '{}', mentions: [] },
    }), BOT, (e) => { events.push(e) })
    expect(events).toEqual([])
  })
```

`unsupportedNoticeText` 的测试（Task 4 用它，此处先测）：

```ts
describe('unsupportedNoticeText', () => {
  test('各类型文案', () => {
    expect(unsupportedNoticeText('file')).toBe('暂不支持文件消息，请发送文字或截图')
    expect(unsupportedNoticeText('media')).toBe('暂不支持视频消息')
    expect(unsupportedNoticeText('audio')).toBe('暂不支持语音消息')
    expect(unsupportedNoticeText('merge_forward')).toBe('暂不支持合并转发消息')
    expect(unsupportedNoticeText('hongbao')).toBe('暂不支持该类型消息（hongbao）')
  })
})
```

import 行补上 `unsupportedNoticeText`。

- [ ] **Step 3: 跑测试确认新测试失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-parse.test.ts`
Expected: 新增 4 个测试 FAIL（`parseMessageEvent` 返回旧形态 / `unsupportedNoticeText` 不存在），改造后的既有测试也 FAIL（返回形态变了——说明改造方向正确）

- [ ] **Step 4: 实现 parse.ts 改造**

`parse.ts` 顶部 import 加类型：`import type { DebugSink } from '../channel.ts'`

在 `ParsedMessage` 之后追加：

```ts
/** 不支持的消息类型标记（渠道层据此回提示，不进核心）。 */
export interface ParsedUnsupported {
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  userId: string
  messageType: string
  /** 话题群消息的话题 ID；非话题缺席。 */
  threadId?: string
}

/** parseMessageEvent 三态：可入核心的消息 / 不支持的类型（渠道回提示） / null（忽略）。 */
export type ParseResult =
  | { kind: 'message'; message: ParsedMessage }
  | { kind: 'unsupported'; unsupported: ParsedUnsupported }

/** unsupported 消息的用户提示文案（渠道层直接回发）。 */
export function unsupportedNoticeText(messageType: string): string {
  switch (messageType) {
    case 'file': return '暂不支持文件消息，请发送文字或截图'
    case 'media': return '暂不支持视频消息'
    case 'audio': return '暂不支持语音消息'
    case 'merge_forward': return '暂不支持合并转发消息'
    default: return `暂不支持该类型消息（${messageType}）`
  }
}
```

`parseMessageEvent` 改签名与分派（其余守卫逻辑不变，注意顺序：sender/userId/msg 基本守卫 → message_type 为 string → message_id/chat_id/chat_type → 群 @ 校验 → 按类型分派）：

```ts
export function parseMessageEvent(data: unknown, botOpenId: string, sink?: DebugSink): ParseResult | null {
  const wrapped = data as { event?: RawEvent } & RawEvent
  const event: RawEvent = wrapped.event ?? wrapped
  if (event.sender?.sender_type !== 'user') return null
  const userId = event.sender.sender_id?.open_id
  const msg = event.message
  if (typeof userId !== 'string' || msg === undefined) return null
  if (typeof msg.message_type !== 'string') return null
  if (typeof msg.message_id !== 'string' || typeof msg.chat_id !== 'string') return null
  if (msg.chat_type !== 'p2p' && msg.chat_type !== 'group') return null
  if (msg.chat_type === 'group'
    && !(msg.mentions ?? []).some((m) => m.mentioned_type === 'bot' && m.id?.open_id === botOpenId)) return null

  const threadId = typeof msg.thread_id === 'string' && msg.thread_id.length > 0 ? msg.thread_id : undefined
  const withThread = threadId !== undefined ? { threadId } : {}

  if (msg.message_type !== 'text' && msg.message_type !== 'post' && msg.message_type !== 'image') {
    if (msg.message_type === 'sticker') {
      // 表情贴图无语义价值：静默跳过，仅留日志可反查。
      sink?.({ event: 'feishu.parse.ignored', reason: 'sticker', messageId: msg.message_id, chatId: msg.chat_id })
      return null
    }
    return {
      kind: 'unsupported',
      unsupported: { messageId: msg.message_id, chatId: msg.chat_id, chatType: msg.chat_type, userId, messageType: msg.message_type, ...withThread },
    }
  }
  if (typeof msg.content !== 'string') return null

  let text = ''
  let imageKeys: string[] = []
  if (msg.message_type === 'text') {
    // ...（现状 text 分支不变）
  } else if (msg.message_type === 'post') {
    // ...（现状 post 分支不变，Task 2/3 再增强 parsePostContent）
  } else {
    // ...（现状 image 分支不变）
  }
  if (text.length === 0 && imageKeys.length === 0) return null

  return {
    kind: 'message',
    message: { messageId: msg.message_id, chatId: msg.chat_id, chatType: msg.chat_type, userId, text, imageKeys, ...withThread },
  }
}
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-parse.test.ts`
Expected: PASS（含既有测试）

- [ ] **Step 6: 修 `feishu/index.ts` 调用点适配联合类型（否则 typecheck 红）**

`feishu/index.ts` 的 `im.message.receive_v1` handler 改为：

```ts
      'im.message.receive_v1': async (data: unknown) => {
        const result = parseMessageEvent(data, botOpenId, tunables.debugLog)
        if (result === null) return
        if (result.kind === 'unsupported') return // Task 4 接 notice
        const parsed = result.message
        if (!dedup.check(parsed.messageId)) return
        // ...（其后现状不变）
      },
```

- [ ] **Step 7: typecheck + 提交**

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS

```bash
git add packages/toolkit/src/channels/feishu/parse.ts packages/toolkit/src/channels/feishu/feishu-parse.test.ts packages/toolkit/src/channels/feishu/index.ts
git commit -m "feat(feishu): parseMessageEvent 三态联合——不支持类型返回 unsupported 标记，sticker 静默 + ignored 日志"
```

---

### Task 2: post 转换增强——title、a href、media 占位、skip-tag 日志

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/parse.ts`（`parsePostContent`）
- Test: `packages/toolkit/src/channels/feishu/feishu-parse.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ParseResult`/`expectMessage` 测试助手
- Produces: `parsePostContent(content, messageId, sink?)` 新签名（模块内私有，测试仍走 `parseMessageEvent` 入口）

- [ ] **Step 1: 写失败测试**

先**修改**既有「图片+文字（post）」用例的期望（title 进首行、a 输出 markdown 链接）：

```ts
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_p', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT))).toEqual({
      messageId: 'om_p', chatId: 'oc_1', chatType: 'p2p', userId: 'ou_u1',
      text: '图片消息\n帮我看 [链接文字](https://x)\n第二段',
      imageKeys: ['img_v1_a', 'img_v1_b'],
    })
```

追加新用例：

```ts
  test('a 标签：href 等于 text 或 href 空 → 退化为纯文本', () => {
    const content = JSON.stringify({ content: [[
      { tag: 'a', text: 'https://x', href: 'https://x' },
      { tag: 'a', text: '裸文字', href: '' },
      { tag: 'a', text: '无href' },
    ]] })
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_a', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT)).text).toBe('https://x裸文字无href')
  })

  test('post 空标题/无标题 → 不产生首行', () => {
    const content = JSON.stringify({ title: '  ', content: [[{ tag: 'text', text: '正文' }]] })
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_t', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT)).text).toBe('正文')
  })

  test('media 节点 → 行内占位；带 file_name 时附名', () => {
    const content = JSON.stringify({ content: [[
      { tag: 'text', text: '看这个 ' },
      { tag: 'media', file_key: 'file_v1_x', file_name: '演示.mp4' },
      { tag: 'media', file_key: 'file_v1_y' },
    ]] })
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_m', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT)).text).toBe('看这个 [附件: 演示.mp4][附件]')
  })

  test('未知标签跳过 + feishu.parse.skip-tag 日志（at/emotion 同样记录）', () => {
    const events: { event: string; [key: string]: unknown }[] = []
    const content = JSON.stringify({ content: [[
      { tag: 'text', text: 'hi' },
      { tag: 'hr' },
      { tag: 'at', user_id: 'ou_x' },
      { tag: 'emotion', emoji_type: 'SMILE' },
    ]] })
    const msg = expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_k', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT, (e) => { events.push(e) }))
    expect(msg.text).toBe('hi')
    expect(events).toEqual([
      { event: 'feishu.parse.skip-tag', tag: 'hr', messageId: 'om_k' },
      { event: 'feishu.parse.skip-tag', tag: 'at', messageId: 'om_k' },
      { event: 'feishu.parse.skip-tag', tag: 'emotion', messageId: 'om_k' },
    ])
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-parse.test.ts`
Expected: 上述用例 FAIL（title 未进文本、href 未拼接、media 被跳过、skip-tag 无日志）

- [ ] **Step 3: 实现 parsePostContent 增强**

替换 `parsePostContent` 与 `PostNode`：

```ts
/** post 富文本节点：text/a 取文本，img 收 image_key，code_block 成围栏块，media 占位；其余跳过 + 日志。 */
interface PostNode {
  tag?: unknown
  text?: unknown
  href?: unknown
  image_key?: unknown
  language?: unknown
  file_name?: unknown
}

/** 从 post content 抽取文本与图片 key；title 非空作首行，段落间以换行连接。 */
function parsePostContent(content: string, messageId: string, sink?: DebugSink): { text: string; imageKeys: string[] } {
  const imageKeys: string[] = []
  const paragraphs: string[] = []
  try {
    const parsed = JSON.parse(content) as { title?: unknown; content?: unknown }
    if (typeof parsed.title === 'string' && parsed.title.trim().length > 0) paragraphs.push(parsed.title.trim())
    const list = Array.isArray(parsed.content) ? parsed.content : []
    for (const paragraph of list) {
      if (!Array.isArray(paragraph)) continue
      let parts: string[] = []
      // 冲刷行内 parts 为独立段落；空 parts 不产生空行（纯图片段落）。
      const flush = (): void => {
        const joined = parts.join('')
        parts = []
        if (joined.length > 0) paragraphs.push(joined)
      }
      for (const node of paragraph as PostNode[]) {
        if (node === null || typeof node !== 'object') continue
        if (node.tag === 'img') {
          if (typeof node.image_key === 'string' && node.image_key.length > 0) imageKeys.push(node.image_key)
        } else if (node.tag === 'text' && typeof node.text === 'string') {
          parts.push(node.text)
        } else if (node.tag === 'a' && typeof node.text === 'string') {
          const href = typeof node.href === 'string' ? node.href : ''
          parts.push(href.length > 0 && href !== node.text ? `[${node.text}](${href})` : node.text)
        } else if (node.tag === 'media') {
          const name = typeof node.file_name === 'string' && node.file_name.length > 0 ? `: ${node.file_name}` : ''
          parts.push(`[附件${name}]`)
        } else {
          sink?.({ event: 'feishu.parse.skip-tag', tag: String(node.tag), messageId })
        }
      }
      flush()
    }
  } catch {
    return { text: '', imageKeys: [] }
  }
  return { text: paragraphs.join('\n'), imageKeys }
}
```

（注意：`code_block` 分支本任务先不实现，落入 else 记 skip-tag——Task 3 加入。）

`parseMessageEvent` 的 post 分支调用改为：

```ts
  } else if (msg.message_type === 'post') {
    const post = parsePostContent(msg.content, msg.message_id, sink)
    text = stripMentionPlaceholders(post.text)
    imageKeys = post.imageKeys
  }
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-parse.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/toolkit/src/channels/feishu/parse.ts packages/toolkit/src/channels/feishu/feishu-parse.test.ts
git commit -m "feat(feishu): post 富文本保真——标题入首行、a 输出 markdown 链接、media 占位、未知标签 skip-tag 日志"
```

---

### Task 3: code_block 围栏块 + 语言映射表

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/parse.ts`
- Test: `packages/toolkit/src/channels/feishu/feishu-parse.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `parsePostContent` 新结构（flush 机制）
- Produces: 模块内常量 `CODE_LANG: Readonly<Record<number, string>>`（不导出）

- [ ] **Step 1: 写失败测试**

```ts
  test('code_block：语言映射 + 独立成段（前后文不粘同段）', () => {
    const content = JSON.stringify({ content: [
      [{ tag: 'text', text: '报错如下' }, { tag: 'code_block', language: 49, text: 'print(1)' }, { tag: 'text', text: '帮忙看看' }],
    ] })
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_c', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT)).text).toBe('报错如下\n```python\nprint(1)\n```\n帮忙看看')
  })

  test('code_block：表外语言/缺 language → 省略语言名；连续代码块各自成段', () => {
    const content = JSON.stringify({ content: [
      [{ tag: 'code_block', language: 999, text: 'a' }],
      [{ tag: 'code_block', text: 'b' }],
    ] })
    expect(expectMessage(parseMessageEvent(event({
      message: { message_id: 'om_c2', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT)).text).toBe('```\na\n```\n```\nb\n```')
  })

  test('code_block：不再记 skip-tag 日志', () => {
    const events: { event: string; [key: string]: unknown }[] = []
    const content = JSON.stringify({ content: [[{ tag: 'code_block', language: 63, text: 'let x = 1' }]] })
    parseMessageEvent(event({
      message: { message_id: 'om_c3', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content, mentions: [] },
    }), BOT, (e) => { events.push(e) })
    expect(events).toEqual([])
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-parse.test.ts`
Expected: 3 个新用例 FAIL（code_block 目前落入 skip-tag 分支）

- [ ] **Step 3: 实现**

`parse.ts` 中（`PostNode` 之前）加语言映射表——飞书 code_block `language` 数字枚举的常用子集（1=PlainText 省略不映射；表外省略语言名）：

```ts
/** code_block language 数字枚举 → 语言名（常用子集；表外与 PlainText(1) 省略语言名）。 */
const CODE_LANG: Readonly<Record<number, string>> = {
  7: 'bash', 8: 'csharp', 9: 'cpp', 10: 'c', 12: 'css', 15: 'dart', 18: 'dockerfile',
  22: 'go', 24: 'html', 28: 'json', 29: 'java', 30: 'javascript', 32: 'kotlin', 36: 'lua',
  38: 'makefile', 39: 'markdown', 40: 'nginx', 43: 'php', 46: 'powershell', 49: 'python',
  52: 'ruby', 53: 'rust', 56: 'sql', 60: 'shell', 61: 'swift', 63: 'typescript', 66: 'xml',
  68: 'yaml', 69: 'diff',
}
```

`parsePostContent` 节点循环中，`media` 分支后、`else` 前插入：

```ts
        } else if (node.tag === 'code_block' && typeof node.text === 'string') {
          // 围栏块独立成段：先冲刷行内 parts，后续文本另起新段，避免与代码粘同一行。
          flush()
          const lang = typeof node.language === 'number' ? CODE_LANG[node.language] ?? '' : ''
          paragraphs.push(`\`\`\`${lang}\n${node.text}\n\`\`\``)
        } else if (node.tag === 'media') {
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu/feishu-parse.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/toolkit/src/channels/feishu/parse.ts packages/toolkit/src/channels/feishu/feishu-parse.test.ts
git commit -m "fix(feishu): post code_block 不再丢失——转 markdown 围栏块独立成段，语言数字枚举映射常用子集"
```

---

### Task 4: 渠道层 unsupported notice 接线

**Files:**
- Modify: `packages/toolkit/src/channels/feishu/index.ts:27-46`
- Test: `packages/toolkit/src/channels/feishu/feishu-parse.test.ts`（unsupportedNoticeText 文案测试已在 Task 1 落地，本任务无新单测——渠道 start() 依赖 lark WSClient 不做单测，逻辑主体 unsupportedNoticeText 是纯函数已覆盖）

**Interfaces:**
- Consumes: `ParseResult`、`ParsedUnsupported`、`unsupportedNoticeText`（Task 1）；`api.sendText(chatId, text, replyToMessageId?)`（api.ts 既有）；`tunables.debugLog`
- Produces: 无新导出

- [ ] **Step 1: 替换 `feishu/index.ts` 的 receive handler**

import 行改为 `import { MessageDedup, parseMessageEvent, parseRecallEvent, unsupportedNoticeText } from './parse.ts'`，handler 的 unsupported 分支（Task 1 的 `return` 占位）实现为：

```ts
      'im.message.receive_v1': async (data: unknown) => {
        const result = parseMessageEvent(data, botOpenId, tunables.debugLog)
        if (result === null) return
        if (result.kind === 'unsupported') {
          const u = result.unsupported
          // dedup 照常消费：飞书重推不重复提示。
          if (!dedup.check(u.messageId)) return
          let noticed = true
          try {
            await api.sendText(u.chatId, unsupportedNoticeText(u.messageType), u.threadId !== undefined ? u.messageId : undefined)
          } catch {
            noticed = false
          }
          tunables.debugLog?.({ event: 'feishu.parse.unsupported', messageType: u.messageType, messageId: u.messageId, chatId: u.chatId, noticed })
          return
        }
        const parsed = result.message
        if (!dedup.check(parsed.messageId)) return
        const reply = new FeishuReplyHandle(api, parsed.chatId, parsed.threadId !== undefined ? parsed.messageId : undefined, tunables, log, tunables.debugLog)
        const loadImages = parsed.imageKeys.length > 0
          ? async () => Promise.all(parsed.imageKeys.map(async (key) => api.downloadImage(parsed.messageId, key)))
          : undefined
        io.onMessage({
          botId: bot.record.id,
          chatId: parsed.chatId,
          chatType: parsed.chatType,
          userId: parsed.userId,
          messageId: parsed.messageId,
          text: parsed.text,
          ...(parsed.threadId !== undefined ? { threadId: parsed.threadId } : {}),
          ...(loadImages !== undefined ? { loadImages } : {}),
          reply,
          ackProcessing: makeAck(api, parsed.messageId, tunables.processingReactionEmoji),
        })
      },
```

- [ ] **Step 2: typecheck + 相关测试回归**

Run: `pnpm --filter dsh-agent-toolkit typecheck; if ($?) { pnpm --filter dsh-agent-toolkit exec vitest run src/channels/feishu }`
Expected: 全部 PASS（feishu 目录全部测试文件回归）

- [ ] **Step 3: 提交**

```bash
git add packages/toolkit/src/channels/feishu/index.ts
git commit -m "feat(feishu): 不支持的消息类型回提示（file/media/audio/merge_forward/未知），dedup 防重推 + unsupported 日志"
```

---

### Task 5: 全量验证 + 域文档同步

**Files:**
- Modify: `docs/domains/feishu.md`（「入站、出站与发起人提示段」一节，第 7 行入站段）

**Interfaces:**
- Consumes: 无
- Produces: 无

- [ ] **Step 1: 全量门禁**

Run（逐条，全部通过才继续）:
```
pnpm --filter dsh-agent-toolkit test
pnpm --filter dsh-agent-toolkit typecheck
pnpm --filter dsh-agent-toolkit bundle
```
Expected: test 907+ 通过（本计划新增用例计入）、typecheck 无错、bundle 产出成功

- [ ] **Step 2: 更新 `docs/domains/feishu.md` 入站段**

在第 7 行段落开头「飞书入站支持 text/post/image 三类消息」之后补一句现行事实（插入位置：该句之后、出站描述之前）：

「post 富文本解析为保真转换：`title` 非空作首行、`a` 输出 markdown 链接 `[text](href)`（href 空或等于 text 退化为纯文本）、`code_block` 转 markdown 围栏块独立成段（`language` 数字枚举映射常用子集，表外省略语言名）、`media` 节点行内占位 `[附件: <file_name>]`、`at`/`emotion`/未知标签跳过并记 `feishu.parse.skip-tag` debugLog；`file`/`media`/`audio`/`merge_forward`/未知类型消息返回 `unsupported` 标记由渠道层直接回文本提示（dedup 防重推，记 `feishu.parse.unsupported`，不进核心），`sticker` 静默跳过仅记 `feishu.parse.ignored`；」

- [ ] **Step 3: 提交**

```bash
git add docs/domains/feishu.md
git commit -m "docs: feishu 域文档同步入站富文本保真与 unsupported 类型提示"
```

---

## 非目标（本计划不做）

- `file` 消息完整接入附件库（独立任务）
- `text` 节点样式还原、merge_forward 内容解析
- 发布新版本（由用户决定何时走 `scripts/publish.ps1`）
