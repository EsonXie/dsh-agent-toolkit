# bot 会话挂 preset 修复委派子会话工具继承 设计

日期：2026-09-07
状态：已实施（2026-09-07）

## 背景与目标

实际使用发现：从**飞书 bot 会话**里用 `team_delegate` 委派给 general（无工具白名单、继承全部工具），子 Agent 抵达模型时**只有 `team_delegate` 一个工具**，无法读写文件/跑命令。Web 主会话发起的委派正常。

根因链（已对源码逐项核实）：

1. bot 会话 agent scope 的唯一父链被 `toolsScope.join()` 绑到 toolkit 自建 `bots-tools` standing scope（`src/channels/tool-scope.ts`，key = `{origin:'dsh-agent-toolkit', kind:'bots-tools'}`），BASIC_TOOLS 挂在这层。
2. 委派子会话由宿主 spawn 驱动组装：`applyChildComposition` → `agentPresets.composeFrom(childCtx, parent.ctx)`（`deepseek-harness/packages/subagent/subagent/src/child-agent.ts:168`）。
3. `composeFrom` → `standingMountFor(parent)` 读父 agent scope 的**直接父链**去 `livePresetMounts()` 里匹配 preset mount（`deepseek-harness/packages/preset/agent-presets/src/mount.ts:222`）——`bots-tools` 不是 preset mount，匹配落空返回 `undefined`，子 agent **不加入任何组合**。
4. 原生工具全在 agent 平面，工具注册表全局层为空（agent-presets README 明示的设计）；子 agent 只剩全局层里的 `team_delegate`（toolkit 在插件根 ctx 注册）。

目标：bot 会话发起的委派，子会话继承与父会话相同的基础工具行（persona/instructions/shell/fs/fs-search）。**bot 会话自身的工具面与提示组成保持不变**。

## 方案：bot 会话改挂 toolkit 生成的最小 preset

`SubagentStartRequest` 无 setup 钩子、一次性 spawn 不走 `ContinuableSetupContribution`，toolkit 无法在委派时给子会话补挂工具——唯一修法是让 bot 会话的 scope 父链本身就是一个 preset standing mount，使 `composeFrom` 能认到。

### 为什么不挂 `agent-team`

`agent-team` 派生自 standard，除 BASIC_TOOLS 外还带 tool-jobs / skill / tool-goal / plan-mode / compaction / workflow / ralph / ask_user / todo / web 等行——挂上会大幅改变 bot 会话工具面与提示组成（ask_user 等工具在飞书渠道语义不明）。拒绝。

### 新增生成的最小 preset `agent-bot`

复用 `team-preset.ts` 的生成机制（用户 root、`.generated-by` 标记保护、启动重写自愈、`PRESET_ID` 白名单、失败 warn 降级），启动时与 `agent-team` 同处生成第二个 preset，id 默认 `agent-bot`。composition 只含与 `BASIC_TOOLS` 一一对应的 5 个行：

```yaml
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
- id: tool-pwsh            # win32；其余平台生成 tool-bash（生成期定平台，不用 !!js）
  name: '@deepseek-ai/dsh-tool-pwsh'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false
```

这些行注册进宿主 tools 注册表、不提供服务，按 standard 注释无需 isolate realm。行内容以 `BASIC_TOOLS` 常量为单一来源序列化生成（不再维护第二份文本），保证 bot 会话工具面与现状逐字节等价。preset 行解析走宿主 loader（profile node_modules 锚点），比现状 toolkit 动态 import 的解析路径更稳（0.2.3 事故的依赖声明要求随之消解，但 devDependencies 声明保留给回退路径）。

### 挂载点与回退

`setupAgentScope`（`src/channels/agent-setup.ts`）的第三参从 `ToolsScope` 泛化为 `ScopeJoiner`（`join(agentCtx): Promise<unknown>`——Task 4 实施修正：`Promise<ScopeKey>` 不可赋给 `Promise<void>`，void 返回类型过窄）。bots 模块构造 preset 优先的 joiner：

