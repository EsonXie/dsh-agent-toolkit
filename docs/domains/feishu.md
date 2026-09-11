# 飞书渠道（现行事实）

> 本文是该功能域**现行状态**的权威描述（2026-09-10 自 AGENTS.md 拆出）；改动该域时同步本文。「为什么这样设计」的决策考古见 `docs/superpowers/specs/archive/`。

## 入站、出站与发起人提示段

飞书入站支持 text/post/image 三类消息：图片经渠道懒下载（不占 WS 3 秒窗口）→ `tools.get` 式落 `ctx.attachments`（可选服务，缺席降级提示）→ image 内容块进 user message（0.2.6）；飞书出站为确认式状态机：planSync 返回逐 op commit，op 成功才提交状态；失败按错误码治理（300301 视同成功 / 200850·200510 重激活重放 / 200860 废弃拆卡续写 / 未知错误 seq+2 重放）；拆卡定格旧卡状态行「📦 内容较长，已接续到下一张卡片」；`cardMaxBytes`（默认 26000）语义为单卡真实 DSL 字节上限（平台硬上限 30KB），`cardPrintStep`（默认 5）控制打字机速度；reply 句柄在 in-flight 准入通过后才替换，`/new` 等旧卡 finalize 后再摘会话映射。bot 会话创建/恢复/重置时注入渠道发起人提示段 `dsh-agent-toolkit:channel:sender`（order 20，channel + 发起人 open_id；`feishu.injectSender` 开关默认 true；0.2.7）。

出站流式增量源（0.1.5 迁移）：app 级订阅 `agent/assistant-stream` 瞬态帧——`start` 帧校验 turn 并建 attempt 基线（chunk 帧不携带 turn/step，按基线归属当前 step），`chunk` 帧按 `text-delta`→正文 / `reasoning-delta`→过程 / `block-end(reasoning)`→过程段段落分隔分流入段，`end` 帧不消费；turn 生命周期仍由 `turn/start`/`turn/end` 驱动。帧为 fire-and-forget（丢帧无重传），持久 `assistant/message` 结算时对账「尾 text 段」有界恢复丢帧——`turn.lastTextStep` 命中结算 step 才以权威全文替换，否则整体跳过（宁缺勿错，不篡改上一步已提交正文）；`assistant/attempt`（无表面消息）不消费。设计依据：`docs/superpowers/specs/archive/2026-09-10-feishu-stream-0.1.5-design.md`。

运维指令面（0.3.1 起）：`/new` `/stop` `/status` 为整条精确匹配指令；`/sessions` 列出 bot 项目 workspace 候选会话（workspaceRegistry 候选 + live 会话标题，标题取不到显示 (无标题)，三服务缺席降级）；`/switch <序号|id前缀>` 把 chat 绑定覆盖到目标会话（序号指最近一次 /sessions 输出的 per-chat 内存缓存；目标在内存直接复用、否则 resume 接管装配照常；binding 在 resume 成功后才覆盖；切走的旧 runtime 不 retire，在飞 turn 卡片照常收尾，闲置落定且未重新绑定后摘出 sessions）；`/help` 列出全部指令；workspaceRegistry 缺席时 /sessions 与 /switch 回复「会话切换在当前环境不可用」。已知限制：/switch 目标会话若正绑定在其他 chat（其 runtime 仍在内存），当前实现直接复用该 runtime——审批卡与在飞卡片仍发往原 chat，且原 chat 的 /new 会取消该会话任务；请避免跨 chat 切换同一会话。

## 审批卡片与 ask_user

飞书审批卡片（0.2.9）：bot 会话工具提权经 `channels/approval/`（ApprovalCenter 渠道无关核心 + 飞书 presenter）处理——`ctx.on('approval/request', …, { prepend: true })` 抢在 web api-proxy 前、按 sessions map 过滤自有会话（非自有 next() 透传）；按钮回调经 WS 长连接 `card.action.trigger`（同 dispatcher 注册，toast 走应答帧返回值）；仅会话发起人可批（`SessionRuntime.initiatorOpenId` 比对）；发卡失败回退 next() 不吞审批；开关 `feishu.approval` 默认 true；扫码建应用 addons 含 `callbacks: ['card.action.trigger']`（存量应用需在开发者后台补开卡片回传）。bot 会话工具面不含 ask_user（守护测试钉住），IM 场景模型直接在回复里提问（basic-tools.ts persona 引导句）。
