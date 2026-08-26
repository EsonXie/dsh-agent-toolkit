# dsh-agent-toolkit 合并与 Agent 管理重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 packages/ 下 4 个插件包（token-usage/agent-team/prompt-stack/project-bot）合并为单包单入口插件 `dsh-agent-toolkit`，以 UI 管理的 Agent 注册表为核心重设计委托与飞书绑定，并归档全部旧代码与旧 spec/plan 文档。

**Architecture:** 单 npm 包 `packages/toolkit`（name: `dsh-agent-toolkit`），单 cordis 插件入口 + 单浏览器 bundle。内部七模块：agents（注册表）/ prompt（分层引擎）/ delegate（team_delegate）/ bots + channels（飞书）/ usage（统计）/ shared（助手）。委派与飞书建会话全部走 `ctx.agents.create` 内存 `setup`，preset 机制整体移除。

**Tech Stack:** TypeScript ESM、cordis、Schemastery、zod、React 18 + CSS Modules、tsdown、vitest（jsdom + @testing-library/react）。

**Spec:** `docs/superpowers/specs/2026-08-26-dsh-agent-toolkit-合并重设计-design.md`

## Global Constraints

- 包名 `dsh-agent-toolkit`（无 scope），插件 `name = 'dsh-agent-toolkit'`，RPC 前缀 `/dsh-agent-toolkit/api`。
- 已有数据的 storage domain 原地保留：`token_usage`、`project_bot`（bots 表只加 `agentRef?` 可选字段，**不 bump version**）；新注册表用新 domain `dsh_agent_toolkit`（domain 名只允许 `^[a-z][a-z0-9_]*$`）。
- 浏览器半纯净度：跨模块值导入仅限同包相对路径；对外部 dsh 包一律 `import type`（运行时值由宿主提供）。**禁止**把 `@deepseek-ai/dsh-storage-domain` 加进 dependencies/peerDependencies（宿主隐式提供，加依赖会导致 domain 双实例）。
- 工具 `execute` 返回规范 JSON；args 只读且已校验；策略/权限逻辑放 `tools/*` 事件钩子。
- 可调参数进 Config schema，不硬编码。
- 所有命令在 Windows PowerShell 5.1 下执行；用 `; if ($?) { ... }` 串联依赖命令。
- 测试命令：`pnpm --filter dsh-agent-toolkit test`；类型检查：`pnpm --filter dsh-agent-toolkit typecheck`；构建：`pnpm --filter dsh-agent-toolkit bundle`。
- deepseek-harness/ 只读，不修改其中任何文件。
- 每个 Task 结束提交一次（frequent commits）；commit message 遵循仓库现有风格（`feat(scope): …` / `refactor(scope): …` / `docs: …` / `chore: …`）。

---

### Task 1: 归档四个旧插件包代码

**Files:**
- Move: `packages/token-usage/` → `archive/2026-08-26-merged-plugins/token-usage/`
- Move: `packages/agent-team/` → `archive/2026-08-26-merged-plugins/agent-team/`
- Move: `packages/prompt-stack/` → `archive/2026-08-26-merged-plugins/prompt-stack/`
- Move: `packages/project-bot/` → `archive/2026-08-26-merged-plugins/project-bot/`

**Interfaces:**
- Consumes: 无
- Produces: 后续迁移任务从 `archive/2026-08-26-merged-plugins/<pkg>/src/...` 拷贝源码（这是唯一的迁移源，迁移未完成前不得删除 archive）。

- [ ] **Step 1: git mv 四个包目录**

```powershell
New-Item -ItemType Directory -Path "archive/2026-08-26-merged-plugins" -Force
git mv packages/token-usage archive/2026-08-26-merged-plugins/token-usage
git mv packages/agent-team archive/2026-08-26-merged-plugins/agent-team
git mv packages/prompt-stack archive/2026-08-26-merged-plugins/prompt-stack
git mv packages/project-bot archive/2026-08-26-merged-plugins/project-bot
```

- [ ] **Step 2: 清理未跟踪残留（node_modules / lib / 本地 tarball）**

`git mv` 只搬跟踪文件；未跟踪的构建产物与依赖目录残留在原处，直接删除（lib 可随时重建，node_modules 由 pnpm 管理）：

```powershell
Remove-Item -Recurse -Force packages/token-usage, packages/agent-team, packages/prompt-stack, packages/project-bot -ErrorAction SilentlyContinue
# 根目录本地 tarball（未跟踪的发布产物）一并移入 archive
Move-Item *.tgz archive/2026-08-26-merged-plugins/ -ErrorAction SilentlyContinue
```

- [ ] **Step 3: 确认 packages/ 为空、archive 完整**

Run: `Get-ChildItem packages; Get-ChildItem archive/2026-08-26-merged-plugins`
Expected: packages 为空（或不存在）；archive 下四个包目录且各自 `src/` 完整（抽查 `archive/2026-08-26-merged-plugins/agent-team/presets/team/agent.cordis.yml` 存在——Task 15 要读它）。

- [ ] **Step 4: Commit**

```powershell
git add -A; git commit -m "chore: 归档四个旧插件包到 archive/2026-08-26-merged-plugins/"
```

---

### Task 2: 归档旧 spec/plan + 乱码文件处理

**Files:**
- Move: `docs/superpowers/specs/*.md`（**除** `2026-08-26-dsh-agent-toolkit-合并重设计-design.md`）→ `docs/superpowers/specs/archive/`
- Move: `docs/superpowers/plans/*.md` → `docs/superpowers/plans/archive/`
- Modify: `docs/superpowers/specs/archive/2026-08-25-飞书卡片过程输出与状态标记-design.md`（视恢复结果）

**Interfaces:**
- Consumes: 无
- Produces: specs 根目录只剩本次新设计；plans 根目录只剩本计划。

- [ ] **Step 1: 尝试从 git 历史恢复乱码 spec**

`2026-08-25-飞书卡片过程输出与状态标记-design.md` 后半段（"修订 2026-08-25 第二轮"起）为 GBK/UTF-8 乱码。逐个历史版本检查：

```powershell
git log --follow --oneline -- "docs/superpowers/specs/2026-08-25-飞书卡片过程输出与状态标记-design.md"
# 对每个历史版本检查是否含乱码替换字符（U+FFFD）或明显 GBK 误读段：
git show <sha>:"docs/superpowers/specs/2026-08-25-飞书卡片过程输出与状态标记-design.md" | Select-String ''
```

找到无乱码的最新版本则 `git show <sha>:<路径> > <路径>` 恢复；全部损坏则走 Step 3 标注。

- [ ] **Step 2: 归档移动（含乱码文件）**

```powershell
New-Item -ItemType Directory -Path docs/superpowers/specs/archive, docs/superpowers/plans/archive -Force
Get-ChildItem docs/superpowers/specs/*.md | Where-Object Name -ne '2026-08-26-dsh-agent-toolkit-合并重设计-design.md' | ForEach-Object { git mv $_.FullName docs/superpowers/specs/archive/ }
Get-ChildItem docs/superpowers/plans/*.md | Where-Object Name -ne '2026-08-26-dsh-agent-toolkit-合并重设计.md' | ForEach-Object { git mv $_.FullName docs/superpowers/plans/archive/ }
```

- [ ] **Step 3: 乱码不可恢复时在文首加损坏标注**

若 Step 1 确认所有历史版本均损坏，在该文件第 1 行前插入：

