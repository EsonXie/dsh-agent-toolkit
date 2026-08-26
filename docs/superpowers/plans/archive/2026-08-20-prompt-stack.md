# prompt-stack 插件实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `packages/prompt-stack/` 插件：语义化提示词分层（layers）+ 按 provider/model 规则匹配覆盖层文本（rules），照 spec `docs/superpowers/specs/2026-08-20-prompt-stack-design.md` 的方案 A 实现。

**Architecture:** 纯 Node 半 dsh 插件，无浏览器 bundle。每层注册一个函数式 PromptSection（`ctx.systemPrompt.section`），text 函数在每次组装时从 `AssembleContext.agent?.options` 读 `{ provider, model }`，按打分规则（model 精确=4 / modelPattern glob=2 / provider=1，取最高分、同分取配置序靠前）选唯一命中规则，用其 `overrides[层名]` 替换该层文本；命中规则的 `append` 渲染为固定追加层 `prompt-stack:model-notes`（order = 最大层 order + 1，无命中时返回空串被 dsh 丢弃）。裸组装（无 agent）全部用默认文本。配置校验失败在 apply 时响亮抛错。

**Tech Stack:** TypeScript (strict, ESM, nodenext)、@deepseek-ai/cordis v4、@deepseek-ai/schemastery（Config schema）、vitest。测试照 dsh 原生模式：`new Context()` + `ctx.plugin(SystemPrompt)` 真实组装。

## Global Constraints

- 包名 `prompt-stack`，`private: true`，源码导出（`exports: { ".": "./src/index.ts" }`，照 agent-team 蓝本，**不做 tsdown bundle**）。
- `src/index.ts` 命名导出 `name = 'prompt-stack'`、`inject = ['systemPrompt']`、`Config`（Schemastery schema）、`apply(ctx, config)`，**无 default export**（混用会让 Loader 丢弃 inject，见 dsh postmortem 0001）。
- 可调参数全部进 Config，插件不硬编码任何用户可改文本；默认 layers/rules 内联为 `src/defaults.ts` 源码常量，作为 schema `.default()`。
- `layers` / `rules` 字段一旦被用户配置即整体替换默认值，不做深合并（schemastery 默认语义即是）。
- 层名同时是 section 名后缀：section 全名 `prompt-stack:<层名>`；固定追加层名 `prompt-stack:model-notes`，层名 `model-notes` 保留禁用。
- 打分：match 内三字段是 AND 语义（任一指定字段不匹配则规则不命中）；分值累加 model=4 / modelPattern=2 / provider=1；只取最高分一条，同分取配置序靠前者。
- 错误处理：层名重复、`overrides` 引用不存在的层名、glob 非法（空 pattern）、`match` 三字段全空、层名用保留名 `model-notes`、`layers` 为空数组 → apply 时抛错；text 的未定义 `{{variable}}` 沿用 dsh 渲染期报错，不兜底；无规则命中是正常路径，静默用默认文本。
- 默认文本改写自 opencode（MIT 许可，`anomalyco/opencode@dev`，`packages/opencode/src/session/prompt/*.txt`）：剔除 opencode 专有内容（身份自述、具体工具名、`/help` `/bug` `ctrl+p`、issues URL、opencode.ai），保留模型族行为指导；`defaults.ts` 顶部注释注明出处。**不写身份首句**（dsh 原生 `harness:identity` 段已覆盖身份）。
- 修改 `deepseek-harness/` 内任何文件都是禁止的（只读宿主）。
- 每个 Task 末尾的 commit 步骤：**本仓库规则要求 git 提交前必须得到用户明确确认**，执行时先询问再提交。
- 文件结尾恰好一个换行；TS 全 strict + noImplicitAny，不留无注释的 `any`。

---

### Task 1: 包脚手架 + smoke 测试

**Files:**
- Create: `packages/prompt-stack/package.json`
- Create: `packages/prompt-stack/tsconfig.json`
- Create: `packages/prompt-stack/src/index.ts`（占位，仅导出 name/inject）
- Test: `packages/prompt-stack/tests/smoke.test.ts`

**Interfaces:**
- Produces: `name: 'prompt-stack'`（string 常量）、`inject: ['systemPrompt']`（string[]）。后续 Task 在同一文件追加 `Config`、`apply`。

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "prompt-stack",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./package.json": "./package.json"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "link:../../deepseek-harness/vendor/cordis",
    "@deepseek-ai/dsh-agent": "link:../../deepseek-harness/packages/core/agent",
    "@deepseek-ai/dsh-llm": "link:../../deepseek-harness/packages/llm/llm",
    "@deepseek-ai/dsh-session": "link:../../deepseek-harness/packages/core/session",
    "@deepseek-ai/dsh-system-prompt": "link:../../deepseek-harness/packages/core/system-prompt",
    "@deepseek-ai/schemastery": "link:../../deepseek-harness/vendor/schemastery",
    "@types/node": "^22.20.1",
    "typescript": "^6.0.3",
    "vitest": "^3.0.0"
  }
}
```

说明：`dsh-llm`/`dsh-session` 仅为 `dsh-agent` 类型声明合并的传递解析兜底（link: 包的依赖经 deepseek-harness 自身 node_modules 解析；若 typecheck 报找不到再补，不预先加更多）。

**对 spec 的一处显式偏离**：spec 写"peerDeps 拷贝 ACP 依赖集"，但 ACP 的 peerDeps 用 `workspace:^` 版本，在本仓库外无法解析；且本仓库两个既有插件都没照做（agent-team 无 peerDeps，已发布的 token-usage 仅 peer `@deepseek-ai/cordis`）。本包照 agent-team 蓝本：`private: true`、无 peerDeps、全部 dsh 依赖走 devDeps `link:`。若未来要发布 npm，再照 token-usage 补 peerDeps 与发布门禁。

- [ ] **Step 2: 写 tsconfig.json**（照 token-usage，去 jsx，不含 tsdown.config.ts）

```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "noImplicitAny": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: 写失败的 smoke 测试**

`packages/prompt-stack/tests/smoke.test.ts`：

```ts
import { expect, test } from 'vitest'
import { inject, name } from '../src/index.ts'

test('插件导出名与 inject', () => {
  expect(name).toBe('prompt-stack')
  expect(inject).toEqual(['systemPrompt'])
})
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm --filter prompt-stack test`
Expected: FAIL（`../src/index.ts` 不存在，模块解析错误）

- [ ] **Step 5: 写占位 src/index.ts**

```ts
/** prompt-stack 插件：语义化提示词分层 + 按模型规则覆盖。 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'prompt-stack'

export const inject = ['systemPrompt']

// 占位 apply，Task 4 补全。
export function apply(_ctx: Context): void {}
```

- [ ] **Step 6: 安装依赖并跑测试 + typecheck**

Run: `pnpm install; if ($?) { pnpm --filter prompt-stack test }; if ($?) { pnpm --filter prompt-stack typecheck }`
Expected: 测试 PASS（1 个），typecheck 无错误

