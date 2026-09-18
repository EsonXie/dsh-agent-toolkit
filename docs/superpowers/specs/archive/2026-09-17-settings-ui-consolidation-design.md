# 插件 UI 入口收编设置面板 + 配置页重设计（设计）

> 状态：设计已确认（2026-09-17 逐节过审），待实施。
> 范围：`packages/toolkit` 浏览器半四个配置面板（Agents/Prompt/Bots/Schedule）从侧边栏底栏迁入宿主设置面板，并逐页重设计；含 Bots 与 Agents 配置合并（方案 A）的数据模型变更与存量迁移。`packages/usage`（token 用量）不迁移，底栏保留。

## 背景与目标

现状：toolkit 在 `sidebar.footer.action` 挂了 5 个图标入口（Agents/Prompt/Usage/Bots/Schedule），点击弹 Modal。问题：

- 底栏是高频区域，宿主设计上仅是「设置旁的可选 action」（宿主自己只有 cordis-panel 一个），5 个低频配置入口占位不合理；
- 宿主惯例：配置类界面进设置面板（General/Models/Plugins/Agent 预设都是 `settings.section`）；
- 用户痛点：①Agent 列表排序乱（应按创建时间）；②保存反馈不明显；③Prompt 分层页对新手不友好；④Bots 与 Agents 存在重复配置（provider/模型/persona/tools）；⑤使用频次：Agents+Bots > Schedule > Prompt。

目标：

1. 四个配置面板迁入设置面板，单 section 内分 tab，逐页重设计，对齐宿主设置页风格；
2. Bots 配置并入 Agents（一个 Agent 挂多个 Bot，每个 Bot 绑一个项目）；
3. 修复排序与保存反馈痛点，Prompt 页增加新手引导。

## 1. 设置面板整体结构

- toolkit 浏览器半经 `ctx.slots.inject('settings.section', () => ctx.slots.register(...))` 注册一个设置 section：
  - `id: 'agent-toolkit'`，`order: 25`（宿主现有 General 0 / Models 10 / Plugins 15 / Agent 预设 20，排最后）；
  - label 走 locale 词典本地化（「Agent 工具箱 / Agent Toolkit」），注册带双装防护 try/catch（沿用现有惯例）。
- 页内 tab 导航由 section 组件自绘（参考宿主 Plugins section 内 tab 形态，但不声明子槽——四页均本插件自有内容，不开放注入点），tab 顺序按使用频次：
  1. **Agents**（默认页，含 Bots）
  2. **Schedule**
  3. **Prompt**
- 底栏清理：删除 `dsh-agent-toolkit:agents` / `:prompt-layers` / `:bots` / `:schedule` 四个 `sidebar.footer.action` 注册；保留 Usage（usage 包独立，不迁移）、委派卡（`tool.call.toolview` key `team_delegate`）、子代理 chip（`conversation.session.header.utilities`）。toolkit 侧 `src/client/shared/createSidebarEntry` 工厂随四个面板删除而移除；usage 包的独立副本不动。
- 浏览器半 `inject` 保持 `['sessions', 'slots', 'locale']` 不变（sessions 仍被委派卡/subagent chip 消费）。
- 页面骨架对齐宿主 section 页（参考 `ui-settings-general` 的 GeneralSection、`ui-agent-preset` 的 AgentPresetSection）：页标题 + 说明段 + 内容区，无弹窗壳，整页滚动；控件复用 ui-primitives，颜色走 `--dsw-*` token，文案全部进 locale 词典。
- 组件规范遵守宿主 client 纪律：共享/跨挂载状态走 `createXXXStore()` 工厂注册时声明 store；组件纯 props（四 share），不碰 ctx。

## 2. Agents + Bots 合并页（核心）

信息架构：整页纵向 Agent 卡片流（对齐宿主 Models 页 provider 卡片形态），一卡 = 一个 Agent + 其名下 Bot 列表。

### 卡片排序与结构

