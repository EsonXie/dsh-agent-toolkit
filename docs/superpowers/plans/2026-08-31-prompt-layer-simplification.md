# 提示词分层简化为四层模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把固定层栈 persona/base/domain/task 简化为「identity（原生只读）→ 模型层（内置只读）→ persona（唯一可编辑）→ 动态层（只读展示）」，persona 改普通段排在模型层之后。

**Architecture:** 保留 `LayerConfig`/rules 架构与层名兼容（方案 A）：`DEFAULT_LAYERS` 缩为单 persona 层；`base` 成为内置保留层名，固定注册 `prompt-stack:base` 段（order 0）由 `DEFAULT_RULES` 驱动；persona 注册 `prompt-stack:persona` 段（order 10），不再填原生 `deployment:persona` 槽位；bot 角色覆盖改用 dsh 原生 scoped shadow。设计依据：`docs/superpowers/specs/2026-08-31-prompt-layer-simplification-design.md`。

**Tech Stack:** TypeScript / vitest / React（浏览器半）/ dsh system-prompt section 机制。

## Global Constraints

- 所有改动在 `packages/toolkit/` 内；不触碰 `deepseek-harness/`。
- 验证命令（仓库根）：单测 `pnpm --filter dsh-agent-toolkit test`；类型检查 `pnpm --filter dsh-agent-toolkit typecheck`；构建 `pnpm --filter dsh-agent-toolkit bundle`。
- 定向跑单文件：`pnpm --filter dsh-agent-toolkit test -- src/prompt/defaults.test.ts`（路径相对 `packages/toolkit/`）。
- cordis.yml 存量 rules 配置零破坏：`base` 仍是 `overrides` 合法目标。
- cordis.yml `systemPrompt.persona` 恢复原生语义（toolkit 不再覆盖/屏蔽）。
- 迁移语义：reconcile 直接丢弃 base/domain/task 层及其已编辑文本（已与用户确认）。
- 最终渲染序：`harness:identity`(-100) → `prompt-stack:base`(0) → `prompt-stack:persona`(10) → `prompt-stack:model-notes`(11) → 工具段(100+)。
- 提交信息风格参照仓库历史（中文简述，如 `feat: ...` / `refactor: ...`）。

---

### Task 1: defaults 缩层集 + 校验规则调整

**Files:**
- Modify: `packages/toolkit/src/prompt/defaults.ts`（`DEFAULT_LAYERS` 缩为单层）
- Modify: `packages/toolkit/src/prompt/index.ts`（仅 `validateLayers`/`validateConfig`；`setupPrompt` 在 Task 2 改）
- Test: `packages/toolkit/src/prompt/defaults.test.ts`
- Test: `packages/toolkit/src/prompt/config.test.ts`

**Interfaces:**
- Produces: `DEFAULT_LAYERS: LayerConfig[]` = `[{ name: 'persona', order: 10, text: '' }]`；`validateLayers` 拒绝保留名 `'base'` 与 `'model-notes'`；`validateConfig` 的 overrides 合法目标 = `{'base'} ∪ 层名集`。Task 2/3/4 依赖这两个校验行为。

- [ ] **Step 1: 改 defaults.test.ts 为失败测试**

`packages/toolkit/src/prompt/defaults.test.ts` 中「默认固定四层」用例替换为：

```ts
  test('默认单层：persona（order 10，默认空串）；base 移出层集', () => {
    expect(DEFAULT_LAYERS).toEqual([{ name: 'persona', order: 10, text: '' }])
  })
```

- [ ] **Step 2: 改 config.test.ts 为失败测试**

`packages/toolkit/src/prompt/config.test.ts` 三处改动：

```ts
// 1) 「保留层名 model-notes 抛错」用例后追加 base 保留名用例：
  test('保留层名 base 抛错', () => {
    const config: ConfigT = { ...base, layers: [...base.layers, { name: 'base', order: 9, text: 'X' }] }
    expect(() => validateConfig(config)).toThrow(/reserved/)
  })

// 2) 新增：base 不再是存储层，但仍是 overrides 合法目标
  test('overrides 引用内置模型层 base 合法', () => {
    const config: ConfigT = { layers: [{ name: 'persona', order: 10, text: '' }], rules: [{ match: { model: 'm' }, overrides: { base: 'X' } }] }
    expect(() => validateConfig(config)).not.toThrow()
  })

// 3) 「默认规则 overrides 全部命中默认层名」改为命中「内置 base ∪ 默认层名」：
  test('默认规则 overrides 全部命中内置 base 或默认层名', () => {
    const valid = new Set(['base', ...DEFAULT_LAYERS.map(layer => layer.name)])
    for (const rule of DEFAULT_RULES) {
      for (const key of Object.keys(rule.overrides ?? {})) {
        expect(valid.has(key), `默认规则 overrides 引用未知层 "${key}"`).toBe(true)
      }
    }
  })
```

注意 config.test.ts 顶部 `base` 夹具（含 base 存储层）会触发保留名抛错——把夹具改为：

```ts
const base: ConfigT = {
  layers: [
    { name: 'persona', order: 10, text: 'P' },
    { name: 'task', order: 50, text: 'TASK' },
  ],
  rules: [{ match: { modelPattern: 'deepseek-*' }, overrides: { task: 'T' }, append: 'N' }],
}
```

`validateLayers` describe 里「合法层数组通过」「层名重复抛错」用例把层名 `base` 换成 `task`（base 已成保留名）。`validateConfig` describe 里「层名重复抛错」用例同理：追加的重名层改为 `{ name: 'task', order: 9, text: 'X' }`（若仍用 base 会先命中保留名抛错而非重名抛错）。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/prompt/defaults.test.ts src/prompt/config.test.ts`
Expected: FAIL（DEFAULT_LAYERS 仍是四层；base 不是保留名）

- [ ] **Step 4: 实现 defaults.ts 缩层集**

`packages/toolkit/src/prompt/defaults.ts` 中 `DEFAULT_LAYERS` 替换为：

```ts
/** 默认语义层（固定层栈的唯一可编辑层）：persona。
 *  结构固定——UI 与服务端均不允许增删层、改名、改序，仅文本可编辑。
 *  persona 注册为普通段 prompt-stack:persona（order 10），排在内置模型层
 *  prompt-stack:base（order 0）之后；默认空串：dsh「空段不渲染」，未填写时行为零变化。 */
