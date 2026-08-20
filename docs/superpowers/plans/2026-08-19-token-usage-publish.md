# token-usage 插件打包发布（本地 tarball 分发）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `packages/token-usage` 改名为 `@dsh-agent-toolkit/token-usage` 并改造为可 `dsh plugin add <tarball>` 安装的 dsh 组合包（bundle）；**不发布 npm、不配 CI**，分发形态为本地 `pnpm pack` 手动产出 tarball。

**Architecture:** 复用现有 tsdown 构建管线，增加第二个配置构建 Node 半（`src/index.ts` → `lib/index.js`，ESM + d.ts）；`package.json` 的 `exports["."]` 从 TS 源码切换到构建产物，补充 `dsh.bundle` manifest 与 `cordis.patch.yml` 使 `dsh plugin add` 能激活配置层；运行时依赖 `@deepseek-ai/schemastery` 从 devDep(link) 转为 dependencies(npm 版本)；devDependencies 保持 `link:` 锚定本地 monorepo checkout。

**Tech Stack:** pnpm 11 workspace、tsdown 0.22（rolldown）、dsh bundle/profile 机制。

## Global Constraints

- 包名 **`@dsh-agent-toolkit/token-usage`**（已定）。四处必须一致：package.json `name`、tsdown `ID` 常量、`cordis.patch.yml` 行 `name`、开发用 `cordis.yml` 行 `name`。**插件导出 `name = 'token-usage'` 不变**（cordis 插件名，不随包名改；`src/` 一行不动）
- 版本 **`0.1.0`**，License **MIT**；**保留 `"private": true`** 作为误发 npm 的闸门
- **不改动 `src/` 下任何业务代码**（aggregate/render/store/index/client 均不动）
- ESM only（`"type": "module"` 保持）
- devDependencies **保持 `link:`**（本地开发锚定 monorepo checkout；不配 CI，无需解决 CI 上的 link 解析）
- npm 版本基线（2026-08-19 实测）：`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/schemastery@3.18.1`
- 提交信息风格沿用仓库历史：`feat(token-usage): ...` / `chore(token-usage): ...` / `docs: ...`
- 仓库默认分支 `master`（当前工作分支 `feat/agent-team`，本计划改动落在哪个分支由用户定）

---

### Task 1: tsdown 增加 Node 半构建配置（含 ID 改名）

**Files:**
- Modify: `packages/token-usage/tsdown.config.ts`（整体改写，见下方完整内容）

**Interfaces:**
- Produces: `lib/index.js`（ESM，`name`/`inject`/`Config`/`apply` 命名导出，无 default export）、`lib/index.d.ts`；后续 Task 2 的 `exports["."]` 指向它们。
- 客户端产物 `lib/client.js` 形态不变（lazy-CJS factory），但 banner 中的模块 id 改为 `@dsh-agent-toolkit/token-usage`——必须等于包名（client-modules 扫描以包名为 entry id）。

- [ ] **Step 1: 改写 tsdown.config.ts 为双配置**

完整新内容（客户端配置逻辑原样保留，仅包一层 `const clientConfig =`；`ID` 改 scoped 包名；新增 `nodeConfig`；导出数组）：

```ts
/** token-usage 构建配置：Node 半（lib/index.js，ESM）+ 客户端 bundle（lib/client.js，lazy-CJS factory）。 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/** 必须等于 package.json 的 name：client-modules 扫描以包名为 entry id（bundle URL /plugins/<id>/client.js）。 */
const ID = '@dsh-agent-toolkit/token-usage'

/** Node 半：所有包依赖保持 external，由安装侧（profile）解析；只转译本包 src。 */
const nodeConfig = {
  name: `${ID}/node`,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, 'clsx', 'zod'],
  },
} satisfies UserConfig

/** 平台模块由 loader 模块表提供，保持 external（对照 dsh web/src/platform.ts:9 + runtime 豁免）。 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form', '@deepseek-ai/dsh-client-runtime/client',
] as const
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const clientConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => ((CLIENT_EXTERNALS as readonly string[]).includes(id) ? undefined : true),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    // 纯净度门禁：跨插件值导入即构建错误；协作走 cordis 服务/slot。
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if ((CLIENT_EXTERNALS as readonly string[]).includes(source)) return null
      if (VENDORED_LIBRARY.test(source)) return null
      if (INLINE_SAFE.test(source)) return null
      throw new Error(`client bundle purity: "${source}" 不是平台模块或 inline-safe 线层——禁止跨插件值导入`)
    },
  }, {
    // CSS Modules 内联：x.module.css → 哈希类名映射 + <style data-plugin> 自动注入。
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(id: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId, code: source, cssModules: { pattern: '[hash]_[local]' }, minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} satisfies UserConfig

export default [nodeConfig, clientConfig]
```

