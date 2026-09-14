# 飞书 /ls 命令实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bot 会话内 `/ls [相对路径] [关键字]`：单层罗列项目目录（目录+文件混合、目录带 `/` 前缀排序在前、100 条截断）；带关键字时在该子树递归按名称搜索（不分大小写、不追随符号链接），输出相对项目根路径，可直接复制给 /doc。

**Architecture:** `directive.ts` 照 /doc 模式加首词判定带参指令 `/ls`（arg 保留大小写）；`doc-command.ts` 抽共享护栏 `resolveProjectPath`（resolveDocPath 变薄封装，行为不变）；新增渠道无关 `ls-command.ts`（listProjectDir / searchProjectTree / formatLsText / lsRejectText）；`inbound.ts` 加 `/ls` 分支（notice 输出、不进 turn）+ `/help` 补行。

**Tech Stack:** TypeScript ESM（仓库约定 `.ts` 扩展名相对导入）、vitest。

**Spec:** `docs/superpowers/specs/2026-09-11-feishu-ls-command-design.md`

## Global Constraints

- /doc 功能（含评审修复：uploadFile 真实返回形态、realpath 父目录校验、addons im:resource）已落地 master，本计划直接叠加。
- 每个 Task 的 commit 只 stage 本 Task 触及的文件；commit message 风格 `feat(toolkit): …` / `docs: …`。
- **单文件测试命令（本环境已验证，勿用计划外形式）**：工作目录 `packages/toolkit` 下 `pnpm exec vitest run src/channels/<file>.test.ts`（exit 0 = 通过）。`pnpm --filter dsh-agent-toolkit exec vitest run ...` 在本环境会二次执行导致 exit 1，禁用。全量 `pnpm --filter dsh-agent-toolkit test`、类型 `pnpm --filter dsh-agent-toolkit typecheck`、构建 `pnpm --filter dsh-agent-toolkit bundle` 从仓库根跑（--filter 形式正常）。
- 文件末尾恰好一个换行；禁止无注释 `any`；新文件头部一行用途注释（照现有文件风格）。
- 错误文案遵循 2026-09-03 /new 事故教训：摘要必须回传渠道（notice），不只写 warn。
- 已知 pre-existing flake：`inbound.test.ts › /switch 边界` 约 2% 概率失败（randomUUID 全数字前缀撞数值分支），单发失败重跑即可，不要"修"它。
- inbound.test.ts 的 harness 已支持 `harness({ project })`（BOT.project 覆盖）与 `msg(text, chatId?, loadImages?, reply?)`，/doc 用例组（`describe('/doc 指令')`）是其用法范例。

---

### Task 1: directive.ts 支持 /ls 带参指令

**Files:**
- Modify: `packages/toolkit/src/channels/directive.ts`
- Test: `packages/toolkit/src/channels/directive.test.ts`

**Interfaces:**
- Produces: `Directive` 联合新增 `'ls'`；`parseDirective('/ls <余串>')` 返回 `{ name: 'ls', arg: <原始大小写余串> }`；`/ls` 无参返回 `{ name: 'ls' }`；`/lsx` 返回 null。Task 4 消费 `directive.name === 'ls'` 与 `directive.arg`。

- [ ] **Step 1: 写失败测试**

在 `directive.test.ts` 的 `describe('parseDirective')` 内追加（可放在 /doc 用例之后）：

