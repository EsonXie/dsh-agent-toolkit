# 消息机器人删除功能 + bot 模型配置语义（main 可配 / 角色用角色模型）设计

日期：2026-09-04（v2 修订：2026-09-04，人工验收后调整模型语义）
状态：v2 待评审

## 修订说明（v1 → v2）

v1 将 bot 自带 `agentOptions`（provider/model）**彻底移除**、模型改由绑定 Agent 决定（main → 宿主默认）。该版本已在分支 `feat/bots-delete-remove-agentoptions` 实现。人工验收后用户反馈：绑 main 时希望能**为每个 bot 各自配置** provider/模型，而不是跟随宿主 composer 的默认模型切换。v2 将 `agentOptions` 以「仅绑 main 可配」的形式恢复；绑角色的语义（`role.model ?? 宿主默认`）维持 v1 不变。

需求 1（列表行内删除）v1 已定案并实现，v2 无变化，原文保留。

## 背景与目标

消息机器人（BotsModal）两项调整：

1. **增加删除功能**：后端 `DELETE /dsh-agent-toolkit/api/bots/bots?id=`（`src/bots/api.ts`）与客户端 `deleteBot()` RPC（`src/client/bots/api.ts`）均已存在——删除即停渠道、取消在飞会话、清绑定、删记录、删密钥（历史会话保留，降级未分组）。缺的只是 UI 入口。（v1 已实现）
2. **bot 模型配置语义**：创建/编辑表单第一步的 Provider、模型两个下拉（写入 `agentOptions`）**仅当绑定 Agent 为 `main` 时显示且必填**；绑角色时隐藏。模型解析：
   - 绑 main → `bot.agentOptions ?? 宿主默认`（`agentDefaultModel.currentSelection()`；兜底兼容无该字段的存量记录）；
   - 绑角色 → `role.model ?? 宿主默认`（记录里残留的 `agentOptions` 不读）。

## 决策记录

- **删除入口**：列表行内删除按钮（编辑表单不加）。理由：删除路径最短，无需先进编辑表单。
- **agentOptions 语义（v2）**：保留 bot 级字段但仅 main 生效。理由：用户需要按 bot 固定模型（不随 composer 默认切换漂移）；角色路径已由 `role.model` 覆盖，bot 级字段对角色冗余且会误导（配了不生效），故绑角色时隐藏并清除。
- **绑角色保存时清除 `agentOptions`**：编辑模式提交 `agentOptions: null`（PUT 清除语义）；新建模式不携带该字段。理由：记录里不留「不生效的配置」，切回 main 时按必填校验重新填写（Provider 默认选中第一项，成本可忽略）。备选「保留原值以便切回」被否：记录语义混乱。
- **宽容兜底**：绑 main 但记录无 `agentOptions`（v1 窗口期创建的记录）运行时回退宿主默认，不报错。理由：v1 窗口期短、记录在开发环境，报错不如可用。

## 需求 1：列表行内删除（v1 已实现，无变化）

### 行结构重排（HTML 合法性）

```
div.botRow（保留现有边框/hover/flex 样式）
├─ button.botMain（flex:1，现有内容：名称/飞书徽标/状态点，点击进编辑）
└─ button.botDelete（行尾，两段确认后执行删除）
```

CSS（`bots.module.css`）：`.botRow` 的 `cursor: pointer` 移到 `.botMain`；新增 `.botMain`（透明背景、继承布局）与 `.botDelete`。

### 删除交互

- **两段确认**（与编辑表单解绑按钮同模式）：组件持单一状态 `confirmDeleteId: string | null`——首点记下该行 id、按钮文案变「确认删除？」，再点（id 匹配）执行 `deleteBot(id)`。任意其它行的删除按钮被点击时确认态转移到新行，原行复位；重开模态时 body 全新挂载天然复位。
- 成功后 `reload()` 刷新列表；请求期间该行删除按钮禁用防重复提交。
- 失败展示：组件持 `deleteError: string | null`，在列表视图底部「新建机器人」按钮上方渲染 `role="alert"` 错误行；下次发起删除或切换确认态时清除。加载失败的既有错误行（带重试语义）不动，与删除错误互不混用。

### 删除语义（后端已有，零改动）

`stopBot`：停渠道 → 取消该 bot 全部在飞会话 → 清绑定表 → 删记录 → 删密钥。历史会话保留但解除绑定。

## 需求 2：agentOptions 仅绑 main 可配（v2）

### 模型解析语义（目标态）

`channels/router.ts` 的 `resolveSession`：

- main（或缺省/指向不存在角色降级）→ `bot.agentOptions ?? this.defaultModel()`（内联，不恢复 `resolveOptions` 方法）
- 角色 → `role.model ?? this.defaultModel()`（v1 现状，不变；即使记录残留 `agentOptions` 也不读）

`defaultModel` 依赖注释语义：「未自配模型的 bot（main 形态）与未配置模型的角色的模型来源（宿主默认模型）」。

