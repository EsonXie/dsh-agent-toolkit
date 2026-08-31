# token-usage 独立拆包与双包发布准备 — 设计

日期：2026-08-31
状态：已评审（待实施）

## 背景与目标

`dsh-agent-toolkit`（Agent 注册表 + 分层提示词 + 并行委派 + 飞书 bots + token 用量）尚未发布；npm 上仅有合并前的旧包 `@dsh-agent-toolkit/token-usage@0.1.0/0.2.0`（prompt-stack / project-bot 从未发布，无需处置）。

目标（用户已确认的决策）：

1. token-usage 拆为**完整独立 dsh 插件**，服务「只要用量统计、不要 Agent/飞书/委派」的轻量用户。
2. 沿用旧 npm 名 `@dsh-agent-toolkit/token-usage`，发布 **0.3.0**。
3. `dsh-agent-toolkit` 通过 **npm 依赖 + `ctx.plugin` 转发** 包含它，发布 **0.1.0**。
4. 发布顺序：先 token-usage 0.3.0，再 dsh-agent-toolkit 0.1.0；随后 deprecate token-usage 旧版本（`<0.3.0`）。

## 包结构

```
packages/
├─ usage/      ← 新增，npm 名 @dsh-agent-toolkit/token-usage@0.3.0
└─ toolkit/    ← 现有，npm 名 dsh-agent-toolkit@0.1.0
```

### 代码迁移（toolkit → usage）

| 源（packages/toolkit） | 目标（packages/usage） |
|---|---|
| `src/usage/`（index/aggregate/heatmap/render/routes/store + 5 个测试文件） | `src/` 对应平铺 |
| `src/client/usage/` | `src/client/` |
| `src/shared/`、`src/client/shared/` 中 usage 实际用到的部分 | `src/shared/`、`src/client/shared/`（按实际依赖拷贝） |

共享助手（`openDomainSafely`、`registerOptionalRoutes`、http 助手、`createSidebarEntry`、`useLoadState`）两包各自持有一份拷贝，**不抽第三个共享包**（YAGNI）。

toolkit 侧删除已迁出的 `src/usage/` 与 `src/client/usage/`，相关测试随代码归 usage 包；361 个测试在两包间重新分配，总数应保持等价覆盖。

## usage 独立包形态

照 toolkit 同一蓝本（`package.json` + 双半 bundle + `cordis.patch.yml`）：

- `src/index.ts`：命名导出
  - `name = '@dsh-agent-toolkit/token-usage'`
  - `inject`：实际消费的服务子集（预估 `storageDomain`、`tokenMeter`、`commands`、`agents`；`webServer` 为可选服务，headless/CLI 下 HTTP API 自动不注册）——**迁移时按 `src/usage/` 实际 ctx 消费核对，不多不少**
  - `Config`：`{ timezone: string }`，默认 `Asia/Shanghai`
  - `apply(ctx)`
- `src/client/index.ts`：导出 `inject = ['slots']` + `apply`，挂载「Token 用量」侧边栏入口与面板（usage client 只消费 `ctx.slots`，已核实）
- 自带 `cordis.patch.yml`（bundles 层，id 为包名）、新写的 `README.md`、MIT `LICENSE`
- package.json：
  - deps：`@deepseek-ai/schemastery`、`clsx`、`recharts`、`zod`（`@larksuiteoapi/node-sdk`、`qrcode`、`js-yaml` 留在 toolkit）
  - peerDeps：`@deepseek-ai/cordis` ^4
  - `files`、`publishConfig.access = public`、`dsh.bundle`/`dsh.client` 段照 toolkit 平移（`dsh.client.inject` 为信息性 boot-graph 边）
  - devDependencies 用 `link:` 指回 `deepseek-harness/` 源码（同 toolkit 现状）
- `tsdown.config.ts` 照 toolkit 平移：Node 半 ESM（`lib/index.js` + dts）+ 浏览器半 lazy-CJS factory（`lib/client.js`），`ID` 改为 `'@dsh-agent-toolkit/token-usage'`；client bundle 纯净度门禁与 CSS Modules 内联插件原样保留
- 存储域 `token_usage`（表 `daily`，守卫新增 `meta` 表）不变，老用户数据无缝衔接（域 version 保持 1：加载侧缺表即空表，已核实 `snapshot.tables[table] ?? {}`）
- HTTP 路由前缀保持 `/dsh-agent-toolkit/api/usage/*` 不变（面板内部 API，双半同迁无破坏面）
- `@deepseek-ai/dsh-storage-domain` 同样只做运行时值导入、不进 dependencies（宿主隐式提供，避免双实例）