```ts
  test('/ls 带参：首词判定，路径参数保留原始大小写', () => {
    expect(parseDirective('/ls docs')).toEqual({ name: 'ls', arg: 'docs' })
    expect(parseDirective('/LS  Docs/Sub key word ')).toEqual({ name: 'ls', arg: 'Docs/Sub key word' })
  })

  test('/ls 无参与尾空白：命中且 arg 缺省', () => {
    expect(parseDirective('/ls')).toEqual({ name: 'ls' })
    expect(parseDirective('/ls  ')).toEqual({ name: 'ls' })
  })

  test('/ls 前缀不误伤：/lsx 不是指令', () => {
    expect(parseDirective('/lsx')).toBeNull()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run（工作目录 `packages/toolkit`）: `pnpm exec vitest run src/channels/directive.test.ts`
Expected: FAIL（`/ls` 相关用例得到 `null`）

- [ ] **Step 3: 实现**

`directive.ts` 修改三处。`Directive` 联合：

```ts
export type Directive = 'new' | 'stop' | 'status' | 'sessions' | 'switch' | 'help' | 'doc' | 'ls'
```

函数 doc 注释改为：

```ts
/**
 * 精确指令（/new /stop /status /sessions /help）要求整条消息 trim+lowercase 精确匹配，
 * 带参数/前后文按普通消息处理；/switch /doc /ls 为首词判定的带参指令。
 * /doc /ls 的 arg 是文件系统路径（大小写敏感）：取自原始文本切片（toLowerCase 不改变长度，索引对齐）。
 */
```

解析分支（`/doc` 分支之后、`return null` 之前）加：

```ts
  if (t === '/ls') return { name: 'ls' }
  if (t.startsWith('/ls ')) return { name: 'ls', arg: raw.slice('/ls '.length).trim() }
```

- [ ] **Step 4: 跑测试确认通过**

Run（工作目录 `packages/toolkit`）: `pnpm exec vitest run src/channels/directive.test.ts`
Expected: PASS（含既有用例）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/directive.ts packages/toolkit/src/channels/directive.test.ts
git commit -m "feat(toolkit): parseDirective 新增 /ls 带参指令（路径参数保留大小写）"
```

---

### Task 2: doc-command.ts 抽共享护栏 resolveProjectPath

**Files:**
- Modify: `packages/toolkit/src/channels/doc-command.ts`
- Test: `packages/toolkit/src/channels/doc-command.test.ts`

**Interfaces:**
- Consumes: 现有 `resolveDocPath` 实现（行为不变地拆解）。
- Produces（Task 3 消费）:
  - `type ProjectPath = { ok: true; abs: string; st: Stats } | { ok: false; reason: 'outside' | 'not-found' }`
  - `resolveProjectPath(project: string, arg: string): Promise<ProjectPath>`（词法包含 + lstat + realpath 父目录校验；`st` 为 lstat 结果，供调用方判 isFile/isSymbolicLink）
- 不变：`resolveDocPath` / `readDocFile` / `docRejectText` 签名与对外行为（既有测试一行不改仍须全绿）。

- [ ] **Step 1: 写失败测试**

在 `doc-command.test.ts` 末尾追加（复用文件头部的 root fixture 与 import；import 行补 `resolveProjectPath`）：

```ts
describe('resolveProjectPath', () => {
  test('命中：返回绝对路径与 lstat 结果', async () => {
    const res = await resolveProjectPath(root, 'docs')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.abs).toBe(path.join(root, 'docs'))
    expect(res.st.isDirectory()).toBe(true)
  })

  test('拒绝越界与不存在', async () => {
    expect(await resolveProjectPath(root, '../outside.md')).toEqual({ ok: false, reason: 'outside' })
    expect(await resolveProjectPath(root, 'nope.md')).toEqual({ ok: false, reason: 'not-found' })
  })

  test('中间目录符号链接越出项目根拒绝', async (t) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-ls-out-'))
    try {
      try {
        await symlink(outside, path.join(root, 'linkdir'), 'junction')
      } catch {
        t.skip('当前环境不允许创建符号链接')
        return
      }
      expect(await resolveProjectPath(root, 'linkdir/x.md')).toEqual({ ok: false, reason: 'outside' })
    } finally {
      await rm(outside, { recursive: true, force: true })
      await rm(path.join(root, 'linkdir'), { recursive: true, force: true })
    }
  })
})
```

注意：`resolveDocPath` 既有用例（含评审修复补的 linkdir 用例）一行不改。

