# AGENTS.md

## 仓库性质

本仓库是 DeepSeek Harness（dsh）插件的开发工作区。包含 `docs/refer/` 下的 dsh 官方文档本地镜像（2026-08 抓取自 <https://deepseek-harness.github.io/deepseek-harness/> 中文站，共 87 篇），以及双包 `packages/toolkit`（npm 包名 `dsh-agent-toolkit`，Agent 注册表 + 分层提示词 + 并行委派 + 飞书 bots + token 用量，Node 半 + 浏览器半 bundle，842/842 测试通过（84 文件，另 2 skipped））+ `packages/usage`（npm 包名 `@dsh-agent-toolkit/token-usage`，token 用量（含启动回填 + `/token-usage refresh` 重建命令），Node 半 + 浏览器半 + client-module 三产物，78/78 测试通过）。合并前的四包代码快照已于 2026-08-27 删除（如需参考可从 git 历史恢复）；其中 token-usage 已 2026-08-31 拆回独立包（`packages/usage`）。使用手册在 `docs/usage/`（中文多文件，含 `images/` 界面截图；委派卡截图待真实委派后补拍）。

已是 git 仓库（2026-08-18 初始化）；`deepseek-harness/` 被 .gitignore 排除。**2026-09-10 起 checkout 为 0.1.5-rc.1 fresh clone（tag `dsh-v0.1.5-rc.1`，`.git` 在位）；旧 08-18 基线 `deepseek-harness.old-0.1.2/` 已于 0.1.5 兼容性升级验证通过后删除（2026-09-10）。**0.1.5-rc.1 结构变化：内置 agent presets 迁至 `packages/preset/agent-presets/presets/`；`packages/client/runtime`（dsh-client-runtime）裁撤，类型拆到 `api/session-controller` 等；`Context.slots` 声明合并在 `@deepseek-ai/dsh-client-ui-renderer/client`。** 升级台账（已完成并归档）：[docs/superpowers/plans/archive/2026-09-10-dsh-0.1.5-compat-upgrade.md](docs/superpowers/plans/archive/2026-09-10-dsh-0.1.5-compat-upgrade.md)（宿主破坏清单与修复记录；飞书流式迁移 spec 同归档于 specs/archive/）。

## 开发命令