- [ ] **Step 7: Commit（先经用户确认）**

```bash
git add packages/prompt-stack
git commit -m "feat(prompt-stack): 包脚手架与 smoke 测试"
```

---

### Task 2: 匹配算法（`src/types.ts` + `src/match.ts`）

**Files:**
- Create: `packages/prompt-stack/src/types.ts`
- Create: `packages/prompt-stack/src/match.ts`
- Test: `packages/prompt-stack/tests/match.test.ts`

**Interfaces:**
- Produces（后续 Task 依赖这些确切签名）:
  - `types.ts`: `interface LayerConfig { name: string; order: number; text: string }`、`interface RuleMatch { provider?: string; model?: string; modelPattern?: string }`、`interface Rule { match: RuleMatch; overrides?: Record<string, string>; append?: string }`、`interface Config { layers: LayerConfig[]; rules: Rule[] }`
  - `match.ts`: `globToRegExp(pattern: string): RegExp`（空/全空白 pattern 抛错）、`scoreRule(match: RuleMatch, provider: string | undefined, model: string | undefined): number`（不命中返回 0）、`selectRule(rules: readonly Rule[], provider: string | undefined, model: string | undefined): Rule | undefined`

- [ ] **Step 1: 写失败的测试**

`packages/prompt-stack/tests/match.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { globToRegExp, scoreRule, selectRule } from '../src/match.ts'
import type { Rule } from '../src/types.ts'

describe('globToRegExp', () => {
  test('* 匹配任意后缀，锚定全串', () => {
    const re = globToRegExp('deepseek-*')
    expect(re.test('deepseek-v4')).toBe(true)
    expect(re.test('deepseek-')).toBe(true)
    expect(re.test('deepseek')).toBe(false)
    expect(re.test('x-deepseek-v4')).toBe(false)
  })

  test('正则元字符被转义（. 不通配）', () => {
    const re = globToRegExp('gpt-4*')
    expect(re.test('gpt-4o')).toBe(true)
    expect(re.test('gptX4o')).toBe(false)
  })

  test('多段通配 gpt*codex*', () => {
    const re = globToRegExp('gpt*codex*')
    expect(re.test('gpt-5-codex')).toBe(true)
    expect(re.test('gpt-5')).toBe(false)
  })

  test('空 pattern 与全空白 pattern 抛错', () => {
    expect(() => globToRegExp('')).toThrow(/non-empty/)
    expect(() => globToRegExp('   ')).toThrow(/non-empty/)
  })
})

describe('scoreRule', () => {
  test('model 精确 = 4，modelPattern = 2，provider = 1，累加', () => {
    expect(scoreRule({ model: 'deepseek-v4' }, 'deepseek', 'deepseek-v4')).toBe(4)
    expect(scoreRule({ modelPattern: 'deepseek-*' }, 'deepseek', 'deepseek-v4')).toBe(2)
    expect(scoreRule({ provider: 'deepseek' }, 'deepseek', 'deepseek-v4')).toBe(1)
    expect(scoreRule({ provider: 'deepseek', model: 'deepseek-v4' }, 'deepseek', 'deepseek-v4')).toBe(5)
    expect(scoreRule({ provider: 'deepseek', modelPattern: 'deepseek-*' }, 'deepseek', 'deepseek-v4')).toBe(3)
  })

  test('任一指定字段不匹配则整条不命中（AND 语义）', () => {
    expect(scoreRule({ provider: 'deepseek', model: 'v3' }, 'deepseek', 'deepseek-v4')).toBe(0)
    expect(scoreRule({ modelPattern: 'claude*' }, 'deepseek', 'deepseek-v4')).toBe(0)
    expect(scoreRule({ provider: 'openai' }, 'deepseek', 'deepseek-v4')).toBe(0)
  })

  test('provider/model 为 undefined 时不命中依赖它们的字段', () => {
    expect(scoreRule({ model: 'm' }, undefined, undefined)).toBe(0)
    expect(scoreRule({ modelPattern: '*' }, undefined, undefined)).toBe(0)
    expect(scoreRule({ provider: 'p' }, undefined, 'm')).toBe(0)
    expect(scoreRule({ modelPattern: '*' }, undefined, 'm')).toBe(2)
  })
})

describe('selectRule', () => {
  const rules: Rule[] = [
    { match: { provider: 'deepseek' }, append: 'provider-rule' },
    { match: { modelPattern: 'deepseek-*' }, append: 'pattern-rule' },
    { match: { model: 'deepseek-v4' }, append: 'exact-rule' },
  ]

  test('精确 id > 通配 > provider-only', () => {
    expect(selectRule(rules, 'deepseek', 'deepseek-v4')?.append).toBe('exact-rule')
    expect(selectRule(rules, 'deepseek', 'deepseek-v3')?.append).toBe('pattern-rule')
    expect(selectRule(rules, 'deepseek', 'other')?.append).toBe('provider-rule')
  })

  test('同分取配置序靠前者', () => {
    const tied: Rule[] = [
      { match: { modelPattern: 'gpt-4*' }, append: 'first' },
      { match: { modelPattern: 'gpt*' }, append: 'second' },
    ]
    expect(selectRule(tied, 'openai', 'gpt-4o')?.append).toBe('first')
  })

  test('无命中返回 undefined', () => {
    expect(selectRule(rules, 'openai', 'gpt-4o')).toBeUndefined()
    expect(selectRule([], 'deepseek', 'deepseek-v4')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter prompt-stack test`
Expected: FAIL（`../src/match.ts` 不存在）

- [ ] **Step 3: 写 src/types.ts**

```ts
/** prompt-stack 的配置类型（仅类型，无运行时代码）。 */

/** 一个语义层：name 同时是 section 名后缀（`prompt-stack:<name>`）。 */
export interface LayerConfig {
  name: string
  /** 拼接顺序，升序；建议区间见 spec（0 persona / 10–40 domain / 50 task）。 */
  order: number
  /** 层文本，支持 dsh 严格插值 `{{variable}}`。 */
  text: string
}

/** 模型匹配条件：三字段均可选但至少一个；多字段为 AND 语义。 */
export interface RuleMatch {
  /** provider 精确匹配。 */
  provider?: string
  /** 模型 id 精确匹配。 */
  model?: string
  /** 模型 id glob（`*` / `?`），如 `deepseek-*`、`gpt*codex*`。 */
  modelPattern?: string
}

/** 一条模型规则：命中后按层覆盖文本，可选追加 model-notes。 */
export interface Rule {
  match: RuleMatch
  /** 层名 -> 替换文本。 */
  overrides?: Record<string, string>
  /** 命中时渲染为固定追加层 `prompt-stack:model-notes`。 */
  append?: string
}

/** 插件配置（整体替换语义，不做深合并）。 */
export interface Config {
  layers: LayerConfig[]
  rules: Rule[]
}
```

- [ ] **Step 4: 写 src/match.ts**

