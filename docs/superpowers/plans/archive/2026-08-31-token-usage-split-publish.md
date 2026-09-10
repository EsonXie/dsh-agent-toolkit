# token-usage 独立拆包与双包发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 token 用量模块从 `packages/toolkit` 拆为可独立安装发布的 dsh 插件 `@dsh-agent-toolkit/token-usage@0.3.0`，`dsh-agent-toolkit@0.1.0` 以 npm 依赖 + 函数级转发方式包含它，随后双包发布并 deprecate 旧版本。

**Architecture:** workspace 新增 `packages/usage`（完整 dsh 插件：Node 半 ESM + 浏览器半 lazy-CJS + 纯 ESM client-module 三产物）；toolkit 通过 `dependencies` 声明 + import 转发复用其 `setupUsage`/`setupUsageClient`，文件布局保持 `src/usage/`、`src/client/usage/` 使迁移为纯拷贝、零 import 改动。双装计量守卫经 `token_usage` 域新增 `meta` 表的 `meter_owner` 标记实现（域 version 保持 1，缺表即空表，已核实）。

**Tech Stack:** pnpm workspace、tsdown（三 entry）、vitest、schemastery、cordis。

**Spec:** `docs/superpowers/specs/2026-08-31-token-usage-split-publish-design.md`

## Global Constraints

- usage 包 npm 名 `@dsh-agent-toolkit/token-usage`，版本 `0.3.0`；toolkit 版本 `0.1.0`。发布顺序：usage 先，toolkit 后。
- 插件包四件套：命名导出 `name`/`inject`/`Config`/`apply`，**无 default export**；包结构照 `deepseek-harness/packages/acp/acp` 蓝本。
- `@deepseek-ai/dsh-storage-domain` 只做运行时值导入，**不进** dependencies/peerDependencies（宿主隐式提供，加依赖会双实例分裂）；devDependencies 一律 `link:` 指回 `deepseek-harness/`。
- 存储域 `token_usage` 的 `version` 保持 `1`（只加 `meta` 表，不 bump）。
- HTTP 路由前缀保持 `/dsh-agent-toolkit/api/usage/*` 不变。
- usage 浏览器半 inject = `['slots']`（已核实只消费 `ctx.slots`）。
- toolkit 的 cordis.yml 存量配置零破坏：`timezone`、`modules.usage` 配置项保留且语义不变。
- 所有可调参数进 Config schema，不硬编码；遵守现有代码注释风格（中文注释、说明"为什么"）。
- 任何 src 改动后跑 `pnpm --filter <pkg> test && pnpm --filter <pkg> typecheck && pnpm --filter <pkg> bundle`。
- 发布脚本不可在 CI/自动化里跑（含人工确认门禁）。

---

### Task 1: packages/usage 骨架与 Node 半迁移

**Files:**
- Create: `packages/usage/package.json`、`tsconfig.json`、`vitest.config.ts`、`tsdown.config.ts`、`cordis.patch.yml`、`src/index.ts`
- Copy（逐字节，不改 import）：`packages/toolkit/src/usage/*` → `packages/usage/src/usage/*`（11 个文件：index/aggregate/heatmap/render/store + 6 个测试）
- Copy（逐字节）：`packages/toolkit/src/shared/storage.ts`、`packages/toolkit/src/shared/webserver.ts` → `packages/usage/src/shared/`

**Interfaces:**
- Produces: `setupUsage(ctx: Context, config: { timezone: string }): void`（Task 2 起加第三参数 `owner: string`）；`tokenUsageDomain`（Task 2 起含 `meta` 表）；usage 包主入口四件套 `name`/`inject`/`Config`/`apply`。
- 布局不变式：`src/usage/index.ts` 里 `../shared/storage.ts`、`src/client/usage/*` 里 `../../usage/aggregate.ts` 等相对路径在两包中深度一致，故全部纯拷贝。

- [ ] **Step 1: 建目录与 package.json**

```powershell
New-Item -ItemType Directory packages\usage, packages\usage\src, packages\usage\src\usage, packages\usage\src\shared
```

`packages/usage/package.json`：

```json
{
  "name": "@dsh-agent-toolkit/token-usage",
  "version": "0.3.0",
  "description": "DeepSeek Harness plugin: per-day token usage statistics — 13-week heatmap, stacked daily chart, /token-usage command",
  "license": "MIT",
  "keywords": ["deepseek-harness", "dsh", "dsh-plugin", "token-usage"],
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./client-module": { "types": "./lib/client-module.d.ts", "default": "./lib/client-module.js" },
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
    "recharts": "^3.10.1",
    "zod": "^4.4.3"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "link:../../deepseek-harness/vendor/cordis",
    "@deepseek-ai/dsh-client-locale": "link:../../deepseek-harness/packages/client/locale",
    "@deepseek-ai/dsh-client-runtime": "link:../../deepseek-harness/packages/client/runtime",
    "@deepseek-ai/dsh-client-ui-primitives": "link:../../deepseek-harness/packages/client/ui-primitives",
    "@deepseek-ai/dsh-client-ui-sidebar": "link:../../deepseek-harness/packages/client/ui-sidebar",
    "@deepseek-ai/dsh-client-ui-slots": "link:../../deepseek-harness/packages/client/ui-slots",
    "@deepseek-ai/dsh-commands": "link:../../deepseek-harness/packages/interaction/commands",
    "@deepseek-ai/dsh-host-webserver": "link:../../deepseek-harness/packages/host/webserver",
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

- [ ] **Step 2: 拷贝 tsconfig/vitest 配置（与 toolkit 逐字节一致）**

```powershell
Copy-Item packages\toolkit\tsconfig.json packages\usage\tsconfig.json
Copy-Item packages\toolkit\vitest.config.ts packages\usage\vitest.config.ts
```

- [ ] **Step 3: 写 cordis.patch.yml 与插件入口 src/index.ts**

`packages/usage/cordis.patch.yml`：

```yaml
- insert:
    - id: '@dsh-agent-toolkit/token-usage'
      name: '@dsh-agent-toolkit/token-usage'
