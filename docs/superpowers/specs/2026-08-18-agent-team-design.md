# Agent 团队插件设计（team = preset，一次性委派）

> 日期：2026-08-18
> 依据：`docs/2026-08-18-插件组技术可行性评估.md`（源码闭环）+ 设计讨论确认
> 状态：设计已获用户确认，待实现

## 1. 核心命题

- **团队 = preset**：一个"团队"就是一个 dsh agent preset 目录。团队的选择/创建/复制/删除/设默认全部复用原生 preset 机制与 Web UI，插件不自建团队管理界面。未来若做"团队构建界面"，它只是 preset 目录的编辑器/生成器，对插件是纯增量、零改动。
- **角色 = preset 目录内的独立 `roles.yml`**：角色定义跟随团队走，各团队互不干扰；无全局 `Config.roles`，无合并语义。
- **委派 = 一次性 spawn 子 Agent**：主 Agent 自主决策，前台同步等待结果。不做后台并行、不做长期队友、不做角色 scoped 注入（一次性路径无注入 seam，见评估报告 §1.4）。

## 2. 包结构

```
packages/agent-team/
├─ package.json          ← peerDeps 拷贝 ACP 依赖集
├─ tsconfig.json
├─ src/
│   ├─ index.ts          ← 命名导出 name/inject/Config/apply（无 default export）
│   └─ roles.ts          ← roles.yml 加载 + Schemastery 校验
└─ presets/team/         ← 随包发行的示例团队（"团队模式"）
    ├─ agent.cordis.yml  ← 挂载本插件（config 可只写 rolesFile 默认值）
    ├─ preset.yml        ← name/description/order（仅展示文本）
    └─ roles.yml         ← 示例名册（2-3 个通用角色，如 reviewer/researcher）
```

## 3. 插件 Config

```ts
Config = {
  rolesFile?: string        // 默认 './roles.yml'，相对 preset 目录（经 ctx.baseUrl 解析，
                            // preset 挂载时 baseUrl 被重写到 preset 目录，
                            // agent-presets/src/mount.ts:48 及 cordis preset skills 先例）
  provider?: string         // 默认 'spawn'
  toolName?: string         // 默认 'team_delegate'
  promptTemplates?: {       // 基础层 C 段（模型适配）模板覆盖入口
    default: string
    families?: Record<string, string>   // 如 { 'deepseek-reasoner': '...' }
  }
}
```

## 4. roles.yml 格式

```yaml
roles:
  - name: reviewer            # 必填；标识符（字母数字 + -_）；重名加载报错
    description: 代码审查员    # 必填；一句话职责，主 Agent 选角的唯一依据
    persona: |                # 必填；角色层提示词
      你是资深代码审查员……
    provider: deepseek        # 可选；缺省继承主 Agent
    model: deepseek-reasoner  # 可选；缺省继承主 Agent
```

- 角色字段只有 `name/description/persona/provider/model`。**不做 toolFilter**：成员工具与主 Agent 保持一致。
- provider/model 都不写 = 完全继承主 Agent；写了走 `resolveChildAgentOptions` 覆盖（父 agent 为底），provider 无适配器时响亮失败。
- 校验用 Schemastery；任一角色非法（缺字段/重名/name 非法）或文件缺失/解析失败 → 插件激活时抛错 → preset 挂载被拒 → 新建会话立即失败，不半挂。
- 不监听 roles.yml 热更：standing mount 的 generation 语义保证"改 roles.yml → 下一个新会话生效"，已开会话保留旧名册。

## 5. 成员系统提示词：两层结构

**成员系统提示词 = 基础层（插件内置，三段） + persona 层（roles.yml）**。roles.yml 只写 persona 层。

基础层三段：

| 段 | 内容 | 说明 |
|---|---|---|
| A. 身份与契约 | 被主 Agent 委派的成员；任务自包含、看不到主对话；最终输出作为结果返回；禁止再委派 | 所有模型通用 |
| B. 能力使用守则 | 工具使用规范、MCP 资源使用边界、动手前先读项目 AGENTS.md 等 | 所有模型通用 |
| C. 模型适配段 | 按 provider/model 族切换措辞（如 reasoning 模型不加"逐步思考"类指令，chat 模型加输出格式约束） | 模型族 → 模板映射 |

