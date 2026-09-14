# 飞书 /ls 渲染升级（树形连接符 + 类型图标 + 文件大小）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** /ls 单层罗列升级为「树形连接符（├──/└──）+ 类型图标 + 文件大小」渲染；递归搜索命中升级为「图标 + 路径 + 大小」；目录去 `/` 后缀（📁 表意）。

**Architecture:** 只改 `ls-command.ts`（渠道无关核心）：`LsEntry` 加 `size?`/`link?`，排序截断后对 ≤100 条展示条目 `stat` 补大小（失败静默）；新增 `formatSize`/`iconForEntry` 助手；`formatLsText` 换渲染。`inbound.ts` 仅改 HELP_TEXT 一行。护栏、搜索遍历、接线不动。

**Tech Stack:** TypeScript ESM（仓库约定 `.ts` 扩展名相对导入）、vitest。

**Spec:** `docs/superpowers/specs/2026-09-11-feishu-ls-command-design.md`（2026-09-14 修订）

## Global Constraints

- 每个 Task 的 commit 只 stage 本 Task 触及的文件；commit message 风格 `feat(toolkit): …` / `docs: …`。
- **单文件测试命令（本环境已验证，勿用计划外形式）**：工作目录 `packages/toolkit` 下 `pnpm exec vitest run src/channels/<file>.test.ts`（exit 0 = 通过）。`pnpm --filter dsh-agent-toolkit exec vitest run ...` 在本环境会二次执行导致 exit 1，禁用。全量 `pnpm --filter dsh-agent-toolkit test`、类型 `pnpm --filter dsh-agent-toolkit typecheck`、构建 `pnpm --filter dsh-agent-toolkit bundle` 从仓库根跑（--filter 形式正常）。
- 文件末尾恰好一个换行；禁止无注释 `any`。
- 已知 pre-existing flake：`inbound.test.ts › /switch 边界` 约 2% 概率失败（randomUUID 全数字前缀撞数值分支），单发失败重跑即可，不要"修"它。
- 渲染基准事实（测试断言依赖）：fixture 中 `README.md` / `notes.md` / `.hidden` / `zeta.md` 内容为 `x` → 1 B；`docs/report.md` 内容 `# 报告\n` → 9 B（'#' 1 + 空格 1 + '报告' 6 + '\n' 1）。`.md` → 图标 📝。
- Task 1 落地后 inbound.test.ts 旧断言（`docs/` 等）必然失败，已在 Task 1 同步更新——两个文件同一个 commit。

---

### Task 1: ls-command 渲染升级（图标 + 大小 + 树形连接符）与全部测试同步

**Files:**
- Modify: `packages/toolkit/src/channels/ls-command.ts`
- Test: `packages/toolkit/src/channels/ls-command.test.ts`
- Modify: `packages/toolkit/src/channels/inbound.ts`（仅 HELP_TEXT 一行）
- Test: `packages/toolkit/src/channels/inbound.test.ts`（仅 /ls 用例断言）

**Interfaces:**
- Consumes: 现有 `listProjectDir` / `searchProjectTree` / `formatLsText` / `lsRejectText` / `resolveLsDir` / `capEntries`（签名与护栏语义不变）。
- Produces（签名不变、类型加宽）:
  - `LsEntry = { name: string; dir: boolean; size?: number; link?: boolean }`（`size` 仅普通文件、字节数；`link: true` 仅单层模式的符号链接条目）
  - `formatSize(bytes: number): string`（`318 B` / `1.0 KB` / `2.4 KB` / `15.5 MB` / `1.5 GB`；1024 进制，KB 起固定一位小数）
  - `iconForEntry(name: string, dir: boolean, link: boolean): string`（🔗 链接 > 📁 目录 > 扩展名映射 > 📄 默认）
  - `formatLsText` 渲染新格式（单层 `├── `/`└── ` 前缀，搜索无前缀；文件带 `  <大小>` 后缀，名称与大小间两个空格）

- [ ] **Step 1: 改测试（先红）**

`ls-command.test.ts` 的 import 行替换为：

```ts
import { formatLsText, formatSize, iconForEntry, listProjectDir, LS_MAX_ENTRIES, lsRejectText, searchProjectTree } from './ls-command.ts'
```

`describe('listProjectDir')` 前两个用例整体替换为：

```ts
  test('单层混合：目录在前，隐藏文件照列，按名称排序，文件带大小', async () => {
    const res = await listProjectDir(root, '.')
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries).toEqual([
      { name: 'docs', dir: true },
      { name: 'empty', dir: true },
      { name: '.hidden', dir: false, size: 1 },
      { name: 'README.md', dir: false, size: 1 },
      { name: 'zeta.md', dir: false, size: 1 },
    ])
    expect(res.truncated).toBeNull()
  })

  test('子目录罗列', async () => {
    const res = await listProjectDir(root, 'docs')
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries).toEqual([
      { name: 'sub', dir: true },
      { name: 'report.md', dir: false, size: 9 },
    ])
  })
```