```markdown
> ⚠️ 归档标注：本文第 101 行起"修订 2026-08-25 第二轮"段落在所有 git 历史版本中均为 GBK/UTF-8 乱码，
> 内容不可完整恢复。已实施代码即最终事实（见 packages 归档与 git 提交 60be0b098e）。
```

- [ ] **Step 4: Commit**

```powershell
git add -A; git commit -m "docs: 归档已完成实现的 8 篇 spec 与 9 篇 plan 到 archive/"
```

---

### Task 3: 脚手架 packages/toolkit

**Files:**
- Create: `packages/toolkit/package.json`
- Create: `packages/toolkit/tsconfig.json`
- Create: `packages/toolkit/tsdown.config.ts`
- Create: `packages/toolkit/cordis.patch.yml`
- Create: `packages/toolkit/vitest.config.ts`（若归档包中有的话照抄）

**Interfaces:**
- Consumes: `archive/2026-08-26-merged-plugins/{token-usage,project-bot}/` 的配置文件
- Produces: 可 install/typecheck/bundle 的空包；`pnpm --filter dsh-agent-toolkit <script>` 可用。

- [ ] **Step 1: 写 package.json**

依赖为四包并集；devDependencies 为四包 link: 并集（**去掉** `dsh-agent-presets`——preset 机制移除）：

```json
{
  "name": "dsh-agent-toolkit",
  "version": "0.1.0",
  "description": "DeepSeek Harness plugin: agent registry with layered prompts, parallel delegation, Feishu bots and token usage",
  "license": "MIT",
  "keywords": ["deepseek-harness", "dsh", "dsh-plugin", "agent-team", "feishu", "token-usage"],
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md", "LICENSE"],
  "publishConfig": { "access": "public" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-tool"
      ]
    }
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "bundle": "tsdown",
    "watch": "tsdown --watch",
    "prepack": "pnpm run bundle"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.1",
    "@larksuiteoapi/node-sdk": "^1.73.0",
    "clsx": "^2.0.0",
    "js-yaml": "^4.1.0",
    "qrcode": "^1.5.4",
    "recharts": "^3.10.1",
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "link:../../deepseek-harness/vendor/cordis",
    "@deepseek-ai/dsh-agent": "link:../../deepseek-harness/packages/core/agent",
    "@deepseek-ai/dsh-agent-default-model": "link:../../deepseek-harness/packages/core/agent-default-model",
    "@deepseek-ai/dsh-client-locale": "link:../../deepseek-harness/packages/client/locale",
    "@deepseek-ai/dsh-client-runtime": "link:../../deepseek-harness/packages/client/runtime",
    "@deepseek-ai/dsh-client-ui-primitives": "link:../../deepseek-harness/packages/client/ui-primitives",
    "@deepseek-ai/dsh-client-ui-sidebar": "link:../../deepseek-harness/packages/client/ui-sidebar",
    "@deepseek-ai/dsh-client-ui-slots": "link:../../deepseek-harness/packages/client/ui-slots",
    "@deepseek-ai/dsh-client-ui-tool": "link:../../deepseek-harness/packages/client/ui-tool",
    "@deepseek-ai/dsh-commands": "link:../../deepseek-harness/packages/interaction/commands",
    "@deepseek-ai/dsh-compaction": "link:../../deepseek-harness/packages/compaction/compaction",
    "@deepseek-ai/dsh-credentials": "link:../../deepseek-harness/packages/credentials/credentials",
    "@deepseek-ai/dsh-home-paths": "link:../../deepseek-harness/packages/util/home-paths",
    "@deepseek-ai/dsh-host-webserver": "link:../../deepseek-harness/packages/host/webserver",
    "@deepseek-ai/dsh-llm": "link:../../deepseek-harness/packages/llm/llm",
    "@deepseek-ai/dsh-scope": "link:../../deepseek-harness/packages/core/scope",
    "@deepseek-ai/dsh-session": "link:../../deepseek-harness/packages/core/session",
    "@deepseek-ai/dsh-session-projection": "link:../../deepseek-harness/packages/session/session-projection",
    "@deepseek-ai/dsh-storage-domain": "link:../../deepseek-harness/packages/storage/storage-domain",
    "@deepseek-ai/dsh-subagent": "link:../../deepseek-harness/packages/subagent/subagent",
    "@deepseek-ai/dsh-system-prompt": "link:../../deepseek-harness/packages/core/system-prompt",
    "@deepseek-ai/dsh-token-meter": "link:../../deepseek-harness/packages/llm/token-meter",
    "@deepseek-ai/dsh-tools": "link:../../deepseek-harness/packages/core/tools",
    "@deepseek-ai/schemastery": "link:../../deepseek-harness/vendor/schemastery",
    "@testing-library/react": "^16.1.0",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.20.1",
    "@types/qrcode": "^1.5.5",
    "@types/react": "~18.3.1",
    "@types/react-dom": "~18.3.0",
    "jsdom": "^26.1.0",
    "lightningcss": "^1.30.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "tsdown": "^0.22.2",
    "typescript": "^6.0.3",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: 拷贝 tsconfig / tsdown / cordis.patch / vitest 配置**

```powershell
Copy-Item archive/2026-08-26-merged-plugins/token-usage/tsconfig.json packages/toolkit/tsconfig.json
Copy-Item archive/2026-08-26-merged-plugins/project-bot/tsdown.config.ts packages/toolkit/tsdown.config.ts
# vitest 配置（若存在；不存在则测试沿用各文件内环境标注，跳过）
Copy-Item archive/2026-08-26-merged-plugins/token-usage/vitest.config.ts packages/toolkit/ -ErrorAction SilentlyContinue
```

`tsdown.config.ts` 只需确认两个入口为 `src/index.ts` 与 `src/client/index.ts`（project-bot 原版即双入口，入口路径若写的是 `src/client/index.ts` 则无需改）；其中 Node 内建门禁、qrcode 浏览器 alias、纯净度插件、CSS Modules 内联插件全部保留——四包合一后这一份就是唯一配置。

写 `packages/toolkit/cordis.patch.yml`（照 token-usage/project-bot 同款结构，id/name 改为新插件名）：

```yaml
- insert:
    - id: dsh-agent-toolkit
      name: dsh-agent-toolkit
