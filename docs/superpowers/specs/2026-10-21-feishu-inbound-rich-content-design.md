# 飞书入站富文本内容保真设计

日期：2026-10-21
状态：设计已确认（待写实施计划）

## 背景

飞书端发送含代码块的富文本（post 消息），web 端会话里代码块完全消失。根因：`packages/toolkit/src/channels/feishu/parse.ts` 的 `parsePostContent` 白名单只收 `img/text/a` 三种节点，`code_block` 等标签静默跳过。沿接收链路完整审计后确认还有多处内容丢失：post 标题、`a` 的 href、post 内 `media` 附件节点，以及 `file`/`media`/`audio`/`merge_forward` 等消息类型被整条静默丢弃（机器人毫无反应）。

## 目标

1. post 富文本转文本时不再丢失实质性内容（代码块、链接 URL、标题、附件占位）
2. 不支持的消息类型给出用户可见的降级提示，消灭「发消息装死」
3. 所有跳过/丢弃行为写 debugLog，生产可反查

## 非目标

- `file` 消息完整接入（下载进附件库）：独立任务
- `text` 节点样式（粗斜体等）还原：纯文本已够模型理解，低价值
- `emotion`/`sticker` 语义化：无语义价值（sticker 静默跳过 + debugLog，不回提示）
- `merge_forward`/`share_chat` 内容解析：仅降级提示
- 核心层（Inbound/Router）接口变更

## 设计

### 1. 解析层输出结构（`src/channels/feishu/parse.ts`）

`parseMessageEvent` 返回值从 `ParsedMessage | null` 改为三态联合：

```ts
export type ParseResult =
  | { kind: 'message'; message: ParsedMessage }
  | { kind: 'unsupported'; messageId: string; chatId: string; chatType: 'p2p' | 'group';
      userId: string; messageType: string; threadId?: string }
  | null
```

- `message`：text/post/image，同现状
- `unsupported`：`file`、`media`、`audio`、`merge_forward` 及一切未知 message_type——统一回提示，不再静默整条丢弃
- `null`：仍需忽略——机器人消息、群未 @ 本机器人、sticker（表情贴图，无语义价值）、内容解析失败、strip 后无文本且无图片

函数签名加可选第三参：`parseMessageEvent(data, botOpenId, sink?: DebugSink)`，保持纯函数，sink 由渠道层从 `tunables.debugLog` 传入。

### 2. post 富文本转换规则（`parsePostContent`）

逐节点处理，输出 paragraphs 数组（段落间 `\n` 连接，同现状）：

| 节点 | 处理 |
|---|---|
| post `title` | 非空时作为 paragraphs 首行 |
| `text` | 原样行内拼接（不变） |
| `a` | href 非空且 ≠ text 时输出 `[text](href)`；否则退化为 text |
| `code_block` | **冲刷当前段落**（已有 parts 先成段），围栏块作为独立 paragraph 插入，后续文本另起新段——避免代码与前后文粘连同行。格式：` ```lang\ntext\n``` `，语言名见映射表，表外省略 |
| `img` | 收 image_key（不变）；段落只有图无文本时不产生空行段落 |
| `media` | 行内插入占位文本 `[附件]`；带 `file_name` 时用 `[附件: <file_name>]` |
| `at`、`emotion`、其余未知标签 | 跳过 + debugLog（事件 `feishu.parse.skip-tag`，含 tag 名） |

### 3. code_block 语言映射表

常用子集映射（数字 → 语言名），表外省略语言名。覆盖约 25 种：PlainText(1)、Bash(7)、CSharp(8)、C++(9)、C(10)、CSS(12)、Dart(15)、Dockerfile(18)、Go(22)、HTML(24)、JSON(28)、Java(29)、JavaScript(30)、Kotlin(32)、Lua(36)、Makefile(38)、Markdown(39)、Nginx(40)、PHP(43)、PowerShell(46)、Python(49)、Ruby(52)、Rust(53)、SQL(56)、Shell(60)、Swift(61)、TypeScript(63)、XML(66)、YAML(68)、Diff(69)。

枚举值以飞书官方 post 消息格式文档为准，实现时对照校验。

### 4. 渠道层（`src/channels/feishu/index.ts`）

- `parseMessageEvent(data, botOpenId, tunables.debugLog)`
- `kind: 'message'` → 现状路径不变
- `kind: 'unsupported'` → **渠道层直接用 api 往该 chat 回一条文本**（threadId 消息回话题内），不进核心：
  - `file` → 「暂不支持文件消息，请发送文字或截图」
  - `media` → 「暂不支持视频消息」
  - `audio` → 「暂不支持语音消息」
  - `merge_forward` → 「暂不支持合并转发消息」
  - 未知类型 → 「暂不支持该类型消息（<messageType>）」
  - 提示发送失败吞掉 + debugLog；dedup 照常消费（unsupported 也过 `dedup.check`，防飞书重推重复提示）
- `null` → 不变

核心层（Inbound/Router/channel.ts）零改动。

### 5. debugLog 事件

- `feishu.parse.skip-tag`：`{ tag, messageId }`——post 解析中跳过的标签
- `feishu.parse.unsupported`：`{ messageType, messageId, chatId, noticed: boolean }`——unsupported 消息，在提示发送尝试后记录（noticed = 提示是否发送成功）
- sticker 等 null 路径也写 `feishu.parse.skip-tag`-级事件（如 `feishu.parse.ignored`，含原因），保证任何静默都有日志

### 6. 测试（`src/channels/feishu/feishu-parse.test.ts` 扩 + 渠道层 notice 测试）

- code_block：含语言 / 表外语言省略 / 与前后文混排（验证段落冲刷与另起新段）/ 连续多个代码块
- `a`：href ≠ text 输出 `[text](href)`；href = text；href 空
- title：非空首行 / 空标题无影响
- `media`：占位 `[附件]` / 带 file_name
- img-only 段落无空行；图文混排不变（回归）
- 各 unsupported 类型 → `kind: 'unsupported'` 且字段完整；渠道层回对应 notice 文案（threadId 消息回话题）
- sticker → null + debugLog；text-only-@ 空消息仍 null（回归）
- sink 断言：skip-tag / unsupported / ignored 事件均触发

## 风险与取舍

- 解析层签名变更（返回值联合 + sink 第三参）只有 `feishu/index.ts` 一个调用方，影响面可控
- notice 由渠道层直接发绕过 Inbound：文案与渠道措辞耦合在飞书实现内，当前单渠道可接受；未来多渠道时再抽象