```
join(agentCtx):
  agentPresets = ctx.get('agentPresets', false)   # join 时惰性解析（attachments 教训：apply 期捕获不可靠）
  if agentPresets 存在:
    try: await agentPresets.mount(agentCtx, config.botsId); return
    catch: warn（含原因）→ 落回退
  await toolsScope.join(agentCtx)                  # 回退：rosterless/旧宿主/mount 失败
```

- `mount` 设计即在 agent factory 的 `setup(agentCtx)` 里调用，拒绝会回滚创建；我们先 try 住转回退——**bot 可用性优先**，preset 出问题不阻断收发消息。
- 回退路径保留已知缺陷（委派子会话无工具），warn 文案明说这一点。
- 生成已在 `src/index.ts` 中 `await` 且先于 `setupBots`，首次 bot 会话创建时 preset 必然已就绪（生成失败则走回退）。
- join 之后的 scoped persona / hooks.sections / `tools.restrict` 全部不变（mount 与 toolsScope.join 同为祖先层绑定，0.2.4 的 join→restrict 语义原样成立；角色 tools 白名单过滤 preset 继承面）。
- resume 路径同 setup，存量 bot 会话恢复后自动换成 preset 组合。

### 委派子会话侧零改动

父会话父链是 preset standing mount 后，`composeFrom` 认父成功，子 agent 加入**同一代际同一实例**（same plugin objects、same tool registrations），自动获得 5 个工具行；`team_delegate` 走全局层照旧可见；角色白名单经请求的 `toolFilter` 在子上 restrict 照旧。`childSessionMeta` 还会把 `agentPreset: 'agent-bot'` 记入子会话头，冷读重建也拿到正确工具集。

## Config

`agentTeamPreset` 段加一个字段（复用同一生成开关与 root 选择）：

- `agentTeamPreset.botsId: z.string().default('agent-bot')`：bot 会话挂的最小 preset id；非法 id 走现有 warn+跳过。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/agents/team-preset.ts` | 生成函数产出第二个 preset（`botsId`，内容从 `BASIC_TOOLS` 序列化） |
| `src/agents/bot-preset.ts`（新） | `BASIC_TOOLS` → composition YAML 文本的序列化（平台定 shell 行），单测锚定逐行内容 |
| `src/channels/scope-joiner.ts`（新） | preset 优先 joiner（mount 成功即用；失败 warn 回退 toolsScope）；`agentPresets.mount` 的结构类型定义在此 |
| `src/channels/agent-setup.ts` | 第三参泛化为 `ScopeJoiner`；join→sections→restrict 顺序不变 |
| `src/bots/index.ts` | 构造新 joiner 替换直接传 `toolsScope`；`toolsScope` 保留作回退 |
| `src/index.ts` | Config 加 `agentTeamPreset.botsId`；透传 |
| 测试 | bot-preset 序列化单测；joiner 的 mount 成功/失败回退/agentPresets 缺席三分支（fake agentPresets + 真实 dsh-scope）；**真实组合守护测试**：真实 `@deepseek-ai/dsh-agent-presets` + 临时 root 装生成的 `agent-bot`，父 scope mount 后 `composeFrom` 子 scope，断言子继承到工具注册（tool-scope.test.ts 用真实 dsh-scope 的先例） |
| `AGENTS.md` | 删除"已知缺口（bot 会话委派子会话看不到基础工具行）"记录，更新 bots 组装描述 |

## 不在本次范围（YAGNI）

- Web 主会话委派（本就正常，不动）。
- bot 会话工具面不变更（不引入 jobs/skills/plan-mode 等 standard 其余行）。
- `agent-team` preset 的生成与内容不动。
- 浏览器半无改动。

## 验证

- `pnpm --filter dsh-agent-toolkit test` + `typecheck` 全绿；改 usage 无需（无依赖），`bundle` 后开发回路验证。
- 开发回路：link 插件 → 飞书 bot 单聊 → 让 bot 委派 general 读写文件 → 子会话实际执行 read/write/pwsh 成功；角色带白名单的 bot 委派后子会话工具被正确 restrict。
- 回退路径：临时把 `botsId` 配成不存在的 id → bot 会话照常可用（走 toolsScope），日志有 warn。