- [ ] **Step 2: 跑测试确认失败**

Run（工作目录 `packages/toolkit`）: `pnpm exec vitest run src/channels/doc-command.test.ts`
Expected: FAIL（`resolveProjectPath is not a function` / 未导出）

- [ ] **Step 3: 实现**

`doc-command.ts` 重构为共享护栏 + 薄封装（文件头注释同步更新为「/doc /ls 指令的路径解析与护栏…」）：

```ts
export type ProjectPath =
  | { ok: true; abs: string; st: Stats }
  | { ok: false; reason: 'outside' | 'not-found' }

/** 相对项目根解析 arg 并做包含护栏：绝对路径与 .. 越界拒绝（词法）；
 * lstat 失败（不存在/不可读/悬空链接）按 not-found；
 * 中间目录若是符号链接 lstat 会跟随其指向，用 realpath 把两侧归一后重判包含
 * （两侧都取真实路径，避免根路径本身带符号链接/8.3 短名时文本不一致误判）。
 * 注意：本护栏只校验到父目录；目标自身是符号链接时的处置由调用方按语义决定
 * （/doc 靠 st.isFile() 拒绝，/ls 显式按越界拒绝）。 */
export async function resolveProjectPath(project: string, arg: string): Promise<ProjectPath> {
  if (path.isAbsolute(arg)) return { ok: false, reason: 'outside' }
  const abs = path.resolve(project, arg)
  const rel = path.relative(project, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'outside' }
  let st: Stats
  try {
    st = await lstat(abs)
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  const realRoot = await realpath(project)
  const realParent = await realpath(path.dirname(abs))
  const realRel = path.relative(realRoot, realParent)
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) return { ok: false, reason: 'outside' }
  return { ok: true, abs, st }
}

/** 相对项目根解析 arg；在 resolveProjectPath 护栏之上追加普通文件与大小上限判定。 */
export async function resolveDocPath(project: string, arg: string, maxBytes: number): Promise<DocResolution> {
  const base = await resolveProjectPath(project, arg)
  if (!base.ok) return base
  if (!base.st.isFile()) return { ok: false, reason: 'not-file' }
  if (base.st.size > maxBytes) return { ok: false, reason: 'too-large' }
  return { ok: true, path: base.abs, name: path.basename(base.abs) }
}
```

`readDocFile` / `docRejectText` 不动。`import type { Stats } from 'node:fs'` 已有，保留。

行为校验点：原实现对「中间符号链接指向项目外的目录」先答 'not-file'（lstat isFile false），新实现答 'outside'——无既有测试覆盖该次序，属可接受的语义收紧；其余次序（词法 outside → not-found → not-file → too-large）不变。

- [ ] **Step 4: 跑测试确认通过**

Run（工作目录 `packages/toolkit`）: `pnpm exec vitest run src/channels/doc-command.test.ts`
Expected: PASS（新增 3 例 + 既有一行未改全绿；symlink 用例在无权限环境 skip 可接受）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/doc-command.ts packages/toolkit/src/channels/doc-command.test.ts
git commit -m "refactor(toolkit): doc-command 抽共享护栏 resolveProjectPath（resolveDocPath 变薄封装，行为不变）"
```

---

### Task 3: ls-command.ts 单层罗列 + 递归名称搜索（渠道无关核心）

**Files:**
- Create: `packages/toolkit/src/channels/ls-command.ts`
- Test: `packages/toolkit/src/channels/ls-command.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `resolveProjectPath` / `ProjectPath`。
- Produces（Task 4 消费）:
  - `LS_MAX_ENTRIES = 100`、`LS_MAX_WALK = 10_000`
  - `type LsEntry = { name: string; dir: boolean }`（单层模式 name = 条目名；搜索模式 name = 相对项目根的 posix 化路径）
  - `type LsReject = 'outside' | 'not-found' | 'not-dir'`
  - `type LsListing = { ok: true; entries: LsEntry[]; truncated: 'cap' | 'walk' | null; remaining: number } | { ok: false; reason: LsReject }`
  - `listProjectDir(project: string, arg: string): Promise<LsListing>`
  - `searchProjectTree(project: string, arg: string, keyword: string): Promise<LsListing>`
  - `formatLsText(res: Extract<LsListing, { ok: true }>, arg: string, keyword: string | undefined): string`
  - `lsRejectText(reason: LsReject, arg: string): string`