```

- [ ] **Step 3: 最小占位入口 + 安装验证**

写 `packages/toolkit/src/index.ts` 占位（后续 Task 15 替换为完整入口）：

```ts
import type { Context } from '@deepseek-ai/cordis'
export const name = 'dsh-agent-toolkit'
export function apply(_ctx: Context): void {}
```

写 `packages/toolkit/src/client/index.ts` 占位：

```ts
export function apply(): void {}
```

Run: `pnpm install; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }; if ($?) { pnpm --filter dsh-agent-toolkit bundle }`
Expected: install 成功；typecheck 通过；bundle 产出 `lib/index.js` + `lib/client.js`。

- [ ] **Step 4: Commit**

```powershell
git add packages/toolkit; git commit -m "feat(toolkit): 新单包脚手架（package.json/tsconfig/tsdown/cordis.patch）"
```

---

### Task 4: shared/ 助手（storage 打开 / webServer 注册 / 侧栏入口工厂 / LoadState）

**Files:**
- Create: `packages/toolkit/src/shared/storage.ts`
- Create: `packages/toolkit/src/shared/webserver.ts`
- Create: `packages/toolkit/src/shared/storage.test.ts`
- Create: `packages/toolkit/src/shared/webserver.test.ts`
- Create: `packages/toolkit/src/client/shared/entry.tsx`
- Create: `packages/toolkit/src/client/shared/load-state.ts`
- Create: `packages/toolkit/src/client/shared/entry.spec.tsx`（jsdom）

**Interfaces:**
- Produces（后续任务依赖的确切签名）:
  - `openDomainSafely(ctx: Context, domain: DomainSpec, warn: (msg: string) => void): Promise<DomainHandle>` — token-usage/src/index.ts:34-44 与 project-bot/src/index.ts:126-133 同款：`.catch(warn)` 防 unhandled + `ctx.effect` 里 `close()`。
  - `registerOptionalRoutes(ctx: Context, register: (webCtx: Context) => () => void): void` — `ctx.inject(['webServer'], ...)` 可选服务模式（两包 index.ts 同款）。
  - `createSidebarEntry(deps: { id: string; order: number; icon: ReactNode; title: string; renderModal: (props: { open: boolean; onClose: () => void }) => ReactNode }): ComponentType<{ wide: boolean }>` — 吸收 UsageEntry/BotsEntry 的 Tooltip+button+`clsx(css.trigger, !wide && css.rail)`+Modal open state 逻辑。
  - `useLoadState<T>(load: () => Promise<T>, deps: unknown[]): { state: LoadState<T>; reload: () => void }` — `LoadState<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; data: T }`，含 stale 标志与 reload 计数器（UsageModal/BotsModal 同构模式）。

- [ ] **Step 1: 写失败测试**

`src/shared/storage.test.ts`：fake ctx（`storageDomain.open` 返回 promise、`effect` 收集 disposer），断言 open 失败时 warn 被调用且不抛 unhandled、dispose 时 close 被调用。
`src/shared/webserver.test.ts`：fake ctx 带/不带 webServer 服务两态，断言服务缺席时不注册、不抛错；在场时 effect disposer 注销路由。
`src/client/shared/entry.spec.tsx`（`// @vitest-environment jsdom`）：渲染入口按钮，点击后 renderModal 收到 `open: true`；`wide=false` 时按钮带 rail class。
`load-state` 测试合并进 entry.spec.tsx 或单列：load resolve → `state.kind === 'ok'`；reject → `kind === 'error'`；deps 变化期间的慢 resolve 被 stale 丢弃。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现四个文件**

实现代码从归档文件提炼（逻辑不变，仅参数化）：
- storage/webserver 逻辑源：`archive/2026-08-26-merged-plugins/token-usage/src/index.ts:34-44, 85-126`
- entry 逻辑源：`archive/2026-08-26-merged-plugins/token-usage/src/client/UsageEntry.tsx`（33 行全文即模板，组件名/文案参数化）
- load-state 逻辑源：`archive/2026-08-26-merged-plugins/project-bot/src/client/BotsModal.tsx` 的 LoadState + stale 模式
- `entry.tsx` 的 CSS：把 `UsageEntry.module.css` 内容拷为 `src/client/shared/entry.module.css` 一并 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（shared 全部测试绿）。

- [ ] **Step 5: Commit**

```powershell
git add packages/toolkit/src; git commit -m "feat(toolkit): shared 助手层（storage/webServer/侧栏入口工厂/LoadState）"
```

---

### Task 5: usage 模块迁移（Node 半）

**Files:**
- Create: `packages/toolkit/src/usage/{store,aggregate,heatmap,render}.ts`（从归档拷贝，仅改文件头注释包名）
- Create: `packages/toolkit/src/usage/index.ts`（**重构**：token-usage 的 `apply` 改为模块函数）
- Create: `packages/toolkit/src/usage/*.test.ts`（归档 token-usage 的 9 个测试文件平移）

**Interfaces:**
- Consumes: `openDomainSafely`、`registerOptionalRoutes`（Task 4）
- Produces: `export function setupUsage(ctx: Context, config: { timezone: string }): void` — 内部完成：domain 打开（经 openDomainSafely）、`session/event` 采集、`/token-usage` 命令注册、两个 webServer exact 路由（经 registerOptionalRoutes）。Command/webServer/storage 的 inject 由宿主声明合并保证（suite 的 `inject` 数组在 Task 15 统一声明）。

- [ ] **Step 1: 拷贝源码与测试**

```powershell
New-Item -ItemType Directory -Path packages/toolkit/src/usage -Force
Copy-Item archive/2026-08-26-merged-plugins/token-usage/src/store.ts, archive/2026-08-26-merged-plugins/token-usage/src/aggregate.ts, archive/2026-08-26-merged-plugins/token-usage/src/heatmap.ts, archive/2026-08-26-merged-plugins/token-usage/src/render.ts packages/toolkit/src/usage/
Copy-Item archive/2026-08-26-merged-plugins/token-usage/src/*.test.ts packages/toolkit/src/usage/
```

- [ ] **Step 2: 重写 usage/index.ts**

以归档 `token-usage/src/index.ts`（132 行）为底：
- 删除 `name`/`Config`/`apply` 插件三件套（Config 的 timezone 平移到 suite Config，Task 15）。
- 改导出：

```ts
/** usage 模块：per-day token 用量采集、/token-usage 命令与 JSON 路由。 */
import type { Context } from '@deepseek-ai/cordis'
import { openDomainSafely } from '../shared/storage.ts'
import { registerOptionalRoutes } from '../shared/webserver.ts'
// …其余 import 同归档文件…

export function setupUsage(ctx: Context, config: { timezone: string }): void {
  // 函数体 = 归档 apply 函数体，唯二改动：
  // 1. ctx.storageDomain.open(...) 段替换为 openDomainSafely(ctx, tokenUsageDomain, msg => ctx.logger.warn(msg))
  // 2. ctx.inject(['webServer'], ...) 段替换为 registerOptionalRoutes(ctx, webCtx => { …原注册逻辑，返回 disposer… })
}
```

- [ ] **Step 3: 修测试 import 并跑通**

测试文件内 `./index.ts` 的引用改为断言 `setupUsage`（原插件测试若直接调 `apply(ctx, config)`，改为 `setupUsage(ctx, { timezone: config.timezone ?? 'Asia/Shanghai' })`）。

Run: `pnpm --filter dsh-agent-toolkit test; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }`
Expected: 41 个 token-usage 原测试 + shared 测试全绿。

- [ ] **Step 4: Commit**

```powershell
git add packages/toolkit/src/usage; git commit -m "feat(toolkit): usage 模块迁移（token-usage Node 半 → setupUsage）"
```

---

### Task 6: usage 浏览器半迁移

**Files:**
- Create: `packages/toolkit/src/client/usage/{UsageModal,ActivityHeatmap,DailyBarChart}.tsx` + 4 个 `.module.css`（归档拷贝）
- Create: `packages/toolkit/src/client/usage/entry.tsx`（用 createSidebarEntry 重写 UsageEntry）
- Create: `packages/toolkit/src/client/usage/*.spec.tsx`（归档 `.client.spec.tsx` 平移）

**Interfaces:**
- Consumes: `createSidebarEntry`、`useLoadState`（Task 4）；`../../usage/aggregate.ts`、`../../usage/heatmap.ts` 纯函数（Task 5）。
- Produces: `export function setupUsageClient(ctx: Context): void` — 内部 `slots.inject('sidebar.footer.action', …)` 注册 usage 入口（id `dsh-agent-toolkit:usage`，order 沿用 token-usage 原值）。

