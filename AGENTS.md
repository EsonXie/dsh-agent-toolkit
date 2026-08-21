# AGENTS.md

## 仓库性质

本仓库是 DeepSeek Harness（dsh）插件的开发工作区。包含 `docs/refer/` 下的 dsh 官方文档本地镜像（2026-08 抓取自 <https://deepseek-harness.github.io/deepseek-harness/> 中文站，共 87 篇），以及 `packages/token-usage` 插件（第一个实现：Node 半 + 浏览器半 bundle，20/20 测试通过）。

已是 git 仓库（2026-08-18 初始化）；`deepseek-harness/` 被 .gitignore 排除（它自带独立 .git）。

## 开发命令

- 单测：`pnpm --filter @dsh-agent-toolkit/token-usage test`；类型检查：`pnpm --filter @dsh-agent-toolkit/token-usage typecheck`；agent-team 同（`pnpm --filter agent-team test` / `typecheck`）；prompt-stack 同（`pnpm --filter @dsh-agent-toolkit/prompt-stack test` / `typecheck`）
- 构建：`pnpm --filter @dsh-agent-toolkit/token-usage bundle` 同时产出 Node 半（lib/index.js，exports 入口）与浏览器半（lib/client.js）——token-usage 任何 src 改动后、进开发回路前都要跑（开发期 `pnpm --filter @dsh-agent-toolkit/token-usage watch`）；agent-team 含浏览器半，改动后需 `pnpm --filter agent-team bundle`；prompt-stack 是纯 Node 半（`pnpm --filter @dsh-agent-toolkit/prompt-stack bundle` 只产 lib/index.js + d.ts），src 改动后同样要跑
- 发布：`powershell -File scripts/publish-token-usage.ps1` / `scripts/publish-prompt-stack.ps1`（六道门禁后 pnpm publish 到官方 registry；不可在 CI/自动化里跑，含人工确认）
- 开发回路：`cd deepseek-harness && pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml`（deepseek-harness 首次需 `pnpm install && pnpm run build`）

## 文档使用（先读这里）

- **`docs/refer/INDEX.md` 是入口**：包含学习路径、核心概念速查表、"我要做 X → 看哪篇"任务索引、87 篇文档清单、10 条开发硬规则。动手前先看它定位，不要逐篇翻文档。
- `docs/refer/` 按站点 URL 结构组织（`guide/`、`develop/`、`reference/`），文件间相对链接已本地化，可直接跳转。

## dsh 插件开发要点（已从文档核实，避免猜错）

- 插件 = 导出 `apply(ctx)` 的 TS 模块，可选导出 `name`、`inject`、`Config`（Schemastery schema）。通过 `ctx` 注册的一切卸载时自动清理；手动资源必须 `ctx.effect(() => disposer)`。
- 本地开发回路：在 dsh 源码 checkout 中运行 `pnpm dsh web --patch ./cordis.yml`（或已装 CLI 时用 `dsh web --patch`）。**patch 中插件路径必须是绝对路径**，相对路径不会被解析。
- 修改 `cordis.yml` 中的插件 config 会触发 HMR 热替换，无需重启。
- agent-team 例外：经 user preset root（`$DSH_HOME/.agent-presets/team`）接入开发回路，不走 cordis.yml patch（CLI overlay 会重置 roots）；含浏览器半，改动后需 `bundle`。
- agent-team 双挂载点：preset 内挂载跑 Node 半真实工作；cordis.yml 另需一行全局挂载 `config: { clientOnly: true }`（Node 半空转，仅让浏览器半 bundle 进 boot 清单，否则 dock 要等"建会话后刷新页面"）。激活失败反馈在 preset chip hover title / select RPC reason，不标 broken、不进服务端控制台。
- **agent-team 单团队约束**：一个 dsh 实例只挂一个团队 preset；多团队 preset 并发挂载时第二个的 `/agent-team` prefix 路由会抛 duplicate route，在激活期响亮报错（spec §9）。
- token-usage 的 src/store.ts 运行时值导入 `@deepseek-ai/dsh-storage-domain`，但不进 dependencies/peerDependencies：它由宿主 dsh base 隐式提供，加依赖会导致 pnpm 装副本、storage domain 双实例注册分裂。
- 从一开始就遵守的约定：可调参数进 Config schema（不硬编码）；工具 `execute` 返回规范 JSON 值、args 只读且已校验；策略/权限逻辑放 `tools/*` 事件钩子，不内建进工具。

## 目录结构（已定案）

```
dsh-agent-toolkit/
├─ deepseek-harness/     ← dsh 源码 checkout（自带 .git；只读使用，不修改其中文件）
│                           本仓库 git 化时必须 .gitignore 掉它
├─ docs/refer/           ← 官方文档镜像（87 篇）
├─ packages/             ← 插件，各自独立 package
│   ├─ token-usage/      ← Token 用量统计（包名 @dsh-agent-toolkit/token-usage，已发布 npm；
│                           发版流程：test → typecheck → bundle → pack 核查 → pnpm publish）
│   ├─ feishu-bot/       ← 飞书机器人
│   ├─ agent-team/       ← Agent 团队（已建成；presets/team/ 随包发行"团队模式"）
│                           teams/default.yml（explorer + general）
└─ prompt-stack/     ← 提示词分层 + 按模型区分提示词（包名 @dsh-agent-toolkit/prompt-stack；
                        纯 Node 半：tsdown 只产 lib/index.js + d.ts，发版流程同 token-usage）
├─ cordis.yml            ← 开发用 patch（插件 name 写绝对路径）
└─ package.json + pnpm-workspace.yaml（workspace 只含 packages/*，不含 deepseek-harness）
```

插件包内部统一照 `deepseek-harness/packages/acp/acp` 蓝本：`package.json`（peerDeps 拷贝 ACP 依赖集）+ `src/index.ts`（命名导出 `name`/`inject`/`Config`/`apply`，无 default export）。

## 调研成果

- `docs/2026-08-18-插件组技术可行性评估.md`：三个规划插件（飞书机器人 / Agent 团队 / Token 统计）的可行性报告，所有未知点已对照 `deepseek-harness/` 源码逐项闭环（含文件:行号引用）。动手实现前先读它。第四节是开发环境与目录结构的定案。
- `deepseek-harness/`：dsh 源码 checkout，用作运行时宿主与类型依赖来源；不要修改其中的文件。

## 文档镜像的刷新

上游源文件在 GitHub 仓库 `deepseek-ai/deepseek-harness` 的 `docs/**/*.zh.md`；如需更新镜像，重新拉取该目录并按现有结构覆盖 `docs/refer/`（链接转换规则：站内相对链接 → 本地相对路径，指向仓库其他位置的链接 → GitHub blob URL）。

## 设计文档

插件设计 spec 统一放 `docs/superpowers/specs/YYYY-MM-DD-<主题>-design.md`。
