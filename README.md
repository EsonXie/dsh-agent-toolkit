# dsh-agent-toolkit

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件开发工作区。核心产物是单体插件 [`packages/toolkit`](packages/toolkit)（npm 包名 `dsh-agent-toolkit`），把五个 Agent 生产力功能合进一个包：

- **Agent 注册表** —— UI 管理的可复用 Agent 名册（persona、模型、工具白名单），支持 YAML 首启导入，内置 `main` / `explorer` / `general` 三个角色。
- **分层提示词** —— 语义化提示词分层 + 按模型匹配的覆盖/追加规则，内置模型层随模型家族自动切换。
- **并行委派** —— `team_delegate` 工具从名册启动一次性子 Agent，web UI 渲染实时委派卡。
- **飞书 bots** —— 项目绑定飞书自建应用，扫码一键创建应用，在飞书里以流式卡片与 Agent 对话。
- **Token 用量** —— 按日/按小时计量，13 周活动热力图 + 单日堆叠图 + `/token-usage` 命令。

## 快速开始

```bash
dsh plugin add dsh-agent-toolkit
```

包自带 `cordis.patch.yml`（bundles 层），装进 profile 后自动激活。安装、配置与功能细节见 [使用手册](docs/usage/README.md) 和 [插件包 README](packages/toolkit/README.md)。

## 开发

### 目录结构

```
├─ deepseek-harness/     ← dsh 源码 checkout（只读使用；已被 .gitignore 排除）
├─ docs/refer/           ← dsh 官方文档本地镜像（入口：docs/refer/INDEX.md）
├─ docs/usage/           ← 插件使用手册（中文多文件 + images/ 截图）
├─ docs/superpowers/     ← 设计 spec（specs/）与实施计划（plans/）
├─ packages/toolkit/     ← 单插件总入口（npm 包名 dsh-agent-toolkit；Node 半 lib/index.js + 浏览器半 lib/client.js）
├─ packages/usage/       ← token 用量独立包（npm 包名 @dsh-agent-toolkit/token-usage；Node 半 + 浏览器半 + client-module 三产物）
├─ scripts/              ← 发布等脚本
└─ cordis.yml            ← 开发用 patch（只按 id 覆盖 config）
```

### 常用命令

```bash
# 单测 / 类型检查 / 构建（src 改动后必须跑 bundle）
pnpm --filter dsh-agent-toolkit test
pnpm --filter dsh-agent-toolkit typecheck
pnpm --filter dsh-agent-toolkit bundle

pnpm --filter @dsh-agent-toolkit/token-usage test
pnpm --filter @dsh-agent-toolkit/token-usage typecheck
pnpm --filter @dsh-agent-toolkit/token-usage bundle

# 开发回路：把插件 link 进 web profile（deepseek-harness 首次需 pnpm install && pnpm run build）
cd deepseek-harness
pnpm dsh plugin --profile web add link:<packages/toolkit 的绝对路径>
pnpm dsh web --patch <仓库根>/cordis.yml   # 日常启动，只按 id 覆盖 config

# 发布（六道门禁 + 人工确认后 pnpm publish；不可在 CI 里跑）
# <name> = dsh-agent-toolkit 或 @dsh-agent-toolkit/token-usage
powershell -File scripts/publish.ps1 -Package <name>
```

### 文档导航

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 开发约定、目录结构定案、插件开发要点、已知问题 |
| [docs/refer/INDEX.md](docs/refer/INDEX.md) | dsh 官方文档镜像入口（学习路径 + 任务索引 + 87 篇清单） |
| [docs/usage/](docs/usage/README.md) | 插件使用手册（含配置参考） |
| [docs/superpowers/specs/](docs/superpowers/specs/) | 设计 spec |

## License

MIT（见 [packages/toolkit/LICENSE](packages/toolkit/README.md)）