- [ ] **Step 1: 拷贝与改写**

```powershell
New-Item -ItemType Directory -Path packages/toolkit/src/client/usage -Force
Copy-Item archive/2026-08-26-merged-plugins/token-usage/src/client/* packages/toolkit/src/client/usage/
```

- 删除拷来的 `index.ts` 与 `UsageEntry.tsx`，新建 `entry.tsx`：`UsageEntry` 组件体替换为 `createSidebarEntry({ id, order, icon, title, renderModal: (p) => <UsageModal {...p} /> })`。
- 新建 `index.ts` 导出 `setupUsageClient`（原 `apply` 体的 slots 注册逻辑，组件换成 entry.tsx 产物）。
- `UsageModal.tsx` 内 LoadState 手写逻辑替换为 `useLoadState`（Task 4），fetch 路径 `/token-usage/...` 改为 `/dsh-agent-toolkit/api/usage/...`——**与 Task 5 的路由同步改**（两 exact 路由统一迁到 `/dsh-agent-toolkit/api/usage/daily`、`/dsh-agent-toolkit/api/usage/range`；回 Task 5 文件同步修改并补测试断言新路径）。

- [ ] **Step 2: 修测试并跑通**

Run: `pnpm --filter dsh-agent-toolkit test; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }`
Expected: 全绿。

- [ ] **Step 3: Commit**

```powershell
git add packages/toolkit/src/client/usage packages/toolkit/src/usage; git commit -m "feat(toolkit): usage 浏览器半迁移（入口工厂化 + RPC 路径归一）"
```

---

### Task 7: prompt 模块迁移 + 角色 persona 装配函数

**Files:**
- Create: `packages/toolkit/src/prompt/{types,defaults,match}.ts`（归档 prompt-stack 平移）
- Create: `packages/toolkit/src/prompt/index.ts`（`apply` → `setupPrompt` + 新增 `buildAgentPersona`）
- Create: `packages/toolkit/src/prompt/persona.ts`（委派契约段 + 装配）
- Create: `packages/toolkit/src/prompt/*.test.ts`（归档 6 个测试平移）+ `persona.test.ts`（新）

**Interfaces:**
- Consumes: `AgentRecord`（Task 8 定义于 `../agents/store.ts`；本任务先以结构类型入参，Task 9 统一换 import）。
- Produces:
  - `export function setupPrompt(ctx: Context, config: { layers: LayerConfig[]; rules: Rule[] }): void` — 归档 prompt-stack `apply` 全体（validateConfig、函数式 section、waterfall 钉住、子 Agent 隔离），逻辑零改动。
  - `export function buildAgentPersona(config: { layers: LayerConfig[]; rules: Rule[] }, role: { name: string; promptLayers?: LayerConfig[] }, model?: { provider?: string; model?: string }): string` — 返回装配文本：`DELEGATE_CONTRACT`（A 身份契约/B 能力守则，从归档 agent-team/src/prompt.ts 的 SECTION_A/SECTION_B 常量平移，name 参数化）+ 按 order 升序合并 `config.layers` 与 `role.promptLayers ?? []`、对命中规则（`selectRule(config.rules, model?.provider, model?.model)`）的 overrides 替换层文本、append 文本作为末段，`\n\n` 连接。

- [ ] **Step 1: 拷贝 + 改造 setupPrompt**

```powershell
New-Item -ItemType Directory -Path packages/toolkit/src/prompt -Force
Copy-Item archive/2026-08-26-merged-plugins/prompt-stack/src/types.ts, archive/2026-08-26-merged-plugins/prompt-stack/src/defaults.ts, archive/2026-08-26-merged-plugins/prompt-stack/src/match.ts, archive/2026-08-26-merged-plugins/prompt-stack/src/*.test.ts packages/toolkit/src/prompt/
```

`index.ts`：删 `name`/`Config`/导出三件套，`apply(ctx, config)` 改 `setupPrompt(ctx, config: { layers; rules })`，函数体不变（validateConfig 继续导出，Task 15 用）。

- [ ] **Step 2: 写 persona.test.ts 失败测试**

断言：
- 无 role.promptLayers、无规则命中时 = 契约段 + 全局 layers 按 order 拼接；
- role.promptLayers 与全局层按 order 交错合并；
- 命中规则的 overrides 替换对应层文本、append 成为末段；
- 契约段中角色名正确代入。

Run: `pnpm --filter dsh-agent-toolkit test` → Expected: FAIL（persona.ts 不存在）。

- [ ] **Step 3: 实现 persona.ts**

```ts
/** 委派子 Agent 的 persona 装配：契约段 + 分层引擎（全局层 + 角色层 + 按模型改写）。 */
import { selectRule } from './match.ts'
import type { LayerConfig, Rule } from './types.ts'

const SECTION_A = (roleName: string): string => `你是团队中的一名成员（角色：${roleName}），由主 Agent 委派任务。
- 你看不到主对话；任务书包含你完成工作所需的全部上下文。
- 你的最终输出会作为结果完整返回给主 Agent：直接给出结论与必要细节。
- 你不能再次委派他人；任务需要拆分时，自己按顺序完成。`

const SECTION_B = `能力使用守则：
- 你可以使用与主 Agent 相同的工具与 MCP 资源，但只在任务必需时调用。
- 动手修改代码前，先阅读项目根目录及涉及目录的 AGENTS.md，并遵循其中约定。
- 产生或修改文件后，运行相关检查（测试、类型检查）验证你的改动。`

export function buildAgentPersona(
  config: { layers: LayerConfig[]; rules: Rule[] },
  role: { name: string; promptLayers?: LayerConfig[] },
  model?: { provider?: string; model?: string },
): string {
  const rule = selectRule(config.rules, model?.provider, model?.model)
  const merged = [...config.layers, ...(role.promptLayers ?? [])].sort((a, b) => a.order - b.order)
  const texts = merged.map(layer => rule?.overrides?.[layer.name] ?? layer.text)
  if (rule?.append !== undefined) texts.push(rule.append)
  return [SECTION_A(role.name), SECTION_B, ...texts].join('\n\n')
}
```

- [ ] **Step 4: 跑测试确认全绿 + typecheck**

Run: `pnpm --filter dsh-agent-toolkit test; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }`
Expected: prompt-stack 原 40 测试 + persona 新测试全绿。

- [ ] **Step 5: Commit**

```powershell
git add packages/toolkit/src/prompt; git commit -m "feat(toolkit): prompt 分层引擎迁移 + buildAgentPersona 装配函数"
```

---

### Task 8: agents 注册表（store + registry + YAML 首启导入）

**Files:**
- Create: `packages/toolkit/src/agents/store.ts`
- Create: `packages/toolkit/src/agents/registry.ts`
- Create: `packages/toolkit/src/agents/builtin.ts`
- Create: `packages/toolkit/src/agents/import-yaml.ts`
- Create: `packages/toolkit/src/agents/{store,registry,import-yaml}.test.ts`

**Interfaces:**
- Produces（Task 9/10/11/13 全部依赖）:

