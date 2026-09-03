# 渠道发起人提示段 设计

日期：2026-09-03
状态：待评审

## 背景与目标

飞书 bot 场景：用户开启一段新对话时，需要 Agent 往飞书多维表格创建一条记录，其中"提问人"为人员类型字段（接受 open_id）。当前入站链路已从 `im.message.receive_v1` 事件解析出 `userId`（open_id），但 `InboundMessage.userId` 在 inbound 层未被消费，Agent 无从知晓发起人身份。

目标：bot 会话创建/恢复时，向系统提示词注入一个静态提示段，声明**会话由哪个渠道发起**（feishu，未来可扩企业微信等）与**发起人 ID**（该渠道的 open_id），供 Agent 在调 Lark CLI 写多维表格时使用。

## 场景约束

- 仅单聊（p2p）：会话发起人 = 该 chat 唯一用户，每次入站消息的发送人即发起人，无需持久化发起人到绑定表。
- 群聊语义不在本次范围；提示段文案固定写"单聊会话"。
- 不做姓名解析（人员字段直接接受 open_id）。
- "何时建记录、Base 的 app_token/table_id" 等业务指令由用户在 bot persona 中自行配置，插件不管。

## 提示段契约

- name：`dsh-agent-toolkit:channel:sender`
- order：20（persona 层 10 之后）
- text（静态，`{channel}` 取 `BotRecord.channel`，`{userId}` 取当前入站消息的 `userId`）：

```
本会话由 {channel} 渠道的单聊会话发起。发起人 ID（{channel} open_id）：`{userId}`。
```

feishu 实际渲染示例：

```
本会话由 feishu 渠道的单聊会话发起。发起人 ID（feishu open_id）：`ou_xxxxxxxx`。
```

## 数据流

```
feishu/parse.ts  parseMessageEvent → ParsedMessage.userId（已有）
feishu/index.ts  → InboundMessage.userId（已有）
inbound.ts       handle(msg)：router.ensure(bot, msg.chatId, msg.reply, msg.userId)
router.ts        ensure(...) / reset(...) 透传 userId → resolveSession(bot, userId)
                 resolveSession 在 hooks.sections 末尾追加 sender 段
agent-setup.ts   setupAgentScope 原样注册 hooks.sections（现有机制，无改动）
```

create / resume / `/new`（reset → ensure）三路径共用同一注入逻辑；`/new` 后发起人自动更新为当前发送人（单聊下同一人）。

## Config 开关

按仓库约定进 Config schema（`src/index.ts` 的 `feishu` 段，即 `BotsModuleConfig`）：

- `feishu.injectSender: z.boolean().default(true)`：为 `false` 时 `resolveSession` 不追加 sender 段。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/index.ts` | Config `feishu` 段加 `injectSender`（默认 true）；透传给 bots/channels 层 |
| `src/channels/router.ts` | `ensure`/`reset` 加 `userId` 参数；`resolveSession` 追加 sender 段 |
| `src/channels/inbound.ts` | `handle` 调 `router.ensure` 传 `msg.userId` |
| `src/channels/runtime.ts` | 如 Config 经 RuntimeDeps 下达，则在此接线 |
| 测试 | `router.test.ts`：段内容、开关关闭不注入、reset 后更新；`inbound.test.ts`：userId 透传 |

## 不在本次范围（YAGNI）

- 绑定表 schema 不扩字段（单聊下无需持久化发起人）。
- 姓名解析（Contacts API / lark-cli contacts）。
- 群聊多发送人归属（需动态段或消息前缀，另行设计）。
- 浏览器半无改动。

## 验证

- `pnpm --filter dsh-agent-toolkit test` + `typecheck` + `bundle` 全绿。
- 开发回路：link 插件 → 建 bot → 单聊发消息 → 会话系统提示词含 sender 段（可用 /status 或宿主会话详情核对）。