```ts
/** 模型规则匹配：glob 编译、AND 打分、最高分选择。 */
import type { Rule, RuleMatch } from './types.ts'

/** 正则元字符（`*` 与 `?` 除外——它们是 glob 通配符，之后单独展开）。 */
const REGEXP_META = /[.+^${}()|[\]\\]/g

/**
 * 把 glob（`*` = 任意串，`?` = 单字符）编译为锚定全串的正则。
 * @param pattern - 非空 glob；空或全空白抛错（激活期响亮报错的调用点在 apply）。
 * @returns 锚定全串的正则。
 */
export function globToRegExp(pattern: string): RegExp {
  if (pattern.trim() === '') {
    throw new Error('prompt-stack: modelPattern must be a non-empty glob')
  }
  const source = pattern
    .replace(REGEXP_META, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')
  return new RegExp(`^${source}$`)
}

/**
 * 给一条规则的 match 打分：任一指定字段不匹配则整条不命中（返回 0）；
 * 命中分值为 model=4 / modelPattern=2 / provider=1 的累加。
 * @param match - 规则的匹配条件。
 * @param provider - 当前 agent 的 provider（创建期配置），可缺省。
 * @param model - 当前 agent 的模型 id，可缺省。
 * @returns 命中分值，0 表示不命中。
 */
export function scoreRule(match: RuleMatch, provider: string | undefined, model: string | undefined): number {
  let score = 0
  if (match.provider !== undefined) {
    if (match.provider !== provider) return 0
    score += 1
  }
  if (match.model !== undefined) {
    if (match.model !== model) return 0
    score += 4
  }
  if (match.modelPattern !== undefined) {
    if (model === undefined || !globToRegExp(match.modelPattern).test(model)) return 0
    score += 2
  }
  return score
}

/**
 * 选出唯一命中规则：最高分者，同分取配置序靠前者。
 * @param rules - 配置中的规则数组（顺序即优先级仲裁序）。
 * @param provider - 当前 agent 的 provider，可缺省。
 * @param model - 当前 agent 的模型 id，可缺省。
 * @returns 命中规则；无命中返回 undefined。
 */
export function selectRule(rules: readonly Rule[], provider: string | undefined, model: string | undefined): Rule | undefined {
  let best: Rule | undefined
  let bestScore = 0
  for (const rule of rules) {
    const score = scoreRule(rule.match, provider, model)
    if (score > bestScore) {
      best = rule
      bestScore = score
    }
  }
  return best
}
```

注：每次组装对 ≤13 条规则现编译 glob 正则，开销可忽略；不为它做预编译缓存（KISS）。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter prompt-stack test`
Expected: PASS（smoke + match 全部）

- [ ] **Step 6: typecheck + Commit（先经用户确认）**

Run: `pnpm --filter prompt-stack typecheck`

```bash
git add packages/prompt-stack
git commit -m "feat(prompt-stack): glob 匹配与规则打分选择"
```

---

### Task 3: 默认配置文本（`src/defaults.ts`）

**Files:**
- Create: `packages/prompt-stack/src/defaults.ts`
- Modify: `packages/prompt-stack/src/index.ts`（临时导入以验证类型，最终形态在 Task 4）
- Test: `packages/prompt-stack/tests/defaults.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `LayerConfig`/`Rule`/`Config` 类型、`selectRule`、`globToRegExp`。
- Produces: `DEFAULT_LAYERS: LayerConfig[]`（唯一一层 `base`，order 0）、`DEFAULT_RULES: Rule[]`（13 条，见下表）。Task 4 的 Config schema 用它们做 `.default()`。

**默认规则表（顺序即同分仲裁序，不得调整）：**

| # | match | 内容 | 改写来源（`https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt/<file>`） |
|---|---|---|---|
| 1 | `modelPattern: "claude*"` | overrides.base = ANTHROPIC_TEXT | anthropic.txt |
| 2 | `modelPattern: "gemini-*"` | overrides.base = GEMINI_TEXT | gemini.txt |
| 3 | `modelPattern: "gpt-4*"` | overrides.base = BEAST_TEXT | beast.txt |
| 4 | `modelPattern: "o1*"` | overrides.base = BEAST_TEXT | 同上 |
| 5 | `modelPattern: "o3*"` | overrides.base = BEAST_TEXT | 同上 |
| 6 | `modelPattern: "gpt*codex*"` | overrides.base = CODEX_TEXT | codex.txt |
| 7 | `modelPattern: "gpt*"` | overrides.base = GPT_TEXT | gpt.txt |
| 8 | `modelPattern: "kimi*"` | overrides.base = KIMI_TEXT | kimi.txt |
| 9 | `provider: "moonshotai"` | overrides.base = KIMI_TEXT | 同上 |
| 10 | `provider: "moonshotai-cn"` | overrides.base = KIMI_TEXT | 同上 |
| 11 | `provider: "kimi-for-coding"` | overrides.base = KIMI_TEXT | 同上 |
| 12 | `modelPattern: "deepseek*"` | **仅 append** = DEEPSEEK_APPEND | DeepSeek 官方建议蒸馏（文本见 Step 3，计划中已写死） |
| 13 | `modelPattern: "glm-*"` | **仅 append** = GLM_APPEND | 智谱官方建议蒸馏（文本见 Step 3，计划中已写死） |

- [ ] **Step 1: 写失败的测试**