export const DEFAULT_LAYERS: LayerConfig[] = [
  { name: 'persona', order: 10, text: '' },
]
```

文件头部注释里「persona 层运行时填入原生 deployment:persona 槽位……」的说明同步改为：「persona 是唯一可编辑存储层；base 为内置模型层（保留层名，不进存储），见 index.ts」。

- [ ] **Step 5: 实现 index.ts 校验调整**

`packages/toolkit/src/prompt/index.ts`：

1. `MODEL_NOTES_LAYER` 常量下方新增：

```ts
/** 内置模型层名（保留）：固定注册 prompt-stack:base 段、不进存储，仍是 rules overrides 的合法目标。 */
export const BASE_LAYER = 'base'
```

2. `validateLayers` 的保留名分支改为：

```ts
    if (layer.name === MODEL_NOTES_LAYER || layer.name === BASE_LAYER) {
      throw new Error(`prompt-stack: layer name "${layer.name}" is reserved`)
    }
```

3. `validateConfig` 的合法目标集改为：

```ts
  const names = new Set([BASE_LAYER, ...config.layers.map(layer => layer.name)])
```

4. `PERSONA_LAYER` 常量本步**保留**（setupPrompt 仍在引用），统一由 Task 2 重写 setupPrompt 时删除。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/prompt/defaults.test.ts src/prompt/config.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/toolkit/src/prompt/defaults.ts packages/toolkit/src/prompt/index.ts packages/toolkit/src/prompt/defaults.test.ts packages/toolkit/src/prompt/config.test.ts
git commit -m "refactor: 层集缩为单 persona 层，base 转为内置保留模型层名"
```

---

### Task 2: setupPrompt 装配重写（base 固定段 + persona 普通段 + 删除槽位填充）

**Files:**
- Modify: `packages/toolkit/src/prompt/index.ts`（`setupPrompt` 主体）
- Test: `packages/toolkit/src/prompt/assemble.test.ts`
- Test: `packages/toolkit/src/prompt/runtime-model.test.ts`
- Test: `packages/toolkit/src/prompt/reregister.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `BASE_LAYER`、`BASE_TEXT`（`./defaults.ts`）。
- Produces: `setupPrompt(ctx, { source, rules })` 注册固定段 `prompt-stack:base`(order 0) + 存储层段 + `prompt-stack:model-notes`(order = max(0, 存储层 orders) + 1)；waterfall 不再触碰 `deployment:persona`。Task 5 的 scoped shadow 依赖全局段名 `prompt-stack:persona`。

- [ ] **Step 1: 重写 assemble.test.ts 为失败测试**

整文件替换为（要点：base 固定段由 BASE_TEXT 兜底；persona 为普通段；删除 deployment:persona 全部用例；cordis.yml persona 原样通过）：

```ts
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt, type AssembleContext, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { setupPrompt, type LayerView } from './index.ts'
import { BASE_TEXT } from './defaults.ts'
import type { Config as ConfigT } from './types.ts'

function agentContext(options: { provider?: string; model?: string }): AssembleContext {
  return { agent: { options, session: { id: 'test-session' } } as unknown as Agent }
}

/** 照 runtime-model.test.ts：铸造 agent 级 scope（scoped shadow 测试用）。 */
async function mintScope(ctx: Context, name: string): Promise<Scope> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, { name }) },
    { inject: ['systemPrompt'] }))
  return scope
}

const CONFIG: ConfigT = {
  layers: [{ name: 'persona', order: 10, text: 'PERSONA' }],
  rules: [
    { match: { modelPattern: 'claude*' }, overrides: { base: 'CLAUDE-BASE' } },
    { match: { provider: 'deepseek', model: 'deepseek-v4' }, append: 'V4-NOTES' },
  ],
}

function fakeSource(layers: ConfigT['layers']): LayerView {
  return { get: () => layers, subscribe: () => () => {} }
}

async function boot(config: ConfigT = CONFIG): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' })
  setupPrompt(ctx, { source: fakeSource(config.layers), rules: config.rules })
  return ctx
}

function sectionTexts(sections: Array<{ name: string; text: string }>): Record<string, string> {
  return Object.fromEntries(sections.map(section => [section.name, section.text]))
}

