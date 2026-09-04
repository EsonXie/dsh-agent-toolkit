# 消息机器人删除功能 + 移除 bot 自带 provider/model 设计

日期：2026-09-04
状态：待评审

## 背景与目标

消息机器人（BotsModal）两项调整：

1. **增加删除功能**：后端 `DELETE /dsh-agent-toolkit/api/bots/bots?id=`（`src/bots/api.ts`）与客户端 `deleteBot()` RPC（`src/client/bots/api.ts`）均已存在——删除即停渠道、取消在飞会话、清绑定、删记录、删密钥（历史会话保留，降级未分组）。缺的只是 UI 入口。
2. **移除 bot 自带 provider/model**：创建/编辑表单第一步的 Provider、模型两个下拉（写入 `agentOptions`）删除，bot 会话模型改为直接取**绑定 Agent 的参数**：
   - 绑 main → 宿主默认模型（`agentDefaultModel.currentSelection()`，即主 Agent 当前所用）；
   - 绑角色 → `role.model`，未配置则回退宿主默认。

## 决策记录

- **删除入口**：列表行内删除按钮（编辑表单不加）。理由：删除路径最短，无需先进编辑表单。
- **agentOptions 清理范围**：彻底移除（schema、API 请求体、`/providers` + `/models` 端点、deps、UI）。理由：0.2.x 开发阶段无兼容负担；保留死代码反增维护面。

## 需求 1：列表行内删除

### 行结构重排（HTML 合法性）

现列表行是单个 `<button class=botRow>`，button 内不能嵌套 button。重排为：

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

## 需求 2：彻底移除 agentOptions

### 模型解析语义（目标态）

`channels/router.ts` 的 `resolveSession`：

- main（或缺省/指向不存在角色降级）→ `this.defaultModel()`
- 角色 → `role.model ?? this.defaultModel()`

`resolveOptions(bot)`（`bot.agentOptions ?? defaultModel()`）整体删除；`defaultModel` 依赖保留，注释语义从「存量 bot 无 agentOptions 时回退」更新为「main 会话的模型来源」。

### 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/client/bots/BotForm.tsx` | 删 Provider/Model 两个下拉、provider/model/providers/models/providersLoaded state、取 providers/models 两个 useEffect、`fetchProviders/fetchModels` 导入、save() 里的非空校验与 `agentOptions` 组装 |
| `src/client/bots/api.ts` | `BotInput` 删 `agentOptions`；删 `fetchProviders`/`fetchModels`/`ProviderOption`/`ModelOption` |
| `src/bots/api.ts` | `CreateBodySchema`/`UpdateBodySchema` 删 `agentOptions`；`ApiDeps` 删 `listProviders`/`listModels` 与 `ProviderOption`/`ModelOption` 接口；删 `/providers`、`/models` GET 端点及 405 清单中对应项 |
| `src/bots/store.ts` | `BotRecordSchema` 删 `agentOptions` 字段 |
| `src/channels/router.ts` | 删 `resolveOptions()`；main 分支 → `defaultModel()`，角色分支 → `role.model ?? defaultModel()`；注释更新 |
| `src/channels/runtime.ts` | `RuntimeDeps.defaultModel` 注释更新（语义不变） |
| `src/bots/index.ts` | `listProviders`/`listModels` 接线删除 |

`src/channels/ports.ts` 的 `AgentsPort.create/resume` 形参保留 `agentOptions`（宿主 API 形态，delegate 同用，不属于本次范围）。

### 存量数据：零迁移

zod object 默认 strip 未知键：

- 存量 bot 记录里的 `agentOptions` 在下次 PUT 时被 `BotRecordSchema.parse` 自动剥离；
- `GET /bots` 不经 parse，残留字段原样返回但客户端已不读，无害；
- Router 不再读 `bot.agentOptions`，存量记录行为即刻收敛到新语义。

## 测试影响

| 测试文件 | 改动 |
|---|---|
| `src/client/bots/bots-modal.client.spec.tsx` | 新增删除用例：两段确认、调 `deleteBot`、成功后 reload、失败展示错误行 |
| `src/client/bots/bot-form.client.spec.tsx` | 删 provider/model 相关交互用例与 fixture（6 处 `agentOptions`），提交 payload 断言不含 `agentOptions` |
| `src/bots/api.test.ts` | create/update body 用例去 `agentOptions`；`/providers`、`/models` 端点用例删除 |
| `src/bots/store.test.ts` | fixture 删 `agentOptions` |
| `src/channels/router.test.ts` | 「bot 有 agentOptions 原样透传」用例删除；「无 agentOptions 回退默认模型」语义保留为主路径用例 |

## 验收标准

1. 列表行尾出现删除按钮；首点变「确认删除？」，再点删除该 bot，列表刷新且该行消失。
2. 删除后：渠道停止、在飞会话取消、绑定清除、凭据删除（后端已有行为，经 UI 触达）。
3. 创建/编辑表单不再出现 Provider/模型字段；提交 payload 不含 `agentOptions`。
4. 绑 main 的 bot 收到消息时，会话以宿主默认模型创建/恢复；绑角色的 bot 用 `role.model`（未配置回退宿主默认）。
5. 存量带 `agentOptions` 的 bot 记录：功能正常，下次编辑保存后记录中该字段消失。
6. 两包 `pnpm test` + `pnpm typecheck` + bundle 全绿。