- [ ] **Step 2: 运行构建**

Run: `pnpm --filter token-usage bundle`
Expected: 两个配置都构建成功；`packages/token-usage/lib/` 下新增 `index.js`、`index.d.ts`、`index.js.map`；`client.js` 重新生成且 banner 含 `@dsh-agent-toolkit/token-usage`（用 `Select-String -Path packages/token-usage/lib/client.js -Pattern '__ModuleLoader__.load' -SimpleMatch` 确认首行 id）。

- [ ] **Step 3: Node 半产物冒烟——纯 Node 导入并检查插件导出形态**

Run（workdir `packages/token-usage`）:

```powershell
node --input-type=module -e "const m = await import('./lib/index.js'); if (m.name !== 'token-usage') throw new Error('name'); if (typeof m.apply !== 'function') throw new Error('apply'); if (!Array.isArray(m.inject)) throw new Error('inject'); if ('default' in m) throw new Error('must not have default export'); console.log('node-half ok:', m.name, m.inject.join(','))"
```

Expected: 输出 `node-half ok: token-usage storageDomain,tokenMeter,commands`（插件导出名保持 `token-usage`；`@deepseek-ai/schemastery` 经 devDependencies 的 link 可解析）。

- [ ] **Step 4: 回归——既有测试与类型检查**

Run: `pnpm --filter token-usage test; pnpm --filter token-usage typecheck`
Expected: 20/20 PASS；typecheck 无错误。

- [ ] **Step 5: 若 dts 生成失败（仅失败时执行的应急分支）**

把 `nodeConfig` 的 `dts: true` 改为 `dts: false`，重跑 Step 2–4；并在 Task 2 的 package.json 中删除 `types` 字段和 `exports["."].types`。成功则跳过本步。

- [ ] **Step 6: Commit**

`lib/` 被根 `.gitignore` 的 `packages/*/lib/` 排除，**不入库**（`prepack` 会在打包前重建，产物无需版本化）：

```powershell
git add packages/token-usage/tsdown.config.ts
git commit -m "feat(token-usage): tsdown 增加 Node 半构建；模块 ID 对齐 scoped 包名"
```

---

### Task 2: 包改名 + package.json 打包化 + cordis.patch.yml + README + 引用点同步

**Files:**
- Modify: `packages/token-usage/package.json`（整体替换，见下方完整内容）
- Create: `packages/token-usage/cordis.patch.yml`
- Create: `packages/token-usage/README.md`
- Modify: `package.json`（根：依赖名、bundle script）
- Modify: `cordis.yml`（开发 patch 行 name）

**Interfaces:**
- Consumes: Task 1 产出的 `lib/index.js` / `lib/index.d.ts` / `lib/client.js`。
- Produces: 可被 `dsh plugin add` 激活的组合包：`dsh.bundle.patch` 指向 `cordis.patch.yml`；patch 行按包名引用（publish.md：patch 行用包名而非路径，Node 模块解析以 profile 目录为锚点）。

- [ ] **Step 1: 创建 `packages/token-usage/cordis.patch.yml`**

```yaml
# token-usage 组合包层：profile 的 dsh.profile.bundles 列出本包时应用。
# 行 name 用包名（非路径），Node 模块解析以 profile 目录为锚点找到已安装代码。
# config 不写：timezone 由 Config schema 默认（系统时区），用户可在自己 profile 的
# cordis.patch.yml 中整行覆盖（patch 是整行替换，不深度合并）。
- insert:
    - id: token-usage
      name: '@dsh-agent-toolkit/token-usage'
```