- [ ] **Step 1: 写失败测试**

新建 `ls-command.test.ts`：

```ts
/** ls-command 的测试：单层罗列（排序/截断/空目录）、递归名称搜索、符号链接不追随、拒绝文案。 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { formatLsText, listProjectDir, LS_MAX_ENTRIES, lsRejectText, searchProjectTree } from './ls-command.ts'

let root: string

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dsh-ls-cmd-'))
  await mkdir(path.join(root, 'docs', 'sub'), { recursive: true })
  await mkdir(path.join(root, 'empty'))
  await writeFile(path.join(root, 'docs', 'report.md'), '# 报告\n', 'utf8')
  await writeFile(path.join(root, 'docs', 'sub', 'notes.md'), 'x', 'utf8')
  await writeFile(path.join(root, 'README.md'), 'x', 'utf8')
  await writeFile(path.join(root, '.hidden'), 'x', 'utf8')
  await writeFile(path.join(root, 'zeta.md'), 'x', 'utf8')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('listProjectDir', () => {
  test('单层混合：目录在前，隐藏文件照列，按名称排序', async () => {
    const res = await listProjectDir(root, '.')
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries.map((e) => `${e.name}${e.dir ? '/' : ''}`))
      .toEqual(['docs/', 'empty/', '.hidden', 'README.md', 'zeta.md'])
    expect(res.truncated).toBeNull()
  })

  test('子目录罗列', async () => {
    const res = await listProjectDir(root, 'docs')
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries.map((e) => `${e.name}${e.dir ? '/' : ''}`)).toEqual(['sub/', 'report.md'])
  })

  test('拒绝越界 / 不存在 / 目标是文件', async () => {
    expect(await listProjectDir(root, '../x')).toEqual({ ok: false, reason: 'outside' })
    expect(await listProjectDir(root, 'nope')).toEqual({ ok: false, reason: 'not-found' })
    expect(await listProjectDir(root, 'README.md')).toEqual({ ok: false, reason: 'not-dir' })
  })

  test('超过 LS_MAX_ENTRIES 截断并计 remaining', async () => {
    const many = await mkdtemp(path.join(tmpdir(), 'dsh-ls-many-'))
    try {
      for (let i = 0; i < LS_MAX_ENTRIES + 7; i++) {
        await writeFile(path.join(many, `f${String(i).padStart(3, '0')}.txt`), 'x')
      }
      const res = await listProjectDir(many, '.')
      if (!res.ok) throw new Error('unreachable')
      expect(res.entries).toHaveLength(LS_MAX_ENTRIES)
      expect(res.truncated).toBe('cap')
      expect(res.remaining).toBe(7)
    } finally {
      await rm(many, { recursive: true, force: true })
    }
  })
})

describe('searchProjectTree', () => {
  test('递归匹配：大小写不敏感，路径相对项目根 posix 化', async () => {
    const res = await searchProjectTree(root, '.', 'REPORT')
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries).toEqual([{ name: 'docs/report.md', dir: false }])
  })

  test('目录也参与匹配（dir 标记）', async () => {
    const res = await searchProjectTree(root, '.', 'sub')
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries).toEqual([{ name: 'docs/sub', dir: true }])
  })

  test('限定子目录为基准，命中按路径排序', async () => {
    const res = await searchProjectTree(root, 'docs', 'md')
    if (!res.ok) throw new Error('unreachable')
    expect(res.entries).toEqual([
      { name: 'docs/report.md', dir: false },
      { name: 'docs/sub/notes.md', dir: false },
    ])
  })

  test('符号链接不追随：链接自身不列出、不进入其子树；链接作目标按越界拒绝', async (t) => {
    const outside = await mkdtemp(path.join(tmpdir(), 'dsh-ls-out-'))
    try {
      await writeFile(path.join(outside, 'secret.md'), 'x')
      try {
        await symlink(outside, path.join(root, 'linkdir'), 'junction')
      } catch {
        t.skip('当前环境不允许创建符号链接')
        return
      }
      const res = await searchProjectTree(root, '.', 'secret')
      if (!res.ok) throw new Error('unreachable')
      expect(res.entries).toEqual([])
      expect(await listProjectDir(root, 'linkdir')).toEqual({ ok: false, reason: 'outside' })
    } finally {
      await rm(outside, { recursive: true, force: true })
      await rm(path.join(root, 'linkdir'), { recursive: true, force: true })
    }
  })
})

describe('formatLsText / lsRejectText', () => {
  test('单层渲染：表头 + 目录 / 后缀 + 截断提示', () => {
    const text = formatLsText({ ok: true, entries: [{ name: 'docs', dir: true }, { name: 'a.md', dir: false }], truncated: 'cap', remaining: 5 }, '.', undefined)
    expect(text).toBe('项目根目录：\ndocs/\na.md\n…还有 5 条，用 /ls <子目录> 细化')
  })

  test('空目录与无匹配', () => {
    expect(formatLsText({ ok: true, entries: [], truncated: null, remaining: 0 }, 'docs', undefined)).toBe('（空目录：docs）')
    expect(formatLsText({ ok: true, entries: [], truncated: null, remaining: 0 }, 'docs', 'xyz')).toBe('无匹配条目：xyz（docs）')
  })

  test('搜索渲染与截断提示', () => {
    expect(formatLsText({ ok: true, entries: [{ name: 'docs/report.md', dir: false }], truncated: null, remaining: 0 }, '.', 'report'))
      .toBe('「report」的匹配条目（项目根）：\ndocs/report.md')
    const entries = Array.from({ length: LS_MAX_ENTRIES }, (_, i) => ({ name: `f${i}`, dir: false }))
    expect(formatLsText({ ok: true, entries, truncated: 'walk', remaining: 0 }, '.', 'f'))
      .toContain('…已截断，用更精确的关键字或更小的目录细化')
  })

  test('拒绝文案', () => {
    expect(lsRejectText('outside', 'x')).toContain('项目目录内')
    expect(lsRejectText('not-found', 'x')).toBe('目录不存在：x')
    expect(lsRejectText('not-dir', 'a.md')).toBe('/ls 列目录，发文件请用 /doc a.md')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run（工作目录 `packages/toolkit`）: `pnpm exec vitest run src/channels/ls-command.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `ls-command.ts`：