```ts
// store.ts
export interface AgentRecord {
  id: string                    // 'main' 或 [a-z0-9-] slug
  name: string
  description?: string
  promptLayers?: LayerConfig[]  // 引用 ../prompt/types.ts
  model?: { provider: string; model: string }
  tools?: { allow: string[] }   // 仅白名单（用户定案：deny 不做）
  builtin?: boolean
}
export const AgentRecordSchema: z.ZodType<AgentRecord>  // zod；id 正则 main|^[a-z][a-z0-9-]{0,31}$
export const agentToolkitDomain = defineDomain({
  name: 'dsh_agent_toolkit', version: 1,
  tables: { agents: domainTable<string, AgentRecord>(AgentRecordSchema) },
})

// registry.ts
export interface AgentRegistry {
  list(): AgentRecord[]                       // main 置顶，其余按 id 字典序
  get(id: string): AgentRecord | undefined
  upsert(record: AgentRecord): Promise<void>  // main 的 name/builtin 不可改；builtin 可改配置不可删
  remove(id: string): Promise<void>           // main 与 builtin 抛错
  subscribe(listener: () => void): () => void // UI/委派提示段热更新用
}
export async function createRegistry(ctx: Context, warn: (msg: string) => void): Promise<AgentRegistry>
// 内部：openDomainSafely 打开 domain → 内存缓存 → 缺 main/explorer/general 时种入内置 →
// 首启导入（import-yaml）→ subscribe 通知。
```

- [ ] **Step 1: 写失败测试**