```

`packages/usage/src/index.ts`：

```ts
/** @dsh-agent-toolkit/token-usage 插件入口：per-day token 用量统计（/token-usage 命令 + JSON API + 侧边栏面板）。 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only 激活对应包对 cordis Context 的声明合并（inject 的 service 属性）。
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { setupUsage } from './usage/index.ts'

export const name = '@dsh-agent-toolkit/token-usage'

// 硬依赖服务全集。webServer 为可选服务（经 registerOptionalRoutes 惰性等待），不进 inject。
export const inject = ['storageDomain', 'tokenMeter', 'commands']

/** 插件配置输出型。 */
export interface Config {
  timezone: string
}

export const Config: z<unknown, Config> = z.object({
  timezone: z.string().default('Asia/Shanghai'),
}) as z<unknown, Config>

export function apply(ctx: Context, config: Config): void {
  setupUsage(ctx, { timezone: config.timezone })
}

// 供 dsh-agent-toolkit 函数级转发复用（见设计 spec「toolkit 集成方式」）。
export { setupUsage } from './usage/index.ts'
```

（`setupUsage` 重复导出是有意的：default 四件套的 import 与命名 re-export 各一处，TS 允许同绑定 re-export；若 typecheck 报冲突则删去顶部 import、改为 `import { setupUsage as setupUsageImpl }`。）

- [ ] **Step 4: 拷贝 Node 半源码与 shared 助手（纯拷贝）**

```powershell
Copy-Item packages\toolkit\src\usage\* packages\usage\src\usage\
Copy-Item packages\toolkit\src\shared\storage.ts, packages\toolkit\src\shared\webserver.ts packages\usage\src\shared\
```

- [ ] **Step 5: 写 tsdown.config.ts（Node 半 + client-module 两 entry；wrapped client 在 Task 3 补）**

`packages/usage/tsdown.config.ts`：从 toolkit 的配置平移，差异点——`ID = '@dsh-agent-toolkit/token-usage'`；删除 qrcode alias 与 `createRequire`（usage 不用 qrcode）；新增 client-module entry。完整内容：

```ts
/** @dsh-agent-toolkit/token-usage 构建配置：Node 半（lib/index.js，ESM）+ client-module（lib/client-module.js，纯 ESM，供 toolkit bundle 复用）。 */
import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/** 必须等于 package.json 的 name：client-modules 扫描以包名为 entry id。 */
const ID = '@dsh-agent-toolkit/token-usage'

/** Node 半：所有包依赖保持 external，由安装侧（profile）解析；只转译本地 src。 */
const nodeConfig = {
  name: `${ID}/node`,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, 'clsx', 'zod'],
  },
} satisfies UserConfig

/** 平台模块由 loader 模块表提供，保持 external（对照 dsh web/src/platform.ts + runtime 豁免）。 */
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

// Node 内建模块名（含 node: 前缀变体）：浏览器半命中即构建错误。
const NODE_BUILTINS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
])

/** 浏览器半共用插件：纯净度门禁 + CSS Modules 内联（与 toolkit 同规则）。 */
const clientPlugins = [{
  // 纯净度门禁：跨插件值导入即构建错误；协作走 cordis 服务/slot。
  name: 'dsh-client-bundle-purity',
  resolveId(source: string) {
    if (NODE_BUILTINS.has(source)) {
      throw new Error(`client bundle purity: "${source}" 是 Node 内建模块——浏览器半禁止引入`)
    }
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
      '}',
      `export default ${JSON.stringify(classMap)};`,
    ].join('\n')
  },
}]