```ts
/** /ls 指令的目录罗列与递归名称搜索：单层 ls 语义 + 关键字子树过滤（不追随符号链接）。 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { resolveProjectPath } from './doc-command.ts'

/** 单层罗列/搜索结果的条数上限（超出截断并提示细化）。 */
export const LS_MAX_ENTRIES = 100
/** 递归搜索的遍历条目数上限（防 node_modules 级大树拖垮响应）。 */
export const LS_MAX_WALK = 10_000

export type LsReject = 'outside' | 'not-found' | 'not-dir'

export interface LsEntry {
  /** 单层模式为条目名；搜索模式为相对项目根的路径（posix 分隔）。 */
  name: string
  dir: boolean
}

export type LsListing =
  | { ok: true; entries: LsEntry[]; truncated: 'cap' | 'walk' | null; remaining: number }
  | { ok: false; reason: LsReject }

/** 目录在前，同类按名称排序。 */
function compareEntries(a: LsEntry, b: LsEntry): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1
  return a.name.localeCompare(b.name)
}

function capEntries(entries: LsEntry[]): LsListing {
  if (entries.length <= LS_MAX_ENTRIES) return { ok: true, entries, truncated: null, remaining: 0 }
  return { ok: true, entries: entries.slice(0, LS_MAX_ENTRIES), truncated: 'cap', remaining: entries.length - LS_MAX_ENTRIES }
}

/** 共享护栏 + /ls 自语义：目标是文件 → not-dir；目标是符号链接 → 按越界拒绝（指向不定，err-safe）。 */
async function resolveLsDir(project: string, arg: string): Promise<LsListing | { ok: true; abs: string }> {
  const base = await resolveProjectPath(project, arg)
  if (!base.ok) return base
  if (base.st.isSymbolicLink()) return { ok: false, reason: 'outside' }
  if (base.st.isFile()) return { ok: false, reason: 'not-dir' }
  return { ok: true, abs: base.abs }
}

/** 单层罗列：readdir withFileTypes 不追随符号链接（链接条目照列，仅作展示）。 */
export async function listProjectDir(project: string, arg: string): Promise<LsListing> {
  const dir = await resolveLsDir(project, arg)
  if (!('abs' in dir)) return dir
  const items = await readdir(dir.abs, { withFileTypes: true })
  const entries = items.map((d) => ({ name: d.name, dir: d.isDirectory() }))
  entries.sort(compareEntries)
  return capEntries(entries)
}

function toProjectRel(project: string, abs: string): string {
  return path.relative(project, abs).split(path.sep).join('/')
}

/** 递归名称过滤：迭代式 DFS（显式栈防深目录爆栈）；符号链接跳过（不追随、不列出），防环防越界。 */
export async function searchProjectTree(project: string, arg: string, keyword: string): Promise<LsListing> {
  const dir = await resolveLsDir(project, arg)
  if (!('abs' in dir)) return dir
  const needle = keyword.toLowerCase()
  const hits: LsEntry[] = []
  let walked = 0
  let truncated: 'cap' | 'walk' | null = null
  const stack: string[] = [dir.abs]
  while (stack.length > 0) {
    if (hits.length >= LS_MAX_ENTRIES) { truncated = 'cap'; break }
    if (walked >= LS_MAX_WALK) { truncated = 'walk'; break }
    const current = stack.pop()!
    let items
    try {
      items = await readdir(current, { withFileTypes: true })
    } catch {
      // 无权限/竞态删除的子目录跳过。
      continue
    }
    walked += items.length
    for (const d of items) {
      if (d.isSymbolicLink()) continue
      const abs = path.join(current, d.name)
      if (d.name.toLowerCase().includes(needle)) {
        hits.push({ name: toProjectRel(project, abs), dir: d.isDirectory() })
      }
      if (d.isDirectory()) stack.push(abs)
    }
  }
  hits.sort((a, b) => a.name.localeCompare(b.name))
  return { ok: true, entries: hits.slice(0, LS_MAX_ENTRIES), truncated, remaining: 0 }
}

/** LsListing → notice 文本（arg 为 '.' 时显示「项目根」）。 */
export function formatLsText(res: Extract<LsListing, { ok: true }>, arg: string, keyword: string | undefined): string {
  const label = arg === '.' ? '项目根' : arg
  const lines = res.entries.map((e) => (e.dir ? `${e.name}/` : e.name))
  if (keyword !== undefined) {
    if (lines.length === 0) return `无匹配条目：${keyword}（${label}）`
    const body = [`「${keyword}」的匹配条目（${label}）：`, ...lines]
    if (res.truncated !== null) body.push('…已截断，用更精确的关键字或更小的目录细化')
    return body.join('\n')
  }
  if (lines.length === 0) return `（空目录：${label}）`
  const body = [`${label === '项目根' ? '项目根目录' : label}：`, ...lines]
  if (res.truncated === 'cap') body.push(`…还有 ${res.remaining} 条，用 /ls <子目录> 细化`)
  return body.join('\n')
}

/** 拒绝原因 → 回传渠道的用户文案。 */
export function lsRejectText(reason: LsReject, arg: string): string {
  switch (reason) {
    case 'outside': return `仅支持项目目录内的路径（相对路径，不越出项目根）：${arg}`
    case 'not-found': return `目录不存在：${arg}`
    case 'not-dir': return `/ls 列目录，发文件请用 /doc ${arg}`
    default: {
      const never: never = reason
      throw new Error(`未知拒绝原因：${String(never)}`)
    }
  }
}
```