- 置顶固定卡：**主 Agent**（内置标识，不可删除；无 persona/工具编辑区，只读说明「使用宿主默认模型与装配」）。
- 其后注册表 Agent 卡片，**按 createdAt 升序**（先建在前，修复排序痛点）；内置 explorer/general 与用户自建同规排序，内置卡带「内置」徽标。
- 卡头：名称、model（provider/model；主 Agent 卡显示「宿主默认」）、工具摘要（「不限制」或「白名单 N 项」）、Bot 数量；操作：编辑、删除。
- **删除约束**：名下有 Bot 的 Agent 禁止删除（服务端 409 + Bot 数量），UI 提示「请先删除或移出其 N 个 Bot」。

### 卡片展开 = Bot 列表（替代原 Bots 页）

- 每个 Bot 一行：名称、飞书连接状态点（绿/灰，沿用现有连接态语义）、项目路径；操作：编辑、删除（保留现有两段确认）。
- 卡尾「+ 添加 Bot」按钮——在哪张卡添加就绑哪个 Agent（无 agentRef 下拉；归属即绑定）。

### 编辑交互（去弹窗，内联 accordion）

- 点「编辑」→ 卡片下方内联展开编辑区；「添加 Agent」「添加 Bot」同规内联展开空白表单。
- Agent 编辑区字段：名称、persona、model（provider + model）、工具区块（「不限制 / 自定义白名单」radio 二选一，沿用现行语义，deny 不存在）。
- Bot 编辑区字段：名称、飞书 appId + appSecretRef、项目路径；**仅主 Agent 卡下的 Bot 表单额外有 provider/模型字段**（语义 = 该 Bot 会话对宿主默认模型的覆盖）；注册表 Agent 卡下的 Bot 表单无这三个字段（完全继承角色）。
- bot 级 persona/tools 字段**移除**（归并到 Agent，见第 5 节数据模型）。

### 保存反馈（修复痛点）

- 每个编辑区底部「保存 / 取消」；未保存修改时保存按钮高亮，离开编辑区前二次确认。
- 保存成功：按钮短暂变「✓ 已保存」+ 页面顶部 toast（ui-primitives Toast）；失败：编辑区内联红字错误，表单内容保留不丢。
- 删除成功同样 toast 反馈。

### 状态管理

`createAgentsStore()` 工厂承载：agent 列表、bot 列表（拉两份列表按 agentRef 客户端分组）、卡片展开状态、编辑草稿、保存态。复用现有 `agents/api.ts` / `bots/api.ts` HTTP 客户端（接口调整见第 5 节）。

## 3. Schedule 页

- 布局：去弹窗壳，整页行式任务列表；页头「+ 添加任务」按钮（内联展开空白表单）。
- 任务行：名称 + cron 表达式（旁附人类可读描述，如「每工作日 09:00」）+ 执行目标（主 Agent / 角色名）+ 启用开关（行内即时生效 + toast）+ 下次运行时间；行尾操作：编辑 / 立即触发 / 删除（两段确认保留）。
- 运行历史：从「与列表混在一页」改为**点击任务行展开该任务的最近运行记录**（时间、成败、耗时、会话链接），保留 `openSession` 跳转会话。
- 编辑表单（内联展开）：名称、cron 表达式（即时校验 + 人类可读预览）、执行目标（主 Agent / 注册表角色下拉）、任务提示词。
- 保存/删除反馈同第 2 节规范。
- 技术：`agent-schedule` locale 词典保留；`createScheduleStore()` 承载列表/展开/草稿/保存态；现有 `schedule/api.ts` 复用。

## 4. Prompt 分层页（新手引导）

四层模型不变：identity（原生，可覆盖，仅主 Agent）→ 模型层（只读）→ persona（可编辑）→ 动态层（只读展示）。存储语义不变（`prompt_layers` 单行：persona 文本 + 可选 identity 覆盖，打开时按种子 reconcile）。