- `store.test.ts`：schema 接受合法记录、拒绝非法 id/空 name/空 allow 数组（`tools.allow` 空数组拒绝，同 BOT 表 tools 的 `.min(1)` 语义）。
- `registry.test.ts`（fake domain table：内存 Map 实现 get/set/del/entries）：种入内置三条（main/explorer/general）；upsert/remove 约束（main 锁定、builtin 不可删）；subscribe 在 upsert/remove 后触发。
- `import-yaml.test.ts`：归档 `agent-team/src/roles.ts` 的 parseRoleYaml/loadRolesDir 逻辑平移（js-yaml 已在 deps）；断言：YAML 角色 → AgentRecord（`persona` 字符串转为单个 `promptLayers: [{ name: 'persona', order: 0, text: persona }]`；`provider/model` 合并为 `model` 字段——仅两者同存时；`tools.deny` 丢弃并 warn）；同名覆盖内置；导入只跑一次（标记写入 domain 的 `meta` 表或 agents 表特殊键 `__imported__`，schema 无法表达则改用独立 meta 表——**决策**：加第二张表 `meta: domainTable<string, { key: string }>`（zod `{ value: z.string() }`），同 version 两表合法）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test` → Expected: FAIL。

- [ ] **Step 3: 实现四个文件**

- `builtin.ts`：三条内置记录。explorer/general 的 persona 文本从归档 `agent-team/src/builtin-roles.ts` 平移（字符串转 promptLayers 同上）；main 记录 `{ id: 'main', name: '主 Agent', builtin: true }`。
- `registry.ts`：内存缓存 + 持久化回写 + listener 集合； upsert 时校验 main 的 `id/name/builtin` 字段不可变（抛错信息中文，风格同归档错误信息）。
- `import-yaml.ts`：`rolesDir = join(resolveDshHome(), 'agent-team', 'roles')`（`@deepseek-ai/dsh-home-paths`，归档 agent-team/src/index.ts:33-35 同款）；meta 表 `get('roles_yaml_imported')` 短路；逐文件解析失败 warn 跳过（不阻塞激活）。

- [ ] **Step 4: 跑测试确认全绿 + typecheck**

- [ ] **Step 5: Commit**

```powershell
git add packages/toolkit/src/agents; git commit -m "feat(toolkit): Agent 注册表（domain/内置保底/YAML 首启导入）"
```

---

### Task 9: delegate/ 重写（注册表驱动的 team_delegate）

**Files:**
- Create: `packages/toolkit/src/delegate/tool.ts`
- Create: `packages/toolkit/src/delegate/index.ts`
- Create: `packages/toolkit/src/delegate/tool.test.ts`（归档 agent-team 的 tool 测试平移改造）

**Interfaces:**
- Consumes: `AgentRegistry`（Task 8）、`buildAgentPersona`（Task 7）。
- Produces: `export function setupDelegate(ctx: Context, config: { provider: string; toolName: string; layers: LayerConfig[]; rules: Rule[] }, registry: AgentRegistry): void` — provider 能力守卫/事件挂载逻辑从归档 agent-team/src/index.ts:52-93 平移；系统提示团队段改为**函数式 section**（text 回调读 `registry.list()`，UI 改角色后新会话即生效）。

- [ ] **Step 1: 平移并改造 tool 测试**

归档 `agent-team` 的 tool.test.ts（假 startRun/roster）平移；roster 类型从 `Role` 换 `AgentRecord`；新增断言：
- 未知 role 的错误信息含注册表可用角色清单（`main` 不出现在清单——`registry.list()` 过滤 `id !== 'main'`）；
- `role.model` 存在时请求带 `agentOptions`；`role.tools.allow` 存在时带 `toolFilter: { allow }`；
- persona 经 `buildAgentPersona` 生成（注入假 build 函数断言被调用）。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现 tool.ts + index.ts**

`tool.ts` 以归档 `agent-team/src/tool.ts`（158 行）为底，改动点：
- `DelegateToolDeps.roster` 类型 `() => readonly AgentRecord[]`；新增 `buildPersona: (role: AgentRecord) => string`。
- execute 内角色查找 `r.id === args.role`（排除 main）；persona 调 `deps.buildPersona(role)`；`agentOptions`/`toolFilter` 组装逻辑同归档 143-151 行，字段名适配 AgentRecord（`role.model.provider/model`、`role.tools.allow`；deny 分支删除）。
- `settleForegroundRun`、`stopReasonError`、`withPartialText`、output schema/presentationMeta/`isConcurrencySafe` **原样保留**。

`index.ts`：`setupDelegate` 组合 provider 守卫（归档 index.ts:52-93 平移）+ 团队段：

```ts
ctx.systemPrompt.section({
  name: 'plugin:dsh-agent-toolkit:team',
  order: 116.6, // 紧随内置 subagent 段（116.5）之后，同归档 agent-team
  text: () => {
    const roles = registry.list().filter(r => r.id !== 'main')
    const rosterText = roles.map(r => `${r.id}: ${r.description ?? r.name}`).join('\n')
    return `你有一组可委派的成员：用 ${config.toolName} 把自包含的子任务委派给合适的成员，成员结果会作为工具返回值回到本对话。\n可用成员：\n${rosterText}`
  },
})
```

- [ ] **Step 4: 跑测试确认全绿 + typecheck**

- [ ] **Step 5: Commit**

```powershell
git add packages/toolkit/src/delegate; git commit -m "feat(toolkit): team_delegate 改为注册表驱动 + 函数式团队提示段"
```

---

### Task 10: bots + channels 迁移（project-bot Node 半，去 preset 化）

**Files:**
- Create: `packages/toolkit/src/bots/{store,api,register-app}.ts`
- Create: `packages/toolkit/src/channels/{channel,ports,runtime,router,inbound,outbound,directive}.ts`
- Create: `packages/toolkit/src/channels/feishu/{index,api,cards,parse,reply}.ts`
- Create: `packages/toolkit/src/bots/index.ts`（`setupBots` 模块函数）
- Create: 对应测试（归档 project-bot 16 个测试文件平移）

**Interfaces:**
- Consumes: `openDomainSafely`、`registerOptionalRoutes`（Task 4）。
- Produces:

```ts
// bots/index.ts
export interface BotsModuleConfig { /* project-bot Config 的 6 个全局可调参数，字段名不变 */ }
export interface BotsDeps {
  registry: AgentRegistry              // Task 8
  prompt: { layers: LayerConfig[]; rules: Rule[] }  // 角色 persona 装配用（Task 13 接线）
}
export function setupBots(ctx: Context, config: BotsModuleConfig, deps: BotsDeps): void
```

- [ ] **Step 1: 拷贝目录**

```powershell
New-Item -ItemType Directory -Path packages/toolkit/src/bots, packages/toolkit/src/channels/feishu -Force
Copy-Item archive/2026-08-26-merged-plugins/project-bot/src/store.ts, archive/2026-08-26-merged-plugins/project-bot/src/api.ts, archive/2026-08-26-merged-plugins/project-bot/src/register-app.ts packages/toolkit/src/bots/
Copy-Item archive/2026-08-26-merged-plugins/project-bot/src/core/*.ts packages/toolkit/src/channels/
Copy-Item archive/2026-08-26-merged-plugins/project-bot/src/channels/feishu/*.ts packages/toolkit/src/channels/feishu/
# 测试：按原目录归属平移（api/register-app 测试 → bots/；core 测试 → channels/；feishu 测试 → channels/feishu/）
```

- [ ] **Step 2: import 路径修正**

归档 project-bot 内部引用 `./core/ports.ts` 等相对路径：core → channels 后，bots/ 内文件的 `./core/x` 改 `../channels/x`；channels/feishu/ 内文件的 `../core/x`（原 `../../core/x`）按新层级调整。typecheck 驱动逐个修。

- [ ] **Step 3: 去 preset 化（agent-setup.ts 重写）**

删除 `resolvePresetId` 与 `PresetsLike.mount` 调用；`setupAgentScope` 改为：

```ts
/** agent 创建期组合：基础工具行挂载 → 角色提示段/工具白名单（agentRef 接线在 Task 13 完成）。 */
export async function setupAgentScope(
  agentCtx: Context,
  hooks: AgentHooks,
): Promise<void> {
  for (const tool of BASIC_TOOLS) await agentCtx.plugin(tool.id, tool.config)
  if (hooks.persona !== undefined) {
    agentCtx.systemPrompt.section({ name: 'dsh-agent-toolkit:persona', order: 0, text: hooks.persona })
  }
  if (hooks.tools !== undefined) {
    agentCtx.tools.restrict({ allow: hooks.tools })
  }
}
```

`BASIC_TOOLS` 常量：读 `archive/2026-08-26-merged-plugins/agent-team/presets/team/agent.cordis.yml` 的基础工具行（persona/instructions/shell/fs/fs-search），原样翻译为 `[{ id, config }]` 数组放入 `channels/basic-tools.ts`（**与 standard preset 同源**——对照 `deepseek-harness/apps/cli/config/agent-presets/standard/` 核对 id 与 config）。`agentCtx.plugin` 若类型不符（preset mount 另有 API），退路：`deepseek-harness/packages/preset/agent-presets` 的 mount 实现源码对照后用等价的 scoped 注册（把该包的 mount 内部调用抄进来，不依赖该包）。

- [ ] **Step 4: 跑测试确认全绿 + typecheck**

原 project-bot 130 个测试中：preset 相关断言改为断言 `agentCtx.plugin` 调用序列；其余应零改动通过。RPC 路径 `/project-bot/api` 改 `/dsh-agent-toolkit/api`（api.ts 前缀与测试同步改；usage 的 two exact 路由在 Task 6 已并入此前缀规划——本任务把 bots 各端点挂到同一前缀下：`/dsh-agent-toolkit/api/bots/...`）。

Run: `pnpm --filter dsh-agent-toolkit test; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }`
Expected: 全绿。

- [ ] **Step 5: Commit**

```powershell
git add packages/toolkit/src/bots packages/toolkit/src/channels; git commit -m "feat(toolkit): bots+飞书渠道迁移（去 preset 化，基础工具 scoped 挂载）"
```

---

### Task 11: bots 浏览器半迁移

**Files:**
- Create: `packages/toolkit/src/client/bots/{BotsModal,BotForm,api}.tsx/ts` + `.module.css`
- Create: `packages/toolkit/src/client/bots/entry.tsx` + `index.ts`
- Create: 对应 `.client.spec.tsx`（归档平移）

**Interfaces:**
- Produces: `export function setupBotsClient(ctx: Context): void`（侧栏入口 id `dsh-agent-toolkit:bots`）。

- [ ] **Step 1: 拷贝与改写**

```powershell
New-Item -ItemType Directory -Path packages/toolkit/src/client/bots -Force
Copy-Item archive/2026-08-26-merged-plugins/project-bot/src/client/* packages/toolkit/src/client/bots/
```

- `BotsEntry.tsx` 删除，`entry.tsx` 用 `createSidebarEntry`（Task 4）重写。
- `api.ts` 的 fetch 前缀 `/project-bot/api` → `/dsh-agent-toolkit/api/bots`。
- `BotsModal.tsx` 的 LoadState 手写逻辑换 `useLoadState`（Task 4）。

- [ ] **Step 2: 修测试并跑通 + typecheck**

- [ ] **Step 3: Commit**

```powershell
git add packages/toolkit/src/client/bots; git commit -m "feat(toolkit): bots 浏览器半迁移"
```

---

### Task 12: 委派卡与客户端总入口

**Files:**
- Create: `packages/toolkit/src/client/delegate/{delegate-card.tsx,locales.ts,index.ts}`（归档 agent-team client 平移）
- Modify: `packages/toolkit/src/client/index.ts`（替换 Task 3 占位：组合三个 setupXxxClient + 委派卡注册）

**Interfaces:**
- Consumes: `setupUsageClient`（Task 6）、`setupBotsClient`（Task 11）。
- Produces: 浏览器半唯一入口 `apply(ctx)`：依次调用 delegate 卡注册、setupUsageClient、setupBotsClient（Agents 面板在 Task 14 加入）。

- [ ] **Step 1: 拷贝委派卡**

```powershell
New-Item -ItemType Directory -Path packages/toolkit/src/client/delegate -Force
Copy-Item archive/2026-08-26-merged-plugins/agent-team/src/client/* packages/toolkit/src/client/delegate/
```

归档 `client/index.ts` 的 locale 注册 + keyed `tool.call.toolview`（key `'team_delegate'`）逻辑平移为 `setupDelegateClient(ctx)`；toolview key 必须与 suite Config 的 `toolName` 默认值一致（保持 `'team_delegate'`，Config 注释沿用归档告诫：改名后卡片落 generic 兜底）。

- [ ] **Step 2: 写客户端总入口**

```ts
/** dsh-agent-toolkit 浏览器半：委派卡 + Agents/Bots/Usage 三面板入口。 */
import type { Context } from '@deepseek-ai/cordis'
import { setupDelegateClient } from './delegate/index.ts'
import { setupUsageClient } from './usage/index.ts'
import { setupBotsClient } from './bots/index.ts'