### 文件改动清单（相对 v1 实现后的分支状态）

| 文件 | 改动 |
|---|---|
| `src/bots/store.ts` | `BotRecordSchema` 恢复 `agentOptions: { provider?, model? }` 可选块（与 v1 删除前逐字一致） |
| `src/bots/api.ts` | `CreateBodySchema`/`UpdateBodySchema` 恢复 `agentOptions`（Update 支持 `null` 清除）；恢复 `ProviderOption`/`ModelOption` 接口、`ApiDeps.listProviders/listModels`、`/providers` + `/models` GET 端点及 405 清单对应项；POST/PUT 处理器恢复 `agentOptions` 落表/合并/清除逻辑 |
| `src/bots/index.ts` | 恢复 `listProviders`/`listModels` 接线与 `import type {} from '@deepseek-ai/dsh-llm'` |
| `src/channels/router.ts` | main 分支 → `bot.agentOptions ?? this.defaultModel()`；注释更新 |
| `src/client/bots/api.ts` | `BotInput` 恢复 `agentOptions`；恢复 `fetchProviders`/`fetchModels`/`ProviderOption`/`ModelOption` |
| `src/client/bots/BotForm.tsx` | 恢复 Provider/模型字段、相关 state 与两个 useEffect；**条件渲染**：`agentRef === 'main'`（含缺省）时显示并必填（Provider 默认选中第一项、模型下拉为空回退手填、留空保存被拦——v1 前原行为），绑角色时隐藏且不校验；save()：绑 main 提交 `agentOptions`，编辑模式绑角色提交 `agentOptions: null`，新建模式绑角色不携带 |
| `docs/usage/feishu-bots.md` | 字段表加回 Provider/模型行（注明「仅绑定 main 时可配」）；「绑定 Agent」行语义改写；API 表加回 `/providers`、`/models` 两行 |

`src/channels/ports.ts` 的 `AgentsPort.create/resume` 形参 `agentOptions` 保持不动（宿主 API 形态，delegate 同用）。

### 表单交互细则

- **编辑回显**：绑 main 且记录有 `agentOptions` → 回填；无（v1 窗口期记录）→ Provider 默认第一项、模型按原校验规则处理。
- **切换绑定**：表单内从角色切回 main → 字段出现（值为当前 state，初始为空则走默认第一项）；从 main 切到角色 → 字段隐藏，保存时清除记录值。
- **校验**：必填校验仅在 `agentRef === 'main'` 时生效。

### 存量数据

- v1 之前的旧记录（带 `agentOptions`）：schema 恢复后自然回读，绑 main 的即刻生效；绑角色的被忽略且下次编辑保存时清除。
- v1 窗口期记录（绑 main、无 `agentOptions`）：运行时回退宿主默认；编辑保存时必填校验要求补上。
- 无需任何迁移代码。

## 测试影响

| 测试文件 | 改动 |
|---|---|
| `src/bots/store.test.ts` | fixture 恢复 `agentOptions`；v1 的「未知键剥离」钉删除（字段回来了），改为「无 agentOptions 的记录正常解析」钉 |
| `src/bots/api.test.ts` | 恢复 `listProviders/listModels` deps 与 `/providers`、`/models` 端点用例；v1 的「agentOptions 被忽略」钉改为「agentOptions 正常落表」；新增「PUT `agentOptions: null` 清除记录字段」用例 |
| `src/channels/router.test.ts` | main 分支三态钉：有 `agentOptions` 用记录值 / 无则回退宿主默认；角色两态钉（有 model / 无 model 回退）保留；新增「绑角色的记录残留 `agentOptions` 不读」钉 |
| `src/client/bots/bot-form.client.spec.tsx` | 恢复 v1 删除的 providers/models stub 与相关断言；新增「绑角色时 Provider/模型不渲染、编辑模式保存携带 `agentOptions: null`」用例；绑 main 的既有用例断言 payload 含 `agentOptions` |
| `src/client/bots/bots-modal.client.spec.tsx` | 无变化（需求 1 用例不动） |

## 验收标准

1. 列表行尾出现删除按钮；首点变「确认删除？」，再点删除该 bot，列表刷新且该行消失。（v1 已验收）
2. 删除后：渠道停止、在飞会话取消、绑定清除、凭据删除（后端已有行为，经 UI 触达）。（v1 已验收）
3. 表单绑 main 时显示 Provider/模型且必填；绑角色时两字段隐藏，提交 payload 不含 `agentOptions`（编辑模式携带 `agentOptions: null`）。
4. 绑 main 的 bot 收到消息时，会话以 `bot.agentOptions` 创建/恢复（无该字段回退宿主默认）；绑角色的 bot 用 `role.model`（未配置回退宿主默认），记录残留的 `agentOptions` 不生效。
5. 存量带 `agentOptions` 的旧记录：schema 恢复后自然回读；绑 main 即刻生效。
6. 两包 `pnpm test` + `pnpm typecheck` + bundle 全绿。
