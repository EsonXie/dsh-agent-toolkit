# 飞书 /ls 命令设计——目录罗列与递归名称搜索

> 2026-09-11 定稿（用户已批准）。衔接 /doc（docs/superpowers/specs/2026-09-11-feishu-doc-command-design.md）：/ls 探路、/doc 发文件。

## 1. 目标

bot 会话内发送 `/ls [相对路径] [关键字]`：无参罗列项目根目录单层条目；带路径罗列该子目录单层条目；带路径+关键字在该子树内递归按名称搜索。输出为 notice 纯文本，用户在飞书里直接看，搜索结果的路径可直接复制给 /doc。

## 2. 语法与语义

| 输入 | 行为 |
|---|---|
| `/ls` | 列项目根目录单层条目 |
| `/ls <路径>` | 列该子目录单层条目（路径相对项目根，大小写敏感保留） |
| `/ls <路径> <关键字>` | 在该子目录**递归**搜索名称包含关键字的条目（不分大小写） |
| `/ls . <关键字>` | 从项目根递归搜索（`.` = 根） |

单参一律按路径处理，不做「单词猜路径还是关键字」的魔法。指令判定照 /doc 模式：首词 `/ls`（tolowerCase 判定），arg 取原始文本切片保留大小写；arg 缺省或 trim 后为空（如 `/ls ` 尾空白）都按无参处理（列项目根），不报用法错误。Inbound 内按首个空白把 arg 拆成 路径 + 关键字（关键字内含空白的场景不支持，YAGNI）。

## 3. 输出格式

**单层列出**：
- 目录与文件混合；目录名带 `/` 后缀；目录在前，同类按名称 `localeCompare` 排序；隐藏文件照列（真 ls 语义）
- 超 100 条截断，末尾追加 `…还有 N 条，用 /ls <子目录> 细化`

**递归搜索**：
- 文件与目录都参与匹配（目录带 `/` 后缀）；输出**相对项目根的路径**（可直接复制给 /doc）；按路径排序
- **不追随符号链接**（防环防越界），符号链接条目本身不列出
- 安全上限：匹配满 100 条或遍历满 10,000 条目即停；截断时末尾追加 `…已截断，用更精确的关键字或更小的目录细化`

**空结果**：单层空目录 → `（空目录）`；搜索无匹配 → `无匹配条目：<关键字>（<路径>）`。

## 4. 护栏（与 /doc 同一套，抽出共享）

- 仅接受相对项目根的相对路径；绝对路径、`..` 越界一律拒绝：`仅支持项目目录内的路径（相对路径，不越出项目根）：<arg>`
- realpath 父目录包含校验防中间目录符号链接越界（复用 /doc 评审修复后的同一实现）
- 目标不存在 → `目录不存在：<arg>`；目标是普通文件 → `/ls 列目录，发文件请用 /doc <路径>`
- 与 /doc 一样不进会话 turn、不占 in-flight 槽；一切失败摘要 notice 回传渠道（2026-09-03 教训）

## 5. 实现结构

1. **`doc-command.ts` 抽共享护栏**：导出 `resolveProjectPath(project, arg): Promise<{ ok: true; abs: string } | { ok: false; reason: 'outside' | 'not-found' }>`（词法包含 + realpath 父目录校验，不含类型/大小检查）。`resolveDocPath` 改为薄封装（共享护栏 + lstat isFile + 大小上限），**对外行为与签名不变，现有测试不动**。
2. **新增 `ls-command.ts`**（渠道无关核心）：
   - `listProjectDir(project, arg): Promise<LsResult>` — 单层罗列
   - `searchProjectTree(project, arg, keyword): Promise<LsResult>` — 递归名称过滤
   - `LsResult = { ok: true; lines: string[]; truncated: 'cap' | 'walk' | null; remaining: number } | { ok: false; reason: LsReject }`，`LsReject = 'outside' | 'not-found' | 'not-dir'`；`truncated: 'cap'` 时 `remaining` 为未显示条数（供「还有 N 条」），`'walk'`（遍历上限）时剩余不可知，`remaining` 恒 0
   - `formatLsLines(...)` 渲染最终文本行（排序、`/` 后缀、截断/空结果提示）
   - 常量：`LS_MAX_ENTRIES = 100`、`LS_MAX_WALK = 10_000`（不开放 Config，YAGNI）
3. **`directive.ts`**：`Directive` 联合加 `'ls'`，解析分支照 /doc（`t === '/ls'`、`t.startsWith('/ls ')`），函数 doc 注释同步。
4. **`inbound.ts`**：`/doc` 分支旁加 `/ls` 分支 → 私有 `sendLs(bot, msg, arg)`：拆参 → 护栏/罗列/搜索 → notice 输出；`HELP_TEXT` 在 `/doc` 行后补 `'/ls [相对路径] [关键字] 列出项目目录内容（带关键字时递归按名称搜索）'`。
5. **文档**：`docs/domains/feishu.md` 指令面段补 /ls 一句；`docs/usage/feishu-bots.md` 指令表补一行（无新权限需求）。

## 6. 测试

- `ls-command.test.ts`（真实临时目录，照 doc-command.test.ts 模式）：单层混合排序与 `/` 后缀；隐藏文件照列；100 条截断与 `还有 N 条` 计数；空目录提示；递归搜索大小写不敏感、子树命中、目录匹配带 `/`；符号链接不追随（带 t.skip 保护）；三类拒绝；遍历上限截断（构造超 10,000 条目的目录树代价高——改以注入式 walk 或直接信任常量逻辑，测试聚焦 100 条匹配截断）
- `directive.test.ts`：`/ls`、`/ls docs`、`/ls Docs Report`（大小写保留）、`/lsx` 不命中
- `inbound.test.ts`：/ls 无参列根、有参列子目录、递归搜索、越界拒绝、不存在、文件参数提示、不进 turn（followups 为 0）

## 7. 非目标

- 不做 glob 模式、不按内容搜索、不做多级排序选项
- 条数/遍历上限不开放 Config
- 不支持关键字含空白