- 单测：两包各跑 `pnpm --filter dsh-agent-toolkit test` + `pnpm --filter @dsh-agent-toolkit/token-usage test`；类型检查：两包各跑 `pnpm --filter dsh-agent-toolkit typecheck` + `pnpm --filter @dsh-agent-toolkit/token-usage typecheck`；构建：`pnpm --filter dsh-agent-toolkit bundle` 产出 Node 半（lib/index.js，exports 入口）与浏览器半（lib/client.js），`pnpm --filter @dsh-agent-toolkit/token-usage bundle` 额外产出纯 ESM client-module（lib/client-module.js，供 toolkit 浏览器半内联）——任何 src 改动后、进开发回路前都要跑（开发期两包各自 `pnpm --filter <pkg> watch`）
- 构建顺序：toolkit 的 bundle 对 usage 无构建期依赖——浏览器半经 tsconfig paths 直接内联 `packages/usage/src/`（`//#region ../usage/src/...`），Node 半对 `@dsh-agent-toolkit/token-usage` 保持 external；但 toolkit 的 **vitest 测试** 与宿主运行时都经 node_modules 解析 usage 的 **lib/**，改 usage src 后先跑 `pnpm --filter @dsh-agent-toolkit/token-usage bundle` 再跑 toolkit 测试/进开发回路，否则会吃到旧 lib
- 发布：`powershell -File scripts/publish.ps1 -Package <name>`（`<name>` = `dsh-agent-toolkit` 或 `@dsh-agent-toolkit/token-usage`；六道门禁后 pnpm publish 到官方 registry；不可在 CI/自动化里跑，含人工确认）。发布历史见 [docs/domains/releases.md](docs/domains/releases.md)（每次发布后在那里追加一条）。
- **本地开发与真实环境的解析差异（本事故教训，勿再踩）**：源码模式 `pnpm dsh` = `node --import tsx/esm`，tsx 用 **CWD（harness 根）的 tsconfig paths** 兜底解析裸包名，会掩盖插件未声明的依赖；生产是裸 Node，只走 node_modules 向上解析。差异矩阵：运行时 tsx vs node；安装 link:（Junction→realpath→checkout 链）vs npm 装（profile 实体目录→可命中安装回退目录）；日志 dsh web **不展示**插件 `ctx.logger.warn`（无 console exporter + 默认级别过滤丢 warn，lark SDK 的 console 输出反而可见）。发版 parity 建议：安装版 dsh + link: 插件跑一遍建 bot → 收发消息 → `/new`。
- 已知问题（2026-08-27 记录，未解决）：Agents 面板编辑区滚到底部后，hover 工具白名单 checkbox / 模型下拉框时视觉抖动（用户感知控件高度变化 + 周围内容跳动）。已排除：插件与宿主全部 CSS（无 hover 布局规则）、滚动条皮肤与 Fluent/Overlay flag、扩展（无痕复现）、DOM 层（用户浏览器内稳态采样 + 逐帧 computed-style 采样均零变化）；同一 chrome.exe 干净 profile（Playwright 有头）不复现。隐藏 editorPane 滚动条无效（已回退）。疑似真实鼠标轨迹/惯性滚动或合成器层绘制问题，待录屏证据后继续定位。
- 开发回路：`cd deepseek-harness && pnpm dsh plugin --profile web add link:D:\work\github\dsh\dsh-agent-toolkit\packages\toolkit` 把插件装进 web profile（deepseek-harness 首次需 `pnpm install && pnpm run build`）；日常启动 `pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml`（只按 id 覆盖 config）

## 文档使用（先读这里）

- **`docs/refer/INDEX.md` 是入口**：包含学习路径、核心概念速查表、"我要做 X → 看哪篇"任务索引、87 篇文档清单、10 条开发硬规则。动手前先看它定位，不要逐篇翻文档。
- `docs/refer/` 按站点 URL 结构组织（`guide/`、`develop/`、`reference/`），文件间相对链接已本地化，可直接跳转。

## dsh 插件开发要点（已从文档核实，避免猜错）

- 插件 = 导出 `apply(ctx)` 的 TS 模块，可选导出 `name`、`inject`、`Config`（Schemastery schema）。通过 `ctx` 注册的一切卸载时自动清理；手动资源必须 `ctx.effect(() => disposer)`。
- 本地开发回路：插件经 `dsh plugin --profile web add link:<packages/toolkit 绝对路径>` 装进 web profile，由包自带 `cordis.patch.yml`（bundles 层，id: dsh-agent-toolkit）激活，走 loader 的 profile 目录解析锚点。**根 patch 不要 insert 本地插件**：Windows 绝对路径（`D:\...`）会被 loader 当裸 specifier 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`（protocol 'd:'），`file://` 名虽可 import 但会脱离 profile 解析锚点（找不到宿主注入服务）；根 `cordis.yml` 只按 id 覆盖 config。
- 修改 `cordis.yml` 中的插件 config 会触发 HMR 热替换，无需重启。
- 单插件入口：`packages/toolkit/src/index.ts` 命名导出 `name`/`inject`/`Config`/`apply`；`inject` 是 merged 模块直接消费的硬依赖服务全集（含 storageDomain/tokenMeter/credentials/agents 等 10 项）。
- 浏览器半 `packages/toolkit/src/client/index.ts` 同样必须命名导出服务名数组 `inject`（现为 `['sessions', 'slots', 'locale']`）：browser kernel 按插件模块自身导出的 inject 门控 `ctx.<service>` 访问，package.json 的 `dsh.client.inject`（包名数组）只是信息性 boot-graph 边，不参与门控。
- 共享层约定：`src/shared/` 的 `openDomainSafely`（安全打开存储域 + 卸载时关闭）/`registerOptionalRoutes`（webServer 可选服务下注册路由，headless/CLI 惰性不抛错）；`src/shared/http.ts`（json/readJsonBody 响应助手，agents/prompt 两个 API 共用）；`src/client/shared/` 的 `useLoadState`（loading/error/ok 状态机）与 `feedback.tsx`（`useToast` + `SaveBar` 保存反馈共享件，Agents/Schedule/Prompt 三页共用）；`createSidebarEntry` 工厂已随 2026-09-17 设置面板收编删除（四个底栏弹窗改为 `src/client/settings/` 单 `settings.section` 壳 + 页内三 tab）。
- 浏览器半 UI 入口：四个底栏弹窗（Agents/Prompt/Bots/Schedule）已收编为宿主设置面板 section「Agent 工具箱」（id `agent-toolkit`, order 25，`src/client/settings/index.ts` 注册 + `ToolkitSection.tsx` 三 tab 壳），usage（token 用量）底栏入口保留不动；新增 chrome 文案走 NS `agent-toolkit`（zh 真源 + en 镜像），`agent-schedule` 词典注册点移至 `src/client/settings/index.ts`。
- toolkit 的 src 运行时值导入 `@deepseek-ai/dsh-storage-domain`，但不进 dependencies/peerDependencies：它由宿主 dsh base 隐式提供（devDependencies link 到 deepseek-harness 源码），加依赖会导致 pnpm 装副本、storage domain 双实例注册分裂。
- 从一开始就遵守的约定：可调参数进 Config schema（不硬编码）；工具 `execute` 返回规范 JSON 值、args 只读且已校验；策略/权限逻辑放 `tools/*` 事件钩子，不内建进工具。

## 功能域（现行事实，改动时同步对应文档）

各域文档是该功能**现行状态**的权威描述（2026-09-10 自本文件拆出）；「为什么这样设计」的决策考古在 `docs/superpowers/{specs,plans}/archive/`。

- 分层提示词（四层模型/规则/存储）→ [docs/domains/prompt-layers.md](docs/domains/prompt-layers.md)
- Agent 注册表、工具白名单与会话工具面（setup/scope/restrict）→ [docs/domains/agents.md](docs/domains/agents.md)
- 委派（team_delegate/路由持久化/名册段）→ [docs/domains/delegation.md](docs/domains/delegation.md)
- 飞书渠道（入站/出站卡片状态机/审批卡/sender 段）→ [docs/domains/feishu.md](docs/domains/feishu.md)
- 定时任务 cron → [docs/domains/schedule.md](docs/domains/schedule.md)
- token 用量 → `packages/usage/`（独立包，见其 README 与源码）
- 发布历史 → [docs/domains/releases.md](docs/domains/releases.md)

## 目录结构（已定案）

```
dsh-agent-toolkit/
├─ deepseek-harness/     ← dsh 源码 checkout（自带 .git；只读使用，不修改其中文件）
│                           本仓库 git 化时必须 .gitignore 掉它
├─ docs/refer/           ← 官方文档镜像（87 篇）
├─ docs/usage/           ← 插件使用手册（中文多文件 + images/ 界面截图）
├─ docs/domains/         ← 功能域现行状态文档（改动对应域时同步）
├─ docs/superpowers/     ← 设计 spec（specs/）与实施计划（plans/）；历史任务的
│                           {specs,plans}/archive/ 只读参考（2026-09-10 根部 25 份 spec +
│                           24 份 plan 已全部归档，archive 内文档间旧路径引用保持原样）
├─ packages/             ← 插件包
│   ├─ toolkit/          ← 单插件总入口（npm 包名 dsh-agent-toolkit；Node 半 lib/index.js +
│   │                      浏览器半 lib/client.js，双半 bundle；发版：test → typecheck →
│   │                      bundle → pack 核查 → pnpm publish）
│   └─ usage/            ← token 用量独立包（npm 包名 @dsh-agent-toolkit/token-usage；Node 半
│                          lib/index.js + 浏览器半 lib/client.js + 纯 ESM client-module
│                          lib/client-module.js 三产物；发版同上）
├─ cordis.yml            ← 开发用 patch（只按 id 覆盖 config；不再 insert 插件）
└─ package.json + pnpm-workspace.yaml（workspace 只含 packages/*，不含 deepseek-harness）
```

包结构照 `deepseek-harness/packages/acp/acp` 蓝本：`package.json`（peerDeps 拷贝 ACP 依赖集）+ `src/index.ts`（命名导出 `name`/`inject`/`Config`/`apply`，无 default export）。

## 调研成果

- `docs/2026-08-18-插件组技术可行性评估.md`：三个规划插件（飞书机器人 / Agent 团队 / Token 统计）的可行性报告，所有未知点已对照 `deepseek-harness/` 源码逐项闭环（含文件:行号引用）。**注意：对应合并前的四包规划，现状已合并为 `packages/toolkit` 单包（其中 token 用量模块又于 2026-08-31 拆回独立包 `packages/usage`，见上方目录结构）**。第四节是开发环境与目录结构的定案（已过时，以本文件当前结构为准）。
- `deepseek-harness/`：dsh 源码 checkout，用作运行时宿主与类型依赖来源；不要修改其中的文件。

## 文档镜像的刷新

上游源文件在 GitHub 仓库 `deepseek-ai/deepseek-harness` 的 `docs/**/*.zh.md`；如需更新镜像，重新拉取该目录并按现有结构覆盖 `docs/refer/`（链接转换规则：站内相对链接 → 本地相对路径，指向仓库其他位置的链接 → GitHub blob URL）。

## 设计文档

插件设计 spec 统一放 `docs/superpowers/specs/YYYY-MM-DD-<主题>-design.md`；实施完成并发布后移入 `docs/superpowers/specs/archive/`（plan 同移 `plans/archive/`），其现行事实并入 `docs/domains/` 对应域文档。
