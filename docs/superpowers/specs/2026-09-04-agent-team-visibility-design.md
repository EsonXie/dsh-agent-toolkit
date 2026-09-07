# Agent 团队可见性开关 设计

日期：2026-09-04
状态：待评审（v2：对照源码核对后修订——委派节补 `teamSectionText` 签名改动；UI 节改为硬编码中文、移除 locale 条目，并确认内置角色可设不可见；YAGNI 补 YAML 导入不支持该字段与内置角色两条）

## 背景与目标

Agent 注册表里的角色当前全部会进入委派体系：系统提示词的团队名册段（`delegate/index.ts` `teamSectionText`，order 116.6）全量列出，`team_delegate` 工具（`delegate/tool.ts`）可向任意非 main 角色委派。用户需要能停用某些 Agent 的团队曝光：让它们在名册与委派中"消失"，但不被删除、仍可作为 bot 绑定角色使用（例如专供某飞书 bot 的角色，不希望主会话能委派给它）。

目标：

- Agent 可设置「Agent 团队可见 / 不可见」；可见（启用）的 Agent 正常出现在团队名册并可被委派，不可见（停用）的 Agent 两者都拦截。
- 消息机器人（飞书 bot）始终可以绑定可见或不可见的 Agent，行为不受此开关影响。
- 存量数据零迁移、默认行为零变化。

## 数据模型

- `AgentRecord` 与 `AgentRecordSchema`（`src/agents/store.ts`）新增可选字段：

  ```ts
  visibleInTeam?: boolean
  ```

- **缺省语义 = 可见**：字段省略/`undefined` 即「在 Agent 团队中可见」；仅显式 `false` 才隐藏。因此：
  - 存量 Agent、内置 explorer/general、YAML 导入的角色全部自动可见，**无需 meta 表一次性迁移标记**。
  - 遵循编辑器现有「省略即不写字段」模式：勾选时省略字段，取消勾选时写 `visibleInTeam: false`。
- 判定辅助统一为 `isTeamVisible(role) = role.visibleInTeam !== false`，供名册段与委派工具共用。
- 落库链路（PUT API schema 校验 → `registry.upsert` 全量替换）对可选字段自动透传，**无需改动**。

## 委派链路过滤

两个挂钩点，同一判定：

1. **名册段**：`delegate/index.ts` `teamSectionText` 现有 `r.id !== 'main'` 过滤处追加 `&& isTeamVisible(r)`，隐藏 Agent 不列出。其签名 `roles: readonly Pick<AgentRecord, 'id' | 'name' | 'description'>[]` 的 Pick 需补 `'visibleInTeam'`；`delegate/index.test.ts` 的 ROSTER 夹具同步补字段。
2. **委派工具**：`delegate/tool.ts` 执行入口现有 `deps.roster().filter(r => r.id !== 'main')` 处追加同一过滤：
   - 向隐藏 Agent 委派 → 走现有"未知角色"报错路径，错误信息列出的可用角色只含可见角色（错误文案不变，隐藏 Agent 自然从清单消失）。

## bot 绑定路径（不受影响，守护测试）

- `channels/router.ts` `resolveSession` 的 `registry.get(ref)` 不经过 `isTeamVisible` 过滤：bot 可绑定可见或不可见的任意 Agent，会话装配（persona 段 / tools restrict / model 覆盖）照旧。
- bot 表单绑定下拉（`client/bots/BotForm.tsx`）继续列出全部 Agent，不加标记、不过滤。
- 不可见 Agent 被删除的既有边界不变（DELETE 404/409 语义不动）。

## UI

- `client/agents/AgentEditor.tsx` 基本信息区块（description 之后）加 checkbox「在 Agent 团队中可见」：
  - 默认勾选（新建/未设置过的 Agent = 可见）；勾选态保存时省略 `visibleInTeam` 字段，取消勾选时提交 `visibleInTeam: false`。
  - 内置角色（builtin）同样可设不可见：编辑器对 builtin 仅锁删除按钮（`locked` 只挡删除与 main 的 name），其余字段本就可编辑，本开关沿用同一语义，不加额外禁用。spec 层面确认「允许隐藏内置 explorer」是预期行为（它只是从团队曝光面消失，不删、仍可绑 bot）。
- `client/agents/AgentsModal.tsx` 角色列表行对 `visibleInTeam === false` 的 Agent 加「团队不可见」徽标（样式参照现有 builtin 徽标，即 `Pill` + `css.builtinBadge` 同款类名模式）。
- **文案遵循 agents 面板现状硬编码中文**（面板全部文案均为内联中文，无 locale 字典、不消费 `ctx.locale`；唯一的字典 `client/delegate/locales.ts` 仅供 slot/toolView 注册）。本次**不动 locale 机制**；若未来面板整体 i18n，再连同存量文案一起迁移。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/agents/store.ts` | `AgentRecord` / `AgentRecordSchema` 加 `visibleInTeam?: boolean`；导出 `isTeamVisible` 辅助 |
| `src/delegate/index.ts` | `teamSectionText` 过滤隐藏 Agent；签名 Pick 补 `'visibleInTeam'` |
| `src/delegate/tool.ts` | 委派执行入口 roster 过滤隐藏 Agent |
| `src/client/agents/AgentEditor.tsx` | 基本信息区加可见性 checkbox（硬编码中文），纳入 save() 的省略语义 |
| `src/client/agents/AgentsModal.tsx` | 列表行加「团队不可见」徽标（硬编码中文） |
| 测试 | 见下节 |

> 注：无 locale 文件改动（见 UI 节说明）。

## 测试

- `agents/store.test.ts`：schema 接受/透传/省略 `visibleInTeam`；`isTeamVisible` 三态（undefined/true → 可见，false → 不可见）。
- `delegate/index.test.ts`：`teamSectionText` 不列出 `visibleInTeam: false` 的角色，其余照旧（ROSTER 夹具补 `visibleInTeam` 字段以匹配签名）。
- `delegate/tool.test.ts`：向隐藏 Agent 委派报错且不在可用清单；可见 Agent 委派不受影响。
- `channels/router.test.ts`：bot 绑定 `visibleInTeam: false` 的角色仍正常建会话（守护「bot 始终可绑」）。
- `client/agents/agents.spec.tsx`（或对应编辑器 spec）：开关交互 + 保存省略语义 + 列表徽标渲染。

## 不在本次范围（YAGNI）

- 不做 meta 表一次性迁移（缺省可见语义天然零迁移）。
- bot 表单下拉不给隐藏 Agent 加标记。
- `/create-agent` 命令的 agentIds 列表不联动过滤（创建入口不受团队可见性约束）。
- 不提供「全局停用 Agent」（本开关只管团队曝光面，bot 绑定照常）。
- main 不进编辑器与管理列表，天然无此开关。
- YAML 导入（`import-yaml.ts` `RoleYamlSchema`）不支持预设 `visibleInTeam`：schema 无此键且 zod 默认剥离未知键；要隐藏导入的角色，需导入后在面板取消勾选。若日后有需求再扩 schema。
- 不禁止内置角色设为不可见（见 UI 节：与本开关「只控曝光面」语义一致）。

## 验证

- `pnpm --filter dsh-agent-toolkit test` + `typecheck` + `bundle` 全绿。
- 开发回路：link 插件 → Agents 面板把某角色设为团队不可见 → 主会话新开会话，系统提示名册段不含该角色，`team_delegate` 向其委派报错 → 飞书 bot 绑定该角色仍可正常收发消息。