- [ ] **Step 2: 整体替换 `packages/token-usage/package.json`**

```json
{
  "name": "@dsh-agent-toolkit/token-usage",
  "version": "0.1.0",
  "private": true,
  "description": "DeepSeek Harness plugin: per-day token usage statistics — /token-usage command, JSON endpoint, sidebar UI",
  "license": "MIT",
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "cordis.patch.yml",
    "README.md"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-sidebar"
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
    "clsx": "^2.0.0",
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "link:../../deepseek-harness/vendor/cordis",
    "@deepseek-ai/dsh-client-runtime": "link:../../deepseek-harness/packages/client/runtime",
    "@deepseek-ai/dsh-client-ui-sidebar": "link:../../deepseek-harness/packages/client/ui-sidebar",
    "@deepseek-ai/dsh-client-ui-primitives": "link:../../deepseek-harness/packages/client/ui-primitives",
    "@deepseek-ai/dsh-client-ui-slots": "link:../../deepseek-harness/packages/client/ui-slots",
    "@deepseek-ai/dsh-commands": "link:../../deepseek-harness/packages/interaction/commands",
    "@deepseek-ai/dsh-compaction": "link:../../deepseek-harness/packages/compaction/compaction",
    "@deepseek-ai/dsh-host-webserver": "link:../../deepseek-harness/packages/host/webserver",
    "@deepseek-ai/dsh-llm": "link:../../deepseek-harness/packages/llm/llm",
    "@deepseek-ai/dsh-session": "link:../../deepseek-harness/packages/core/session",
    "@deepseek-ai/dsh-storage-domain": "link:../../deepseek-harness/packages/storage/storage-domain",
    "@deepseek-ai/dsh-token-meter": "link:../../deepseek-harness/packages/llm/token-meter",
    "@deepseek-ai/schemastery": "link:../../deepseek-harness/vendor/schemastery",
    "@testing-library/react": "^16.1.0",
    "@types/node": "^22.20.1",
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

要点说明（实施者必读）：

- **`"private": true` 保留**：不发布 npm，它既不阻碍 `pnpm pack`（已实测），又能挡住误 `pnpm publish`。
- `exports["."]` 从 `./src/index.ts` 切到构建产物（tarball 安装进 profile 后，宿主 dsh 跑构建后 JS，不跑 tsx）。
- `@deepseek-ai/schemastery` 是 Node 半**运行时值导入**（`import z from ...`），必须进 `dependencies`，使 pnpm 把它装进 profile。Config schema 走 Standard Schema 接口被宿主泛型调用，与宿主 vendored 副本并存无 instanceof 问题（config.md 强调 Standard Schema 接口即为此）。
- 其余 `@deepseek-ai/dsh-*` 在本包中**只有 type-only 导入**（服务经 `ctx` 注入，不走 import），不进 dependencies/peerDependencies，避免 pnpm 自动装一份与宿主版本脱节的副本进 profile；`@deepseek-ai/cordis` 按 dsh 仓库惯例作 peerDependency。
- devDependencies 保留 `link:`（本地开发锚定 monorepo checkout；已实测 `pnpm pack` 不报错，安装方不读 devDependencies）。
- `prepack` 保证 `pnpm pack` 前重建两半产物。

- [ ] **Step 3: 创建 `packages/token-usage/README.md`**

````markdown
# @dsh-agent-toolkit/token-usage

DeepSeek Harness（dsh）插件：按日统计 token 用量。

- `/token-usage [YYYY-MM-DD]` 斜杠命令：今日 + 近 7 日汇总，或指定日期
- `GET /token-usage/api/daily?date=YYYY-MM-DD` JSON 端点（web 模式）
- Web UI 侧边栏用量面板（点击打开明细弹窗）

## 安装

本包不发布 npm，以 tarball 分发：

```sh
pnpm pack                                            # 产出 dsh-agent-toolkit-token-usage-0.1.0.tgz
dsh plugin --profile web add ./dsh-agent-toolkit-token-usage-0.1.0.tgz
```

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `timezone` | string（IANA 名） | 系统时区 | 按日聚合的分日时区 |

在 profile 的 `cordis.patch.yml` 中整行覆盖：

```yaml
- id: token-usage
  name: '@dsh-agent-toolkit/token-usage'
  config:
    timezone: Asia/Shanghai