`packages/prompt-stack/tests/defaults.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { DEFAULT_LAYERS, DEFAULT_RULES } from '../src/defaults.ts'
import { selectRule } from '../src/match.ts'

/** 所有默认文本中禁止出现的 opencode 专有标记（大小写不敏感者另行小写化比较）。 */
const FORBIDDEN = ['opencode', '/bug', '/help', 'ctrl+p', 'todowrite', 'apply_patch', 'webfetch', 'opencode.ai', 'anomalyco']

/** 每条规则文本（overrides 与 append）的必含标记。 */
const REQUIRED_MARKERS: Array<{ ruleIndex: number; markers: string[] }> = [
  { ruleIndex: 0, markers: ['Professional objectivity'] },        // claude → anthropic
  { ruleIndex: 1, markers: ['Core Mandates'] },                   // gemini
  { ruleIndex: 2, markers: ['Workflow', 'root cause'] },          // gpt-4* → beast
  { ruleIndex: 5, markers: ['Editing constraints'] },             // gpt*codex* → codex
  { ruleIndex: 6, markers: ['Autonomy and persistence'] },        // gpt* → gpt
  { ruleIndex: 7, markers: ['same language as the user'] },       // kimi* → kimi
  { ruleIndex: 12, markers: ['reasoning_content'] },              // glm-* append
]

function allTexts(): string[] {
  const texts = DEFAULT_LAYERS.map(layer => layer.text)
  for (const rule of DEFAULT_RULES) {
    texts.push(...Object.values(rule.overrides ?? {}))
    if (rule.append !== undefined) texts.push(rule.append)
  }
  return texts
}

describe('DEFAULT_LAYERS / DEFAULT_RULES 结构', () => {
  test('默认只有 base 层，order 0', () => {
    expect(DEFAULT_LAYERS).toHaveLength(1)
    expect(DEFAULT_LAYERS[0].name).toBe('base')
    expect(DEFAULT_LAYERS[0].order).toBe(0)
    expect(DEFAULT_LAYERS[0].text.length).toBeGreaterThan(500)
  })

  test('13 条默认规则；deepseek/glm 仅 append 无 overrides', () => {
    expect(DEFAULT_RULES).toHaveLength(13)
    const deepseek = DEFAULT_RULES[11]
    const glm = DEFAULT_RULES[12]
    expect(deepseek.match).toEqual({ modelPattern: 'deepseek*' })
    expect(deepseek.overrides).toBeUndefined()
    expect(deepseek.append).toBeDefined()
    expect(glm.match).toEqual({ modelPattern: 'glm-*' })
    expect(glm.overrides).toBeUndefined()
    expect(glm.append).toBeDefined()
  })
})

describe('默认文本卫生', () => {
  test('不含 opencode 专有标记', () => {
    for (const text of allTexts()) {
      const lower = text.toLowerCase()
      for (const token of FORBIDDEN) {
        expect(lower, `文本不应包含 "${token}"`).not.toContain(token)
      }
    }
  })

  test('各模型族文本含必含标记', () => {
    for (const { ruleIndex, markers } of REQUIRED_MARKERS) {
      const rule = DEFAULT_RULES[ruleIndex]
      const text = rule.overrides?.base ?? rule.append ?? ''
      for (const marker of markers) {
        expect(text, `rules[${ruleIndex}] 应包含 "${marker}"`).toContain(marker)
      }
    }
  })
})

describe('默认规则的选择行为', () => {
  test('claude/gemini/deepseek/glm/kimi 路由', () => {
    expect(selectRule(DEFAULT_RULES, 'anthropic', 'claude-sonnet-4')?.overrides?.base).toContain('Professional objectivity')
    expect(selectRule(DEFAULT_RULES, 'google', 'gemini-2.5-pro')?.overrides?.base).toContain('Core Mandates')
    expect(selectRule(DEFAULT_RULES, 'deepseek', 'deepseek-v4')?.append).toBeDefined()
    expect(selectRule(DEFAULT_RULES, 'zhipu', 'glm-4.6')?.append).toContain('reasoning_content')
    expect(selectRule(DEFAULT_RULES, 'moonshotai', 'k2')?.overrides?.base).toContain('same language as the user')
    expect(selectRule(DEFAULT_RULES, 'kimi-for-coding', 'k3-256k')?.overrides?.base).toContain('same language as the user')
  })

  test('gpt-4o 同分取配置序靠前者（beast 而非 gpt）', () => {
    expect(selectRule(DEFAULT_RULES, 'openai', 'gpt-4o')?.overrides?.base).toContain('Workflow')
  })

  test('gpt-5-codex 命中 codex 规则', () => {
    expect(selectRule(DEFAULT_RULES, 'openai', 'gpt-5-codex')?.overrides?.base).toContain('Editing constraints')
  })

  test('未知模型无命中', () => {
    expect(selectRule(DEFAULT_RULES, 'unknown', 'mystery-1')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter prompt-stack test`
Expected: FAIL（`../src/defaults.ts` 不存在）

- [ ] **Step 3: 写 src/defaults.ts**

文件骨架（常量名与结构必须如下；各 TEXT 常量的内容与改写契约见后）：

```ts
// 默认文本改写自 opencode（MIT 许可，https://github.com/anomalyco/opencode，
// packages/opencode/src/session/prompt/*.txt @ dev 分支）：剔除 opencode 专有内容
// （身份自述、具体工具名、/help /bug ctrl+p、issues URL、opencode.ai），保留模型族
// 行为指导。身份首句刻意不写——dsh 原生 `harness:identity` 段（order -100）已覆盖身份。
import type { LayerConfig, Rule } from './types.ts'

/** 通用基座层文本（default.txt 改写版）。 */
export const BASE_TEXT = `...见下`

/** 模型族行为指导文本（anthropic/gemini/beast/codex/gpt/kimi 改写版，
 *  内容按下文"6 个模型族 TEXT 的改写契约"逐条产出，英文，不写身份首句）。 */
export const ANTHROPIC_TEXT = `...按契约产出...`
export const GEMINI_TEXT = `...`
export const BEAST_TEXT = `...`
export const CODEX_TEXT = `...`
export const GPT_TEXT = `...`
export const KIMI_TEXT = `...`

/** DeepSeek 官方建议蒸馏（仅追加，不覆盖 base）。 */
export const DEEPSEEK_APPEND = `...见下`

/** 智谱官方建议蒸馏（仅追加，不覆盖 base）。 */
export const GLM_APPEND = `...见下`

/** 默认语义层：仅 base。 */
export const DEFAULT_LAYERS: LayerConfig[] = [
  { name: 'base', order: 0, text: BASE_TEXT },
]

/** 默认模型规则（顺序即同分仲裁序，勿调整）。 */
export const DEFAULT_RULES: Rule[] = [
  { match: { modelPattern: 'claude*' }, overrides: { base: ANTHROPIC_TEXT } },
  { match: { modelPattern: 'gemini-*' }, overrides: { base: GEMINI_TEXT } },
  { match: { modelPattern: 'gpt-4*' }, overrides: { base: BEAST_TEXT } },
  { match: { modelPattern: 'o1*' }, overrides: { base: BEAST_TEXT } },
  { match: { modelPattern: 'o3*' }, overrides: { base: BEAST_TEXT } },
  { match: { modelPattern: 'gpt*codex*' }, overrides: { base: CODEX_TEXT } },
  { match: { modelPattern: 'gpt*' }, overrides: { base: GPT_TEXT } },
  { match: { modelPattern: 'kimi*' }, overrides: { base: KIMI_TEXT } },
  { match: { provider: 'moonshotai' }, overrides: { base: KIMI_TEXT } },
  { match: { provider: 'moonshotai-cn' }, overrides: { base: KIMI_TEXT } },
  { match: { provider: 'kimi-for-coding' }, overrides: { base: KIMI_TEXT } },
  { match: { modelPattern: 'deepseek*' }, append: DEEPSEEK_APPEND },
  { match: { modelPattern: 'glm-*' }, append: GLM_APPEND },
]
```

**BASE_TEXT 全文（写死，逐字使用）：**

