# 飞书出站图片正显设计（200570 断流根治）

日期：2026-10-21
状态：设计已确认（待写实施计划）

## 背景

宿主系统提示词教模型用 `![Description](<path/to/image.png>)` 在正文输出图片（web 端靠本地路径重写显示）。飞书渠道出站把该 markdown 原样塞进卡片，而飞书卡片 markdown 图片语法只认 `![img](img_key)`（须先经 im/v1/images 上传换 key），服务端校验 dest 非法时返回错误码 **200570「card contains invalid image keys」**（2026-10-21 实时复现确认：update/insert/replace 含本地路径图片均被拒；img_key 形态 code 0 内嵌正显成功）。

插件错误治理（`reply.ts` execOne）未覆盖 200570 → 按未知错误 seq+2 重放一次 → 必然再失败 → abandon 废弃换卡 → 新卡重放同样含非法图片的内容 → 再失败 → 单 flush 废弃超 `MAX_ABANDON_PER_FLUSH`(3) 抛错被吞，后续每个 flush 重复循环——**流式输出从此断掉**；连 finalize 的整卡重放（replace）也 200570，内容补不回来。

## 设计

### 架构与数据流

```
outbound.update(segments)
      │
      ▼
ImageSanitizer.sanitize(segments)     ← 纯函数同步转换（新增，channels/feishu/ 内）
      │  完整 `![desc](<path>)` 引用：
      │    已有 img_key 缓存 → `![img](img_key)`
      │    上传中            → 占位文本 `🖼 desc（图片上传中…）`
      │    失败/读不到        → 降级文本 `🖼 desc（图片无法发送）`
      │  不完整尾部引用       → 原样放行（非完整语法，飞书不校验）
      │  新发现的 path 登记给 resolver 启动后台上传
      ▼
planSync（零改动，只见合法内容）→ 卡片 ops
      ▲
ImageResolver 上传完成 → 回调 reply 句柄主动触发一次 flush（占位 → img_key 正显）
```

- 渠道适配全部落在 `channels/feishu/` 内，不出渠道层。
- img_key 缓存键 = 规范化后的绝对路径；per reply 句柄实例（turn 级生命周期，随会话销毁）。
- 路径解析：相对路径按 bot 项目根 resolve；绝对路径原样（不限项目根，已确认：模型自己产出的图发给它正对话的用户，风险低）。
- **净化时机**：reply 句柄持有的是 outbound 给的**原始** segments；sanitize 在每次 planSync 规划前与整卡重放（closeCard/breakCard/planFinalize 的 buildClosedCardJson）前对最新原文执行——上传完成后重净化才能拿到 img_key，且重放负载同样保证合法。
- **历史卡不回刷**：上传完成时若引用所在段已在历史卡封闭（重放已定格占位），只刷新当前卡。

### 净化函数规则（ImageSanitizer，纯函数）

识别标准 markdown 图片语法 `![alt](dest)`，dest 支持尖括号形态（`<path with spaces>`，系统提示词教的形态）与裸形态。

| 引用状态 | 转换结果 |
|---|---|
| dest 已是 `img_v*` 形态 | 原样保留（幂等，防重复处理） |
| 本地路径，缓存命中 img_key | `![img](img_key)` |
| 本地路径，上传进行中 | `🖼 alt（图片上传中…）` |
| 本地路径，上传失败/读不到/非图片/超限 | `🖼 alt（图片无法发送）` |
| http(s) URL / data URI / 其他非 img_key dest | `🖼 alt（图片无法发送）`（降级，保证永不 200570） |

边界规则：

- 文本尾部不完整图片引用（如流式刚到 `![chart](<C:\Use`）原样放行——飞书只在语法完整（有闭合 `)`）时校验 img_key；闭合字符到达的那个 flush 自然转成占位/正显。
- 同段多图各自独立转换；同路径重复引用共享一次上传（缓存）。
- alt 原样进占位/降级文案，截断 50 字符防超长。
- text 段与 process 段都过同一净化函数（reasoning 里也可能复述图片语法）。
- 降级用纯文本不用链接语法（飞书链接 url 校验未经实验验证，保守）。

### ImageResolver（上传器）

- `resolve(path)` → `ready: img_key` / `pending` / `failed`；首次见到 path 启动后台上传，Promise 缓存防重复。
- 上传流程：resolve 路径 → 读文件 → 魔数嗅探（复用 `sniffImageMediaType`）→ ≤10MB（飞书图片上限）→ `im/v1/images` 上传 → img_key。任一步失败 = `failed`（永久降级，本 turn 不重试）。
- 上传完成 → 回调 reply 句柄 `update(currentSegments)` 触发一次 flush；turn 已 finalize 则跳过。
- 上传不阻塞打字机：占位先进卡，正显随后刷新。

### FeishuApi 新增方法

`uploadImage(data: Uint8Array): Promise<string>`：im/v1/images（image_type=message，multipart）→ image_key。应用需 im:resource 权限（与 /doc 同权限，bots 扫码建应用已含）。

### 错误治理兜底（reply.ts execOne 补 200570）

净化层正常时 200570 永不发生；兜底防漏网语法：收到 200570 → **不 abandon**（换卡重放同样内容必然再失败，死循环）→ 把当前卡全部段文本经「剥离图片语法」（`![x](y)` → alt 纯文本）重放一次，继续正常流式，记 warn 日志。

### Config

新增 `feishu.imageUpload`（`z.boolean().default(true)`）：关闭则全部走降级文案不上传（无 im:resource 权限的应用可关）。接线链：`src/index.ts` Config schema → `src/bots/index.ts` BotsModuleConfig → `src/channels/runtime.ts` deps → feishu 渠道 reply 构造。

### 测试

单测（vitest，fake FeishuApi）：

- ImageSanitizer：完整/不完整引用、尖括号/裸路径、`img_v*` 幂等、多图、pending/ready/failed 三态、URL/data URI 降级、process 段净化、alt 截断。
- ImageResolver：路径解析（相对/绝对/项目根外）、读文件失败、魔数不符、超限、上传失败 → failed 永久降级；重复 path 共享上传；上传完成触发 flush 回调。
- FeishuReplyHandle 集成（fake api 记录 ops）：占位 → 上传完成 → 后续 update 含 img_key；finalize 时上传未完成 → 定格降级/占位文案；`imageUpload:false` 全降级不上传。
- 200570 兜底：fake api 对 update 抛 200570 → 剥离图片语法重放成功，不 abandon、不建新卡。
- 回归：既有测试全绿（净化对无图片文本恒等）。

实机验收（发布前 parity 回路）：dev 回路 link 插件，让 bot 产 PNG 并输出 → 飞书端占位短暂出现 → 图片内嵌正显，流式不中断。

## 非目标

- http(s) 图片下载上传、data URI 解码上传（系统提示词只教本地路径，降级即可）
- 历史卡片图片回填
- 审批卡/问答卡等其他卡类型的图片支持（出站正文卡片之外无图片来源）