```

依赖 dsh 提供 `storageDomain`、`tokenMeter`、`commands` 服务（`@deepseek-ai/dsh-base` 均含）；`webServer` 为可选注入，headless/CLI 下不注册 HTTP 端点。
````

- [ ] **Step 4: 同步根 package.json**

```json
{
  "name": "dsh-agent-toolkit",
  "private": true,
  "type": "module",
  "dependencies": {
    "@dsh-agent-toolkit/token-usage": "workspace:*"
  },
  "scripts": {
    "test": "pnpm -r run test",
    "typecheck": "pnpm -r run typecheck",
    "bundle": "pnpm --filter @dsh-agent-toolkit/token-usage run bundle"
  }
}
```

- [ ] **Step 5: 同步开发用 `cordis.yml`**

```yaml
# 开发用 patch：dsh web --patch 叠加到 web profile。
# 顶层必须是 loader patch 条目（PatchOptions）数组；insert 追加行。
# 插件行 name 用裸包名：包已通过 `dsh plugin --profile web add link:<本包路径>` 装进 profile，
# loader 导入与 client-modules 扫描都以 profile 目录（~/.dsh/profiles/web）为解析锚点。
- insert:
    - id: token-usage
      name: '@dsh-agent-toolkit/token-usage'
      config:
        timezone: Asia/Shanghai
