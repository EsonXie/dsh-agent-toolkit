# 飞书 /doc 命令：会话文档直发飞书（设计）

> 状态：已与用户对齐，待实施。背景：多轮对话产出的文档以 Markdown 为主，用户希望在飞书会话中直接打开查看，不引入自建网页或第三方服务。

## 目标与非目标

**目标**：在 bot 会话中发送 `/doc <相对路径>`，把该文件以飞书文件消息发回当前会话，用户在飞书内点击直接预览（飞书支持直接打开 .md 文档——用户已确认；若实测预览为纯文本，升级路径见「后续增强」）。

**非目标（YAGNI）**：不做文件树/目录列举（`/docs` 留作后续增强）；不做 Markdown 渲染（卡片渲染、云文档导入为已评估的备选升级路径）；不做编辑；不引入任何新网络监听或第三方进程。

## 交互与命令解析

- `directive.ts` 新增带参指令 `/doc`，复用 `/switch` 同款首词判定模式：`t === '/doc'` → 无参（由 Inbound 提示用法）；`t.startsWith('/doc ')` → `arg` 为余串 trim。**注意**：`arg` 是文件路径，tolowerCase 会破坏大小写敏感路径——解析时路径参数取原始文本（trim 后、不低化），与 `/switch` 的会话序号参数区分处理。
- 指令分发落在 `inbound.ts` 现有 directive 分支链中，与 `/new` `/stop` `/status` 同级；不进会话 turn、不占 in-flight 槽（与 `/status` 一致）。
- `/help` 输出补一行 `/doc <相对路径>` 用法。

## 路径解析与安全护栏

新模块 `channels/doc-command.ts`（渠道无关核心），职责单一：`resolveDocPath(project, arg, maxBytes) → { ok: true; path; name } | { ok: false; reason }`。

- 根目录：当前 bot 的 `bot.project`（即会话 cwd；`/switch` 切换会话不改变项目根）。
- 拒绝：绝对路径（`path.isAbsolute`，含 Windows 盘符与 UNC）；resolve 后越出项目根（`path.relative` 以 `..` 开头或为绝对结果）；不存在；非普通文件（目录/符号链接，用 `lstat` 判定，与宿主 workspaceFiles 同款护栏）。
- 大小上限：Config `feishu.docMaxBytes`，默认 30 MiB（对齐飞书文件上传限制量级，实现时以官方文档核实值为准），超限拒绝并提示实际大小。
- 大小写：Windows 下按用户输入原样 resolve，不做归一化。

## 上传与发送（飞书 presenter）

`channels/feishu/api.ts` 的 `FeishuApi` 新增两个方法，复用现有 `lark.Client` 与 WS 长连接，无新增网络面：

- `uploadFile(name: string, data: Uint8Array): Promise<string>`：`client.im.file.create`，`file_type: 'stream'`，`file_name` 保留原始文件名（含 `.md` 扩展名，保证飞书预览按类型识别）；返回 `file_key`，缺失按现有风格抛 `code/msg`。
- `sendFile(chatId: string, fileKey: string): Promise<void>`：`client.im.message.create`，`msg_type: 'file'`，content `{ file_key }`（字段名以实现时 SDK 类型为准）。

流程：`/doc` 分支 → `resolveDocPath` → 读文件（`node:fs/promises`，读入内存——已受 docMaxBytes 上界约束）→ `uploadFile` → `sendFile` → 完成（可选 `notice('已发送：<name>')` 省略，文件消息自身即反馈）。

## 错误处理

全部以一条文本 notice 回复当前会话，不进入模型会话、不抛给全局 onError（用户输入错误属预期路径）：

| 场景 | 文案要点 |
|---|---|
| 无参 `/doc` | 用法提示 |
| 路径越界/绝对路径 | 仅允许项目目录内相对路径 |
| 文件不存在 | 附解析后的相对路径 |
| 非普通文件 | 不支持目录/链接 |
| 超大小 | 附实际上限 |
| 上传/发送失败 | 复用现有 `feishuErrorCode` 摘要，notice 带回渠道（2026-09-03 /new 事故教训：错误摘要必须回传渠道，不只写 warn） |

## Config

`feishu.docMaxBytes`（number，默认 `30 * 1024 * 1024`）——可调参数进 Config，不硬编码（仓库约定）。

## 权限与部署

- 应用需开通 `im:resource`（上传图片与文件）权限；存量应用需在开发者后台补开并发布版本——与 `card.action.trigger` 补开同类，写入 `docs/usage/` 飞书章节。
- 无新增事件订阅、无新增 addons。

## 测试

- `directive.test.ts`：`/doc` 无参/带参/大小写路径保留/前后空白。
- `doc-command.test.ts`（新增）：resolveDocPath 各护栏分支（tmp 目录 fixture；符号链接用 lstat 拒绝）。
- `api.ts` 新增方法：mock lark.Client 断言 `im.file.create` / `message.create` 参数与错误包装。
- `inbound.test.ts`：`/doc` 端到端（fake FeishuApi + tmp 文件），断言成功发文件与四类错误 notice 文案。
- 全量门禁：toolkit `test` + `typecheck` + `bundle`。

## 集成注意

- 本设计与已落地的 `/sessions /switch` 工作（`2026-09-11-feishu-session-switch-design.md`，含 8aa42d1250 / 99be3825c4 两个后续 fix）同触 `directive.ts`/`inbound.ts`：分发形态已定（directive 分支链 new→stop→status→help→sessions→switch→ensure，/doc 分支加在链尾 ensure 之前），两处命令分支互不耦合。
- `/doc` 只读文件系统，不影响会话状态、路由映射与卡片状态机。

## 后续增强（不在本 spec）

- `/docs`：列举会话近期产出的文档（宿主 `fs/observed` 埋点可观测 agent 写文件）→ 卡片按钮选取，免去手输路径。
- 若飞书 .md 预览实测不满足（纯文本无渲染）：升级路径 A = 卡片渲染（复用拆卡状态机，30KB/卡上限）；升级路径 B = drive `import_task` 导入云文档（内容出内网，需用户另行授权）。
