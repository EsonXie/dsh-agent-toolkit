# Agent 工具白名单 UI 显式化 + deny 彻底清理 设计

日期：2026-09-01
状态：已获用户批准（2026-09-01）

## 背景

- 合并重设计（2026-08-26）时定案"tools 仅白名单，deny 不做"，数据模型（`agents/store.ts` 的 `tools?: { allow: string[] }`）与委派透传（`delegate/tool.ts` 的 `toolFilter.allow`）均已只支持白名单。
- 残留：① `import-yaml.ts` 仍解析 `tools.deny` 并 warn 丢弃（兼容 shim）；② UI 的"工具白名单"区块对**未配置**（`tools === undefined` = 不限制）的角色显示为全不勾，与"自定义但全不勾"视觉不可区分——用户因此误判 explorer 的只读约束丢失；③ 旧架构 explorer 的 `deny: [write, edit]` 硬约束在合并时随 deny 语义一并消失，目前只读仅靠 persona 软约束。

## 决策（用户已确认）

| 问题 | 决策 |
| --- | --- |
| UI 方案 | **方案 A：radio 二选一**「不限制（继承会话全部工具）/ 自定义白名单」 |
| explorer 默认白名单 | **只读 + shell**（同旧架构）：read / read_image / glob / grep + pwsh（win32）或 bash（其余平台） |
| YAML deny 兼容 shim | **彻底删除**（deny 键作未知键静默剥离，不再 warn） |
| 存量 explorer 记录 | **一次性幂等迁移**：`tools === undefined` 时补默认白名单（meta 标记） |

## 设计

### 1. UI 显式化（`src/client/agents/AgentEditor.tsx`）

- 工具区块顶部加 radio 二选一：
  - 「不限制（继承会话全部工具）」
  - 「自定义白名单」
- 初值派生：编辑模式 `agent.tools !== undefined` → 自定义并回显勾选；否则 → 不限制。新建模式维持现状：自定义 + 名册到达后默认全勾。
- 选「不限制」时 checkbox 组禁用并灰显（值保留在 state，切回自定义时不丢勾选）。
- 保存映射：不限制 → 省略 `tools` 字段；自定义 → `tools: { allow: tools }`。
- **校验**：自定义模式下勾选数为 0 → 保存按钮禁用并附 hint"自定义白名单至少勾选一个工具，或改选不限制"（与新建模式名册未到禁用保存的现有模式一致）——防止空数组静默退化为不限制（schema `min(1)` 语义）。

### 2. explorer 默认白名单（`src/agents/builtin.ts`）

- explorer 记录加 `tools: { allow: <派生值> }`。
- 派生方式：`NATIVE_TOOL_NAMES.filter((n) => n !== 'write' && n !== 'edit')`（从 `channels/basic-tools.ts` 导入）。
  - 必须派生不可写死：shell 工具按平台互斥注册（win32=pwsh，其余=bash），宿主 `tools.restrict` 对未知名响亮失败（旧 team preset 注释有前车之鉴）。
- general 维持不配置（不限制）。

### 3. 存量迁移（`src/agents/registry.ts`）

- 新增 meta 标记键 `explorer_readonly_migrated`（与 `TOOLS_NATIVE_MIGRATED_KEY` 同款一次性幂等模式）：
  - 标记未置位时：explorer 记录存在且 `tools === undefined` → put 补默认白名单（派生值同上）；置位标记。
  - 已配 tools 的 explorer（用户改过）不动。
- **启动顺序约束**：`createRegistry` 内 `seedBuiltins` 移到全部迁移（含原生并入）之后执行——新种入的 explorer 自带只读白名单，若先种入，原生并入循环（向已配 tools 的记录合并全部 `NATIVE_TOOL_NAMES`）会把 write/edit 加回，新装环境的只读约束即失效。
- 迁移后用户可经新 UI 显式改回「不限制」——新 UI 使其成为可表达的有意选择。

### 4. deny 彻底清理

- `src/agents/import-yaml.ts`：
  - zod schema 删 `deny` 字段 → 存量 YAML 的 `tools.deny` 作未知键静默剥离（与 zod 默认 strip 行为一致）。
  - 删 deny warn 分支与 `warn` 参数说明中的 deny 提法。
  - 空 tools 校验文案去掉 "allow/deny 至少配一个" → 改为仅指 allow。
- `src/agents/store.ts`：注释保留"仅白名单"语义说明，删"用户定案：deny 不做"的历史表述。
- `docs/usage/agents.md`：删"`tools.deny` 被忽略并记 warn"等 deny 提及。
- 不动：`archive/`、可行性评估、`docs/refer/`（宿主文档镜像，deny 是宿主 tools 子系统的合法概念）。

### 5. 测试

- `agents.spec.tsx`：radio 初值派生（无 tools → 不限制；有 → 自定义回显）、切不限制保存省略 tools、自定义空勾选保存禁用/报错。
- `builtin.ts` / `store.test.ts`：explorer 默认白名单断言（平台条件名）。
- `registry.test.ts`：迁移幂等；已配 tools 的 explorer 不被误伤；标记置位后不再迁移。
- `import-yaml.test.ts`：deny 键剥离断言替换原 warn 断言；空 tools 文案。
- 验证三件套：`pnpm --filter dsh-agent-toolkit test` + `typecheck` + `bundle`。

## 影响面

仅 `packages/toolkit`：`src/client/agents/AgentEditor.tsx`（+ css/spec）、`src/agents/{builtin.ts, registry.ts, import-yaml.ts, store.ts}`（注释）+ 各自测试、`docs/usage/agents.md`。无 schema 结构变更（`AgentRecord.tools` 不变），无 API 变更，`@dsh-agent-toolkit/token-usage` 不受影响。