```text
IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.

# Tone and style
You should be concise, direct, and to the point. When you run a non-trivial shell command, explain what the command does and why you are running it, so the user understands what you are doing (this is especially important when the command changes the user's system).
Your output will be displayed on a command line interface. You can use GitHub-flavored markdown for formatting; it will be rendered in a monospace font using the CommonMark specification.
Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools or code comments as a means to communicate with the user during the session.
If you cannot or will not help the user with something, do not preach about why or what it could lead to. Offer helpful alternatives if possible, and otherwise keep your response to 1-2 sentences.
Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
IMPORTANT: Minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy. Only address the specific query or task at hand, avoiding tangential information unless absolutely critical. If you can answer in 1-3 sentences or a short paragraph, please do.
IMPORTANT: Do not answer with unnecessary preamble or postamble (such as explaining your code or summarizing your actions) unless the user asks you to.
Keep responses short: answer the user's question directly, without elaboration. Avoid introductions, conclusions, and restatements such as "The answer is ..." or "Here is what I will do next ...".
<example>
user: what is 2+2?
assistant: 4
</example>

<example>
user: what files are in the directory src/?
assistant: [lists files and sees foo.c, bar.c, baz.c]
user: which file contains the implementation of foo?
assistant: src/foo.c
</example>

# Proactiveness
Be proactive only when the user asks you to do something. Strike a balance between:
1. Doing the right thing when asked, including follow-up actions the request implies.
2. Not surprising the user with actions taken without asking.
If the user asks how to approach something, answer the question first instead of immediately jumping into action.
Do not add a code-explanation summary unless requested. After working on a file, just stop.

# Following conventions
When making changes to files, first understand the file's code conventions. Mimic code style, use existing libraries and utilities, and follow existing patterns.
- NEVER assume that a given library is available, even if it is well known. Whenever you write code that uses a library or framework, first check that this codebase already uses it (neighboring files, package manifests such as package.json or cargo.toml).
- When you create a new component, first look at existing components: framework choice, naming conventions, typing, and other conventions.
- When you edit a piece of code, read its surrounding context (especially its imports) and make the change idiomatic to it.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys. Never commit secrets or keys to the repository.

# Code style
- IMPORTANT: DO NOT ADD ***ANY*** COMMENTS unless asked.

# Doing tasks
For software engineering tasks (fixing bugs, adding features, refactoring, explaining code, and more):
- Use the available search tools extensively, in parallel and sequentially, to understand the codebase and the user's query.
- Implement the solution using all tools available to you.
- Verify the solution with tests where possible. NEVER assume a specific test framework or test script; check the README or search the codebase to determine the testing approach.
- When you have completed a task, run the project's lint and typecheck commands if they exist. If you cannot find the correct command, ask the user for it.
- NEVER commit changes unless the user explicitly asks you to.

Tool results and user messages may include <system-reminder> tags. They contain useful information and reminders. They are NOT part of the user's provided input or the tool result.

# Tool usage policy
- For file or content search, prefer dedicated search tools over shell commands to reduce context usage.
- You can call multiple tools in a single response. Batch independent calls together for optimal performance; run dependent calls sequentially.

Before you begin work, think about what the code you are editing is supposed to do, based on filenames and directory structure.

# Code references
When referencing specific functions or pieces of code, use the pattern `file_path:line_number` so the user can easily navigate to the source location.
```

**DEEPSEEK_APPEND 全文（写死，逐字使用）：**

```text
Notes for DeepSeek models:
- Tool calls follow the OpenAI function-calling style; pass arguments strictly according to each tool's JSON schema.
- Reasoning models (e.g. deepseek-reasoner) emit their reasoning before the final answer; do not ask them to skip the thinking process.
```

**GLM_APPEND 全文（写死，逐字使用）：**

```text
Notes for GLM models:
- Tool calls follow the OpenAI function-calling style; pass arguments strictly according to each tool's JSON schema.
- For thinking-enabled GLM models, the reasoning_content of each message must be passed back verbatim on the next request; never drop or rewrite it.
- With interleaved thinking, keep the reasoning context across tool-call rounds.
```

**6 个模型族 TEXT 的改写契约**（执行时 webfetch 源文件，按下表逐条改写；每条"保留"要点都要在产出文本中有对应表述，每条"剔除"项都不得残留；英文撰写；不写身份首句）：

- **ANTHROPIC_TEXT** ← anthropic.txt（105 行）
  - 剔除：L1/L3 身份自述；L8 `ctrl+p`；L9–10 issues 反馈地址；L12 opencode 文档查询；L23–67 整段 `# Task Management`（TodoWrite 工具名 + 两个长示例——把"频繁用任务列表规划跟踪、完成即勾掉、复杂任务拆小步骤"泛化保留为 2–3 句，不带工具名）；L73/L96/L79–94 的具体工具名（Task/WebFetch/Read/Edit/Write/Bash/cat/sed/awk）泛化为"专用搜索/编辑工具优先于 shell"。
  - 保留要点：URL 禁令；emoji 仅被要求时；CLI GFM 等宽渲染；输出即沟通、工具用于行动；优先编辑现有文件、不新建不必要文件；**`# Professional objectivity` 整段（事实导向、不虚假附和、严谨标准一视同仁、不确定先查证）**——节标题逐字保留；搜索→实现→验证；system-reminder 权威性；独立工具并行、依赖串行；`file:line` 代码引用。
- **GEMINI_TEXT** ← gemini.txt（155 行）
  - 剔除：L1 身份自述；L13/L20–24/L28/L33 的工具名与参数句法（`read`/`write`/`grep`/`glob`/`file_path`/`npm init`/`npx create-react-app`——精神"用绝对路径""专用工具优先"保留）；L49–58 bash 工具行为细节；L61–62 `/help` `/bug`；L64–152 整段 `# Examples`（`[tool_call: ...]` 渲染格式）；L154–155 收尾句。
  - 保留要点（节标题 `# Core Mandates` 逐字保留）：严格遵循既有约定、先读周边代码/测试/配置；不臆测库可用性；模仿既有风格/结构/类型/架构；注释少而精聚焦 why；彻底完成请求含蕴含的后续动作；超范围动作先确认、被问"怎么做"先解释；改完不多余总结；不擅自回滚改动；任务五步法（理解→计划→实现→测试→构建/lint）；新应用先提计划获准再实现；CLI 直接简洁最小输出；安全：改系统状态前说明影响、不泄露 secrets；独立并行/依赖串行；尊重用户取消；文件操作绝对路径；前端 UI 质量要求；效率与安全平衡、持续工作至完成。
- **BEAST_TEXT** ← beast.txt（147 行）
  - 剔除：L1 身份自述（保留 "keep going until the user's query is completely resolved" 精神到首段）；L13/L33/L68 `webfetch` 工具名与 `google.com/search?q=...` 具体 URL（精神"用可用搜索手段联网核实"保留）；L17–18 "using Google every single time" 绝对化措辞；L22 resume/continue 检查 todo 续做；L24/L34 "sequential thinking tool"；L83 "read 2000 lines at a time"（泛化为"充分读上下文"）；L113–123 整段 `# Memory`（memory.instruction.md + front matter——泛化为"记忆用户偏好"一句）。
  - 保留要点（`# Workflow` 节标题逐字保留；调试节必须含 "root cause" 原词）：回合制彻底解决不提前结束；思考彻底但避免重复冗长；自主完成不依赖用户；结束前逐项核对验证；说要调用工具就必须真调用；训练数据过时须联网核实第三方用法、读原文递归收集；调用前一句告知要做什么、调用后反思结果；检查边界反复测试；10 步工作流（抓 URL→深理解→查码→调研→计划→小步实现→调试→频繁测试→迭代→反思）；调试找根因而非症状、用打印/日志检验假设；沟通清晰简洁 casual 专业；避免重复读文件；不自动 git stage/commit。