export function apply(ctx: Context): void {
  setupDelegateClient(ctx)
  setupUsageClient(ctx)
  setupBotsClient(ctx)
}
```

- [ ] **Step 3: 平移委派卡测试 + 全量验证**

Run: `pnpm --filter dsh-agent-toolkit test; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }; if ($?) { pnpm --filter dsh-agent-toolkit bundle }`
Expected: 全绿；`lib/client.js` 含全部三个面板与委派卡。

- [ ] **Step 4: Commit**

```powershell
git add packages/toolkit/src/client; git commit -m "feat(toolkit): 委派卡迁移 + 浏览器半总入口"
```

---

### Task 13: 飞书绑定 agentRef（bots 表扩展 + 会话创建接线）

**Files:**
- Modify: `packages/toolkit/src/bots/store.ts`（BotRecordSchema 加字段）
- Modify: `packages/toolkit/src/channels/router.ts` + `packages/toolkit/src/bots/index.ts`（会话创建接线）
- Modify: `packages/toolkit/src/bots/api.ts`（bots CRUD 接受 agentRef）
- Modify: `packages/toolkit/src/client/bots/BotForm.tsx` + `api.ts`（绑定 Agent 下拉）
- Test: `packages/toolkit/src/bots/store.test.ts`、`packages/toolkit/src/channels/router.test.ts`

**Interfaces:**
- Consumes: `AgentRegistry`、`buildAgentPersona`（经 setupBots 的 deps.prompt）。
- Produces: BotRecord 多 `agentRef?: string`（`'main'` 或注册表角色 id，缺省 `'main'`）。

- [ ] **Step 1: 写失败测试**

- store：`agentRef` 可选、缺省记录（无该字段的旧数据）照常通过校验（**零迁移断言**：不含 agentRef 的序列化记录 round-trip 成功）。
- router/setup：绑定 main 的 bot 创建会话时 `agentOptions` 取 `agentDefaultModel.currentSelection()`、不注册角色 section、不 restrict；绑定角色时注册该角色 promptLayers 各 section（`systemPrompt.section` 按 layer.order）、`tools.restrict({ allow })`、`agentOptions = role.model`；agentRef 指向不存在角色时 warn 并降级 main。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

- store.ts：BotRecordSchema 加 `agentRef: z.string().min(1).optional()`（**不 bump version**）。
- router.ts：创建会话的 `agentOptions`/`setup` 组装处接入 registry：从 deps 取 `registry.get(bot.agentRef ?? 'main')`；角色命中时 setup 内逐层 `agentCtx.systemPrompt.section({ name: \`dsh-agent-toolkit:agent:${layer.name}\`, order: layer.order, text })` + `tools.restrict`；未命中 warn 降级。
- api.ts / BotForm.tsx：CRUD 与表单加 agentRef 字段；下拉选项来自 `/dsh-agent-toolkit/api/agents`（Task 14 的端点，本任务先用 fetch 约定，Task 14 落地后端）。

- [ ] **Step 4: 跑测试确认全绿 + typecheck**

- [ ] **Step 5: Commit**

```powershell
git add packages/toolkit/src; git commit -m "feat(toolkit): 飞书 bot 绑定主/子 Agent（agentRef）"
```

---

### Task 14: Agents RPC 端点 + Agents 管理面板

**Files:**
- Create: `packages/toolkit/src/agents/api.ts`（端点组）
- Modify: `packages/toolkit/src/bots/api.ts` 或统一分发处（挂载 agents 端点）
- Create: `packages/toolkit/src/client/agents/{AgentsModal,AgentEditor,api}.tsx/ts` + `.module.css` + `entry.tsx` + `index.ts`
- Modify: `packages/toolkit/src/client/index.ts`（加 setupAgentsClient）
- Test: `packages/toolkit/src/agents/api.test.ts`、`packages/toolkit/src/client/agents/agents.spec.tsx`

**Interfaces:**
- Consumes: `AgentRegistry`（Task 8）。
- Produces: REST 端点（`/dsh-agent-toolkit/api` 前缀内）：
  - `GET /agents` → `AgentRecord[]`；`PUT /agents/:id`（upsert）；`DELETE /agents/:id`
  - `GET /providers` → `{id,name}[]`（`ctx.llm.listProviders()`）；`GET /providers/:provider/models` → `ctx.llm.listModels(provider)`
  - `GET /tools` → 当前注册工具名列表（`ctx.tools` 列举；若无列举 API，从 `ctx.tools` 源码确认等价物——实现时对照 `deepseek-harness/packages/core/tools/src/index.ts`）
- 客户端：`setupAgentsClient(ctx)`（侧栏入口 id `dsh-agent-toolkit:agents`，order 在三入口中最前）。

- [ ] **Step 1: 写 agents/api.test.ts 失败测试**

fake registry + fake llm，逐端点断言（含 upsert 非法记录 400、删 main/builtin 409、providers/models 透传）。

- [ ] **Step 2: 跑测试确认失败 → 实现 agents/api.ts → 跑通**

handler 结构照 `bots/api.ts`（归档 project-bot/src/api.ts 的 prefix 内分发模式）；统一挂载点把路径空间分为 `/usage/*`、`/bots/*`、`/agents/*`、`/providers*`、`/tools`。

- [ ] **Step 3: Agents 面板 UI（写 spec 测试 → 实现）**

- `AgentsModal`：左列表右编辑器布局；列表 main 置顶（锁定标识）+ 角色行（name + description 摘要 + builtin 徽标）；底部「新建角色」。
- `AgentEditor` 四区块：基本信息（id[新建时]/name/description）、提示词分层（promptLayers 列表：每项 name/order/text 三区，支持增删与上下移=order 调整）、模型（provider→model 级联下拉 + 「跟随默认」空选项）、工具白名单（`/tools` 多选勾选）。
- 状态机复用 `useLoadState`；保存走 `PUT /agents/:id`，失败回显 error。
- spec 测试（jsdom）：列表渲染、新建→保存调用 fetch、main 锁定不可删（无删除按钮）、模型级联（选 provider 后拉 models）。

- [ ] **Step 4: 全量验证 + bundle**

Run: `pnpm --filter dsh-agent-toolkit test; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }; if ($?) { pnpm --filter dsh-agent-toolkit bundle }`
Expected: 全绿（此时测试总数 ≈ 250 迁移 + 新增）。

- [ ] **Step 5: Commit**

```powershell
git add packages/toolkit/src; git commit -m "feat(toolkit): Agents RPC 端点 + 管理面板 UI"
```

---

### Task 15: 插件总入口 index.ts + Config

**Files:**
- Modify: `packages/toolkit/src/index.ts`（替换 Task 3 占位）
- Test: `packages/toolkit/src/index.test.ts`

**Interfaces:**
- Consumes: 全部模块 setup 函数（Task 5/7/8/9/10）。
- Produces: 完整插件 `name`/`inject`/`Config`/`apply`。

- [ ] **Step 1: 写失败测试（Config schema + 模块开关）**

断言：`Config({})` 默认值（modules.feishu=true、modules.usage=true、layers/rules 落 DEFAULT_*、timezone='Asia/Shanghai'、provider='spawn'、toolName='team_delegate'）；`modules.usage=false` 时 fake ctx 上不注册 `/token-usage` 命令。

- [ ] **Step 2: 实现**

```ts
/** dsh-agent-toolkit：Agent 注册表 + 分层提示词 + 并行委派 + 飞书 bots + token 用量。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createRegistry } from './agents/registry.ts'
import { DEFAULT_LAYERS, DEFAULT_RULES } from './prompt/defaults.ts'
import { setupPrompt, validateConfig as validatePromptConfig } from './prompt/index.ts'
import { setupDelegate } from './delegate/index.ts'
import { setupBots } from './bots/index.ts'
import { setupUsage } from './usage/index.ts'
// LayerConfig/Rule 的 schemastery schema 照归档 prompt-stack/src/index.ts:21-41 的写法（含 overrides transform hack）

export const name = 'dsh-agent-toolkit'
export const inject = ['tools', 'subagents', 'systemPrompt', 'commands', 'llm', 'agentDefaultModel', 'agents']

export const Config = z.object({
  modules: z.object({
    feishu: z.boolean().default(true),
    usage: z.boolean().default(true),
  }).default({ feishu: true, usage: true }),
  layers: /* 照归档 prompt-stack Config.layers */.default(DEFAULT_LAYERS),
  rules: /* 照归档 prompt-stack Config.rules */.default(DEFAULT_RULES),
  timezone: z.string().default('Asia/Shanghai'),
  provider: z.string().default('spawn'),
  toolName: z.string().default('team_delegate'),
  feishu: z.object({ /* project-bot Config 的 6 个全局可调参数，字段名/默认原样平移，源：archive/2026-08-26-merged-plugins/project-bot/src/index.ts 的 Config 定义 */ }).default(/* 同上源文件的默认值 */),
})

export async function apply(ctx: Context, config: /* Config 输出型 */): Promise<void> {
  validatePromptConfig({ layers: config.layers, rules: config.rules })
  const warn = (msg: string): void => ctx.logger.warn(msg)
  const registry = await createRegistry(ctx, warn)
  setupPrompt(ctx, { layers: config.layers, rules: config.rules })
  setupDelegate(ctx, { provider: config.provider, toolName: config.toolName, layers: config.layers, rules: config.rules }, registry)
  if (config.modules.feishu) setupBots(ctx, config.feishu, { registry, prompt: { layers: config.layers, rules: config.rules } })
  if (config.modules.usage) setupUsage(ctx, { timezone: config.timezone })
}
```

（Config schema 细节以归档 prompt-stack/project-bot/token-usage 的 Config 定义为准逐字段平移；`inject` 列表若有多余服务导致缺服务环境激活失败，按测试反馈裁剪——cordis inject 是硬依赖声明。）

- [ ] **Step 3: 全量验证**

Run: `pnpm --filter dsh-agent-toolkit test; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }; if ($?) { pnpm --filter dsh-agent-toolkit bundle }`

- [ ] **Step 4: Commit**

```powershell
git add packages/toolkit/src/index.ts packages/toolkit/src/index.test.ts; git commit -m "feat(toolkit): 插件总入口与 Config schema"
```

---

### Task 16: 开发回路接线 + 端到端冒烟

**Files:**
- Modify: `cordis.yml`（仓库根）
- Modify: `pnpm-workspace.yaml`（确认无需改动——workspace 只含 `packages/*`，archive 不受影响）

**Interfaces:**
- Produces: `pnpm dsh web --patch` 开发回路可用。

- [ ] **Step 1: 重写 cordis.yml**

旧内容中 agent-team/prompt-stack/token-usage 三行全部删除，替换为（patch 插件路径必须绝对路径）：

```yaml
- insert:
    - id: dsh-agent-toolkit
      name: D:\work\github\dsh\dsh-agent-toolkit\packages\toolkit
      config:
        timezone: Asia/Shanghai
```

（插件同时自带 cordis.patch.yml 走 bundles 层时，根 patch 不再重复 insert——按 token-usage/project-bot 惯例二选一；选根 patch 直挂便于开发期 HMR，包的 cordis.patch.yml 留给发布态。若出现 duplicate loader entry id 报错，删根 patch 的 insert、改用包自带 patch。）

- [ ] **Step 2: 冒烟**

```powershell
cd deepseek-harness; pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml
```

人工核对清单：① 侧栏出现 Agents/Bots/Usage 三入口；② Agents 面板内置三角色在列；③ 主会话系统提示词含团队段与分层段；④ `team_delegate` 委派 explorer 成功且委派卡渲染；⑤ Usage 面板数据正常。（逐项记录结果，失败项回对应 Task 修复。）

- [ ] **Step 3: Commit**

```powershell
git add cordis.yml; git commit -m "chore: 开发回路切到 dsh-agent-toolkit 单插件"
```

---

### Task 17: AGENTS.md 改写 + 收尾

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/refer/INDEX.md`（若其中插件清单引用了旧四包结构）

**Interfaces:**
- Produces: 文档与新结构一致。

- [ ] **Step 1: 改写 AGENTS.md**

要点：
- 目录结构段：`packages/` 只剩 `toolkit/`；新增 `archive/2026-08-26-merged-plugins/`（旧四包代码快照，只读参考）与 `docs/superpowers/{specs,plans}/archive/`。
- 开发命令段：四包命令归一为 `pnpm --filter dsh-agent-toolkit test / typecheck / bundle / watch`。
- 「dsh 插件开发要点」段：删除 agent-team 双挂载点/preset root/扁平名册等已作废段落；替换为：单插件入口、Agent 注册表（UI 管理 + YAML 首启导入）、内存 setup 建会话、共享层 shared/ 约定。
- 「调研成果」「目录结构（已定案）」中过时的包清单同步更新。
- feishu-bot 过时条目删除（早已并入 project-bot，现并入 toolkit）。

- [ ] **Step 2: 发布态收尾（记录，不执行）**

已发布 npm 的 `@dsh-agent-toolkit/token-usage`、`@dsh-agent-toolkit/prompt-stack`、`@dsh-agent-toolkit/project-bot` 的 `npm deprecate <pkg> "已合并进 dsh-agent-toolkit"` 属人工发布操作（同 scripts/publish-*.ps1 的人工确认惯例），本计划不执行；在 AGENTS.md 记为待办。旧 `scripts/publish-*.ps1` 若只服务旧包，移入 `archive/2026-08-26-merged-plugins/scripts/`；为新包保留/改写一份 `scripts/publish-toolkit.ps1`（六道门禁结构照抄 publish-token-usage.ps1，包名替换）。

- [ ] **Step 3: 最终全量验证 + Commit**

Run: `pnpm --filter dsh-agent-toolkit test; if ($?) { pnpm --filter dsh-agent-toolkit typecheck }; if ($?) { pnpm --filter dsh-agent-toolkit bundle }`

```powershell
git add AGENTS.md docs/refer/INDEX.md scripts; git commit -m "docs: AGENTS.md 改写为单包结构 + 发布脚本归并"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3 架构→Task 3；§4 工具挂载/过滤→Task 10 Step 3 + Task 13；§5.1 注册表→Task 8；§5.2 分层引擎→Task 7；§5.3 YAML 导入→Task 8；§6 委托→Task 9 + Task 12；§7 飞书绑定→Task 13；§8 浏览器半→Task 6/11/12/14；§9 存储→Task 5/8/13；§10 shared 消重→Task 4；§11 spec/plan 整理→Task 1/2/17；§12 测试→各 Task TDD 步骤。
- **已知执行期核对点**（不是占位符，是需在执行时对照源码确认的具体位置）：① `BASIC_TOOLS` 的 id/config 以归档 team preset 与 standard preset 文件为准（Task 10 Step 3）；② `agentCtx.plugin` 不可用时退路到 agent-presets mount 内部等价调用（Task 10 Step 3）；③ `ctx.tools` 列举 API 以 core/tools 源码为准（Task 14）；④ 根 cordis.yml insert 与包自带 patch 二选一按 duplicate id 报错反馈定（Task 16 Step 1）。