```

- [ ] **Step 6: 本地 web profile 重新链接（包名变更必须重装）**

旧名 `token-usage` 还挂在 web profile 的依赖里，改名后解析锚点对不上。

Run（workdir `deepseek-harness`）:

```powershell
pnpm dsh plugin --profile web remove token-usage
pnpm dsh plugin --profile web add "link:D:\work\github\dsh\dsh-agent-toolkit\packages\token-usage"
```

Expected: profile 的 `dsh.profile.bundles` 中 `token-usage` 被 `@dsh-agent-toolkit/token-usage` 替换。

- [ ] **Step 7: 重建、安装、回归**

Run（workdir 仓库根）: `pnpm install; pnpm --filter @dsh-agent-toolkit/token-usage bundle; pnpm --filter @dsh-agent-toolkit/token-usage test; pnpm --filter @dsh-agent-toolkit/token-usage typecheck`
Expected: 全绿（20/20）。`pnpm install` 让 workspace 按新包名重新链接。

**已知风险与应急**：`@deepseek-ai/schemastery` 同时出现在 dependencies（`^3.18.1`）和 devDependencies（`link:`）——pnpm 允许同名重叠且本地 link 生效、打包时 devDeps 被忽略（消费者拿到 registry 版），但若 `pnpm install` 对此报错，删除 devDependencies 中的 `@deepseek-ai/schemastery` link 行，本地也改用 registry 版本（schemastery 是 vendored 稳定库，与宿主漂移风险低），再继续。

- [ ] **Step 8: 验证开发回路仍可用（exports 切换 + 改名后的关键回归）**

Run（workdir `deepseek-harness`）: `pnpm dsh --profile web --dump-config`
Expected: 输出含 `@dsh-agent-toolkit/token-usage` 行且命令成功退出（不启动服务器、无需 API key）。

- [ ] **Step 9: Commit**

```powershell
git add packages/token-usage package.json cordis.yml pnpm-lock.yaml
git commit -m "feat(token-usage): 改名 @dsh-agent-toolkit/token-usage 并打包化（exports→lib、dsh.bundle manifest、schemastery 转 runtime dep）"
```

---

### Task 3: 打包产物验证（pnpm pack 内容核查）

**Files:**
- 无文件改动（纯验证）

**Interfaces:**
- Consumes: Task 2 的完整包形态。
- Produces: `packages/token-usage/dsh-agent-toolkit-token-usage-0.1.0.tgz`（scoped 包的 tarball 文件名规则：scope 的 `@` 去掉、`/` 转 `-`），供 Task 4 安装验证。

- [ ] **Step 1: 打包**

Run（workdir `packages/token-usage`）: `pnpm pack`
Expected: 生成 `dsh-agent-toolkit-token-usage-0.1.0.tgz`；`prepack` 自动重跑 bundle。

- [ ] **Step 2: 核查 tarball 内容**

Run: `tar -tf packages/token-usage/dsh-agent-toolkit-token-usage-0.1.0.tgz`
Expected（逐条核对，缺一不可、多一不可）:

- ✅ 必含：`package/package.json`、`package/README.md`、`package/cordis.patch.yml`、`package/lib/index.js`、`package/lib/index.d.ts`、`package/lib/client.js`（`.map` 可有可无，不阻塞）
- ❌ 必不含：`src/`、`tests/`、`tsconfig.json`、`tsdown.config.ts`、`vitest.config.ts`、`node_modules/`

- [ ] **Step 3: 核查 tarball 内 package.json 关键字段**

Run:

```powershell
tar -xOf packages/token-usage/dsh-agent-toolkit-token-usage-0.1.0.tgz package/package.json | node --input-type=module -e "let s=''; for await (const c of process.stdin) s+=c; const p=JSON.parse(s); if (p.name!=='@dsh-agent-toolkit/token-usage') throw new Error('name: '+p.name); if (p.version!=='0.1.0') throw new Error('version'); if (p.exports['.'].default!=='./lib/index.js') throw new Error('exports'); if (p.dsh.bundle.patch!=='./cordis.patch.yml') throw new Error('bundle patch'); if (p.dependencies['@deepseek-ai/schemastery']!=='^3.18.1') throw new Error('schemastery dep'); console.log('tarball manifest ok')"
```

Expected: 输出 `tarball manifest ok`。

---

### Task 4: 临时 profile 端到端安装验证（tarball）

**Files:**
- 无仓库文件改动（在 `$DSH_HOME/profiles/` 下创建临时 profile，验证完清理）

**Interfaces:**
- Consumes: Task 3 的 `dsh-agent-toolkit-token-usage-0.1.0.tgz`。
- 命令在 `deepseek-harness/` 目录用 `pnpm dsh ...` 执行（源码启动器；publish.md 第 7 行确认可用）。

- [ ] **Step 1: 安装 tarball 进新 profile**

Run（workdir `deepseek-harness`）:

```powershell
pnpm dsh plugin --profile tu-verify add "D:\work\github\dsh\dsh-agent-toolkit\packages\token-usage\dsh-agent-toolkit-token-usage-0.1.0.tgz"
```

Expected: 成功；**不应**出现"没有 dsh.bundle 声明"的警告；profile 的 `dsh.profile.bundles` 追加 `@dsh-agent-toolkit/token-usage`。

- [ ] **Step 2: 验证配置层激活**

Run: `pnpm dsh --profile tu-verify --dump-config`
Expected: 输出含 `# == @dsh-agent-toolkit/token-usage` 层标题与 `id: token-usage` 行（publish.md：dump-config 会显示各组合包层）。

- [ ] **Step 3: 启动 web 并验证 Node 半端点与 client bundle 路由**

Run（workdir `deepseek-harness`）:

```powershell
$log = "$env:TEMP\opencode\tu-verify-web.log"
$proc = Start-Process pnpm -ArgumentList 'dsh','web','--profile','tu-verify' -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -NoNewWindow
# 轮询日志直到出现监听 URL（最多 60s）
$url = $null
foreach ($i in 1..30) { Start-Sleep 2; $m = Select-String -Path $log -Pattern 'http://[^\s]+' | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value; break } }
if (-not $url) { Get-Content $log; throw 'web 未在 60s 内监听' }
curl.exe -s -o NUL -w "%{http_code}" "$url/plugins/@dsh-agent-toolkit/token-usage/client.js"   # 期望 200（scoped 包名含斜杠，路由按完整包名匹配）
curl.exe -s "$url/token-usage/api/daily"                                                       # 期望 JSON：{"today":"YYYY-MM-DD","record":{...}}
Stop-Process -Id $proc.Id -Force
```