截断用例在 `expect(res.remaining).toBe(7)` 前加一行：

```ts
      expect(res.entries[0]).toEqual({ name: 'f000.txt', dir: false, size: 1 })
```

`describe('searchProjectTree')` 三处 entries 断言替换为：

```ts
    expect(res.entries).toEqual([{ name: 'docs/report.md', dir: false, size: 9 }])
```
```ts
    expect(res.entries).toEqual([{ name: 'docs/sub', dir: true }])
```
```ts
    expect(res.entries).toEqual([
      { name: 'docs/report.md', dir: false, size: 9 },
      { name: 'docs/sub/notes.md', dir: false, size: 1 },
    ])
```

符号链接用例在 `expect(await listProjectDir(root, 'linkdir')).toEqual(...)` 之前加单层链接条目标记断言：

```ts
      const listed = await listProjectDir(root, '.')
      if (!listed.ok) throw new Error('unreachable')
      expect(listed.entries).toContainEqual({ name: 'linkdir', dir: false, link: true })
```

`describe('formatLsText / lsRejectText')` 的第一个用例（单层渲染）与第三个用例（搜索渲染）整体替换为：

```ts
  test('单层渲染：树形连接符（末条 └──）+ 图标 + 大小 + 截断提示', () => {
    const text = formatLsText({ ok: true, entries: [
      { name: 'docs', dir: true },
      { name: 'a.md', dir: false, size: 2451 },
      { name: 'linkdir', dir: false, link: true },
    ], truncated: 'cap', remaining: 5 }, '.', undefined)
    expect(text).toBe('项目根目录：\n├── 📁 docs\n├── 📝 a.md  2.4 KB\n└── 🔗 linkdir\n…还有 5 条，用 /ls <子目录> 细化')
  })
```

```ts
  test('搜索渲染：图标 + 路径 + 大小（无连接符）与截断提示', () => {
    expect(formatLsText({ ok: true, entries: [{ name: 'docs/report.md', dir: false, size: 2451 }], truncated: null, remaining: 0 }, '.', 'report'))
      .toBe('「report」的匹配条目（项目根）：\n📝 docs/report.md  2.4 KB')
    const entries = Array.from({ length: LS_MAX_ENTRIES }, (_, i) => ({ name: `f${i}`, dir: false }))
    expect(formatLsText({ ok: true, entries, truncated: 'walk', remaining: 0 }, '.', 'f'))
      .toContain('…已截断，用更精确的关键字或更小的目录细化')
  })
```

文件末尾追加两个新 describe：

```ts
describe('formatSize', () => {
  test('档位：B 整数、KB 起固定一位小数', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(318)).toBe('318 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(2451)).toBe('2.4 KB')
    expect(formatSize(16252928)).toBe('15.5 MB')
    expect(formatSize(1610612736)).toBe('1.5 GB')
  })
})

describe('iconForEntry', () => {
  test('目录/符号链接/扩展名映射/大小写不敏感/默认', () => {
    expect(iconForEntry('docs', true, false)).toBe('📁')
    expect(iconForEntry('linkdir', false, true)).toBe('🔗')
    expect(iconForEntry('README.MD', false, false)).toBe('📝')
    expect(iconForEntry('logo.PNG', false, false)).toBe('🖼️')
    expect(iconForEntry('a.zip', false, false)).toBe('📦')
    expect(iconForEntry('a.ts', false, false)).toBe('📜')
    expect(iconForEntry('cordis.yml', false, false)).toBe('⚙️')
    expect(iconForEntry('noext', false, false)).toBe('📄')
  })
})
```

`inbound.test.ts` 的 `describe('/ls 指令')` 内三处断言替换（其余用例不动）：

无参用例中 `expect(text).toContain('docs/')` 与 `expect(text).toContain('README.md')` 两行替换为：

```ts
    expect(text).toContain('├── 📁 docs')
    expect(text).toContain('└── 📝 README.md  1 B')
```

有参用例的 waitFor 断言替换为：

```ts
    await vi.waitFor(() => {
      expect(rec.notices.some((n) => n.includes('├── 📁 sub') && n.includes('└── 📝 report.md  9 B'))).toBe(true)
    })
```

递归搜索用例的 waitFor 断言替换为：

```ts
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('📝 docs/sub/notes.md  1 B'))).toBe(true) })
```

- [ ] **Step 2: 跑测试确认失败**

Run（工作目录 `packages/toolkit`）: `pnpm exec vitest run src/channels/ls-command.test.ts`
Expected: FAIL（formatSize/iconForEntry 未导出 + 渲染断言不符）