注意：实现里 `resolveLsDir` 的返回联合用 `'abs' in dir` 判别。

- [ ] **Step 4: 跑测试确认通过**

Run（工作目录 `packages/toolkit`）: `pnpm exec vitest run src/channels/ls-command.test.ts`
Expected: PASS（symlink 用例在无权限环境 skip 可接受）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/ls-command.ts packages/toolkit/src/channels/ls-command.test.ts
git commit -m "feat(toolkit): ls-command 单层罗列与递归名称搜索（100 条/1 万遍历上限，符号链接不追随）"
```

---

### Task 4: Inbound /ls 分支 + /help 文案

**Files:**
- Modify: `packages/toolkit/src/channels/inbound.ts`
- Test: `packages/toolkit/src/channels/inbound.test.ts`

**Interfaces:**
- Consumes: Task 1 `{ name: 'ls', arg }`；Task 3 的 `listProjectDir` / `searchProjectTree` / `formatLsText` / `lsRejectText`。
- Produces: `/ls` 用户可见行为（spec §2/§3/§4 文案表）。

- [ ] **Step 1: 写失败测试**

`inbound.test.ts` 追加（先读文件，复用 /doc 用例组的 fixture 模式：`harness({ project })` + `msg()`；文件头 `node:fs/promises` import 补 `mkdir`——mkdtemp/rm/writeFile/tmpdir/path 在 /doc 用例引入时已具备）。在 `describe('/doc 指令')` 之后新建：

```ts
describe('/ls 指令', () => {
  let project: string
  beforeAll(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'dsh-ls-inbound-'))
    await mkdir(path.join(project, 'docs', 'sub'), { recursive: true })
    await writeFile(path.join(project, 'docs', 'report.md'), '# 报告\n', 'utf8')
    await writeFile(path.join(project, 'docs', 'sub', 'notes.md'), 'x', 'utf8')
    await writeFile(path.join(project, 'README.md'), 'x', 'utf8')
  })
  afterAll(async () => { await rm(project, { recursive: true, force: true }) })

  test('/ls 无参列项目根（不进会话 turn）', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/ls'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('项目根目录'))).toBe(true) })
    const text = rec.notices.find((n) => n.includes('项目根目录'))!
    expect(text).toContain('docs/')
    expect(text).toContain('README.md')
    expect(rec.followups).toHaveLength(0)
  })

  test('/ls 有参列子目录', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/ls docs'))
    await vi.waitFor(() => {
      expect(rec.notices.some((n) => n.includes('sub/') && n.includes('report.md'))).toBe(true)
    })
  })

  test('/ls 带关键字递归搜索（多词关键字 join）', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/ls docs NOTES'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('docs/sub/notes.md'))).toBe(true) })
  })

  test('/ls 越界路径拒绝', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/ls ../secret'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('项目目录内'))).toBe(true) })
  })

  test('/ls 目录不存在', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/ls nope'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('目录不存在'))).toBe(true) })
  })

  test('/ls 目标是文件时提示用 /doc', async () => {
    const { rec, inbound, msg } = harness({ project })
    inbound.onMessage(msg('/ls README.md'))
    await vi.waitFor(() => { expect(rec.notices.some((n) => n.includes('发文件请用 /doc'))).toBe(true) })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run（工作目录 `packages/toolkit`）: `pnpm exec vitest run src/channels/inbound.test.ts`
Expected: FAIL（/ls 走普通消息路径进 followup / 无对应 notice）

- [ ] **Step 3: 实现**

`inbound.ts`：

1. import 补 `import { formatLsText, listProjectDir, lsRejectText, searchProjectTree } from './ls-command.ts'`
2. `HELP_TEXT` 在 `/doc` 行之后加一行：`'/ls [相对路径] [关键字] 列出项目目录内容（带关键字时递归按名称搜索）',`
3. 指令分支链中（`/doc` 分支之后、`/sessions` 分支之前）加：

```ts
    if (directive?.name === 'ls') {
      await this.sendLs(bot, msg, directive.arg)
      return
    }
```

4. 类内加私有方法（放在 `sendDoc` 之后）：

```ts
  /** /ls：arg 缺省/空 = 列项目根；单 token = 路径；其余 token join 为递归搜索关键字。 */
  private async sendLs(bot: BotRecord, msg: InboundMessage, arg: string | undefined): Promise<void> {
    const tokens = arg === undefined || arg.length === 0 ? [] : arg.split(/\s+/)
    const dirArg = tokens[0] ?? '.'
    const keyword = tokens.length > 1 ? tokens.slice(1).join(' ') : undefined
    const res = keyword === undefined
      ? await listProjectDir(bot.project, dirArg)
      : await searchProjectTree(bot.project, dirArg, keyword)
    if (!res.ok) {
      await msg.reply.notice(lsRejectText(res.reason, dirArg))
      return
    }
    await msg.reply.notice(formatLsText(res, dirArg, keyword))
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run（工作目录 `packages/toolkit`）: `pnpm exec vitest run src/channels/inbound.test.ts`
Expected: PASS（含既有所用例；若遇已知 /switch 边界 flake 单发失败，重跑一次）

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/inbound.ts packages/toolkit/src/channels/inbound.test.ts
git commit -m "feat(toolkit): /ls 指令——项目目录单层罗列与递归名称搜索"
```

---

### Task 5: 全量门禁 + 文档同步

**Files:**
- Modify: `docs/domains/feishu.md`
- Modify: `docs/usage/feishu-bots.md`

**Interfaces:**
- Consumes: Task 1-4 全部。

- [ ] **Step 1: 全量测试**

Run（仓库根）: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（676 + 新增用例全绿）

- [ ] **Step 2: 类型检查**

Run（仓库根）: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS

- [ ] **Step 3: 构建**

Run（仓库根）: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 成功产出 lib/index.js + lib/client.js

- [ ] **Step 4: 文档**

`docs/domains/feishu.md` 的指令面段（`/doc` 句之后）补一句：`/ls [相对路径] [关键字]` 单层罗列项目目录（目录带 `/` 后缀、目录在前按名称排序、100 条截断）；带关键字时在该子树递归按名称搜索（不分大小写、不追随符号链接、遍历上限 1 万条），输出相对项目根路径可直接复制给 /doc；护栏与 /doc 同一套（项目根内相对路径、realpath 防符号链接越界）。

`docs/usage/feishu-bots.md` 指令表（`/doc` 行之后）补一行：

```markdown
| `/ls [相对路径] [关键字]` | 列出项目目录内容（目录带 `/` 后缀，超 100 条截断）；带关键字时递归按名称搜索，结果路径可直接复制给 `/doc` |
```

无新权限需求（/ls 纯本地文件读取 + notice 文本）。

- [ ] **Step 5: Commit**

```bash
git add docs/domains/feishu.md docs/usage/feishu-bots.md
git commit -m "docs: 飞书 /ls 指令用法（单层罗列 + 递归名称搜索）"
```

- [ ] **Step 6: 真实环境验证（开发回路，人工）**

重启 dsh web 后在飞书 bot 会话验证：`/ls`（列根、node_modules 等照列、截断提示）→ `/ls docs` → `/ls . md`（递归搜索，复制结果路径）→ `/doc <搜索结果路径>` 联动 → `/ls ../x` 与 `/ls 不存在` 护栏文案。