- **顶部说明区**（可折叠，默认展开）：一句话总述 + 四层栈示意（自上而下 = 渲染顺序），每层一句话：是什么、谁控制、对谁会话生效；讲清「最终系统提示 = 四层拼装」心智模型。
- **层栈 = 纵向四张卡片**，每张标「只读 / 可编辑」徽标 + 一句话作用说明：
  1. **identity 层**：只读展示原生文本；「自定义覆盖」编辑区（留空 = 还原原生）；标注「仅主 Agent 会话生效」。
  2. **模型层**：只读展示当前命中文本，注明来源（命中规则 `overrides.base` 或内置默认）。
  3. **persona 层**（主编辑区，新手引导集中处）：编辑框上方放编写指引（建议写：角色定位、语气风格、行为边界；不建议写：具体任务指令、临时上下文）；提供 2–3 个示例模板（如「资深代码评审」「谨慎的运维助手」）一键填入可再改；空态 placeholder 给最短示例。
  4. **动态层**：只读、默认折叠，展开看 contexts/工具段说明。
- 保存反馈同统一规范。

## 5. 数据模型、迁移与兼容

### Bot 记录收窄（`src/bots/store.ts`）

- 删除字段：`persona`、`tools`（归并到 Agent 记录）。
- 保留字段：id/name/channel/feishu/project/agentRef/createdAt/updatedAt；`agentOptions.provider/model` 保留但语义收窄为**仅 agentRef='main' 时有效**。
- **行为变化明示**：主 Agent 名下 Bot 不再支持单独 persona/工具白名单；需要差异化 persona 的 Bot 应创建角色 Agent 再绑定。

### 存量迁移（启动时一次性，幂等）

- `project_bot` domain 增加 `meta` 表（沿用 agents store 的 meta 标记模式），标记 `bots_agent_merge_migrated`。
- 迁移逻辑：遍历存量 Bot——
  - `agentRef` 指向注册表角色：丢弃 bot 级 persona/tools/agentOptions；若与角色记录不一致，记 warn 列出被丢弃值（角色可能被多 Bot 共享，不反向合并进角色）。
  - `agentRef` 缺省/'main'：保留 agentOptions.provider/model，丢弃 persona/tools。
- 迁移完成写标记；标记存在则跳过。

### API 调整（`bots/api.ts`、`agents/api.ts`）

- Bot create/update：payload 删除 persona/tools；`provider/model` 仅在 agentRef='main' 时接受，否则服务端 400（enforce 在服务端，不只靠 UI 隐藏）。
- Agent delete：名下有 Bot 返回 409 + Bot 数量（UI 据此提示）。
- Agent list：按 createdAt 升序返回。
- 不加新聚合接口；「Agent 卡片 + Bot 列表」由客户端 store 拉两份列表分组组装。

### 运行时适配

- `channels/agent-setup.ts` 等删除 bot 级 persona/tools 注入路径；bot 会话 persona/工具一律来自 agentRef 角色记录（main = 宿主默认装配，无 persona）。
- 不受影响面逐一核实并更新测试：委派卡、子代理 chip、飞书入出站状态机、审批/问答卡、cron 执行目标解析（schedule 的「主 Agent / 角色」语义不变）。

### UI 注册变更

- 新增 `settings.section` 注入注册；删除四个 `sidebar.footer.action` 注册及 toolkit 侧 `src/client/shared/` 的 `createSidebarEntry` 工厂（`useLoadState` 若仍被新页复用则保留，否则一并移除）。

### 测试策略（沿用现有 vitest 体系）

- Node 半：store 迁移测试（幂等性、main/非 main 两路、warn 路径）、API 400/409 校验测试、agent-setup 适配测试；
- 浏览器半：jsdom 组件测试（卡片流渲染与排序、内联编辑展开/收起、保存反馈 toast、删除两段确认、tab 切换、主 Agent 卡特例）、`settings.section` 注册测试；
- 更新受影响存量测试；门禁：两包各自 `test` + `typecheck` + `bundle` 全绿（toolkit 测试经 node_modules 解析 usage 的 lib/，本次未动 usage，无需先构建 usage）。

### 文档同步

- `docs/domains/feishu.md`：Bot 字段收窄与行为变化；
- `docs/domains/agents.md`：UI 入口从底栏改设置面板；
- `docs/usage/`：手册与界面截图更新（迁移后补拍）；
- 根 `AGENTS.md`：功能域段落对应描述。