- [ ] **Step 3: 实现**

`ls-command.ts` 修改（文件头注释同步更新）：

文件头第一行改为：

```ts
/** /ls 指令的目录罗列与递归名称搜索：单层树形渲染（连接符 + 类型图标 + 文件大小）+ 关键字子树过滤（不追随符号链接）。 */
```

import 行补 `stat`：

```ts
import { readdir, stat } from 'node:fs/promises'
```

`LsEntry` 替换为：

```ts
export interface LsEntry {
  /** 单层模式为条目名；搜索模式为相对项目根的路径（posix 分隔）。 */
  name: string
  dir: boolean
  /** 仅普通文件有值（字节）；目录与符号链接条目无。截断后对展示条目 stat 补全，单条失败静默略过。 */
  size?: number
  /** true = 符号链接条目（仅单层模式会列出；不追随、不显示大小）。 */
  link?: boolean
}
```

`capEntries` 之后插入图标与大小助手：

```ts
/** 文件扩展名 → 类型图标（不分大小写）；未命中用 📄。 */
const ICON_BY_EXT: Record<string, string> = {
  md: '📝', markdown: '📝', txt: '📝',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', ico: '🖼️', bmp: '🖼️',
  zip: '📦', tar: '📦', gz: '📦', tgz: '📦', '7z': '📦', rar: '📦',
  mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬',
  mp3: '🎵', wav: '🎵', flac: '🎵', m4a: '🎵', ogg: '🎵',
  csv: '📊', xlsx: '📊', xls: '📊',
  ts: '📜', tsx: '📜', js: '📜', jsx: '📜', mjs: '📜', cjs: '📜', py: '📜', java: '📜', go: '📜', rs: '📜',
  c: '📜', cc: '📜', cpp: '📜', h: '📜', hpp: '📜', cs: '📜', sh: '📜', ps1: '📜', bat: '📜',
  vue: '📜', html: '📜', css: '📜', scss: '📜',
  json: '⚙️', yaml: '⚙️', yml: '⚙️', toml: '⚙️', xml: '⚙️', ini: '⚙️', env: '⚙️',
  pdf: '📕',
}

/** 条目 → 类型图标：符号链接 🔗、目录 📁、文件按扩展名映射、默认 📄。 */
export function iconForEntry(name: string, dir: boolean, link: boolean): string {
  if (link) return '🔗'
  if (dir) return '📁'
  return ICON_BY_EXT[path.extname(name).slice(1).toLowerCase()] ?? '📄'
}

/** 字节数 → 人类可读：1024 进制，KB 起固定一位小数。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const u of units) {
    if (value < 1024) break
    value /= 1024
    unit = u
  }
  return `${value.toFixed(1)} ${unit}`
}

/** 截断后对展示的普通文件条目 stat 补 size；单条失败静默略过（保持 never-throws）。 */
async function fillSizes(entries: LsEntry[], absOf: (e: LsEntry) => string): Promise<void> {
  await Promise.all(entries.map(async (e) => {
    if (e.dir || e.link) return
    try {
      e.size = (await stat(absOf(e))).size
    } catch {
      // 竞态删除/权限不足：条目照常显示，仅无大小。
    }
  }))
}
```

`listProjectDir` 整体替换为（链接条目标记 link、截断后补大小）：

```ts
/** 单层罗列：readdir withFileTypes 不追随符号链接（链接条目照列，仅作展示）。 */
export async function listProjectDir(project: string, arg: string): Promise<LsListing> {
  const dir = await resolveLsDir(project, arg)
  if (!('abs' in dir)) return dir
  const items = await readdir(dir.abs, { withFileTypes: true })
  const entries: LsEntry[] = items.map((d) => (d.isSymbolicLink()
    ? { name: d.name, dir: false, link: true }
    : { name: d.name, dir: d.isDirectory() }))
  entries.sort(compareEntries)
  const capped = capEntries(entries)
  if (capped.ok) await fillSizes(capped.entries, (e) => path.join(dir.abs, e.name))
  return capped
}
```

`searchProjectTree` 末尾三行（`hits.sort` 起）替换为：

```ts
  hits.sort((a, b) => a.name.localeCompare(b.name))
  const entries = hits.slice(0, LS_MAX_ENTRIES)
  await fillSizes(entries, (e) => path.join(project, e.name))
  return { ok: true, entries, truncated, remaining: 0 }
```

`formatLsText` 整体替换为（含新私有助手 entryLine）：