describe('prompt 组装（模型层 + persona 普通段）', () => {
  test('裸组装（无 agent）：模型层为内置 BASE_TEXT，model-notes 不渲染', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble()
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe(BASE_TEXT)
    expect(texts['prompt-stack:persona']).toBe('PERSONA')
    expect(texts['prompt-stack:model-notes']).toBe('')
    expect(renderPrompt(assembly)).not.toContain('model-notes')
  })

  test('渲染顺序：模型层（order 0）在 persona（order 10）之前，notes 最后', async () => {
    const ctx = await boot()
    const names = (await ctx.systemPrompt.assemble()).sections.map(s => s.name)
    expect(names.indexOf('prompt-stack:base')).toBeLessThan(names.indexOf('prompt-stack:persona'))
    expect(names.indexOf('prompt-stack:model-notes')).toBeGreaterThan(names.indexOf('prompt-stack:persona'))
  })

  test('命中规则：模型层整份覆盖、persona 保持存储文本、append 进 model-notes', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble(agentContext({ provider: 'deepseek', model: 'deepseek-v4' }))
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe(BASE_TEXT)   // deepseek 规则仅 append，不覆盖 base
    expect(texts['prompt-stack:persona']).toBe('PERSONA')
    expect(texts['prompt-stack:model-notes']).toBe('V4-NOTES')
  })

  test('通配命中 claude：模型层替换为 CLAUDE-BASE', async () => {
    const ctx = await boot()
    const assembly = await ctx.systemPrompt.assemble(agentContext({ model: 'claude-sonnet-4' }))
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('CLAUDE-BASE')
    expect(texts['prompt-stack:model-notes']).toBe('')
  })

  test('persona 默认空串时段被丢弃（行为零变化）', async () => {
    const ctx = await boot({ ...CONFIG, layers: [{ name: 'persona', order: 10, text: '' }] })
    const assembly = await ctx.systemPrompt.assemble(agentContext({}))
    expect(sectionTexts(assembly.sections)['prompt-stack:persona']).toBe('')
    expect(renderPrompt(assembly)).not.toContain('persona')
  })

  test('宿主变量插值与重名不抛错（回归，同原语义）', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
    ctx.systemPrompt.variable('model', context => context.agent?.options.model)
    setupPrompt(ctx, { source: fakeSource([{ name: 'who', order: 10, text: 'model={{model}} provider={{provider}}' }]), rules: [] })
    const assembly = await ctx.systemPrompt.assemble(agentContext({ provider: 'deepseek', model: 'deepseek-v4' }))
    expect(renderPrompt(assembly)).toContain('model=deepseek-v4 provider=deepseek')
  })

  test('Config 校验失败在 apply 期响亮抛错', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    expect(() => setupPrompt(ctx, { source: fakeSource([]), rules: [] })).toThrow(/at least one layer/)
  })

  test('子 Agent（origin=subagent）：模型层与 persona 渲染空串，model-notes 按子的模型照常命中', async () => {
    const ctx = await boot()
    const childContext = {
      agent: {
        options: { provider: 'deepseek', model: 'deepseek-v4' },
        session: { header: { origin: 'subagent' } },
      } as unknown as Agent,
    }
    const assembly = await ctx.systemPrompt.assemble(childContext)
    const texts = sectionTexts(assembly.sections)
    expect(texts['prompt-stack:base']).toBe('')
    expect(texts['prompt-stack:persona']).toBe('')
    expect(texts['prompt-stack:model-notes']).toBe('V4-NOTES')
    expect(renderPrompt(assembly)).not.toContain(BASE_TEXT.slice(0, 40))
    expect(renderPrompt(assembly)).toContain('V4-NOTES')
  })
})

describe('deployment:persona 槽位归还原生', () => {
  test('toolkit 不改写槽位：cordis.yml 的 systemPrompt.persona 原样渲染', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: 'NATIVE-PERSONA' })
    setupPrompt(ctx, { source: fakeSource(CONFIG.layers), rules: CONFIG.rules })
    const assembly = await ctx.systemPrompt.assemble(agentContext({}))
    const texts = sectionTexts(assembly.sections)
    expect(texts['deployment:persona']).toBe('NATIVE-PERSONA')
    // UI persona 层走自己的普通段，与槽位互不影响
    expect(texts['prompt-stack:persona']).toBe('PERSONA')
  })

  test('bot 角色 scoped 同名段 shadow 全局 persona 段', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: '' })
    setupPrompt(ctx, { source: fakeSource(CONFIG.layers), rules: CONFIG.rules })
    // scoped shadow 是 agent scope 机制：根 ctx 全局重名注册会抛错，必须走 scope。
    const scope = await mintScope(ctx, 'agent')
    scope.ctx.systemPrompt.section({ name: 'prompt-stack:persona', order: 10, text: 'ROLE-PERSONA' })
    const assembly = await ctx.systemPrompt.assemble({ ...agentContext({}), scope: scopeOf(scope.ctx)! })
    expect(sectionTexts(assembly.sections)['prompt-stack:persona']).toBe('ROLE-PERSONA')
  })
})
```

- [ ] **Step 2: 调整 runtime-model.test.ts / reregister.test.ts 夹具**

runtime-model.test.ts：`CONFIG.layers` 改为 `[{ name: 'persona', order: 10, text: 'P' }]`；断言 `prompt-stack:task` 的改为 `prompt-stack:persona`；`expect(texts['prompt-stack:base']).toBe('BASE')` 改为 `toBe(BASE_TEXT)`（import { BASE_TEXT } from './defaults.ts'）；「新会话重新解析」里 `second['prompt-stack:base']` 同理。钉住/回退逻辑不变。

reregister.test.ts：初始层 `[{ name: 'persona', order: 10, text: 'P' }]`；「新增/删除层」用例改为新增/删除 `task`（order 50）段，base 断言改为恒在场（固定注册）：

```ts
    // base 是内置固定段：层集如何变化都恒在场
    expect(afterRemove).toContain('prompt-stack:base')
```

「model-notes order 随最大层 order 重算」用例不变（task order 100 时 notes 排后）。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/prompt/assemble.test.ts src/prompt/runtime-model.test.ts src/prompt/reregister.test.ts`
Expected: FAIL（base 段不存在/deployment:persona 仍被改写）

- [ ] **Step 4: 重写 setupPrompt**

`packages/toolkit/src/prompt/index.ts` 全文替换为：