## toolkit 集成方式

- `packages/toolkit/package.json` dependencies 加 `"@dsh-agent-toolkit/token-usage": "workspace:^"`（pnpm publish 自动转为 `^0.3.0`）
- **函数级转发**（非 `ctx.plugin`：toolkit 测试 harness 是假 ctx 对象，不支持 `ctx.plugin`；直接调用对现有测试零破坏）：
  - usage 包主入口除插件四件套外再导出 `setupUsage(ctx, config, owner)`；toolkit `src/index.ts` 把 `setupUsage` 的 import 从 `./usage/index.ts` 改为 `@dsh-agent-toolkit/token-usage`，调用处不变
  - usage 包新增 `./client-module` 导出（lib/client-module.js + d.ts，纯 ESM 无 loader 包装）；toolkit `src/client/index.ts` 把 `setupUsageClient` 的 import 改为 `@dsh-agent-toolkit/token-usage/client-module`，调用处不变
  - toolkit 的 `Config` 保留 `timezone` 与 `modules.usage`，语义不变，cordis.yml 存量配置零破坏；`inject` 不变
  - toolkit tsconfig 加 `paths` 映射到 usage 源码，typecheck 不依赖 usage 先构建
- tsdown：
  - Node 半 `neverBundle` 追加 `@dsh-agent-toolkit/token-usage`（保持 external，由 profile 安装侧解析）
  - 浏览器半无需改动：alwaysBundle 会把 usage client 代码（含 recharts）打进 toolkit 的 `client.js`；纯净度门禁只拦 `@deepseek-ai/`，不受影响
- toolkit 的 dependencies 中 `recharts`/`clsx` 若仅被 usage UI 使用则移除（client bundle 会把它们内联进 lib/client.js，Node 半不再需要）；迁移时按实际 import 核对

## 双重安装守卫

两包同时安装会导致 tokenMeter 重复计数。方案：

- `token_usage` 域 `meta` 表（若无则随 domain 布局新增）加 `meter_owner` 标记
- apply 时：若无主则占位（记录包名）并正常挂载计量；已有主则记 warn（提示另一包已在计量）并跳过计量挂载——UI 面板仍可用（读同一份数据）
- dispose（HMR/卸载）时释放占位
- 幂等、HMR 安全

## 文档与脚本

- **新写** `packages/usage/README.md`：功能简介、独立安装 `dsh plugin add @dsh-agent-toolkit/token-usage`、配置项（timezone）、与 dsh-agent-toolkit 的关系及二选一提示
- **更新** `packages/toolkit/README.md`：token 用量说明改为来自依赖包（功能描述不变）
- **更新** `docs/usage/token-usage.md`：加「独立安装」节；`docs/usage/README.md` 存储域表归属说明
- **更新** 根 `AGENTS.md`：目录结构（双包）、发布命令、待办清单（移除 prompt-stack/project-bot deprecate 项——两包从未发布；保留 token-usage 旧版本 deprecate 项）
- **LICENSE**：两包各补一份 MIT LICENSE；publish 脚本 pack 核查恢复对 README.md/LICENSE 的检查
- **发布脚本**：`scripts/publish-toolkit.ps1` 泛化为 `scripts/publish.ps1 -Package <name>`（参数化包名与包目录；六道门禁不变：npm 登录检查 → 版本冲突检查 → test → typecheck → pack 内容核查 → 人工确认 → publish → npm view 验证）

## 发布与收尾

1. `powershell -File scripts/publish.ps1 -Package @dsh-agent-toolkit/token-usage`（0.3.0）
2. `powershell -File scripts/publish.ps1 -Package dsh-agent-toolkit`（0.1.0）
3. `npm deprecate @dsh-agent-toolkit/token-usage@"<0.3.0" "已重写并合并架构，请升级 0.3.0 或直接使用 dsh-agent-toolkit"`（人工执行，不进自动化）
4. 安装验证：`dsh plugin --profile web add @dsh-agent-toolkit/token-usage`（独立）、`add dsh-agent-toolkit`（集成）

## 验证

- 两包各自 `pnpm --filter <pkg> test` / `typecheck` / `bundle` 全绿
- 发布前 `pnpm pack` 核查两包 tarball（必需文件 + 违禁文件清单照现有脚本）
- 开发回路冒烟：`link:` 安装 toolkit 后 Agents 面板、委派、飞书、Token 用量四处功能回归

## 非目标

- 不抽第三共享包；不改 `token_usage` 存储域 schema；不动 prompt/agents/delegate/bots 模块代码（除 import 路径随迁移调整）
- prompt-stack / project-bot 无 npm 存量，不做任何处置