- **CODEX_TEXT** ← codex.txt（79 行）
  - 剔除：L1 身份自述；L8 `apply_patch` 与 `gofmt` 示例（精神"单文件编辑用编辑工具"保留）；L12–14 Read/Edit/Write/Glob/Grep 工具名清单；L14 `bun` 命令示例；L76–79 文件引用格式细节（`file://`/`vscode://` 禁止等——保留"统一用 `file_path:line_number`"）。
  - 保留要点（节标题 `## Editing constraints` 逐字保留）：编辑默认 ASCII；注释只在必要处；专用工具优先于 shell 做文件操作、shell 用于 git/构建/测试；无依赖并行/有依赖串行；dirty worktree 卫生（不撤他人改动、不 amend、不用破坏性 git 命令）；前端避免平庸模板布局（排版/色彩/动效/移动端）；已有设计系统则沿用；默认极简、真被卡住才问一个带默认建议的问题；采取合理方案并说明而非逐字要权限；实质性工作给清晰总结；不倾倒大文件、引用路径；给后续步骤建议；最终回答排版规则（fenced code 带语言标签等）。
- **GPT_TEXT** ← gpt.txt（107 行）
  - 剔除：L1 身份自述；L5 "Glob and Grep tools (powered by rg)"；L6 `multi_tool_use.parallel` 与 `echo "====";` 示例；L27 `apply_patch`；L28 "Do not use Python to read/write files"（泛化为"用专用工具而非脚本读写文件"）；L60/L93 寒暄开场示例；L64 "save/copy this file"；L81–107 `commentary`/`final` 渠道机制（精神"中间进度简短、只在有实质信息时发；最终回答匹配任务复杂度"保留为一节）。
  - 保留要点（节标题 `## Autonomy and persistence` 逐字保留）：最小正确改动、两方案选更小；不做无具体需要的向后兼容代码；默认假设用户要你改代码/跑工具不空谈；遇障碍自己解决；端到端完成（实现→验证→说明）不中途停；不撤他人/其他 agent 改动；简单请求直接执行；bug 报告诊断根因尝试复现；review 请求发现优先按严重度排序带 file:line；前端避免 AI slop；不开头寒暄/元评论；GFM 渲染、无嵌套 bullet、inline code 标命令；不用 emoji（除非要求）。
- **KIMI_TEXT** ← kimi.txt（95 行）
  - 剔除：L1 身份自述；L11 `task` 工具名（泛化"可委托子代理并给完整上下文"）；L32/L34/L38 的 `write`/`edit`/`bash`/`read`/`glob`/`grep` 工具名；L17 plan mode 只读限制；L70–83 "Why AGENTS.md?" 解释段（保留"先读项目的 AGENTS.md/README 理解约定"一句——AGENTS.md 概念本身保留）。
  - 保留要点（必须含 "same language as the user" 原句或等价明确表述）：以行动为主用工具做真实改动不只文字描述；简单问题直接答；需要改文件必须用工具实现；一次响应可并行多个非干扰工具调用；依据工具结果决定下一步；尊重 system-reminder 权威性可覆盖正常行为；**用与用户相同的语言回复**；从零构建：理解需求→澄清→架构→模块化；现有库先读再改找根因补测试；最小改动沿用项目风格；不做 git 变更除非明确要求；调研先计划、隔离安装第三方包、验证生成物；非沙箱环境谨慎不碰工作目录外；文件操作用绝对路径；HELPFUL/CONCISE/ACCURATE、不跑题不臆造、果断行动不过早放弃、保持简单。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter prompt-stack test`
Expected: PASS（含 defaults 全部用例）。若 FORBIDDEN 标记误伤（如某文本合理包含 "web" 字样——注意 FORBIDDEN 里是 'webfetch' 全小写比较，正常单词不会误伤），先核对是否真为 opencode 专有残留，是则改写，不是才调整测试并说明理由。

- [ ] **Step 5: typecheck + Commit（先经用户确认）**

Run: `pnpm --filter prompt-stack typecheck`

```bash
git add packages/prompt-stack
git commit -m "feat(prompt-stack): 默认层与按模型族改写的默认规则文本"
```

---

### Task 4: Config schema、校验与 apply（`src/index.ts` 完成形态）

**Files:**
- Modify: `packages/prompt-stack/src/index.ts`（整体重写为完成形态）
- Test: `packages/prompt-stack/tests/config.test.ts`
- Test: `packages/prompt-stack/tests/assemble.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `globToRegExp`/`selectRule` 与全部类型；Task 3 的 `DEFAULT_LAYERS`/`DEFAULT_RULES`。
- Produces（插件对外契约）: `Config: z<Config>`（schemastery schema，`.default()` 用 Task 3 常量）、`validateConfig(config: Config): void`、`apply(ctx: Context, config: Config): void`。注册 section 名 `prompt-stack:<层名>` 与 `prompt-stack:model-notes`；注册 prompt 变量 `model` 与 `provider`。

- [ ] **Step 1: 写失败的校验测试**

`packages/prompt-stack/tests/config.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { Config, validateConfig } from '../src/index.ts'
import { DEFAULT_LAYERS, DEFAULT_RULES } from '../src/defaults.ts'
import type { Config as ConfigT } from '../src/types.ts'

const base: ConfigT = {
  layers: [
    { name: 'base', order: 0, text: 'BASE' },
    { name: 'task', order: 50, text: 'TASK' },
  ],
  rules: [{ match: { modelPattern: 'deepseek-*' }, overrides: { task: 'T' }, append: 'N' }],
}

describe('validateConfig', () => {
  test('合法配置与插件默认配置都通过', () => {
    expect(() => validateConfig(base)).not.toThrow()
    expect(() => validateConfig({ layers: DEFAULT_LAYERS, rules: DEFAULT_RULES })).not.toThrow()
  })

  test('layers 为空数组抛错', () => {
    expect(() => validateConfig({ layers: [], rules: [] })).toThrow(/at least one layer/)
  })

  test('层名重复抛错', () => {
    const config: ConfigT = { ...base, layers: [...base.layers, { name: 'base', order: 9, text: 'X' }] }
    expect(() => validateConfig(config)).toThrow(/duplicate layer name "base"/)
  })

  test('保留层名 model-notes 抛错', () => {
    const config: ConfigT = { ...base, layers: [...base.layers, { name: 'model-notes', order: 9, text: 'X' }] }
    expect(() => validateConfig(config)).toThrow(/reserved/)
  })

  test('overrides 引用不存在的层名抛错', () => {
    const config: ConfigT = { ...base, rules: [{ match: { model: 'm' }, overrides: { ghost: 'X' } }] }
    expect(() => validateConfig(config)).toThrow(/unknown layer "ghost"/)
  })

  test('match 三字段全空抛错（带规则序号）', () => {
    const config: ConfigT = { ...base, rules: [{ match: {} }] }
    expect(() => validateConfig(config)).toThrow(/rules\[0\].match/)
  })

  test('空 modelPattern 抛错', () => {
    const config: ConfigT = { ...base, rules: [{ match: { modelPattern: '  ' } }] }
    expect(() => validateConfig(config)).toThrow(/non-empty glob/)
  })
})

describe('Config schema', () => {
  test('空输入产出默认配置（layers/rules 整体默认）', () => {
    const parsed = Config({})
    expect(parsed.layers).toEqual(DEFAULT_LAYERS)
    expect(parsed.rules).toEqual(DEFAULT_RULES)
  })

  test('用户配置整体替换默认值（不做深合并）', () => {
    const parsed = Config({ layers: [{ name: 'only', order: 3, text: 'X' }] })
    expect(parsed.layers).toEqual([{ name: 'only', order: 3, text: 'X' }])
    expect(parsed.rules).toEqual(DEFAULT_RULES)
  })
})
```