Expected: client.js 返回 200（内容为 `window.__ModuleLoader__.load` 包裹的 bundle，id 为 `@dsh-agent-toolkit/token-usage`）；API 返回 200 JSON。插件 inject 的 `storageDomain`/`tokenMeter`/`commands` 与可选 `webServer` 均由 `@deepseek-ai/dsh-base` 提供，全程无需 API key。

- [ ] **Step 4: 清理临时 profile**

```powershell
pnpm dsh plugin --profile tu-verify remove @dsh-agent-toolkit/token-usage   # workdir: deepseek-harness
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\profiles\tu-verify"
```

（`$DSH_HOME` 默认 `~/.dsh`；若环境变量另有设置，删 `$env:DSH_HOME\profiles\tu-verify`。）

---

### Task 5: 文档更新（AGENTS.md）+ 收尾提交

**Files:**
- Modify: `AGENTS.md`（两处，见 Step 1）

**Interfaces:**
- Consumes: Task 1–4 全部完成。
- Produces: AGENTS.md 与新包名、构建要求同步。

- [ ] **Step 1: 更新 AGENTS.md**

改动一——「开发命令」节第一行：

```
- 单测：`pnpm --filter token-usage test`；类型检查：`pnpm --filter token-usage typecheck`；agent-team 同（`pnpm --filter agent-team test` / `typecheck`）
- 客户端 bundle：`pnpm --filter token-usage bundle`（开发期 `pnpm --filter token-usage watch`）；agent-team 含浏览器半，改动后需 `pnpm --filter agent-team bundle`
```

改为（filter 换新包名；bundle 说明扩展为两半）：

```
- 单测：`pnpm --filter @dsh-agent-toolkit/token-usage test`；类型检查：`pnpm --filter @dsh-agent-toolkit/token-usage typecheck`；agent-team 同（`pnpm --filter agent-team test` / `typecheck`）
- 构建：`pnpm --filter @dsh-agent-toolkit/token-usage bundle` 同时产出 Node 半（lib/index.js，exports 入口）与浏览器半（lib/client.js）——token-usage 任何 src 改动后、进开发回路前都要跑（开发期 `pnpm --filter @dsh-agent-toolkit/token-usage watch`）；agent-team 含浏览器半，改动后需 `pnpm --filter agent-team bundle`
```

改动二——「目录结构」中 token-usage 行：

```
│   ├─ token-usage/      ← Token 用量统计（第一个实现，已建成）
```

改为：

```
│   ├─ token-usage/      ← Token 用量统计（包名 @dsh-agent-toolkit/token-usage；已建成；
│                           不发 npm，pnpm pack 产 tarball 经 dsh plugin add 安装）
```

- [ ] **Step 2: Commit**

```powershell
git add AGENTS.md
git commit -m "docs: AGENTS.md 同步 token-usage 改名与构建要求"
```

---

## 发布决策记录（已定）

| 决策点 | 结论 | 依据 |
|---|---|---|
| 渠道 | **不发布 npm**；本地 `pnpm pack` 手动产 tarball 交付 | 用户决定（2026-08-19） |
| npm 误发防线 | 保留 `"private": true` | 不阻碍 `pnpm pack`（已实测），挡住误 publish |
| 包名 | **`@dsh-agent-toolkit/token-usage`** | 用户决定；与仓库名呼应，scope 留足后续插件位 |
| 插件导出名 | 保持 `token-usage` 不变 | cordis 插件名独立于包名；不动 src |
| 版本 / License | 0.1.0 / MIT | 首个对外版本；与 dsh 主仓库一致 |
| Node 半构建 | tsdown 第二配置（非 tsc） | 复用现有管线；src 用 `.ts` 扩展名导入 + `allowImportingTsExtensions`，tsc emit 需改源码导入，违背"不动 src"约束 |
| devDeps 策略 | 保持 `link:` 锚定本地 monorepo checkout | 用户决定；类型基线与宿主源码严格一致（本仓库不配 CI，无需解决 CI 上的 link 解析） |
| GitHub 安装路径 | 不支持 | 需自包含 prepare + 用户 allowBuilds 授权；tarball 已覆盖 |
| CI | **不配**（GitHub Actions 等均无） | 用户决定（2026-08-19）；本地手动跑 test/typecheck/bundle/pack 核查 |