- C 段实现：插件内置"模型族 → 模板"映射表（含 `default` 兜底），按 `resolveChildAgentOptions` 解析出的最终 model 匹配；`Config.promptTemplates` 可覆盖。
- 背景：子 Agent 的 `persona` 会遮蔽 deployment 级 persona（"shadows deployment:persona"），基础层必须由插件主动补。

## 6. team_delegate 工具契约

模型可见面（对齐内置 tool-subagent 的"配置在 Config、任务在输入"范式）：

```jsonc
// 参数
{ "role": "reviewer",            // 必填，必须命中名册
  "description": "审查登录模块",  // 必填，3-5 词展示用短标签
  "prompt": "请审查 src/auth/…" } // 必填，自包含任务书
// 返回（规范 JSON）
{ "kind": "foreground", "role": "reviewer", "runId": "…", "output": [/* content blocks */] }
```

- **工具 description**：激活时动态拼装 = 固定委派语义说明（成员看不到本对话、任务要自包含）+ 当前名册列表（每角色一行 `name: description`）。
- **systemPrompt.section**：团队介绍段，告诉主 Agent 有团队可用、用 team_delegate 委派；order 参考内置 `116.5` 附近。
- **执行管线**（照抄内置 `settleForegroundRun` 语义）：
  1. `exec.agent` 为空 → 报错
  2. role 未命中 → 报错并列出可用角色名（主 Agent 可自愈重试）
  3. `ctx.subagents.start(provider, { label: 'role:<name>: <description>', persona: 两层拼装, agentOptions?（角色配了才传）, maxDepth, prompt, parent: exec.agent, signal: exec.signal })`
  4. `await run.result`；stopReason 非 `completed` → 报错并附成员部分产出（`withPartialText` 语义）
  5. 结果收集与 `run.dispose()` 走 `Promise.allSettled`，dispose 失败不掩盖结果失败（AggregateError）
  6. 返回规范 JSON
- **并发**：`isConcurrencySafe: () => true`。
- **防套娃**：委派请求携带 `maxDepth: 1`，成员（深度 1）再调 team_delegate 会被 provider 响亮拒绝。toolFilter 路线不可用（只过滤全局工具，team_delegate 是 preset scoped 注册）。0/1 边界语义实现时对 `assertSubagentMaxDepth` 与 provider 源码核实后钉死。

## 7. 错误处理汇总

| 场景 | 时机 | 行为 |
|---|---|---|
| roles.yml 缺失/解析失败/校验失败 | 插件激活 | 抛错，preset 挂载被拒，新建会话立即失败 |
| 角色 provider 无适配器 | 首次委派该角色 | `resolveChildAgentOptions` 响亮失败 |
| role 未命中 | 委派时 | 报错 + 列出可用角色名 |
| 成员异常终止 | 结果收集 | 报错 + 附部分产出文本 |
| 成员试图再委派 | 成员执行时 | provider 按 maxDepth 拒绝 |
| 插件 HMR 卸载 | 任意 | cordis 自动清理注册；名册是纯内存数据，无手动资源 |

## 8. preset 发行（两条官方路径，文档化安装步骤）

1. 部署方 patch：把 `presets/team` 加进 `agentPresets.config.roots`（`trust: 'system'`）——dsh CLI 发行内置 preset 的同款做法。
2. 用户 copy：团队在 UI 出现后，用户复制派生自己的团队，改 roles.yml 即可。

## 9. 测试策略

1. **单测**（vitest）：roles.yml 解析/校验（合法、缺字段、重名、缺文件）；两层提示词拼装（模型族模板选择、Config 覆盖）。
2. **REAL-composition 测试**：boot 测试专用 cordis.yml（preset + 插件），断言工具注册、名册编入 description、未知 role 报错列名册。
3. **HMR 安全测试**：dispose 插件 fiber → 工具与提示段注册移除。
4. 真实 LLM 端到端委派不进单测，作为开发回路手动验证项。

## 10. 范围之外（明确不做）

- 角色 scoped 工具/技能注入（一次性路径无 seam；评估报告 §1.4）
- 后台并行委派、长期可继续队友
- 自建团队管理 UI（未来纯增量）
- outputSchema 结构化产出（一次性路径虽支持，当前无需求）