- [ ] **Step 2: 写失败的组装集成测试**

`packages/prompt-stack/tests/assemble.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt, type AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply, Config } from '../src/index.ts'

/** 构造只带 options 的最小 agent 替身（assemble 路径只读 agent.options）。 */
function agentContext(options: { provider?: string; model?: string }): AssembleContext {
  return { agent: { options } as unknown as Agent }
}

const CONFIG = {
  layers: [
    { name: 'base', order: 0, text: 'BASE' },
    { name: 'task', order: 50, text: 'TASK' },
  ],
  rules: [
    { match: { modelPattern: 'claude*' }, overrides: { base: 'CLAUDE-BASE' } },
    { match: { provider: 'deepseek', model: 'deepseek-v4' }, overrides: { task: 'V4-TASK' }, append: 'V4-NOTES' },
  ],
}

async function boot(config: unknown = CONFIG): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' })
  apply(ctx, Config(config))
  return ctx
}

function sectionTexts(sections: Array<{ name: string; text: string }>): Record<string, string> {
  return Object.fromEntries(sections.map(section => [section.name, section.text]))
}

describe('prompt-stack 组装', () => {
  test('裸组装（无 agent）：全部默认文本，model-notes 不渲染', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble()
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('BASE')
    expect(texts['prompt-stack:task']).toBe('TASK')
    expect(texts['prompt-stack:model-notes']).toBe('')
    // 空段在渲染期被丢弃
    expect(renderPrompt(assembly)).not.toContain('model-notes')
  })

  test('命中规则：覆盖层替换、未覆盖层保持默认、append 进 model-notes 且排在最后', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble(agentContext({ provider: 'deepseek', model: 'deepseek-v4' }))
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('BASE')
    expect(texts['prompt-stack:task']).toBe('V4-TASK')
    expect(texts['prompt-stack:model-notes']).toBe('V4-NOTES')
    // model-notes order = 最大层 order(50) + 1 = 51，排在 prompt-stack 各层最后
    const names = assembly.sections.map(section => section.name)
    expect(names.indexOf('prompt-stack:model-notes')).toBeGreaterThan(names.indexOf('prompt-stack:task'))
  })

  test('通配命中另一规则：只替换被覆盖层', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble(agentContext({ model: 'claude-sonnet-4' }))
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('CLAUDE-BASE')
    expect(texts['prompt-stack:task']).toBe('TASK')
    expect(texts['prompt-stack:model-notes']).toBe('')
  })

  test('注册的 model/provider 变量来自 agent.options，{{model}} 可插值', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    apply(ctx, Config({ layers: [{ name: 'who', order: 0, text: 'model={{model}} provider={{provider}}' }], rules: [] }))
    const assembly = await ctx.systemPrompt.assemble(agentContext({ provider: 'deepseek', model: 'deepseek-v4' }))
    expect(renderPrompt(assembly)).toContain('model=deepseek-v4 provider=deepseek')
  })

  test('Config 校验失败在 apply 期响亮抛错', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    expect(() => apply(ctx, Config({ layers: [], rules: [] }))).toThrow(/at least one layer/)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter prompt-stack test`
Expected: FAIL（`Config`/`validateConfig` 未导出）

- [ ] **Step 4: 整体重写 src/index.ts 为完成形态**

```ts
/** prompt-stack 插件：语义化提示词分层 + 按模型规则覆盖层文本。 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// type-only 导入激活声明合并：Context.systemPrompt 与 AssembleContext.agent。
import type {} from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { DEFAULT_LAYERS, DEFAULT_RULES } from './defaults.ts'
import { globToRegExp, selectRule } from './match.ts'
import type { Config as ConfigT, Rule } from './types.ts'

export type { Config, LayerConfig, Rule, RuleMatch } from './types.ts'

export const name = 'prompt-stack'

export const inject = ['systemPrompt']

/** 固定追加层的层名（保留，用户层不得使用）。 */
export const MODEL_NOTES_LAYER = 'model-notes'

export const Config: z<ConfigT> = z.object({
  layers: z.array(z.object({
    name: z.string().required(),
    order: z.number().required(),
    text: z.string().required(),
  })).default(DEFAULT_LAYERS),
  rules: z.array(z.object({
    match: z.object({
      provider: z.string(),
      model: z.string(),
      modelPattern: z.string(),
    }).required(),
    overrides: z.dict(z.string()),
    append: z.string(),
  })).default(DEFAULT_RULES),
}) as z<ConfigT>

/**
 * 激活期校验（dsh「误配置响亮失败」惯例）：空 layers、层名重复、保留层名、
 * overrides 引用未知层、空 match、非法 glob 全部抛错。
 * @param config - 已经过 schema 解析的配置。
 */
export function validateConfig(config: ConfigT): void {
  if (config.layers.length === 0) {
    throw new Error('prompt-stack: config.layers must define at least one layer')
  }
  const names = new Set<string>()
  for (const layer of config.layers) {
    if (layer.name === MODEL_NOTES_LAYER) {
      throw new Error(`prompt-stack: layer name "${MODEL_NOTES_LAYER}" is reserved for the rules' append text`)
    }
    if (names.has(layer.name)) {
      throw new Error(`prompt-stack: duplicate layer name "${layer.name}"`)
    }
    names.add(layer.name)
  }
  for (const [index, rule] of config.rules.entries()) {
    const { provider, model, modelPattern } = rule.match
    if (provider === undefined && model === undefined && modelPattern === undefined) {
      throw new Error(`prompt-stack: rules[${index}].match must set at least one of provider, model, modelPattern`)
    }
    // 非法 glob（空 pattern）在此抛错。
    if (modelPattern !== undefined) globToRegExp(modelPattern)
    for (const key of Object.keys(rule.overrides ?? {})) {
      if (!names.has(key)) {
        throw new Error(`prompt-stack: rules[${index}].overrides references unknown layer "${key}"`)
      }
    }
  }
}

