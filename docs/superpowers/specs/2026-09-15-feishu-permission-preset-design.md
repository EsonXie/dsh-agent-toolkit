# 飞书 bot 会话权限预设（permissionPreset）设计

> 2026-09-15。来源问题：飞书聊天中 Agent 提权时飞书无任何响应、只能去 web 界面审批（审批卡不发）。
> 结论：**不修审批卡链路**，改为给飞书 bot 会话提供「建账即应用权限预设」的配置能力（典型用法
> `danger-full-access` = 完全权限不审批），绕开整个审批交互面。

## 问题与根因考古

现象：飞书会话里 Agent 需要提权时，飞书无审批卡片、Agent 挂起，只能在 web 界面点允许。

核实过的机制链（均为现行宿主行为）：

- web 提权弹窗是浏览器端 answerer（`ui-approval` 经 Remote Events waterfall 转发）；插件宿主侧
  answerer prepend 在前（`bots/index.ts`），`next()` 让出后才轮到 web。「飞书无卡 + web 弹窗」=
  插件 answerer 让出。让出路径：会话不在 `sessions` map / 渠道无审批能力 / `present()` 抛错后
  warn 回退（`ctx.logger.warn` 在 dsh web 不可见 → 静默卡住的主嫌疑）。
- **委派子会话在宿主侧被无条件钉死 `approval/policy: 'never'`**
  （`deepseek-harness/packages/subagent/subagent/src/child-agent.ts:242-247`
  `captureDelegatedPolicyOverrides`：approval 服务在场即 pin；`source: 'delegation'` 写入子会话
  日志）。子 Agent 系统提示被告知不要请求提权，请求在 answerer 瀑布之前就被策略层拒绝
  （`user-approval/src/index.ts` decide()）。因此委派子会话**不可能卡在审批上**，「覆盖委派
  子会话审批路由」是一条永远不会命中的代码路径，方案否决。
- 宿主自带权限预设服务 `permissionPresets`（`interaction/permission-presets`）：预设 =
  `sandbox/mode` + `approval/policy` 两个会话日志事件（last-event-wins，重启回放恢复）。内置
  `workspace-write`（ask，默认）与 `danger-full-access`（never，完全权限）。`set()` 幂等：
  knob 值未变不追加事件。`session/created` 时 `pinInitialPermission` pin 默认预设。
- 委派边界自动继承父会话 sandbox override（child-agent.ts:244）→ 主会话完全权限后子 Agent
  同样完全权限，零代码。

## 设计

### 配置

`feishu.permissionPreset: z.string().optional()`（与 `feishu.approval` 同级）：

- 缺省 = 维持宿主默认预设，行为完全不变。
- 设为宿主预设表中的合法名（如 `'danger-full-access'`）= 本部署全部飞书 bot 会话应用该预设。
- 非法名：warn 并跳过，会话照常可用（配置错误不打死聊天链路）。

### 应用点

`createAgentsPort`（`channels/agents-port.ts`）加第 4 个可选参数 `applyPreset?: (session: Session) => void`，
在 `adaptAgent`（create/resume 返回的 AgentHandle）与 `adaptLive`（agents.get 接管）里、拿到
`agent` 后调用。agents-port 的三个方法恰好一一对应四条建账路径（渠道层只有它能拿到
`agent.session`——`AgentPort` 结构化端口不暴露 session）：

- `create()`：新会话。宿主 `session/created` 先 pin 默认预设，create resolve 后我们覆盖
  （last-event-wins，时序天然正确）；
- `resume()`：冷会话恢复（含重启恢复、`/new` 重建、`/switch` 冷接管）；
- `get()`：web 存活会话被接管（ensure/switch 的 `agents.get` 命中路径；归飞书管，权限跟随，
  符合配置意图）。

**不应用**的两条天然被排除：活跃会话复用（ensure 查插件自有 `sessions` map 提前返回）与
`/switch` 命中插件内存会话——两条路径都不经过 `agents.get`，保持会话当前权限状态，不把 web
正在使用的会话静默翻转。

schedule 执行器共用 `createAgentsPort` 但不传 `applyPreset`，cron 会话不受影响。

### 服务获取

`ctx.get('permissionPresets')` 可选服务读取（`agentPresets` 先例，不进 inject 硬依赖）；
配置了但服务缺席 → warn 一次跳过。

### 实现触点

1. `src/index.ts`：Config schema `feishu` 加 `permissionPreset`。
2. `src/bots/index.ts`：`BotsModuleConfig` 加字段；装配 `applyPreset` 闭包（服务缺席/非法名
   warn）；`import type {} from '@deepseek-ai/dsh-permission-presets'` 激活 `ctx.get` 类型
   （package.json devDependencies 加 link，照 `dsh-user-approval` 先例）。
3. `src/channels/agents-port.ts`：`createAgentsPort` 加可选参数并在 adaptAgent/adaptLive 调用。

### 安全警示（写进文档与配置注释）

`danger-full-access` 下任何能给 bot 发消息的人 = 拿到宿主机器完全文件/命令权限；群聊中
@ bot 即触发。建议仅私聊 bot 启用。

### 与审批卡功能的关系

启用 `danger-full-access` 后审批不再发起，`feishu.approval` 卡片在该路径上不触发（两者不
冲突：approval 仍服务于未配 preset 的部署）。原「主会话不出卡」问题保持未修、优先级降低。

## 测试

- `channels/agents-port.test.ts`（新建）：create/resume/get 三方法均调用 applyPreset 且参数为
  agent.session；未传该参数不调用（schedule 路径形态）。
- `bots/index.test.ts`：服务缺席 → warn 不抛；非法名 → warn 不调 set；合法 → 调
  `svc.set(session, name)`。
- `bots/smoke.test.ts`：feishu config 键清单钉住测试补 `permissionPreset`。
- 真实回路验收：cordis.yml 配 `permissionPreset: danger-full-access` → 飞书 `/new` → 让
  Agent 写工作区外文件 → 不弹审批直接成功 → 再委派子任务验证子 Agent 同样畅通。

## 文档同步

- `docs/domains/feishu.md`：配置语义、覆盖路径（含接管翻转 / switch 内存复用不翻转）、
  委派继承零代码、安全警示。
- 发布时：releases.md 追加；`docs/usage/` 手册补说明。