```ts
/** 条目行：图标 + 名称 + 可选大小后缀；prefix 为树形连接符（单层模式用，搜索模式传空串）。 */
function entryLine(e: LsEntry, prefix: string): string {
  const base = `${prefix}${iconForEntry(e.name, e.dir, e.link === true)} ${e.name}`
  return e.size === undefined ? base : `${base}  ${formatSize(e.size)}`
}

/** LsListing → notice 文本（arg 为 '.' 时显示「项目根」）。 */
export function formatLsText(res: Extract<LsListing, { ok: true }>, arg: string, keyword: string | undefined): string {
  const label = arg === '.' ? '项目根' : arg
  if (keyword !== undefined) {
    const lines = res.entries.map((e) => entryLine(e, ''))
    if (lines.length === 0) return `无匹配条目：${keyword}（${label}）`
    const body = [`「${keyword}」的匹配条目（${label}）：`, ...lines]
    if (res.truncated !== null) body.push('…已截断，用更精确的关键字或更小的目录细化')
    return body.join('\n')
  }
  const lines = res.entries.map((e, i) => entryLine(e, i === res.entries.length - 1 ? '└── ' : '├── '))
  if (lines.length === 0) return `（空目录：${label}）`
  const body = [`${label === '项目根' ? '项目根目录' : label}：`, ...lines]
  if (res.truncated === 'cap') body.push(`…还有 ${res.remaining} 条，用 /ls <子目录> 细化`)
  return body.join('\n')
}
```

`inbound.ts` 的 HELP_TEXT `/ls` 行替换为：

```ts
  '/ls [相对路径] [关键字] 列出项目目录内容（图标 + 大小；带关键字时递归按名称搜索）',
```

- [ ] **Step 4: 跑测试确认通过**

Run（工作目录 `packages/toolkit`）: `pnpm exec vitest run src/channels/ls-command.test.ts`
Expected: PASS（含既有用例）

Run（工作目录 `packages/toolkit`）: `pnpm exec vitest run src/channels/inbound.test.ts`
Expected: PASS（含既有所用例；若遇已知 /switch 边界 flake 单发失败，重跑一次）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/ls-command.ts packages/toolkit/src/channels/ls-command.test.ts packages/toolkit/src/channels/inbound.ts packages/toolkit/src/channels/inbound.test.ts
git commit -m "feat(toolkit): /ls 渲染升级——树形连接符 + 类型图标 + 文件大小（搜索模式同风格）"
```

---

### Task 2: 文档同步 + 全量门禁

**Files:**
- Modify: `docs/domains/feishu.md`
- Modify: `docs/usage/feishu-bots.md`

**Interfaces:**
- Consumes: Task 1。

- [ ] **Step 1: 文档更新**

`docs/domains/feishu.md` 第 11 行指令面段中，把这句：

```
`/ls [相对路径] [关键字]` 单层罗列项目目录（目录带 `/` 后缀、目录在前按名称排序、100 条截断）；带关键字时在该子树递归按名称搜索（不分大小写、不追随符号链接、遍历上限 1 万条），输出相对项目根路径可直接复制给 /doc；护栏与 /doc 同一套（项目根内相对路径、realpath 防符号链接越界）
```

替换为（保持 `；` 分句风格）：

```
`/ls [相对路径] [关键字]` 单层罗列项目目录（树形连接符 + 类型图标 + 文件大小、目录在前按名称排序、100 条截断）；带关键字时在该子树递归按名称搜索（不分大小写、不追随符号链接、遍历上限 1 万条），输出「图标 + 相对项目根路径 + 大小」（复制给 /doc 需去掉首尾装饰）；护栏与 /doc 同一套（项目根内相对路径、realpath 防符号链接越界）
```

`docs/usage/feishu-bots.md` 指令表中 `/ls` 行（第 71 行）替换为：

```markdown
| `/ls [相对路径] [关键字]` | 列出项目目录内容（树形连接符 + 类型图标 + 文件大小，超 100 条截断）；带关键字时递归按名称搜索，结果含图标与大小，复制路径给 `/doc` 需去掉首尾 |
```

- [ ] **Step 2: 全量测试**

Run（仓库根）: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（既有 700 左右 + 新增用例全绿；symlink 环境 skip 与 /switch flake 豁免照旧）

- [ ] **Step 3: 类型检查**

Run（仓库根）: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS

- [ ] **Step 4: 构建**

Run（仓库根）: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 成功产出 lib/index.js + lib/client.js

- [ ] **Step 5: Commit**

```bash
git add docs/domains/feishu.md docs/usage/feishu-bots.md
git commit -m "docs: /ls 渲染升级（树形连接符 + 图标 + 文件大小）用法同步"
```

- [ ] **Step 6: 真实环境验证（开发回路，人工）**

重启 dsh web 后在飞书 bot 会话验证：`/ls`（树形连接符 + 图标 + 大小、node_modules 等照列、截断提示）→ `/ls docs` → `/ls . md`（搜索模式图标 + 路径 + 大小）。
