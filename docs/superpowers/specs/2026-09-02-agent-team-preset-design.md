# Agent 团队 preset 自动生成设计

日期：2026-09-02
状态：已获用户批准（方向修正后定稿）

## 背景与问题

dsh 0.1.2-alpha.4 引入 agent presets 架构，并重写了内置 `subagent` 工具体系：

- `subagent` 默认后台 continuable 运行，新增配套工具 `send_message` / `list_agents` / `interrupt_agent` 与 `subagent_fork`
- 系统提示词新增强引导段（`tool:subagent`，order 2800：*"Use subagent in the background by default…"*）

结果：模型在委派意图下优先选择被原生强引导的 `subagent`，而非 toolkit 的 `team_delegate`，Agent 团队的预配置角色（persona / 模型路由 / 工具白名单）不被使用。

经抓包逐字节验证（mock LLM + 用户完整数据副本 + alpha4）：**插件本身全部生效**——分层提示词各层、团队名册段、`team_delegate` 工具均正常到达模型；问题纯粹是工具竞争。

## 定案方向（用户裁定）

**不在 standard 模式中屏蔽任何原生工具**；改为创建一个新的 **「Agent 团队」preset**，在该模式中 subagent 工具族不存在，委派唯一入口是 `team_delegate`。standard 模式保持原样。

`team_delegate` 与团队名册段维持 host 平面全局注册（现状），所有模式可见可用——不削弱任何模式，也不做平面迁移。

## 方案

toolkit 启动时自动生成/刷新一个用户 preset `agent-team`：composition 派生自宿主当前 shipped `standard`，仅禁用 subagent 工具族的 4 个行。

### 数据流

```
apply()
  └─ config.agentTeamPreset.enabled === false → 跳过
  └─ ctx.get('agentPresets') 缺席（rc2 等无 presets 的旧宿主）→ 静默跳过（旧宿主无竞争问题）
  └─ 服务在：
       1. source = config.agentTeamPreset.source（默认 'standard'）
          经 agentPresets.read(source) 读 composition 文本；失败（未知/损坏 preset）→ warn 降级
       2. 文本级锚点改写：对 4 个目标行各插入一行 `disabled: true`（缩进跟随锚点行）。
          锚点匹配是**整行精确匹配** `- id: <行id>`（允许行尾空白），防止
          `tool-subagent` 误中 `tool-subagent-fork` / `tool-subagent-control` 前缀；
          插入前检查该行所属块内已有 `disabled:` 键则跳过（幂等 + 不与宿主已有的
          `disabled: !!js ...` 撞出 YAML 重复键）。目标行：
          - tool-subagent            （subagent 工具 + 强引导段）
          - tool-subagent-fork       （subagent_fork 工具）
          - tool-subagent-control    （send_message / interrupt_agent）
          - tool-subagent-list-agents（list_agents）
          锚点缺失（宿主未来改名/删行）→ warn 并跳过该锚点，其余照常
       3. 目标目录 = 首个 trust=user 的 preset root（agentPresets.roots）/<config.id>/
          - 目录已存在且无 .generated-by 标记（用户手工同名 preset）→ 不覆盖，warn 跳过
          - 否则写入三个文件（每次启动重写，幂等）：
            agent.cordis.yml   改写后的 composition（头部加「本文件由 dsh-agent-toolkit 生成，勿手改」注释）
            preset.yml         name/description（来自 config）
            .generated-by      标记文件，内容 'dsh-agent-toolkit'
```

### 禁用行的选择依据

- 4 个行覆盖了全部 5 个与 `team_delegate` 竞争/配套的模型可见工具（subagent、subagent_fork、send_message、list_agents、interrupt_agent）
- 引导段无需额外处理：`tool:subagent` 段由 tool-subagent 插件自身注册，行禁用后自然消失
- 同 delegation group 的 `workflow-worker-thread` / `tool-workflow` / `tool-ralph` 保留——它们由用户显式触发，不是委派竞争项

### Config schema 新增

```ts
agentTeamPreset: z.object({
  enabled: z.boolean().default(true),
  id: z.string().default('agent-team'),
  source: z.string().default('standard'),
  name: z.string().default('Agent 团队'),
  description: z.string().default('Agent 团队模式：禁用原生 subagent 工具族，委派统一走 team_delegate 团队角色'),
}).default({...})
```

### 边界与保护

- **不设为默认 preset**：用户在模式选择器显式选用；不改 `agent-presets` settings
- **卸载不删目录**：可能有会话在用；composition 不引用 toolkit 行，残留 preset 自身仍可用（团队工具随插件卸载消失）
- **代际隔离**：standing mount 按文件代际，运行中会话不受影响，重写只影响新会话
- **写失败**（权限/磁盘）→ `logger.warn` 降级，插件其余功能不受影响
- **rc2 兼容**：无 `agentPresets` 服务时整个功能静默关闭，零行为变化

### 不做的事（YAGNI）

- 不做 restrict 运行时屏蔽（agent/created + tools.restrict 方案已否决）
- 不把 team_delegate 迁到 preset 平面
- 不改 standard 模式的任何行为
- 不提供 preset 删除/编辑 UI（alpha4 原生 roster/authoring 已有）

## 测试

**vitest 单测**（`src/agents/team-preset.test.ts`）：
1. 锚点改写：4 个目标行各插入 `disabled: true`，缩进正确，其余文本逐字节不变
2. 幂等：对已禁用行不重复插入（生成结果再生成 = 不变）
3. 锚点缺失：缺失锚点 warn + 跳过，其余锚点照常
4. 同名用户 preset 保护：无标记目录存在时不覆盖
5. 服务缺席：无 agentPresets 时不写任何文件、不抛错
6. enabled=false：不写文件

**端到端验证**（复现环境：alpha4 + 用户数据副本 + mock LLM）：
1. 启动后 roster 出现 agent-team；副本 settings 设 `agent-presets.default: agent-team`
2. 新会话抓包：5 个 subagent 族工具消失、`tool:subagent` 引导段消失、`team_delegate` 在、团队名册段在
3. 强制 team_delegate 委派 explorer：子 Agent 收到角色 persona + 白名单，正常完成
4. 对照组 standard 模式会话：原生 subagent 工具族原样在

## 文档更新

- AGENTS.md：Agent 注册表/委派条目补「agent-team preset 自动生成」一句
- docs/usage/：手册补「团队模式」使用说明（如何在模式选择器选用）