```ts
/** prompt 模块：内置模型层（按模型规则整份覆盖）+ persona 可编辑层 + model-notes 自动层。 */
import type { Context } from '@deepseek-ai/cordis'
// type-only 导入激活声明合并：Context.systemPrompt 与 AssembleContext.agent。
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { BASE_TEXT } from './defaults.ts'
import { globToRegExp, selectRule } from './match.ts'
import type { Config as ConfigT, LayerConfig, Rule } from './types.ts'

export type { Config, LayerConfig, Rule, RuleMatch } from './types.ts'

/** 固定追加层的层名（保留，用户层不得使用）。 */
export const MODEL_NOTES_LAYER = 'model-notes'

/** 内置模型层名（保留）：固定注册 prompt-stack:base 段、不进存储，仍是 rules overrides 的合法目标。 */
export const BASE_LAYER = 'base'

const BASE_SECTION = `prompt-stack:${BASE_LAYER}`

/** 运行时层视图：setupPrompt 只消费 get + subscribe，不关心存储细节（测试可注入假实现）。 */
export interface LayerView {
  get(): LayerConfig[]
  subscribe(listener: () => void): () => void
}

/** 层列表语义校验：空、层名重复、保留层名（base/model-notes）。 */
export function validateLayers(layers: LayerConfig[]): void {
  if (layers.length === 0) {
    throw new Error('prompt-stack: config.layers must define at least one layer')
  }
  const names = new Set<string>()
  for (const layer of layers) {
    if (layer.name === MODEL_NOTES_LAYER || layer.name === BASE_LAYER) {
      throw new Error(`prompt-stack: layer name "${layer.name}" is reserved`)
    }
    if (names.has(layer.name)) {
      throw new Error(`prompt-stack: duplicate layer name "${layer.name}"`)
    }
    names.add(layer.name)
  }
}

/**
 * 激活期校验（dsh「误配置响亮失败」惯例）：空 layers、层名重复、保留层名、
 * overrides 引用未知层（内置 base 与 model-notes 之外的存储层名）、空 match、非法 glob 全部抛错。
 */
export function validateConfig(config: ConfigT): void {
  validateLayers(config.layers)
  const names = new Set([BASE_LAYER, ...config.layers.map(layer => layer.name)])
  for (const [index, rule] of config.rules.entries()) {
    const { provider, model, modelPattern } = rule.match
    if (provider === undefined && model === undefined && modelPattern === undefined) {
      throw new Error(`prompt-stack: rules[${index}].match must set at least one of provider, model, modelPattern`)
    }
    if (modelPattern !== undefined) globToRegExp(modelPattern)
    for (const key of Object.keys(rule.overrides ?? {})) {
      if (!names.has(key)) {
        throw new Error(`prompt-stack: rules[${index}].overrides references unknown layer "${key}"`)
      }
    }
  }
}

/**
 * 固定注册 prompt-stack:base（模型层，order 0）+ 每个存储层一个段 + model-notes。
 * 文本在每次组装时按当前 agent 的 provider/model 选唯一命中规则（最高分、同分取配置序靠前）；
 * 模型层用 overrides.base 整份替换内置 BASE_TEXT，存储层用 overrides 替换该层文本。
 * 裸组装（无 agent）静默用默认文本。deployment:persona 槽位归还原生，本模块不触碰。
 *
 * 运行时选模型与首条消息钉住语义不变（见 waterfall 注释）。
 */
export function setupPrompt(ctx: Context, config: { source: LayerView; rules: Rule[] }): void {
  const { source, rules } = config
  const hitRule = (context: AssembleContext): Rule | undefined =>
    selectRule(rules, context.agent?.options?.provider, context.agent?.options?.model)
  // 子 Agent 隔离：模型层/persona 不泄漏进子 Agent 组装；model-notes 是模型层
  // （模型的通用使用说明），主子共用、按子的生效模型命中规则。
  const isSubagent = (context: AssembleContext): boolean =>
    context.agent?.session?.header?.origin === 'subagent'

  // 层文本可经 UI 修改：registerSections 先 dispose 上一轮再按当前层重注册，
  // source 变更时经 subscribe 触发。base 与 model-notes 恒注册，不随层集变化。
  let disposers: Array<() => void> = []
  const registerSections = (): void => {
    for (const dispose of disposers) dispose()
    disposers = []
    const layers = source.get()
    validateLayers(layers)
    const notesOrder = Math.max(0, ...layers.map(layer => layer.order)) + 1
    disposers.push(ctx.systemPrompt.section({
      name: BASE_SECTION,
      order: 0,
      text: (context) =>
        isSubagent(context) ? '' : (hitRule(context)?.overrides?.[BASE_LAYER] ?? BASE_TEXT),
    }))
    for (const layer of layers) {
      disposers.push(ctx.systemPrompt.section({
        name: `prompt-stack:${layer.name}`,
        order: layer.order,
        text: (context) =>
          isSubagent(context) ? '' : (hitRule(context)?.overrides?.[layer.name] ?? layer.text),
      }))
    }
    disposers.push(ctx.systemPrompt.section({
      name: `prompt-stack:${MODEL_NOTES_LAYER}`,
      order: notesOrder,
      text: (context) => hitRule(context)?.append ?? '',
    }))
  }
  registerSections()
  ctx.effect(() => source.subscribe(registerSections))

  const notesSection = `prompt-stack:${MODEL_NOTES_LAYER}`
  // 首条消息钉住：每个会话的首次组装解析出的 provider/model 缓存起来，会话中途
  // 切模型不再改写系统提示词（对话的行为契约保持稳定）。键带 session id：
  // clear/新会话（id 变化）自动重新解析。HMR 重挂载换新闭包，缓存随之重置。
  const pinned = new WeakMap<Agent, { sessionId: unknown; provider: string | undefined; model: string | undefined }>()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    let provider = assembled.variables.provider ?? context.agent?.options?.provider
    let model = assembled.variables.model ?? context.agent?.options?.model
    const agent = context.agent
    if (agent !== undefined) {
      const cached = pinned.get(agent)
      if (cached !== undefined && cached.sessionId === agent.session.id) {
        provider = cached.provider
        model = cached.model
      } else if (provider !== undefined || model !== undefined) {
        pinned.set(agent, { sessionId: agent.session.id, provider, model })
      }
    }
    const rule = selectRule(rules, provider, model)
    const layers = source.get()
    const sections = assembled.sections.map((section) => {
      if (section.name === notesSection) {
        return { ...section, text: rule?.append ?? '' }
      }
      if (section.name === BASE_SECTION) {
        return { ...section, text: isSubagent(context) ? '' : (rule?.overrides?.[BASE_LAYER] ?? BASE_TEXT) }
      }
      const layer = layers.find(l => section.name === `prompt-stack:${l.name}`)
      if (layer === undefined) return section
      return { ...section, text: isSubagent(context) ? '' : (rule?.overrides?.[layer.name] ?? layer.text) }
    })
    return { ...assembled, sections }
  })
}
```