/** client-module：纯 ESM，无 loader 包装，供 dsh-agent-toolkit 浏览器半 alwaysBundle 内联。 */
const clientModuleConfig = {
  name: `${ID}/client-module`,
  entry: { 'client-module': 'src/client/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'browser',
  dts: true,
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
  plugins: clientPlugins,
} satisfies UserConfig

export default [nodeConfig, clientModuleConfig]
```

注意：`src/client/index.ts` 此任务还不存在（Task 3 创建），本步 bundle 会因缺 entry 失败——先只跑 `test`/`typecheck`，bundle 验证放到 Task 3。若希望本步即可 bundle，可临时注释 clientModuleConfig（不推荐）。

- [ ] **Step 6: 安装依赖并跑迁移来的测试**

```powershell
pnpm install; pnpm --filter @dsh-agent-toolkit/token-usage test
```

预期：usage 6 个测试文件全绿（aggregate/heatmap/render/routes/smoke/store）。若 routes.test.ts 等因相对 import 失败，说明拷贝破坏了布局不变式，逐项核对。

- [ ] **Step 7: typecheck**

```powershell
pnpm --filter @dsh-agent-toolkit/token-usage typecheck
```

预期通过。若报缺类型包（如 client spec 里出现的 `@deepseek-ai/dsh-client-*`），在 devDependencies 补对应 `link:` 行后 `pnpm install` 重跑。

- [ ] **Step 8: 给插件入口补一个 smoke 测试**

`packages/usage/src/index.test.ts`：

```ts
import { expect, test } from 'vitest'
import { apply, Config, inject, name } from './index.ts'

test('插件入口导出四件套', () => {
  expect(name).toBe('@dsh-agent-toolkit/token-usage')
  expect(inject).toEqual(['storageDomain', 'tokenMeter', 'commands'])
  expect(typeof apply).toBe('function')
})

test('Config({}) 产出默认时区', () => {
  expect(Config({})).toEqual({ timezone: 'Asia/Shanghai' })
})
```

运行 `pnpm --filter @dsh-agent-toolkit/token-usage test`，预期全绿。

- [ ] **Step 9: Commit**

```powershell
git add packages/usage; git commit -m "feat: scaffold @dsh-agent-toolkit/token-usage 包并迁移 Node 半"
```

---

### Task 2: meter_owner 双装守卫（TDD）

**Files:**
- Modify: `packages/usage/src/usage/store.ts`（加 meta 表）
- Modify: `packages/usage/src/usage/index.ts`（守卫逻辑 + `owner` 参数）
- Modify: `packages/usage/src/index.ts`（apply 传 `name` 作 owner）
- Test: `packages/usage/src/usage/meter-owner.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `setupUsage`、`tokenUsageDomain`。
- Produces: `setupUsage(ctx: Context, config: { timezone: string }, owner: string): void`——toolkit（Task 5）以 `owner = 'dsh-agent-toolkit'` 调用；`tokenUsageDomain.tables` 新增 `meta: KvTable<string, { value: string }>`。

- [ ] **Step 1: 写失败测试**

`packages/usage/src/usage/meter-owner.test.ts`：

```ts
import { expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { setupUsage } from './index.ts'

/** Map 支撑的假存储域：按 table 名惰性建表，够守卫逻辑读写即可。 */
function makeCtx() {
  const tables = new Map<string, Map<string, unknown>>()
  const domain = {
    table: (name: string) => {
      let records = tables.get(name)
      if (records === undefined) { records = new Map(); tables.set(name, records) }
      return {
        get: (k: string) => records!.get(k),
        put: async (k: string, v: unknown) => { records!.set(k, v) },
        delete: async (k: string) => records!.delete(k),
      }
    },
    close: async () => {},
  }
  const listeners: unknown[] = []
  const disposers: (() => unknown)[] = []
  const warn = vi.fn()
  const ctx = {
    logger: { warn },
    tokenMeter: { estimateMessage: () => 0 },
    storageDomain: { open: () => Promise.resolve(domain) },
    effect: (fn: () => unknown) => { disposers.push(fn as () => unknown) },
    on: (_event: string, fn: unknown) => { listeners.push(fn) },
    commands: { register: vi.fn() },
    inject: () => {},
  }
  return { ctx: ctx as unknown as Context, tables, listeners, disposers, warn }
}

/** 等 domainReady/metering 微任务链落地。 */
const flush = () => new Promise((r) => setTimeout(r, 0))

test('meter_owner 空缺：占位并挂载采集监听', async () => {
  const { ctx, tables, listeners } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  expect(listeners).toHaveLength(1)
  expect(tables.get('meta')?.get('meter_owner')).toEqual({ value: 'pkg-a' })
})

test('meter_owner 已占用：不挂采集监听、warn 提示、命令仍注册', async () => {
  const { ctx, tables, listeners, warn } = makeCtx()
  tables.get // 预占：先建 meta 表再写入
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  const h2 = makeCtx()
  h2.tables.set('meta', tables.get('meta')!) // 共享同一存储介质
  // 用共享 domain 重建 h2 的 open
  const domain2 = {
    table: (name: string) => ({
      get: (k: string) => tables.get(name)?.get(k),
      put: async (k: string, v: unknown) => { let t = tables.get(name); if (!t) { t = new Map(); tables.set(name, t) } t.set(k, v) },
      delete: async (k: string) => tables.get(name)?.delete(k) ?? false,
    }),
    close: async () => {},
  }
  ;(h2.ctx as unknown as { storageDomain: unknown }).storageDomain = { open: () => Promise.resolve(domain2) }
  setupUsage(h2.ctx, { timezone: 'Asia/Shanghai' }, 'pkg-b')
  await flush()
  expect(h2.listeners).toHaveLength(0)
  expect(h2.warn).toHaveBeenCalledWith(expect.stringContaining('pkg-a'))
  expect((h2.ctx as unknown as { commands: { register: unknown } }).commands.register).toHaveBeenCalled()
})

test('占位方卸载：释放 meter_owner', async () => {
  const { ctx, tables, disposers } = makeCtx()
  setupUsage(ctx, { timezone: 'Asia/Shanghai' }, 'pkg-a')
  await flush()
  expect(tables.get('meta')?.get('meter_owner')).toEqual({ value: 'pkg-a' })
  for (const d of disposers) await d()
  expect(tables.get('meta')?.get('meter_owner')).toBeUndefined()
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
pnpm --filter @dsh-agent-toolkit/token-usage test -- meter-owner
```

预期：FAIL（`setupUsage` 只收 2 参、无 meta 表、无守卫）。

- [ ] **Step 3: store.ts 加 meta 表（version 保持 1）**

`packages/usage/src/usage/store.ts` 末尾替换 domain 声明：

```ts
/** meta 表单例标记的值形状（meter_owner 等）。 */
export const MetaRowSchema = z.object({ value: z.string() })

/** domain 名受 UNIT_NAME_RE 约束（^[a-z][a-z0-9_]*$），不允许连字符。 */
export const tokenUsageDomain = defineDomain({
  name: 'token_usage',
  // version 保持 1：加载侧缺表即空表（snapshot.tables[table] ?? {}），加 meta 表无需 bump。
  version: 1,
  tables: {
    daily: domainTable<string, DailyRecord>(DailyRecordSchema),
    meta: domainTable<string, { value: string }>(MetaRowSchema),
  },
})
```

- [ ] **Step 4: index.ts 加守卫**

`packages/usage/src/usage/index.ts` 改动点：

1. 签名：`export function setupUsage(ctx: Context, config: { timezone: string }, owner: string): void {`
2. 顶部加常量 `const METER_OWNER_KEY = 'meter_owner'`
3. `domainReady` 的 `.then` 里加 `meta = domain.table('meta') as KvTable<string, { value: string }>`（旁边声明 `let meta: KvTable<string, { value: string }> | undefined`）
4. `domainReady` 之后加计量所有权块：

```ts
  // 双装守卫：token_usage 域 meta 表 meter_owner 先到先得。已被他包占用时本实例
  // 跳过采集（不挂 session/event 监听），命令/路由/面板照常（读同一份数据）。
  let ownsMeter = false
  const meteringReady = domainReady.then(async () => {
    const existing = meta!.get(METER_OWNER_KEY)
    if (existing !== undefined) {
      ctx.logger.warn(`token 计量已由 ${existing.value} 挂载，本实例（${owner}）跳过采集；面板与命令为只读共用`)
      return false
    }
    await meta!.put(METER_OWNER_KEY, { value: owner })
    ownsMeter = true
    return true
  })
```

5. `openDomainSafely` 的 `beforeClose` 从 `() => tail.then(() => undefined, () => undefined)` 改为：

```ts
    () => tail.then(async () => {
      // 释放计量所有权（仅占位方）；失败不阻断 close。
      if (ownsMeter) await meta?.delete(METER_OWNER_KEY).catch(() => undefined)
    }, () => undefined),
```

6. `ctx.on('session/event', ...)` 包进门卫：

```ts
  void meteringReady.then((metering) => {
    if (!metering) return
    ctx.on('session/event', (session, event) => {
      // ……原有监听体不变……
    })
  })
```

（原监听体内 `tail`/`domainReady` 引用不变；守卫失败时不挂监听，`tail` 恒为空链。）

7. `packages/usage/src/index.ts` 的 apply 改传 owner：`setupUsage(ctx, { timezone: config.timezone }, name)`。

- [ ] **Step 5: 跑测试确认全绿**

```powershell
pnpm --filter @dsh-agent-toolkit/token-usage test
```

预期：meter-owner 3 个新测试 + 存量测试全绿。注意 routes.test.ts 的 `makeCtx` 假 domain `table()` 对所有名字返回同一假表，守卫会读到 `get() === undefined` → 正常占位，不受影响。

- [ ] **Step 6: typecheck + commit**

```powershell
pnpm --filter @dsh-agent-toolkit/token-usage typecheck
git add packages/usage; git commit -m "feat: token-usage 双装计量守卫（meter_owner 先到先得）"
```

---

### Task 3: usage 浏览器半迁移 + wrapped client 入口

**Files:**
- Create: `packages/usage/src/client/index.ts`
- Copy（纯拷贝）：`packages/toolkit/src/client/usage/*` → `packages/usage/src/client/usage/*`（12 个文件）
- Copy（纯拷贝）：`packages/toolkit/src/client/shared/entry.tsx`、`entry.module.css`、`load-state.ts`、`entry.spec.tsx` → `packages/usage/src/client/shared/`
- Modify: `packages/usage/tsdown.config.ts`（追加 wrapped client entry）

**Interfaces:**
- Consumes: Task 1 的布局不变式（`../shared/entry.tsx`、`../../usage/aggregate.ts` 深度一致）。
- Produces: `setupUsageClient(ctx: Context): void`（经主入口 re-export，同时由 client-module/lib/client.js 两产物承载）；浏览器半 `inject = ['slots']`。

- [ ] **Step 1: 拷贝浏览器半源码**

```powershell
New-Item -ItemType Directory packages\usage\src\client, packages\usage\src\client\usage, packages\usage\src\client\shared
Copy-Item packages\toolkit\src\client\usage\* packages\usage\src\client\usage\
Copy-Item packages\toolkit\src\client\shared\* packages\usage\src\client\shared\
```

- [ ] **Step 2: 写浏览器半入口**

`packages/usage/src/client/index.ts`：

```ts
/** @dsh-agent-toolkit/token-usage 浏览器半：注册「Token 用量」侧边栏底栏入口。 */
import type { Context } from '@deepseek-ai/cordis'
import { setupUsageClient } from './usage/index.ts'

export const inject = ['slots']

export function apply(ctx: Context): void {
  setupUsageClient(ctx)
}

// 供 dsh-agent-toolkit 浏览器半 bundle 复用（client-module 入口）。
export { setupUsageClient } from './usage/index.ts'
```

- [ ] **Step 3: tsdown 追加 wrapped client entry**

`packages/usage/tsdown.config.ts` 在 `clientModuleConfig` 后追加（复用 `CLIENT_EXTERNALS`/`clientPlugins`，与 toolkit 的 clientConfig 同构）：

```ts
/** 浏览器半：lazy-CJS factory，由 dsh client-modules 装载（bundle URL /plugins/<id>/client.js）。 */
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
  plugins: clientPlugins,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} satisfies UserConfig

export default [nodeConfig, clientModuleConfig, clientConfig]
```

- [ ] **Step 4: test + typecheck + bundle 三连**

```powershell
pnpm --filter @dsh-agent-toolkit/token-usage test
pnpm --filter @dsh-agent-toolkit/token-usage typecheck
pnpm --filter @dsh-agent-toolkit/token-usage bundle
```

预期：全绿；`lib/` 产出 `index.js`/`index.d.ts`/`client-module.js`/`client-module.d.ts`/`client.js`（+ sourcemap）。检查 `lib/client.js` 开头含 `window.__ModuleLoader__.load({ id: '@dsh-agent-toolkit/token-usage'`。

- [ ] **Step 5: Commit**

```powershell
git add packages/usage; git commit -m "feat: token-usage 浏览器半迁移 + client-module/wrapped client 双产物"
```

---

### Task 4: usage README 与 LICENSE

**Files:**
- Create: `packages/usage/README.md`、`packages/usage/LICENSE`

- [ ] **Step 1: 写 LICENSE（MIT，与 toolkit 一致）**

```text
MIT License

Copyright (c) 2026 EsonXie

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

（toolkit 的 LICENSE 在 Task 6 用同文本同版权行。）

- [ ] **Step 2: 写 README.md（npm 页面主文档）**

骨架（写全文，不留 TODO）：

```markdown
# @dsh-agent-toolkit/token-usage

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件：按日/按小时计量 token 用量。

- 13 周活动热力图 + 单日堆叠图（按模型/按项目/压缩单列），侧边栏底栏「Token 用量」打开
- `/token-usage [YYYY-MM-DD]` 命令：今日 + 近 7 日，或指定日期
- JSON API：`/dsh-agent-toolkit/api/usage/daily?date=`、`/dsh-agent-toolkit/api/usage/range?days=`（web 模式）
- 用量缺失的样本经 tokenMeter 启发式估算，估算量单列

## 安装

​```bash
dsh plugin add @dsh-agent-toolkit/token-usage
​```

包自带 `cordis.patch.yml`（bundles 层），装进 profile 后自动激活。

> **与 dsh-agent-toolkit 二选一**：`dsh-agent-toolkit` 已内置本插件全部功能（Agent 注册表/分层提示词/委派/飞书 bots + token 用量）。
> 两者同时安装时计量先到先得（后到者只读共用数据），但仍建议只装其一。

## 配置

​```yaml
- id: '@dsh-agent-toolkit/token-usage'
  config:
    timezone: Asia/Shanghai   # 默认值；按日/按小时聚合的时区
​```

修改配置触发 HMR 热替换，无需重启。

## 运行前提

- 宿主注入服务：`storageDomain`、`tokenMeter`、`commands`（`webServer` 可选，headless/CLI 下 API 自动不注册）。
- peer dependency：`@deepseek-ai/cordis` ^4。

## 从 0.2.x 升级

0.3.0 起本包重写为 `dsh-agent-toolkit` workspace 的用量模块，存储域 `token_usage` 不变，历史数据保留。
0.1.x/0.2.x 已废弃（deprecated）。

## License

MIT
```

- [ ] **Step 3: pack 冒烟（不发布）**

```powershell
Set-Location packages\usage; pnpm pack; tar -tf dsh-agent-toolkit-token-usage-0.3.0.tgz; Set-Location ..\..
```

预期含：`package/package.json`、`package/cordis.patch.yml`、`package/README.md`、`package/LICENSE`、`package/lib/index.js`、`index.d.ts`、`client.js`、`client-module.js`、`client-module.d.ts`；不含 `src/`、`tsconfig`、`*config.ts`。删 tarball：`Remove-Item packages\usage\*.tgz`。

- [ ] **Step 4: Commit**

```powershell
git add packages/usage/README.md packages/usage/LICENSE; git commit -m "docs: token-usage README 与 MIT LICENSE"
```

---

### Task 5: toolkit 集成改造

**Files:**
- Modify: `packages/toolkit/package.json`（加依赖、瘦 dependencies）
- Modify: `packages/toolkit/src/index.ts:16,131`（import 与调用）
- Modify: `packages/toolkit/src/client/index.ts:6`（import）
- Modify: `packages/toolkit/tsdown.config.ts:23`（neverBundle）
- Modify: `packages/toolkit/tsconfig.json`（paths）
- Delete: `packages/toolkit/src/usage/`、`packages/toolkit/src/client/usage/`

**Interfaces:**
- Consumes: `setupUsage(ctx, config, owner)`、`setupUsageClient(ctx)`（Task 2/3）。
- Produces: toolkit 对外行为不变（配置项/命令/路由/面板全部保留）。

- [ ] **Step 1: package.json 加 workspace 依赖**

dependencies 块加一行（保持字母序，放 `@deepseek-ai/schemastery` 前）：

```json
    "@dsh-agent-toolkit/token-usage": "workspace:^",
```

然后 `pnpm install`。

- [ ] **Step 2: 改 Node 半 import 与调用**

`packages/toolkit/src/index.ts`：

- 第 16 行 `import { setupUsage } from './usage/index.ts'` → `import { setupUsage } from '@dsh-agent-toolkit/token-usage'`
- 第 131 行 `if (config.modules.usage) setupUsage(ctx, { timezone: config.timezone })` → `if (config.modules.usage) setupUsage(ctx, { timezone: config.timezone }, name)`

- [ ] **Step 3: 改浏览器半 import**

`packages/toolkit/src/client/index.ts` 第 6 行：

```ts
import { setupUsageClient } from '@dsh-agent-toolkit/token-usage/client-module'
```

- [ ] **Step 4: tsconfig 加 paths（typecheck 不依赖 usage 先构建）**

`packages/toolkit/tsconfig.json` 的 `compilerOptions` 内加：

```json
    "paths": {
      "@dsh-agent-toolkit/token-usage": ["../usage/src/index.ts"],
      "@dsh-agent-toolkit/token-usage/client-module": ["../usage/src/client/index.ts"]
    },
```

- [ ] **Step 5: tsdown neverBundle 加 usage 包（Node 半保持 external）**

`packages/toolkit/tsdown.config.ts` 第 23 行：

```ts
    neverBundle: [/^@deepseek-ai\//, '@dsh-agent-toolkit/token-usage', '@larksuiteoapi/node-sdk', 'clsx', 'zod'],
```

浏览器半不改：`@dsh-agent-toolkit/token-usage/client-module` 命中 alwaysBundle 自动内联；纯净度门禁只拦 `@deepseek-ai/`。

- [ ] **Step 6: 先跑测试确认集成等价（删除前）**

```powershell
pnpm --filter dsh-agent-toolkit test; pnpm --filter dsh-agent-toolkit typecheck
```

预期：361 测试全绿（index.test.ts 的假 ctx 不感知 setupUsage 来源；token_usage 域照常打开、命令照常注册）。此时旧 `src/usage` 已无人引用。

- [ ] **Step 7: 删除旧模块并核对依赖瘦身**

```powershell
Remove-Item -Recurse packages\toolkit\src\usage, packages\toolkit\src\client\usage
rg -l "from 'recharts'|from 'clsx'" packages\toolkit\src
```

- recharts：预期无残留引用 → 从 `packages/toolkit/package.json` dependencies 删 `"recharts": "^3.10.1"`。
- clsx：若仍有引用（bots/agents 的 client 可能用）则保留，无则删。
- 删完 `pnpm install` 后三连：`pnpm --filter dsh-agent-toolkit test; pnpm --filter dsh-agent-toolkit typecheck; pnpm --filter dsh-agent-toolkit bundle`。

预期：全绿；toolkit 测试数 = 361 − 迁走的 usage 测试数；`lib/client.js` 体积含 recharts（usage 面板随 client-module 内联）。记录两边测试数，确认总覆盖守恒（usage 包 + toolkit 包 ≥ 原 361 − 纯搬迁重复）。

- [ ] **Step 8: 开发回路冒烟（人工）**

```powershell
pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml
```

人工核对四处：Agents 面板、委派卡、消息机器人面板、Token 用量面板（热力图/堆叠图渲染、`/token-usage` 命令）。

- [ ] **Step 9: Commit**

```powershell
git add packages/toolkit pnpm-lock.yaml; git commit -m "refactor: toolkit 经 npm 依赖转发集成 token-usage 包"
```

---

### Task 6: 文档与 toolkit LICENSE

**Files:**
- Create: `packages/toolkit/LICENSE`
- Modify: `packages/toolkit/README.md`、`docs/usage/token-usage.md`、`docs/usage/README.md`、`AGENTS.md`

- [ ] **Step 1: 写 `packages/toolkit/LICENSE`**

内容与 Task 4 的 MIT 文本逐字节相同。

- [ ] **Step 2: 更新 `packages/toolkit/README.md`**

- 「Token 用量」功能条加一句：「由依赖包 [`@dsh-agent-toolkit/token-usage`](https://www.npmjs.com/package/@dsh-agent-toolkit/token-usage) 提供，可独立安装。」
- 「运行前提」加一条：「安装时 npm 会自动带入依赖 `@dsh-agent-toolkit/token-usage`；两者**不要**再单独并列安装（计量先到先得，见该包 README）。」

- [ ] **Step 3: 更新 `docs/usage/token-usage.md`**

开头加「独立安装」节：只要用量统计可 `dsh plugin add @dsh-agent-toolkit/token-usage` 单独安装；功能/数据/路由完全一致。

- [ ] **Step 4: 更新 `docs/usage/README.md`**

存储域表 `token_usage` 行备注「由依赖包 @dsh-agent-toolkit/token-usage 打开」。

- [ ] **Step 5: 更新根 `AGENTS.md`**

- 目录结构：`packages/` 下加 `usage/` 条目（npm 包名、三产物、发布命令）。
- 开发命令：测试/构建命令改为两包各跑（`pnpm --filter @dsh-agent-toolkit/token-usage ...` + `pnpm --filter dsh-agent-toolkit ...`）。
- 发布：`scripts/publish-toolkit.ps1` → `scripts/publish.ps1 -Package <name>`（Task 7 落地后名称以此为准）。
- 待办：移除「deprecate prompt-stack/project-bot」（两包从未发布，已核实 npm 404）；保留 token-usage `<0.3.0` deprecate 项；移除「补 LICENSE」项（本计划落地）。
- 「合并前的四包代码快照」段落补一句：token-usage 已 2026-08-31 拆回独立包（`packages/usage`）。

- [ ] **Step 6: Commit**

```powershell
git add packages/toolkit/LICENSE packages/toolkit/README.md docs/usage AGENTS.md
git commit -m "docs: 双包发布文档与 LICENSE 更新"
```

---

### Task 7: publish 脚本泛化

**Files:**
- Create: `scripts/publish.ps1`
- Delete: `scripts/publish-toolkit.ps1`
- Modify: `AGENTS.md`（脚本名引用，若 Task 6 未覆盖）

**Interfaces:**
- Produces: `scripts/publish.ps1 -Package <'dsh-agent-toolkit' | '@dsh-agent-toolkit/token-usage'> [-SkipTests]`。

- [ ] **Step 1: 写 `scripts/publish.ps1`（以旧脚本为底，参数化三处：包目录、tgz 文件名、必需文件清单；恢复 README/LICENSE 核查）**

```powershell
#requires -Version 5.1
<#
.SYNOPSIS
  手动发布 workspace 内插件包到 npm 官方 registry。
.DESCRIPTION
  门禁链：npm 登录检查 → 版本冲突检查 → test → typecheck → pack 内容核查 → 人工确认 → publish → npm view 验证。
  prepack 钩子会在 pack/publish 前自动重跑 bundle。
.EXAMPLE
  powershell -File scripts/publish.ps1 -Package '@dsh-agent-toolkit/token-usage'
  powershell -File scripts/publish.ps1 -Package dsh-agent-toolkit -SkipTests
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('dsh-agent-toolkit', '@dsh-agent-toolkit/token-usage')]
  [string]$Package,
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$Registry = 'https://registry.npmjs.org'   # 必须钉官方源（本机默认 registry 是 npmmirror 镜像）
$SubDir = @{ 'dsh-agent-toolkit' = 'toolkit'; '@dsh-agent-toolkit/token-usage' = 'usage' }[$Package]
$PkgDir = Join-Path (Join-Path $PSScriptRoot '..\packages') $SubDir | Resolve-Path

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

$pkg = Get-Content (Join-Path $PkgDir 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
Step "准备发布 $Package@$version"

# 1. npm 登录检查（granular token 或交互登录均可）
$user = npm whoami --registry $Registry 2>$null
if ($LASTEXITCODE -ne 0 -or -not $user) {
  throw "未登录官方 registry。请先执行: npm login --registry $Registry（或配置 granular access token 到 `$env:USERPROFILE\.npmrc）"
}
Write-Host "npm 用户: $user"

# 2. 版本冲突检查（npm 版本不可撤回）
$ErrorActionPreference = 'Continue'  # PS 5.1: EAP=Stop 下原生命令的 stderr（如 E404）会误抛终止错误，故这里先降级跑 2 步检查 404
npm view "$Package@$version" version --registry $Registry 2>$null | Out-Null
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -eq 0) { throw "$Package@$version 已存在于 npm。请先 bump package.json 版本号再发布。" }
Write-Host "版本 $version 尚未发布，可发布"

# 3. 测试与类型检查
if (-not $SkipTests) {
  Step '测试与类型检查'
  pnpm --filter $Package test
  if ($LASTEXITCODE -ne 0) { throw '测试失败，中止发布' }
  pnpm --filter $Package typecheck
  if ($LASTEXITCODE -ne 0) { throw '类型检查失败，中止发布' }
}

# 4. pack 内容核查（prepack 自动重跑 bundle）
Step 'pack 内容核查'
Push-Location $PkgDir
try {
  pnpm pack
  if ($LASTEXITCODE -ne 0) { throw 'pnpm pack 失败' }
  $tgz = ($Package -replace '^@', '' -replace '/', '-') + "-$version.tgz"
  $entries = tar -tf $tgz
  $required = @(
    'package/package.json', 'package/cordis.patch.yml', 'package/README.md', 'package/LICENSE',
    'package/lib/index.js', 'package/lib/index.d.ts', 'package/lib/client.js'
  )
  if ($Package -eq '@dsh-agent-toolkit/token-usage') {
    $required += 'package/lib/client-module.js', 'package/lib/client-module.d.ts'
  }
  foreach ($r in $required) {
    if ($entries -notcontains $r) { throw "tarball 缺少必需文件: $r" }
  }
  $forbidden = $entries | Where-Object {
    $_ -match '^package/(src|tests|node_modules)/' -or
    $_ -match 'tsconfig|tsdown\.config|vitest\.config'
  }
  if ($forbidden) { throw "tarball 含违禁文件: $($forbidden -join ', ')" }
  Write-Host "tarball 内容核查通过（$($entries.Count) 项）"
}
finally { Pop-Location }

# 5. 人工确认 + 发布
Step '发布'
$confirm = Read-Host "即将把 $Package@$version 发布到 npm（不可撤回）。输入 yes 继续"
if ($confirm -ne 'yes') { throw '已取消发布' }
Push-Location $PkgDir
try {
  # 若账号要求 2FA，npm 会在此交互式提示输入 OTP
  pnpm publish --no-git-checks --registry $Registry
  if ($LASTEXITCODE -ne 0) { throw 'pnpm publish 失败，见上方错误输出' }
}
finally { Pop-Location }

# 6. 发布验证
Step '发布验证'
$ErrorActionPreference = 'Continue'  # registry 同步可能有延迟，E404 的 stderr 在 EAP=Stop 下会误抛终止错误
$got = npm view "$Package@$version" version --registry $Registry 2>$null
$ErrorActionPreference = 'Stop'
if ($got -ne $version) {
  Write-Host "npm view 暂未取到 $version——registry 同步可能有延迟，请稍后手动复查：" -ForegroundColor Yellow
  Write-Host "  npm view $Package --registry $Registry"
  exit 0
}
Write-Host "`n发布成功: $Package@$version" -ForegroundColor Green
Write-Host "安装验证: dsh plugin --profile web add $Package"
```

- [ ] **Step 2: 演练（跑到人工确认处取消）**

```powershell
powershell -File scripts\publish.ps1 -Package '@dsh-agent-toolkit/token-usage' -SkipTests
```

预期：登录/版本冲突检查通过 → pack 核查通过（含 README/LICENSE/client-module 断言）→ 人工确认提示处输入 `no` 中止。删残留 tarball：`Remove-Item packages\usage\*.tgz`。

- [ ] **Step 3: 删旧脚本并 commit**

```powershell
Remove-Item scripts\publish-toolkit.ps1
git add scripts AGENTS.md; git commit -m "chore: publish 脚本泛化为 publish.ps1 -Package"
```

---

### Task 8: 发布执行（人工门禁，不自动化）

**Files:** 无代码改动；发布与 npm 操作。

- [ ] **Step 1: 全量终验**

```powershell
pnpm install
pnpm --filter @dsh-agent-toolkit/token-usage test; pnpm --filter @dsh-agent-toolkit/token-usage typecheck; pnpm --filter @dsh-agent-toolkit/token-usage bundle
pnpm --filter dsh-agent-toolkit test; pnpm --filter dsh-agent-toolkit typecheck; pnpm --filter dsh-agent-toolkit bundle
```

- [ ] **Step 2: 发布 usage 0.3.0**

```powershell
powershell -File scripts\publish.ps1 -Package '@dsh-agent-toolkit/token-usage' -SkipTests
```

- [ ] **Step 3: 发布 toolkit 0.1.0**

```powershell
powershell -File scripts\publish.ps1 -Package dsh-agent-toolkit -SkipTests
```

（toolkit 的 `workspace:^` 在 publish 时被 pnpm 转为 `^0.3.0`——发布后 `npm view dsh-agent-toolkit dependencies` 核对。）

- [ ] **Step 4: deprecate 旧版本（人工执行）**

```powershell
npm deprecate '@dsh-agent-toolkit/token-usage@<0.3.0' "0.3.0 起本包已重写为 dsh-agent-toolkit 的用量模块并可独立安装；0.1.x/0.2.x 不再维护。" --registry https://registry.npmjs.org
```

- [ ] **Step 5: 安装验证（真实 profile）**

```powershell
pnpm dsh plugin --profile web add @dsh-agent-toolkit/token-usage   # 独立安装：面板 + /token-usage 可用
pnpm dsh plugin --profile web add dsh-agent-toolkit                # 集成安装：五功能回归
```

- [ ] **Step 6: push**

```powershell
git push -u origin master   # 或当前分支名
```

---

## Self-Review 记录

- Spec 覆盖：拆包（T1/T3）、守卫（T2）、README/LICENSE（T4/T6）、toolkit 集成（T5）、文档/AGENTS.md（T6）、publish 脚本（T7）、发布与 deprecate（T8）——spec 各节均有对应任务。
- 已核实事实：域 version 不加表不 bump（`snapshot.tables[table] ?? {}`）；usage client 只消费 `ctx.slots`；迁移文件相对 import 深度一致（纯拷贝）；`dsh-agent-toolkit` npm 404 未发布、`@dsh-agent-toolkit/token-usage` 在 npm 有 0.1.0/0.2.0、另两个 scoped 包从未发布。
- 已知风险（执行时验证）：scoped 包名的 client-modules bundle URL（`/plugins/@dsh-agent-toolkit/token-usage/client.js`）需宿主支持，Task 3 后在开发回路确认；`pnpm publish` 对 `workspace:^` 的转换在 Task 8 Step 3 核对。