/**
 * 每个层注册一个函数式 section；text 在每次组装时按当前 agent 的
 * provider/model 选唯一命中规则（最高分、同分取配置序靠前），用其
 * overrides 替换该层文本。裸组装（无 agent）静默用默认文本。
 */
export function apply(ctx: Context, config: ConfigT): void {
  validateConfig(config)
  const notesOrder = Math.max(...config.layers.map(layer => layer.order)) + 1
  const hitRule = (context: AssembleContext): Rule | undefined =>
    selectRule(config.rules, context.agent?.options?.provider, context.agent?.options?.model)
  for (const layer of config.layers) {
    ctx.systemPrompt.section({
      name: `prompt-stack:${layer.name}`,
      order: layer.order,
      text: (context) => hitRule(context)?.overrides?.[layer.name] ?? layer.text,
    })
  }
  // 无命中时返回空串，沿用 dsh「空段不渲染」被丢弃。
  ctx.systemPrompt.section({
    name: `prompt-stack:${MODEL_NOTES_LAYER}`,
    order: notesOrder,
    text: (context) => hitRule(context)?.append ?? '',
  })
  // 供层文本 {{model}} / {{provider}} 插值；与其他全局注册同名变量冲突时沿用 dsh 重名抛错。
  ctx.systemPrompt.variable('model', context => context.agent?.options?.model)
  ctx.systemPrompt.variable('provider', context => context.agent?.options?.provider)
}
```

注意：schema 的类型标注以实现期 typecheck 为准——`Config(...)` 在测试中直接接收未知输入，故可标为 `z<unknown, ConfigT>`；schemastery 对可选 dict 字段会注入空对象默认值，若导致 `toEqual(DEFAULT_RULES)` 断言失败，可用 `z.transform` 丢弃空 `overrides`/`append`（允许偏离，已在执行中核实）。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter prompt-stack test`
Expected: PASS（smoke + match + defaults + config + assemble 全部）

- [ ] **Step 6: typecheck + Commit（先经用户确认）**

Run: `pnpm --filter prompt-stack typecheck`

```bash
git add packages/prompt-stack
git commit -m "feat(prompt-stack): Config schema、激活期校验与 section 注册"
```

---

### Task 5: 开发回路接线 + 仓库文档同步

**Files:**
- Modify: `cordis.yml`（追加 prompt-stack 条目）
- Modify: `AGENTS.md`（目录结构 + 开发命令两节）
- Create: `packages/prompt-stack/README.md`

**Interfaces:**
- Consumes: Task 4 的完整插件。

- [ ] **Step 1: cordis.yml 追加条目**

在 `cordis.yml` 的 insert 列表末尾追加（放在 agent-team 条目之后）：

```yaml
    - id: prompt-stack
      name: prompt-stack
```

（不写 config → 走默认 layers/rules；用户要自定义时再加 `config:` 触发 HMR 验证。）

- [ ] **Step 2: 装进 web profile 并启动开发回路做人工验证**

```powershell
pnpm dsh plugin --profile web add link:D:\work\github\dsh\dsh-agent-toolkit\packages\prompt-stack
cd deepseek-harness; pnpm dsh web --patch D:\work\github\dsh\dsh-agent-toolkit\cordis.yml
```

人工验证清单（在 web UI 操作）：
1. 用 deepseek 模型建会话发一条消息 → 会话能正常跑（说明组装没抛错）。
2. 在 cordis.yml 给 prompt-stack 加一行可识别 config（如 `layers: [{ name: base, order: 0, text: "PROMPT-STACK-HMR-MARKER" }]`）保存 → HMR 重挂载不报错；再删掉还原。
3. 把一个 rule 的 match 写成 `{}`（空 match）保存 → 激活期响亮报错可见（loader 报出 `rules[0].match must set at least one of ...`）；还原。

若 profile 加载拒绝 `exports: ./src/index.ts` 的源码形式（Agent-team 先例表明 tsx 源启动下可用），回退方案：照 token-usage 的 nodeConfig 加 `tsdown.config.ts`（只保留 node 半），exports 改指 `./lib/index.js`，package.json 加 `bundle` 脚本与 tsdown 依赖，并在 AGENTS.md 补开发命令说明。

- [ ] **Step 3: 写 packages/prompt-stack/README.md**

```markdown
# prompt-stack

DeepSeek Harness 插件：语义化提示词分层 + 按模型规则覆盖层文本。

- 每个语义层注册为 `prompt-stack:<层名>` section，按 `order` 升序拼接。
- 规则按当前 agent 创建期的 `provider`/`model` 匹配（`provider` 精确 / `model` 精确 / `modelPattern` glob），打分 model=4、pattern=2、provider=1，取最高分一条（同分取配置序靠前）；命中规则的 `overrides[层名]` 替换该层文本，`append` 渲染为固定追加层 `prompt-stack:model-notes`（order = 最大层 order + 1）。
- 裸组装（无 agent）全部使用默认文本；无规则命中是正常路径，不告警。
- 默认仅一层 `base`（order 0）+ 13 条模型族规则；默认文本改写自 opencode（MIT 许可）的 session/prompt/*.txt，剔除其专有内容、保留模型族行为指导。
- 层文本支持 dsh 严格插值；插件注册 `{{model}}` / `{{provider}}` 变量（取自创建期模型配置）。

## 配置示例

\`\`\`yaml
prompt-stack:
  layers:
    - { name: persona, order: 0,  text: "你是 {{model}} 驱动的……" }
    - { name: task,    order: 50, text: "……" }
  rules:
    - match: { provider: deepseek, model: deepseek-v4 }
      overrides: { task: "V4 专用任务指引……" }
      append: "该模型需注意……"
\`\`\`

order 建议区间（与 dsh 惯例对齐）：`-100` harness identity（原生，不动）、`0` persona、`10–40` domain/领域知识、`50` task/任务指引、`100–199` 工具指引（原生，不动）；插件的 model-notes 追加层自动取最大层 order + 1。

## 已知局限

`agent.options.model` 是创建期模型；会话中通过 UI 运行时切换模型时取到的不是当步生效模型。适用场景是不同模型对应不同 agent/preset 配置；运行时切模型感知留作未来增强（`system-prompt/assemble` waterfall 路径）。
```

- [ ] **Step 4: 更新 AGENTS.md**

目录结构节中 `packages/` 列表在 agent-team 行后追加一行：

```
│   ├─ prompt-stack/     ← 提示词分层 + 按模型区分提示词（纯 Node 半，无 bundle）
```

开发命令节第一行的 agent-team 说明后补一句（或在该行尾追加）：`prompt-stack 同（pnpm --filter prompt-stack test / typecheck；纯 Node 半无 bundle）`。

- [ ] **Step 5: 全量验证 + Commit（先经用户确认）**

Run: `pnpm --filter prompt-stack test; if ($?) { pnpm --filter prompt-stack typecheck }`
Expected: 全 PASS

```bash
git add cordis.yml AGENTS.md packages/prompt-stack
git commit -m "feat(prompt-stack): 接入开发回路并同步仓库文档"
```