要点：删除 `PERSONA_SECTION` / `TOOLKIT_PERSONA_SECTION` 导入与 persona 槽位分支；删除 `PERSONA_LAYER` 常量。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/prompt/assemble.test.ts src/prompt/runtime-model.test.ts src/prompt/reregister.test.ts src/prompt/smoke.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/prompt/index.ts packages/toolkit/src/prompt/assemble.test.ts packages/toolkit/src/prompt/runtime-model.test.ts packages/toolkit/src/prompt/reregister.test.ts
git commit -m "refactor: 模型层固定注册 order 0，persona 改普通段 order 10，persona 槽位归还原生"
```

---

### Task 3: layer-source 旧存储兼容（存量含 base 层不再抛错）

**Files:**
- Modify: `packages/toolkit/src/prompt/layer-source.ts`
- Test: `packages/toolkit/src/prompt/layer-source.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `validateLayers`（base 已成保留名）。
- Produces: `openLayerSource(tables, seedLayers)` 对含 base/domain/task 的旧存储不抛错，reconcile 后丢弃多余层。

- [ ] **Step 1: 写失败测试**

layer-source.test.ts 的 `SEED` 改为 `const SEED: LayerConfig[] = [{ name: 'persona', order: 10, text: '' }]`，并新增迁移用例：

```ts
  test('旧四层存储（含 base 保留层与已编辑文本）→ 丢弃 base/domain/task，保留 persona 文本', async () => {
    const t = tables()
    await t.promptLayers.put(PROMPT_LAYERS_KEY, {
      layers: [
        { name: 'persona', order: 0, text: 'MY-PERSONA' },
        { name: 'base', order: 0, text: 'B-EDITED' },
        { name: 'domain', order: 20, text: 'D' },
        { name: 'task', order: 50, text: 'T' },
      ],
    })
    const source = await openLayerSource(t.api, SEED)
    expect(source.get()).toEqual([{ name: 'persona', order: 10, text: 'MY-PERSONA' }])
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: source.get() })
  })
```

其余用例同步到新种子：「首启」中断言 `source.get()` 等于 SEED；「reconcile 补缺失/丢多余」用例的存量改为 `[{ name: 'legacy', order: 99, text: 'GONE' }]`，期望 `[{ name: 'persona', order: 10, text: '' }]`；「set」用例改 persona 文本；「reconcileLayers 输出种子结构」期望单层（stored `[{ name: 'persona', order: 7, text: 'KEPT' }, { name: 'ghost', order: 1, text: 'G' }]` → `[{ name: 'persona', order: 10, text: 'KEPT' }]`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/prompt/layer-source.test.ts`
Expected: FAIL（旧存储含 base → validateLayers 抛 reserved）

- [ ] **Step 3: 实现 openLayerSource 调整**

`packages/toolkit/src/prompt/layer-source.ts`：打开已有存储时**先 reconcile 再校验**（ reconcile 输出恒为种子结构，天然合法；旧存储里的保留层名/多余层由 reconcile 丢弃）。`openLayerSource` 中：

```ts
  const existing = promptLayers.get(PROMPT_LAYERS_KEY)
  if (existing !== undefined) {
    // 不再 validateLayers(existing.layers)：旧存储可能含已退役的层名（如 base），
    // reconcile 负责对齐种子结构，校验只针对 reconcile 后的结果（恒合法，防御性保留）。
    cache = reconcileLayers(existing.layers, seedLayers)
    validateLayers(cache)
    await promptLayers.put(PROMPT_LAYERS_KEY, { layers: cache })
  } else {
    // ... 不变
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/prompt/layer-source.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/prompt/layer-source.ts packages/toolkit/src/prompt/layer-source.test.ts
git commit -m "fix: 旧存储层先 reconcile 再校验，含退役 base 层的存量可迁移"
```

---

### Task 4: buildAgentPersona 显式拼模型层 + delegate 去 getLayers

**Files:**
- Modify: `packages/toolkit/src/prompt/persona.ts`
- Modify: `packages/toolkit/src/delegate/index.ts`（删 `getLayers`）
- Modify: `packages/toolkit/src/index.ts`（`setupDelegate` 调用删 `getLayers`）
- Test: `packages/toolkit/src/prompt/persona.test.ts`

**Interfaces:**
- Consumes: `BASE_TEXT`（defaults.ts）、`selectRule`。
- Produces: `buildAgentPersona(config: { rules: Rule[] }, role: { name: string; persona?: string }, model?: { provider?: string; model?: string }): string`（签名去掉 `getLayers`）；`DelegateConfig` 去掉 `getLayers` 字段。

- [ ] **Step 1: 重写 persona.test.ts 为失败测试**

整文件替换为：

```ts
import { describe, expect, test } from 'vitest'
import { buildAgentPersona } from './persona.ts'
import { BASE_TEXT } from './defaults.ts'
import type { Rule } from './types.ts'

const SECTION_A = (roleName: string): string => `你是团队中的一名成员（角色：${roleName}），由主 Agent 委派任务。
- 你看不到主对话；任务书包含你完成工作所需的全部上下文。
- 你的最终输出会作为结果完整返回给主 Agent：直接给出结论与必要细节。
- 你不能再次委派他人；任务需要拆分时，自己按顺序完成。`

const SECTION_B = `能力使用守则：
- 你可以使用与主 Agent 相同的工具与 MCP 资源，但只在任务必需时调用。
- 动手修改代码前，先阅读项目根目录及涉及目录的 AGENTS.md，并遵循其中约定。
- 产生或修改文件后，运行相关检查（测试、类型检查）验证你的改动。`

describe('buildAgentPersona', () => {
  test('无 role.persona、无规则命中 = 契约段 + 内置模型层 BASE_TEXT', () => {
    expect(buildAgentPersona({ rules: [] }, { name: 'explorer' }))
      .toBe(`${SECTION_A('explorer')}\n\n${SECTION_B}\n\n${BASE_TEXT}`)
  })

  test('role.persona 排在模型层之后；空/纯空白跳过不产空段落', () => {
    const withRole = buildAgentPersona({ rules: [] }, { name: 'general', persona: 'R' })
    expect(withRole).toBe(`${SECTION_A('general')}\n\n${SECTION_B}\n\n${BASE_TEXT}\n\nR`)
    const empty = `${SECTION_A('general')}\n\n${SECTION_B}\n\n${BASE_TEXT}`
    expect(buildAgentPersona({ rules: [] }, { name: 'general', persona: '' })).toBe(empty)
    expect(buildAgentPersona({ rules: [] }, { name: 'general', persona: '   \n\t ' })).toBe(empty)
  })

  test('命中规则：overrides.base 整份替换模型层、append 成为末段', () => {
    const rules: Rule[] = [{ match: { model: 'deepseek-v4' }, overrides: { base: 'V4-BASE' }, append: 'V4-NOTES' }]
    const persona = buildAgentPersona({ rules }, { name: 'general', persona: 'R' }, { provider: 'deepseek', model: 'deepseek-v4' })
    expect(persona).toBe(`${SECTION_A('general')}\n\n${SECTION_B}\n\nV4-BASE\n\nR\n\nV4-NOTES`)
  })

  test('契约段中角色名正确代入', () => {
    const persona = buildAgentPersona({ rules: [] }, { name: 'code-reviewer' })
    expect(persona.startsWith('你是团队中的一名成员（角色：code-reviewer），由主 Agent 委派任务。')).toBe(true)
    expect(persona).not.toContain('undefined')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/prompt/persona.test.ts`
Expected: FAIL（签名/行为不符）

- [ ] **Step 3: 重写 persona.ts**

```ts
/** 委派子 Agent 的 persona 装配：契约段 + 内置模型层（按子的模型改写）+ 角色 persona。 */
import { BASE_TEXT } from './defaults.ts'
import { selectRule } from './match.ts'
import type { Rule } from './types.ts'

const SECTION_A = (roleName: string): string => `你是团队中的一名成员（角色：${roleName}），由主 Agent 委派任务。
- 你看不到主对话；任务书包含你完成工作所需的全部上下文。
- 你的最终输出会作为结果完整返回给主 Agent：直接给出结论与必要细节。
- 你不能再次委派他人；任务需要拆分时，自己按顺序完成。`

const SECTION_B = `能力使用守则：
- 你可以使用与主 Agent 相同的工具与 MCP 资源，但只在任务必需时调用。
- 动手修改代码前，先阅读项目根目录及涉及目录的 AGENTS.md，并遵循其中约定。
- 产生或修改文件后，运行相关检查（测试、类型检查）验证你的改动。`

/**
 * 子 Agent 提示词 = 契约段 A/B + 模型层文本（命中规则 overrides.base 整份替换内置
 * BASE_TEXT）+ 角色 persona（非空时，排在模型层之后）+ 命中规则的 append（model-notes）。
 * 全局 persona 层是主 Agent 的人设，不进入子 Agent（子的角色由 role.persona 顶替）。
 */
export function buildAgentPersona(
  config: { rules: Rule[] },
  role: { name: string; persona?: string },
  model?: { provider?: string; model?: string },
): string {
  const rule = selectRule(config.rules, model?.provider, model?.model)
  const texts = [rule?.overrides?.base ?? BASE_TEXT]
  if (role.persona !== undefined && role.persona.trim().length > 0) texts.push(role.persona)
  if (rule?.append !== undefined) texts.push(rule.append)
  return [SECTION_A(role.name), SECTION_B, ...texts].join('\n\n')
}
```

- [ ] **Step 4: delegate/index.ts 与 src/index.ts 去 getLayers**

`packages/toolkit/src/delegate/index.ts`：`DelegateConfig` 删除 `getLayers` 字段（含注释与 `LayerConfig` 导入）；`buildPersona` 闭包改为：

```ts
        buildPersona: (role: AgentRecord) =>
          buildAgentPersona({ rules: config.rules }, role, role.model),
```

`packages/toolkit/src/index.ts`：`setupDelegate` 调用删除 `getLayers: () => layerSource.get(),` 一行。

- [ ] **Step 5: 跑测试确认通过（含 delegate 相关）**

Run: `pnpm --filter dsh-agent-toolkit test -- src/prompt/persona.test.ts src/delegate`
Expected: PASS（delegate/tool.test.ts 注入假 buildPersona，签名 `(role) => string` 不变）

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/prompt/persona.ts packages/toolkit/src/prompt/persona.test.ts packages/toolkit/src/delegate/index.ts packages/toolkit/src/index.ts
git commit -m "refactor: 委派 persona 显式拼内置模型层，delegate 去 getLayers 依赖"
```

---

### Task 5: bot 角色 persona 改 scoped shadow

**Files:**
- Modify: `packages/toolkit/src/channels/agent-setup.ts`
- Test: `packages/toolkit/src/channels/agent-setup.test.ts`

**Interfaces:**
- Consumes: Task 2 的全局段名 `prompt-stack:persona`（order 10）。
- Produces: `TOOLKIT_PERSONA_SECTION = 'prompt-stack:persona'`；bot 会话 scoped 注册同名段（order 10）shadow 全局 persona 层。

- [ ] **Step 1: 改 agent-setup.test.ts 为失败测试**

三处断言更新（调用串里的段名与 order）：

```ts
// 「基础工具行…注入 persona 与 tools 白名单」：
    expect(calls).toEqual([...mountCalls, 'section:prompt-stack:persona:10:你是评审助手', 'restrict:bash'])

// 「只带 persona」：
    expect(calls.at(-1)).toBe('section:prompt-stack:persona:10:p')
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/agent-setup.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 agent-setup.ts**

```ts
/** bot 会话角色 persona 的 scoped 段名：与全局 persona 层同名，scoped 注册即 shadow 覆盖主 Agent persona。 */
export const TOOLKIT_PERSONA_SECTION = 'prompt-stack:persona'
```

注册行 order 0 → 10：

```ts
  if (hooks.persona !== undefined) {
    agentCtx.systemPrompt.section({ name: TOOLKIT_PERSONA_SECTION, order: 10, text: hooks.persona })
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/channels/agent-setup.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/channels/agent-setup.ts packages/toolkit/src/channels/agent-setup.test.ts
git commit -m "refactor: bot 角色 persona 改 scoped 同名段 shadow 全局 persona 层"
```

---

### Task 6: API 返回 modelFallbackText + apply 接线

**Files:**
- Modify: `packages/toolkit/src/prompt/api.ts`
- Modify: `packages/toolkit/src/index.ts`（`setupPromptLayersApi` deps）
- Test: `packages/toolkit/src/prompt/api.test.ts`

**Interfaces:**
- Consumes: `BASE_TEXT`。
- Produces: GET 响应新增 `modelFallbackText: string`；Task 7 的浏览器半消费该字段。

- [ ] **Step 1: 改 api.test.ts 为失败测试**

`SEED` 改为 `[{ name: 'persona', order: 10, text: 'P' }]`；GET 两个用例的期望响应加 `modelFallbackText: BASE_TEXT`（`import { BASE_TEXT } from './defaults.ts'`）；「结构变更（增/删层）→ 400」的增层用例改为 `[{ name: 'persona', order: 10, text: 'P' }, { name: 'task', order: 50, text: 'T' }]`；「非法层」用例加 `[{ name: 'base', order: 0, text: 'X' }]`（保留名）；「重置回种子」用 `source.set([{ name: 'persona', order: 10, text: 'P-EDITED' }])`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/prompt/api.test.ts`
Expected: FAIL（响应缺 modelFallbackText）

- [ ] **Step 3: 实现 api.ts 与接线**

`packages/toolkit/src/prompt/api.ts`：顶部 `import { BASE_TEXT } from './defaults.ts'`；GET 响应改为：

```ts
      json(res, 200, { layers: deps.source.get(), rules: deps.rules, seedLayers: deps.seedLayers, native, modelFallbackText: BASE_TEXT })
```

`packages/toolkit/src/index.ts`：`setupPromptLayersApi` deps 无需新增字段（modelFallbackText 是常量，api.ts 直接引用）；确认 `index.test.ts` 的 sections 断言仍含 `prompt-stack:base`/`prompt-stack:model-notes`（固定注册后依然成立，无需改）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/prompt/api.test.ts src/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/prompt/api.ts packages/toolkit/src/prompt/api.test.ts packages/toolkit/src/index.ts packages/toolkit/src/index.test.ts
git commit -m "feat: prompt-layers API 返回内置模型层兜底文本 modelFallbackText"
```

---

### Task 7: 浏览器半 UI（模型层只读行 + persona 唯一可编辑）

**Files:**
- Modify: `packages/toolkit/src/client/prompt/api.ts`
- Modify: `packages/toolkit/src/client/prompt/PromptLayersModal.tsx`
- Test: `packages/toolkit/src/client/prompt/prompt-layers.spec.tsx`

**Interfaces:**
- Consumes: Task 6 的 `modelFallbackText`。
- Produces: 面板层列表 = identity（只读）→ 模型层（只读）→ persona（可编辑）→ model-notes（只读）→ 动态层折叠区。

- [ ] **Step 1: 改 prompt-layers.spec.tsx 为失败测试**

`PAYLOAD` 替换为：

```ts
const PAYLOAD = {
  layers: [{ name: 'persona', order: 10, text: 'PERSONA' }],
  rules: [{ match: { modelPattern: 'deepseek*' }, overrides: { base: 'V4-BASE' }, append: 'V4-NOTES' }],
  seedLayers: [{ name: 'persona', order: 10, text: '' }],
  native: {
    sections: [
      { name: 'harness:identity', text: 'IDENTITY' },
      { name: 'prompt-stack:model-notes', text: '' },
    ],
    contexts: [{ name: 'some-context', text: 'CTX-TEXT' }],
  },
  modelFallbackText: 'FALLBACK-BASE',
}
```

用例更新：

```ts
test('加载后展示层栈：identity/模型层只读行 + persona 可编辑 + model-notes 只读行', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  expect(await screen.findByText('harness:identity')).toBeTruthy()
  expect(screen.getByText('模型层', { selector: 'button > span' })).toBeTruthy()
  expect(screen.getByText('persona', { selector: 'button > span' })).toBeTruthy()
  expect(screen.getByText('model-notes')).toBeTruthy()
  // 三个只读徽标（identity / 模型层 / model-notes）
  expect(screen.getAllByText('只读')).toHaveLength(3)
  // 无 base/domain/task 可编辑行
  for (const name of ['base', 'domain', 'task']) {
    expect(screen.queryByText(name, { selector: 'button > span' })).toBeNull()
  }
  // 默认选中 persona，编辑器回显其文本
  expect(screen.getByLabelText('层文本')).toHaveProperty('value', 'PERSONA')
})

test('选中模型层只读行 → 展示兜底文本，不出现层文本编辑器', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona')
  fireEvent.click(screen.getByText('模型层', { selector: 'button > span' }))
  expect(screen.queryByLabelText('层文本')).toBeNull()
  expect(screen.getByLabelText('只读段文本')).toHaveProperty('value', 'FALLBACK-BASE')
})

test('编辑 persona 文本并保存 → PUT 全量携带（单层结构不变）', async () => {
  const calls = stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('persona')
  fireEvent.change(screen.getByLabelText('层文本'), { target: { value: 'NEW PERSONA' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/prompt-layers' && c.method === 'PUT')
    expect(put?.body).toEqual({ layers: [{ name: 'persona', order: 10, text: 'NEW PERSONA' }] })
  })
})
```

「结构固定」「选中 identity/model-notes 只读行」「动态层」用例保留（findByText 等待目标从 'base' 改为 'persona'）；「规则只读视图」两例的 overrides 键断言从 `task` 改为 `base`，且 `base` 不再被判悬空（不断言标红）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client/prompt/prompt-layers.spec.tsx`
Expected: FAIL（模型层行不存在/仍有 base 行）

- [ ] **Step 3: 实现 client api.ts 与 PromptLayersModal.tsx**

`packages/toolkit/src/client/prompt/api.ts`：`PromptLayersPayload` 加 `modelFallbackText: string`。

`packages/toolkit/src/client/prompt/PromptLayersModal.tsx`：

1. 常量区加 `const MODEL_SECTION = 'prompt-stack:base'`。
2. state 加 `const [modelFallbackText, setModelFallbackText] = useState('')`；加载 effect 里 `setModelFallbackText(state.data.modelFallbackText)`。
3. `isReadonlyRow` 加 `|| selectedKey === MODEL_SECTION`。
4. 层列表：identity 行之后、`ordered.map` 之前插入：

```tsx
            {readonlyRow(MODEL_SECTION, '模型层', '内置 · 按模型命中规则覆盖')}
```

5. 只读编辑器：模型层行的文本取 `modelFallbackText`，提示文案分支：

```tsx
            <p className={css.hint}>
              {selectedKey === IDENTITY_SECTION
                ? 'harness:identity 是 dsh 原生身份段，不可编辑。'
                : selectedKey === MODEL_SECTION
                  ? '模型层是内置提示词：运行时按当前模型命中规则整份覆盖（见下方规则区），不可编辑。'
                  : 'model-notes 是保留层：规则命中时以其 append 文本渲染，不可直接编辑。'}
            </p>
            <textarea className={css.textarea} readOnly aria-label="只读段文本" rows={8}
              value={selectedKey === MODEL_SECTION ? modelFallbackText : nativeText(native, selectedKey ?? '')} />
```

6. 规则悬空判定合法目标加 base：`const layerNames = new Set(['base', ...ordered.map(l => l.name)])`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test -- src/client/prompt`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/client/prompt/api.ts packages/toolkit/src/client/prompt/PromptLayersModal.tsx packages/toolkit/src/client/prompt/prompt-layers.spec.tsx
git commit -m "feat: 提示词面板改四层模型（模型层只读行，persona 唯一可编辑）"
```

---

### Task 8: 文档同步 + 全量验证

**Files:**
- Modify: `docs/usage/prompt-layers.md`
- Modify: `docs/usage/config-reference.md`（若 layers 默认值/结构描述过时）
- Modify: `packages/toolkit/README.md`（若分层描述过时）
- Modify: `AGENTS.md`（分层要点）
- Modify: `docs/usage/agents.md`（若提及 persona 层栈）

**Interfaces:**
- Consumes: Task 1-7 全部产物。

- [ ] **Step 1: 重写 docs/usage/prompt-layers.md 的「分层结构」「UI 管理（层）」两节**

「分层结构」替换为四层模型描述（照 spec 第 1 节表格）：identity（原生只读）→ 模型层（内置、按模型命中规则整份覆盖、只读）→ persona（唯一可编辑，排在模型层之后、权重最高）→ model-notes（自动）→ 动态层（contexts/工具段，只读展示）。明确两点行为变化：

- domain/task 层已取消，升级时存量文本直接丢弃；
- cordis.yml 的 `systemPrompt.persona` 恢复原生语义（渲染在 identity 之后、模型层之前），与 UI persona 层各自独立。

「UI 管理（层）」更新为：identity/模型层/model-notes 只读行 + persona 唯一可编辑 + 规则/动态层只读折叠区。「规则匹配」「内置默认规则」「运行时行为」「激活期校验」节按新语义过一遍（overrides 合法目标 = base + 存储层名；persona 段名 `prompt-stack:persona` order 10）。

- [ ] **Step 2: 同步 config-reference.md / README.md / agents.md**

rg 检查三处的分层/persona 描述，过时处改成四层模型口径；`config-reference.md` 的 `layers` 默认值改为 `[{ name: 'persona', order: 10, text: '' }]`。

- [ ] **Step 3: 更新根 AGENTS.md 分层要点**

「分层提示词」条目改为：固定层栈 = identity（原生）/ 模型层（内置 `prompt-stack:base` order 0，只读）/ persona（`prompt-stack:persona` order 10，唯一可编辑）/ 动态层；persona 改普通段、`deployment:persona` 槽位归还原生；设计依据指向 `docs/superpowers/specs/2026-08-31-prompt-layer-simplification-design.md`。

- [ ] **Step 4: 全量验证**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS（358+ 全绿）
Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: PASS
Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 产出 lib/index.js + lib/client.js 无错误

- [ ] **Step 5: Commit**

```bash
git add docs/usage/prompt-layers.md docs/usage/config-reference.md docs/usage/agents.md packages/toolkit/README.md AGENTS.md
git commit -m "docs: 提示词四层模型文档同步"
```
