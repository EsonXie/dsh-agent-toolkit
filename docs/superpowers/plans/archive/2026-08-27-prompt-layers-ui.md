# 分层提示词 UI 管理界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给分层提示词的 layers（层）加一个 UI 管理界面：层 CRUD + 排序 + 重置 + 规则只读视图；编辑结果存存储域（Config 仅作首启种子），改完立即生效。

**Architecture:** 新增 `src/prompt/layer-source.ts`（内存层源 + 存储回写 + 订阅通知）；`setupPrompt` 从静态 layers 改为消费 `LayerView` 并按通知重注册 sections；域打开上移到 `apply()` 统一一次；新增 `src/prompt/api.ts`（HTTP 端点，镜像 agents/api）；新增 `src/client/prompt/`（浏览器半面板，复刻 Agents 面板）。

**Tech Stack:** TypeScript + zod + schemastery；Node 半走 `@deepseek-ai/dsh-storage-domain` KV 表 + `webServer` 路由；浏览器半 React 18 + `@deepseek-ai/dsh-client-ui-primitives` + CSS Modules；测试 vitest + @testing-library/react。

## Global Constraints

- 所有可调参数进 Config schema，不硬编码；层名禁保留名 `model-notes`（`MODEL_NOTES_LAYER`，`src/prompt/index.ts`）。
- 存储域表名须匹配 `UNIT_NAME_RE`（`^[a-z][a-z0-9_]*$`，不允许大写/连字符）；域 `dsh_agent_toolkit` version 1 不变。
- `dsh_agent_toolkit` 域由 storage-domain 强制单开（同名二次 `open` 抛 `already-open`）——域只在 `apply()` 打开一次，`createRegistry`/`openLayerSource` 只消费表句柄。
- 工具/服务注册走 `ctx.effect` 或返回 disposer（`ctx.systemPrompt.section()` 返回 disposer）；webServer 为可选服务，路由经 `registerOptionalRoutes` 注册。
- 错误消息与既有测试断言字节一致（`at least one layer`、`duplicate layer name "..."`、`reserved`）。
- 测试放 `src/**/*.test.ts(x)`（与源码同目录，非 tests/）；验证命令：`pnpm --filter dsh-agent-toolkit test`、`typecheck`、`bundle`。
- 新浏览器半入口 id 用 `dsh-agent-toolkit:prompt-layers`，slot order 为 0（agents 入口是 -1，紧随其后）。

---

### Task 1: 抽取 `validateLayers`

**Files:**
- Modify: `packages/toolkit/src/prompt/index.ts`
- Test: `packages/toolkit/src/prompt/config.test.ts`

**Interfaces:**
- Consumes: 无（依赖现有 `MODEL_NOTES_LAYER`、`LayerConfig`）。
- Produces: `export function validateLayers(layers: LayerConfig[]): void`（空数组、重名、保留名三类错误）；`validateConfig` 改为内部调用它。

- [ ] **Step 1: 写失败测试**

在 `config.test.ts` 末尾追加（`validateConfig` 现有 describe 之后）：

```ts
describe('validateLayers', () => {
  test('合法层数组通过', () => {
    expect(() => validateLayers([{ name: 'base', order: 0, text: 'B' }])).not.toThrow()
  })

  test('空数组抛错', () => {
    expect(() => validateLayers([])).toThrow(/at least one layer/)
  })

  test('层名重复抛错', () => {
    expect(() => validateLayers([
      { name: 'base', order: 0, text: 'B' },
      { name: 'base', order: 1, text: 'B2' },
    ])).toThrow(/duplicate layer name "base"/)
  })

  test('保留层名 model-notes 抛错', () => {
    expect(() => validateLayers([{ name: 'model-notes', order: 0, text: 'X' }])).toThrow(/reserved/)
  })
})
```

同时在文件顶部 import 改为：`import { validateConfig, validateLayers } from './index.ts'`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test config.test.ts`
Expected: FAIL —— `validateLayers is not exported`（import 错误）。

- [ ] **Step 3: 实现**

在 `src/prompt/index.ts` 中，把 `validateConfig` 里的三层校验抽出为 `validateLayers`，并让 `validateConfig` 调用它。替换 `index.ts` 中 `validateConfig` 函数体（第 20-47 行）为：

```ts
/** 层列表语义校验：空、层名重复、保留层名。层名规则校验（overrides 引用）见 validateConfig。 */
export function validateLayers(layers: LayerConfig[]): void {
  if (layers.length === 0) {
    throw new Error('prompt-stack: config.layers must define at least one layer')
  }
  const names = new Set<string>()
  for (const layer of layers) {
    if (layer.name === MODEL_NOTES_LAYER) {
      throw new Error(`prompt-stack: layer name "${MODEL_NOTES_LAYER}" is reserved for the rules' append text`)
    }
    if (names.has(layer.name)) {
      throw new Error(`prompt-stack: duplicate layer name "${layer.name}"`)
    }
    names.add(layer.name)
  }
}

/**
 * 激活期校验（dsh「误配置响亮失败」惯例）：空 layers、层名重复、保留层名、
 * overrides 引用未知层、空 match、非法 glob 全部抛错。
 * @param config - 已经过 schema 解析的配置。
 */
export function validateConfig(config: ConfigT): void {
  validateLayers(config.layers)
  const names = new Set(config.layers.map(layer => layer.name))
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test config.test.ts`
Expected: PASS（validateLayers 4 个新用例 + validateConfig 既有用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/prompt/index.ts packages/toolkit/src/prompt/config.test.ts
git commit -m "refactor(toolkit): 抽取 validateLayers 供运行时层源复用"
```

---

### Task 2: `LayerView` 接口 + `setupPrompt` 改为消费 `{source, rules}` 并支持重注册

**Files:**
- Modify: `packages/toolkit/src/prompt/index.ts`
- Modify: `packages/toolkit/src/prompt/assemble.test.ts`
- Modify: `packages/toolkit/src/prompt/runtime-model.test.ts`
- Create: `packages/toolkit/src/prompt/reregister.test.ts`
- Modify: `packages/toolkit/src/index.ts`（apply 改用静态 source 占位，行为不变）

**Interfaces:**
- Consumes: Task 1 的 `validateLayers`。
- Produces: `export interface LayerView { get(): LayerConfig[]; subscribe(listener: () => void): () => void }`；`setupPrompt(ctx, config: { source: LayerView; rules: Rule[] })`。后续 Task 3/7 依赖此签名。

- [ ] **Step 1: 写失败测试（重注册行为）**

新建 `src/prompt/reregister.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { type AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { setupPrompt, type LayerView } from './index.ts'
import type { LayerConfig } from './types.ts'

/** 可变层源：get 返回当前层；setLayers 换层并通知（模拟 LayerSource 的 set+notify）。 */
function mutableSource(initial: LayerConfig[]) {
  let layers = initial
  const listeners = new Set<() => void>()
  return {
    get: () => layers,
    setLayers: (next: LayerConfig[]) => { layers = next; for (const l of [...listeners]) l() },
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
  }
}

function agentContext(model: string): AssembleContext {
  return { agent: { options: { provider: 'deepseek', model }, session: { id: 's1' } } as unknown as Agent }
}

async function boot(source: LayerView): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' })
  setupPrompt(ctx, { source, rules: [] })
  return ctx
}

function names(sections: Array<{ name: string }>): string[] {
  return sections.map(s => s.name)
}

describe('setupPrompt 层重注册', () => {
  test('层变更后新组装使用新层（新增层出现、被删层消失）', async () => {
    const source = mutableSource([{ name: 'base', order: 0, text: 'B' }])
    const ctx = await boot(source)

    expect(names((await ctx.systemPrompt.assemble()).sections)).toContain('prompt-stack:base')

    source.setLayers([
      { name: 'base', order: 0, text: 'B' },
      { name: 'task', order: 50, text: 'T' },
    ])
    const afterAdd = names((await ctx.systemPrompt.assemble()).sections)
    expect(afterAdd).toContain('prompt-stack:task')

    source.setLayers([{ name: 'base', order: 0, text: 'B' }])
    const afterRemove = names((await ctx.systemPrompt.assemble()).sections)
    expect(afterRemove).not.toContain('prompt-stack:task')
  })

  test('model-notes 的 order 随最大层 order 重算，始终排在层之后', async () => {
    const source = mutableSource([{ name: 'base', order: 0, text: 'B' }])
    const ctx = await boot(source)

    source.setLayers([
      { name: 'base', order: 0, text: 'B' },
      { name: 'task', order: 100, text: 'T' },
    ])
    const sections = (await ctx.systemPrompt.assemble()).sections
    const sectionNames = names(sections)
    expect(sectionNames.indexOf('prompt-stack:model-notes')).toBeGreaterThan(sectionNames.indexOf('prompt-stack:task'))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test reregister.test.ts`
Expected: FAIL —— 类型错误（`setupPrompt` 当前签名是 `{layers, rules}`，`LayerView` 不存在）。

- [ ] **Step 3: 改造 `setupPrompt`**

在 `src/prompt/index.ts` 顶部（`MODEL_NOTES_LAYER` 附近）加：

```ts
/** 运行时层视图：setupPrompt 只消费 get + subscribe，不关心存储细节（测试可注入假实现）。 */
export interface LayerView {
  get(): LayerConfig[]
  subscribe(listener: () => void): () => void
}
```

把 `setupPrompt`（第 60-118 行）整体替换为：

```ts
export function setupPrompt(ctx: Context, config: { source: LayerView; rules: Rule[] }): void {
  const { source, rules } = config
  const hitRule = (context: AssembleContext): Rule | undefined =>
    selectRule(rules, context.agent?.options?.provider, context.agent?.options?.model)
  // 子 Agent 隔离：人设/领域/任务等普通层不泄漏进子 Agent 组装（spec §4.5）；
  // model-notes 是模型层（模型的通用使用说明），主子共用、按子的生效模型命中规则。
  const isSubagent = (context: AssembleContext): boolean =>
    context.agent?.session?.header?.origin === 'subagent'

  // 层可能经 UI 增删/改序：registerSections 先 dispose 上一轮再按当前层重注册，
  // source 变更时经 subscribe 触发。dispose 用 section() 返回的 disposer。
  let disposers: Array<() => void> = []
  const registerSections = (): void => {
    for (const dispose of disposers) dispose()
    disposers = []
    const layers = source.get()
    validateLayers(layers)
    const notesOrder = Math.max(...layers.map(layer => layer.order)) + 1
    for (const layer of layers) {
      disposers.push(ctx.systemPrompt.section({
        name: `prompt-stack:${layer.name}`,
        order: layer.order,
        text: (context) =>
          isSubagent(context) ? '' : (hitRule(context)?.overrides?.[layer.name] ?? layer.text),
      }))
    }
    // 无命中时返回空串，沿用 dsh「空段不渲染」被丢弃。
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
    // 最终 variables 优先（运行时选择），缺省回退创建期 agent.options。
    let provider = assembled.variables.provider ?? context.agent?.options?.provider
    let model = assembled.variables.model ?? context.agent?.options?.model
    const agent = context.agent
    if (agent !== undefined) {
      const cached = pinned.get(agent)
      if (cached !== undefined && cached.sessionId === agent.session.id) {
        provider = cached.provider
        model = cached.model
      } else if (provider !== undefined || model !== undefined) {
        // 只在解析出实际模型时缓存；全 undefined 的组装不钉住（留给首个真实 step）。
        pinned.set(agent, { sessionId: agent.session.id, provider, model })
      }
    }
    const rule = selectRule(rules, provider, model)
    const layers = source.get()
    const sections = assembled.sections.map((section) => {
      if (section.name === notesSection) {
        return { ...section, text: rule?.append ?? '' }
      }
      const layer = layers.find(l => section.name === `prompt-stack:${l.name}`)
      if (layer === undefined) return section
      // 子 Agent 隔离在此同样生效：上面的 text 回调返回的空串会被本节覆盖，
      // 所以按 origin 直接改写（model-notes 分支已在上面单独处理，不受隔离）。
      return { ...section, text: isSubagent(context) ? '' : (rule?.overrides?.[layer.name] ?? layer.text) }
    })
    return { ...assembled, sections }
  })
}
```

- [ ] **Step 4: 更新既有测试文件与 apply 占位**

`src/prompt/assemble.test.ts`：
- 在 `CONFIG` 定义后加一个 fake 源工厂：

```ts
function fakeSource(layers: ConfigT['layers']): LayerView {
  return { get: () => layers, subscribe: () => () => {} }
}
```
（`LayerView` 从 `./index.ts` import 加进顶部 import 行。）

- `boot` 内 `setupPrompt(ctx, config)` → `setupPrompt(ctx, { source: fakeSource(config.layers), rules: config.rules })`。
- 第 74 行 `setupPrompt(ctx, { layers: [...], rules: [] })` → `setupPrompt(ctx, { source: fakeSource([{ name: 'who', order: 0, text: 'model={{model}} provider={{provider}}' }]), rules: [] })`。
- 第 84 行 `setupPrompt(ctx, { layers: [{ name: 'base', order: 0, text: 'B' }], rules: [] })` → `setupPrompt(ctx, { source: fakeSource([{ name: 'base', order: 0, text: 'B' }]), rules: [] })`。
- 第 90 行「Config 校验失败在 apply 期响亮抛错」测试：`setupPrompt(ctx, { layers: [], rules: [] })` → `expect(() => setupPrompt(ctx, { source: fakeSource([]), rules: [] })).toThrow(/at least one layer/)`。

`src/prompt/runtime-model.test.ts`：
- 顶部加同样的 `fakeSource` 工厂（`import { setupPrompt, type LayerView } from './index.ts'`）。
- `boot` 内 `setupPrompt(ctx, CONFIG)` → `setupPrompt(ctx, { source: fakeSource(CONFIG.layers), rules: CONFIG.rules })`。

`src/index.ts`（插件入口 apply，暂时静态占位，Task 7 换成真源）：
- import 行加 `import { setupPrompt, validateConfig as validatePromptConfig, type LayerView } from './prompt/index.ts'`（若尚未引入 `LayerView`）。
- `setupPrompt(ctx, { layers: config.layers, rules: config.rules })` 替换为：

```ts
const layersRef: LayerConfig[] = config.layers
const staticSource: LayerView = { get: () => layersRef, subscribe: () => () => {} }
setupPrompt(ctx, { source: staticSource, rules: config.rules })
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test prompt`
Expected: PASS（assemble / runtime-model / reregister / config / defaults / match / persona / smoke 全绿）。

- [ ] **Step 6: Commit**

```bash
git add packages/toolkit/src/prompt/index.ts packages/toolkit/src/prompt/assemble.test.ts packages/toolkit/src/prompt/runtime-model.test.ts packages/toolkit/src/prompt/reregister.test.ts packages/toolkit/src/index.ts
git commit -m "feat(toolkit): setupPrompt 改消费 LayerView 并按通知重注册 sections"
```

---

### Task 3: 委派路径 getter 化（`buildAgentPersona` / `DelegateConfig`）

**Files:**
- Modify: `packages/toolkit/src/prompt/persona.ts`
- Modify: `packages/toolkit/src/delegate/index.ts`
- Modify: `packages/toolkit/src/index.ts`（`setupDelegate` 传 `getLayers`）
- Test: `packages/toolkit/src/prompt/persona.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `LayerView` 思路（此处为 `getLayers` 函数）。
- Produces: `buildAgentPersona(config: { getLayers: () => LayerConfig[]; rules: Rule[] }, role, model?)`；`DelegateConfig.getLayers: () => LayerConfig[]`。

- [ ] **Step 1: 写失败测试**

`src/prompt/persona.test.ts` 的 `configOf` 改为 getter 形态（其余断言不变）：

```ts
const configOf = (layers: LayerConfig[], rules: Rule[]): { getLayers: () => LayerConfig[]; rules: Rule[] } =>
  ({ getLayers: () => layers, rules })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test persona.test.ts`
Expected: FAIL —— 类型错误（`buildAgentPersona` 仍收 `{layers, rules}`）。

- [ ] **Step 3: 实现**

`src/prompt/persona.ts`：签名与取层处改为：

```ts
export function buildAgentPersona(
  config: { getLayers: () => LayerConfig[]; rules: Rule[] },
  role: { name: string; persona?: string },
  model?: { provider?: string; model?: string },
): string {
  const rule = selectRule(config.rules, model?.provider, model?.model)
  // 角色 persona 固定为 order 0 层；数组稳定排序保证同 order 的全局层（如 base）排在 persona 之前。
  // 与 router 的角色分支一致：persona 缺失或纯空白时跳过，不产出空段落。
  const roleLayers: LayerConfig[] =
    role.persona === undefined || role.persona.trim().length === 0
      ? []
      : [{ name: 'persona', order: 0, text: role.persona }]
  const merged = [...config.getLayers(), ...roleLayers].sort((a, b) => a.order - b.order)
  const texts = merged.map(layer => rule?.overrides?.[layer.name] ?? layer.text)
  if (rule?.append !== undefined) texts.push(rule.append)
  return [SECTION_A(role.name), SECTION_B, ...texts].join('\n\n')
}
```

`src/delegate/index.ts`：
- `DelegateConfig.layers: LayerConfig[]` → `getLayers: () => LayerConfig[]`（注释「persona 装配用的全局提示分层」保留）。
- `mountTool` 内 `buildPersona` 行改为：`buildPersona: (role: AgentRecord) => buildAgentPersona({ getLayers: config.getLayers, rules: config.rules }, role, role.model),`
- 顶部 `import type { LayerConfig, Rule } from '../prompt/types.ts'` 中 `LayerConfig` 已不再被引用时移除（`Rule` 仍用）。

`src/index.ts` apply：`setupDelegate(ctx, { provider: config.provider, toolName: config.toolName, layers: config.layers, rules: config.rules }, registry)` → `setupDelegate(ctx, { provider: config.provider, toolName: config.toolName, getLayers: () => config.layers, rules: config.rules }, registry)`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test prompt persona`
Expected: PASS。若 `delegate/tool.test.ts` 编译失败，检查它是否直接构造了 `buildPersona`（它注入假实现，不应受影响）。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/prompt/persona.ts packages/toolkit/src/delegate/index.ts packages/toolkit/src/index.ts packages/toolkit/src/prompt/persona.test.ts
git commit -m "refactor(toolkit): 委派 persona 装配改经 getLayers 实时取层"
```

---

### Task 4: 存储域加 `prompt_layers` 表 + 导出 `LayerConfigSchema`

**Files:**
- Modify: `packages/toolkit/src/agents/store.ts`
- Test: `packages/toolkit/src/agents/store.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `export const LayerConfigSchema`（zod，`{name, order, text}`）；`agentToolkitDomain.tables.prompt_layers`（`KvTable<string, { layers: LayerConfig[] }>`，单行 key 常量 `'layers'`）。

- [ ] **Step 1: 写失败测试**

`src/agents/store.test.ts` 第 18 行断言改为：

```ts
expect(Object.keys(agentToolkitDomain.tables)).toEqual(['agents', 'meta', 'prompt_layers'])
```

并在 `describe('agentToolkitDomain')` 内加：

```ts
test('prompt_layers 表 schema 校验 { layers: LayerConfig[] } 单行', () => {
  const table = agentToolkitDomain.tables.prompt_layers
  expect(table.valueSchema.safeParse({ layers: [{ name: 'base', order: 0, text: 'B' }] }).success).toBe(true)
  expect(table.valueSchema.safeParse({ layers: [{ name: 'base' }] }).success).toBe(false)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test store.test.ts`
Expected: FAIL —— 表布局断言 `['agents','meta']` 不匹配（新表未加）。

- [ ] **Step 3: 实现**

`src/agents/store.ts`：
- `const LayerConfigSchema = z.object(...)` → `export const LayerConfigSchema = z.object(...)`（第 22 行）。
- `agentToolkitDomain` 的 `tables` 里 `meta` 之后加：

```ts
    // 分层提示词层列表：单行 JSON（key 常量 'layers'），整体替换语义，与 agents 表同构校验。
    prompt_layers: domainTable<string, { layers: LayerConfig[] }>(z.object({ layers: z.array(LayerConfigSchema) })),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test store.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/agents/store.ts packages/toolkit/src/agents/store.test.ts
git commit -m "feat(toolkit): 存储域新增 prompt_layers 表并导出 LayerConfigSchema"
```

---

### Task 5: `layer-source.ts`（openLayerSource + set/reset + 首启种子）

**Files:**
- Create: `packages/toolkit/src/prompt/layer-source.ts`
- Test: `packages/toolkit/src/prompt/layer-source.test.ts`

**Interfaces:**
- Consumes: Task 1 `validateLayers`（从 `./index.ts`）；Task 4 `LayerConfigSchema`（供测试参考）；`LayerView`（Task 2，从 `./index.ts` type import）。
- Produces:
  - `export const PROMPT_LAYERS_KEY = 'layers'`、`export const PROMPT_LAYERS_SEEDED_KEY = 'prompt_layers_seeded'`
  - `export interface PromptLayersRow { layers: LayerConfig[] }`
  - `export interface LayerSource extends LayerView { set(layers: LayerConfig[]): Promise<void>; reset(): Promise<void> }`
  - `export interface PromptLayerTables { promptLayers: KvTable<string, PromptLayersRow>; meta: KvTable<string, { value: string }> }`
  - `export async function openLayerSource(tables: PromptLayerTables, seedLayers: LayerConfig[]): Promise<LayerSource>`

- [ ] **Step 1: 写失败测试**

新建 `src/prompt/layer-source.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { openLayerSource, PROMPT_LAYERS_KEY, PROMPT_LAYERS_SEEDED_KEY, type PromptLayerTables } from './layer-source.ts'
import type { LayerConfig } from './types.ts'

class FakeTable<V> implements KvTable<string, V> {
  private readonly records = new Map<string, V>()
  get(key: string): V | undefined { return this.records.get(key) }
  entries(): IterableIterator<[string, V]> { return this.records.entries() }
  keys(): IterableIterator<string> { return this.records.keys() }
  get size(): number { return this.records.size }
  async put(key: string, value: V): Promise<void> { this.records.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.records.delete(key) }
  async update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error(`missing-key: ${key}`)
    const next = fn(current)
    this.records.set(key, next)
    return next
  }
}

const SEED: LayerConfig[] = [{ name: 'base', order: 0, text: 'B' }]

function tables() {
  const promptLayers = new FakeTable<{ layers: LayerConfig[] }>()
  const meta = new FakeTable<{ value: string }>()
  return { promptLayers, meta, api: { promptLayers, meta } as PromptLayerTables }
}

describe('openLayerSource', () => {
  test('首启：无表数据时种入种子层并置标记；二次打开不再覆盖', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    expect(source.get()).toEqual(SEED)
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: SEED })
    expect(t.meta.get(PROMPT_LAYERS_SEEDED_KEY)).toEqual({ value: '1' })

    // 模拟已有编辑后的存储：二次打开应读存储而非种子
    const edited: LayerConfig[] = [{ name: 'base', order: 0, text: 'B' }, { name: 'task', order: 50, text: 'T' }]
    await t.promptLayers.put(PROMPT_LAYERS_KEY, { layers: edited })
    const source2 = await openLayerSource(t.api, SEED)
    expect(source2.get()).toEqual(edited)
  })

  test('set：校验通过写表并通知；非法层拒绝且不落表', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    const listener = { called: 0 }
    source.subscribe(() => { listener.called++ })

    const next: LayerConfig[] = [{ name: 'base', order: 0, text: 'B' }, { name: 'task', order: 50, text: 'T' }]
    await source.set(next)
    expect(source.get()).toEqual(next)
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: next })
    expect(listener.called).toBe(1)

    await expect(source.set([])).rejects.toThrow(/at least one layer/)
    await expect(source.set([
      { name: 'a', order: 0, text: 'A' },
      { name: 'a', order: 1, text: 'A2' },
    ])).rejects.toThrow(/duplicate layer name "a"/)
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: next })
  })

  test('reset：清表清标记后重写种子并通知', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    await source.set([{ name: 'base', order: 0, text: 'B' }, { name: 'task', order: 50, text: 'T' }])
    const listener = { called: 0 }
    source.subscribe(() => { listener.called++ })

    await source.reset()
    expect(source.get()).toEqual(SEED)
    expect(t.promptLayers.get(PROMPT_LAYERS_KEY)).toEqual({ layers: SEED })
    expect(t.meta.get(PROMPT_LAYERS_SEEDED_KEY)).toEqual({ value: '1' })
    expect(listener.called).toBe(1)
  })

  test('subscribe：退订后不再收到通知', async () => {
    const t = tables()
    const source = await openLayerSource(t.api, SEED)
    const listener = { called: 0 }
    const off = source.subscribe(() => { listener.called++ })
    await source.set([{ name: 'base', order: 0, text: 'X' }])
    expect(listener.called).toBe(1)
    off()
    await source.set([{ name: 'base', order: 0, text: 'Y' }])
    expect(listener.called).toBe(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test layer-source.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `src/prompt/layer-source.ts`：

```ts
/** 分层提示词层源：内存缓存 + prompt_layers 表回写 + 订阅通知；Config 仅作首启种子。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { LayerConfig } from './types.ts'
import { validateLayers, type LayerView } from './index.ts'

/** prompt_layers 表单行的 key 常量。 */
export const PROMPT_LAYERS_KEY = 'layers'
/** meta 表首启种子一次性标记键。 */
export const PROMPT_LAYERS_SEEDED_KEY = 'prompt_layers_seeded'

export interface PromptLayersRow { layers: LayerConfig[] }

/** 层源的完整能力：setupPrompt 只消费 get/subscribe（LayerView），存储层消费 set/reset。 */
export interface LayerSource extends LayerView {
  /** 校验 → 写表 → 更新内存 → 通知订阅者。 */
  set(layers: LayerConfig[]): Promise<void>
  /** 清表 + 清种子标记 → 重写种子 → 通知订阅者。 */
  reset(): Promise<void>
}

export interface PromptLayerTables {
  promptLayers: KvTable<string, PromptLayersRow>
  meta: KvTable<string, { value: string }>
}

/**
 * 打开层源。域由 apply 统一 open（storage-domain 同名单开），本函数只消费表句柄。
 * 首启（meta 无标记 / 表无数据）种入 Config 种子并置标记；此后一律读存储。
 */
export async function openLayerSource(tables: PromptLayerTables, seedLayers: LayerConfig[]): Promise<LayerSource> {
  const { promptLayers, meta } = tables
  let cache: LayerConfig[]
  const existing = promptLayers.get(PROMPT_LAYERS_KEY)
  if (existing !== undefined) {
    cache = existing.layers
    validateLayers(cache)
  } else {
    validateLayers(seedLayers)
    cache = seedLayers
    await promptLayers.put(PROMPT_LAYERS_KEY, { layers: cache })
  }
  if (meta.get(PROMPT_LAYERS_SEEDED_KEY) === undefined) {
    await meta.put(PROMPT_LAYERS_SEEDED_KEY, { value: '1' })
  }

  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of [...listeners]) listener() }

  return {
    get: () => cache,
    async set(layers: LayerConfig[]): Promise<void> {
      validateLayers(layers)
      await promptLayers.put(PROMPT_LAYERS_KEY, { layers })
      cache = layers
      notify()
    },
    async reset(): Promise<void> {
      await promptLayers.delete(PROMPT_LAYERS_KEY)
      await meta.delete(PROMPT_LAYERS_SEEDED_KEY)
      await promptLayers.put(PROMPT_LAYERS_KEY, { layers: seedLayers })
      await meta.put(PROMPT_LAYERS_SEEDED_KEY, { value: '1' })
      cache = seedLayers
      notify()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test layer-source.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/prompt/layer-source.ts packages/toolkit/src/prompt/layer-source.test.ts
git commit -m "feat(toolkit): 新增分层提示词层源 openLayerSource（种子/set/reset/订阅）"
```

---

### Task 6: `createRegistry` 收表句柄，域打开上移 apply

**Files:**
- Modify: `packages/toolkit/src/agents/registry.ts`
- Modify: `packages/toolkit/src/index.ts`
- Test: `packages/toolkit/src/agents/registry.test.ts`

**Interfaces:**
- Consumes: `agentToolkitDomain`、`KvTable`（已存在）。
- Produces: `createRegistry(warn: (msg: string) => void, tables: { agents: KvTable<string, AgentRecord>; meta: KvTable<string, { value: string }> }): Promise<AgentRegistry>`（`ctx` 参数移除）。

- [ ] **Step 1: 改签名并上移域打开**

`src/agents/registry.ts`：
- 删掉 `import { openDomainSafely } from '../shared/storage.ts'`（不再用）。
- `createRegistry` 签名与开头改为：

```ts
/**
 * 打开 dsh_agent_toolkit 域 → 缺 main/explorer/general 时种入内置 → 首启 YAML 导入 →
 * 构建内存缓存。域由 apply 统一 open（storage-domain 同名单开），此处只消费表句柄。
 */
export async function createRegistry(
  warn: (msg: string) => void,
  tables: { agents: KvTable<string, AgentRecord>; meta: KvTable<string, { value: string }> },
): Promise<AgentRegistry> {
  const { agents, meta } = tables
```
并删除原第 30-32 行的 `const domain = await openDomainSafely(...)`、`const agents = domain.table('agents') as ...`、`const meta = domain.table('meta') as ...`。

`src/index.ts` apply：`const registry = await createRegistry(ctx, warn)` → 先打开域：

```ts
  const domain = await openDomainSafely(ctx, agentToolkitDomain, warn)
  const registryTables = {
    agents: domain.table('agents') as KvTable<string, AgentRecord>,
    meta: domain.table('meta') as KvTable<string, { value: string }>,
  }
  const registry = await createRegistry(warn, registryTables)
```

并新增 import：`import { agentToolkitDomain, type AgentRecord } from './agents/store.ts'`、`import { openDomainSafely } from './shared/storage.ts'`、`import type { KvTable } from '@deepseek-ai/dsh-storage-domain'`。

- [ ] **Step 2: 更新 registry.test.ts**

- 删除 `makeCtx`/`FakeCtx` 定义（第 42-54 行）。
- 新增 `tablesOf` 助手（放 `agentsOf` 之后）：

```ts
function tablesOf(domain: FakeDomain) {
  return {
    agents: domain.table('agents') as unknown as KvTable<string, AgentRecord>,
    meta: domain.table('meta') as unknown as KvTable<string, { value: string }>,
  }
}
```

- 把全部 20 处 `const { ctx } = makeCtx(domain)` 一行删除，并把紧随的 `await createRegistry(ctx, vi.fn())` 改为 `await createRegistry(vi.fn(), tablesOf(domain))`。涉及测试：`空表种入内置三条`、`已有记录不重复种入`、`list`、`upsert：写穿到持久层并刷新缓存`、`upsert：main 的 name/builtin 锁定`、`upsert：内置角色可改配置`、`upsert：非法记录被拒`、`remove：main 与内置抛错`、`remove：非内置可删`、`subscribe：upsert/remove 后触发`、`多个订阅者`、`createRegistry：旧记录 promptLayers 迁移`、`createRegistry：存量 tools.allow 一次性并入`。
- 以首个测试为样例，最终形态：

```ts
test('createRegistry：空表种入内置三条（main/explorer/general）', async () => {
  const domain = new FakeDomain(agentToolkitDomain)
  const registry = await createRegistry(vi.fn(), tablesOf(domain))
  expect(registry.list().map(r => r.id)).toEqual(['main', 'explorer', 'general'])
  expect(registry.get('main')?.name).toBe('主 Agent')
  expect(registry.get('explorer')?.builtin).toBe(true)
  expect(registry.get('general')?.builtin).toBe(true)
})
```

其余测试照此机械替换（`agentsOf(domain)`、`new FakeDomain(agentToolkitDomain)` 不变；`vi.fn()` 即 warn 参数）。

- [ ] **Step 3: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test registry.test.ts index.test.ts`
Expected: PASS（index.test.ts 的 `openedDomains` 断言仍为三域，因为 apply 现在自己打开 `dsh_agent_toolkit`）。

- [ ] **Step 4: Commit**

```bash
git add packages/toolkit/src/agents/registry.ts packages/toolkit/src/index.ts packages/toolkit/src/agents/registry.test.ts
git commit -m "refactor(toolkit): 域打开上移 apply，createRegistry 改收表句柄"
```

---

### Task 7: apply 接线 openLayerSource（真源替换静态占位）

**Files:**
- Modify: `packages/toolkit/src/index.ts`
- Test: `packages/toolkit/src/index.test.ts`

**Interfaces:**
- Consumes: Task 5 `openLayerSource`、Task 6 的表句柄。
- Produces: `apply()` 现在打开 `prompt_layers` 表并构建真 `LayerSource` 传给 `setupPrompt`。

- [ ] **Step 1: 实现**

`src/index.ts` apply：把 Task 6 的表句柄构造扩为含 `promptLayers`，并替换静态占位：

```ts
  const domain = await openDomainSafely(ctx, agentToolkitDomain, warn)
  const tables = {
    agents: domain.table('agents') as KvTable<string, AgentRecord>,
    meta: domain.table('meta') as KvTable<string, { value: string }>,
    promptLayers: domain.table('prompt_layers') as KvTable<string, { layers: LayerConfig[] }>,
  }
  const registry = await createRegistry(warn, { agents: tables.agents, meta: tables.meta })
  const layerSource = await openLayerSource({ promptLayers: tables.promptLayers, meta: tables.meta }, config.layers)
  setupPrompt(ctx, { source: layerSource, rules: config.rules })
  setupDelegate(ctx, {
    provider: config.provider,
    toolName: config.toolName,
    getLayers: () => layerSource.get(),
    rules: config.rules,
  }, registry)
```

删除 Task 2 引入的 `layersRef`/`staticSource` 两行；新增 import `openLayerSource`（`from './prompt/layer-source.ts'`）。`LayerView` type import 若已无引用则移除。

- [ ] **Step 2: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test index.test.ts`
Expected: PASS（`openedDomains` 仍三域、`sections` 仍含 `prompt-stack:base`/`prompt-stack:model-notes`；`makeCtx` 的 FakeDomain 已含 prompt_layers 表，openLayerSource 种子写入成功）。

- [ ] **Step 3: Commit**

```bash
git add packages/toolkit/src/index.ts
git commit -m "feat(toolkit): apply 接线 openLayerSource，分层提示词运行时改读存储"
```

---

### Task 8: 抽取 `shared/http.ts`（纯重构）

**Files:**
- Create: `packages/toolkit/src/shared/http.ts`
- Modify: `packages/toolkit/src/agents/api.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `export const MAX_BODY_BYTES = 64 * 1024`；`export function json(res, code, body)`；`export async function readJsonBody(req, res): Promise<unknown | undefined>`。

- [ ] **Step 1: 抽文件**

新建 `src/shared/http.ts`（内容照 `agents/api.ts` 第 22-48 行的 `MAX_BODY_BYTES`/`json`/`readJsonBody` 原样搬移，保持注释）。

- [ ] **Step 2: 改 agents/api.ts**

删除 `agents/api.ts` 第 22-48 行的三处定义，改为：`import { json, readJsonBody } from '../shared/http.ts'`（`MAX_BODY_BYTES` 若不再引用则无需 import）。

- [ ] **Step 3: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test agents/api.test.ts`
Expected: PASS（行为字节不变）。

- [ ] **Step 4: Commit**

```bash
git add packages/toolkit/src/shared/http.ts packages/toolkit/src/agents/api.ts
git commit -m "refactor(toolkit): 抽取 shared/http.ts 供多个 api 模块复用"
```

---

### Task 9: 分层提示词 HTTP API（Node 半）

**Files:**
- Create: `packages/toolkit/src/prompt/api.ts`
- Test: `packages/toolkit/src/prompt/api.test.ts`

**Interfaces:**
- Consumes: Task 5 `LayerSource`、Task 1 `validateLayers`、Task 4 `LayerConfigSchema`、Task 8 `json`/`readJsonBody`、`registerOptionalRoutes`。
- Produces: `export interface PromptLayersApiDeps { source: LayerSource; rules: Rule[]; seedLayers: LayerConfig[] }`；`export function createPromptLayersApiHandler(deps): (req, res) => Promise<void>`；`export function setupPromptLayersApi(ctx, deps): void`。

- [ ] **Step 1: 写失败测试**

新建 `src/prompt/api.test.ts`（mock req/res 照 `agents/api.test.ts` 第 9-32 行的 `mockReq`/`mockRes` 抄写）：

```ts
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { createPromptLayersApiHandler, type PromptLayersApiDeps } from './api.ts'
import { openLayerSource } from './layer-source.ts'
import type { LayerConfig } from './types.ts'

function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  req.method = method
  req.url = url
  req.headers = {}
  return req
}
function mockRawReq(method: string, url: string, raw: string): IncomingMessage {
  const req = Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage
  req.method = method
  req.url = url
  req.headers = {}
  return req
}
type MockRes = ServerResponse & { status: number; body: string }
function mockRes(): MockRes {
  const res = { status: 0, body: '' } as MockRes
  res.writeHead = ((code: number) => { res.status = code; return res }) as unknown as MockRes['writeHead']
  res.end = ((chunk?: unknown) => { if (typeof chunk === 'string') res.body = chunk; return res }) as unknown as MockRes['end']
  return res
}

class FakeTable<V> {
  private readonly records = new Map<string, V>()
  get(key: string): V | undefined { return this.records.get(key) }
  entries(): IterableIterator<[string, V]> { return this.records.entries() }
  keys(): IterableIterator<string> { return this.records.keys() }
  get size(): number { return this.records.size }
  async put(key: string, value: V): Promise<void> { this.records.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.records.delete(key) }
  async update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.records.get(key)
    if (current === undefined) throw new Error(`missing-key: ${key}`)
    const next = fn(current)
    this.records.set(key, next)
    return next
  }
}

const SEED: LayerConfig[] = [{ name: 'base', order: 0, text: 'B' }]
const RULES = [{ match: { modelPattern: 'deepseek*' }, append: 'DS' }]

async function harness() {
  const promptLayers = new FakeTable<{ layers: LayerConfig[] }>()
  const meta = new FakeTable<{ value: string }>()
  const source = await openLayerSource(
    { promptLayers, meta } as unknown as Parameters<typeof openLayerSource>[0],
    SEED,
  )
  const deps: PromptLayersApiDeps = { source, rules: RULES, seedLayers: SEED }
  return { deps, handler: createPromptLayersApiHandler(deps), source }
}

describe('GET /prompt-layers', () => {
  test('返回 { layers, rules, seedLayers }', async () => {
    const { handler } = await harness()
    const res = mockRes()
    await handler(mockReq('GET', '/dsh-agent-toolkit/api/prompt-layers'), res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ layers: SEED, rules: RULES, seedLayers: SEED })
  })
})

describe('PUT /prompt-layers', () => {
  test('合法层写穿并生效', async () => {
    const { handler, source } = await harness()
    const res = mockRes()
    const next: LayerConfig[] = [{ name: 'base', order: 0, text: 'B' }, { name: 'task', order: 50, text: 'T' }]
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/prompt-layers', { layers: next }), res)
    expect(res.status).toBe(200)
    expect(source.get()).toEqual(next)
  })

  test('非法层（重名/空/保留名/缺字段）→ 400', async () => {
    const { handler } = await harness()
    for (const layers of [
      [],
      [{ name: 'a', order: 0, text: 'A' }, { name: 'a', order: 1, text: 'A2' }],
      [{ name: 'model-notes', order: 0, text: 'X' }],
      [{ name: 'base' }],
    ]) {
      const res = mockRes()
      await handler(mockReq('PUT', '/dsh-agent-toolkit/api/prompt-layers', { layers }), res)
      expect(res.status).toBe(400)
    }
  })

  test('body 缺 layers 数组 / 非法 JSON → 400', async () => {
    const { handler } = await harness()
    const missing = mockRes()
    await handler(mockReq('PUT', '/dsh-agent-toolkit/api/prompt-layers', { nope: true }), missing)
    expect(missing.status).toBe(400)

    const bad = mockRes()
    await handler(mockRawReq('PUT', '/dsh-agent-toolkit/api/prompt-layers', '{ not json'), bad)
    expect(bad.status).toBe(400)
  })
})

describe('POST /prompt-layers/reset', () => {
  test('重置回种子', async () => {
    const { handler, source } = await harness()
    await source.set([{ name: 'base', order: 0, text: 'B' }, { name: 'task', order: 50, text: 'T' }])
    const res = mockRes()
    await handler(mockReq('POST', '/dsh-agent-toolkit/api/prompt-layers/reset'), res)
    expect(res.status).toBe(200)
    expect(source.get()).toEqual(SEED)
  })
})

test('未知路径 404；已知路径错误方法 405', async () => {
  const { handler } = await harness()
  const res404 = mockRes()
  await handler(mockReq('GET', '/dsh-agent-toolkit/api/prompt-layers/extra'), res404)
  expect(res404.status).toBe(404)

  const res405 = mockRes()
  await handler(mockReq('DELETE', '/dsh-agent-toolkit/api/prompt-layers'), res405)
  expect(res405.status).toBe(405)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test api.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `src/prompt/api.ts`：

```ts
/** 分层提示词 RPC 端点组：读（layers+rules+seed）、写（PUT 全量替换）、reset。 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { registerOptionalRoutes } from '../shared/webserver.ts'
import { json, readJsonBody } from '../shared/http.ts'
import { LayerConfigSchema } from '../agents/store.ts'
import { validateLayers } from './index.ts'
import type { LayerSource } from './layer-source.ts'
import type { LayerConfig, Rule } from './types.ts'

export interface PromptLayersApiDeps {
  source: LayerSource
  rules: Rule[]
  seedLayers: LayerConfig[]
}

const LayersBodySchema = z.object({ layers: z.array(LayerConfigSchema) })

export function createPromptLayersApiHandler(deps: PromptLayersApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sub = url.pathname.replace(/^\/dsh-agent-toolkit\/api\/prompt-layers/, '') || '/'
    const method = req.method ?? 'GET'

    if (sub === '/' && method === 'GET') {
      json(res, 200, { layers: deps.source.get(), rules: deps.rules, seedLayers: deps.seedLayers })
      return
    }

    if (sub === '/' && method === 'PUT') {
      const body = await readJsonBody(req, res)
      if (body === undefined) return
      const parsed = LayersBodySchema.safeParse(body)
      if (!parsed.success) {
        json(res, 400, { error: parsed.error.issues[0]?.message ?? 'invalid layers body' })
        return
      }
      try {
        validateLayers(parsed.data.layers)
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      try {
        await deps.source.set(parsed.data.layers)
      } catch (error) {
        json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      json(res, 200, { ok: true })
      return
    }

    if (sub === '/reset' && method === 'POST') {
      await deps.source.reset()
      json(res, 200, { ok: true })
      return
    }

    if (sub === '/reset' || sub === '/') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    json(res, 404, { error: 'not found' })
  }
}

/** 注册 /dsh-agent-toolkit/api/prompt-layers 前缀路由（webServer 可选服务，缺席惰性不注册）。 */
export function setupPromptLayersApi(ctx: Context, deps: PromptLayersApiDeps): void {
  const handler = createPromptLayersApiHandler(deps)
  registerOptionalRoutes(ctx, (webCtx) => {
    const dispose = webCtx.webServer.register({ kind: 'prefix', path: '/dsh-agent-toolkit/api/prompt-layers', handler })
    return () => dispose()
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test src/prompt/api.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/toolkit/src/prompt/api.ts packages/toolkit/src/prompt/api.test.ts
git commit -m "feat(toolkit): 新增分层提示词 RPC 端点（GET/PUT/reset）"
```

---

### Task 10: apply 接 `setupPromptLayersApi` + index.test 断言

**Files:**
- Modify: `packages/toolkit/src/index.ts`
- Test: `packages/toolkit/src/index.test.ts`

**Interfaces:**
- Consumes: Task 9 `setupPromptLayersApi`。
- Produces: `apply()` 注册 prompt-layers 路由（恒启用，不随 modules 门控）。

- [ ] **Step 1: 实现**

`src/index.ts` apply：在 `setupAgentsApi(...)` 之后加：

```ts
  setupPromptLayersApi(ctx, { source: layerSource, rules: config.rules, seedLayers: config.layers })
```

新增 import `import { setupPromptLayersApi } from './prompt/api.ts'`。

- [ ] **Step 2: 更新测试**

`src/index.test.ts` 的两个路由相关测试（`modules.feishu=false：agents/providers/tools RPC 仍注册`、`默认配置：agents RPC 与 bots 路由均注册`）的 `paths` 断言各加一条：`expect(paths).toContain('/dsh-agent-toolkit/api/prompt-layers')`。

- [ ] **Step 3: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test index.test.ts`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add packages/toolkit/src/index.ts packages/toolkit/src/index.test.ts
git commit -m "feat(toolkit): apply 接线分层提示词 RPC 路由"
```

---

### Task 11: 浏览器半 UI（`src/client/prompt/`）

**Files:**
- Create: `packages/toolkit/src/client/prompt/api.ts`
- Create: `packages/toolkit/src/client/prompt/PromptLayersModal.tsx`
- Create: `packages/toolkit/src/client/prompt/entry.tsx`
- Create: `packages/toolkit/src/client/prompt/index.ts`
- Create: `packages/toolkit/src/client/prompt/prompt.module.css`
- Create: `packages/toolkit/src/client/prompt/prompt-layers.spec.tsx`
- Create: `packages/toolkit/src/client/prompt/prompt-entry.client.spec.tsx`
- Modify: `packages/toolkit/src/client/index.ts`

**Interfaces:**
- Consumes: `createSidebarEntry`（`../shared/entry.tsx`）、`useLoadState`（`../shared/load-state.ts`）、ui-primitives `Modal`/`Button`/`Input`/`IconListPenOutline16`；`LayerConfig`/`Rule` 类型（type import）。
- Produces: `export function setupPromptClient(ctx: Context): void`；`export function PromptLayersEntry(props): ReactNode`。

- [ ] **Step 1: 写失败测试**

新建 `src/client/prompt/prompt-layers.spec.tsx`：

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PromptLayersModal } from './PromptLayersModal.tsx'

const PAYLOAD = {
  layers: [
    { name: 'base', order: 0, text: 'BASE' },
    { name: 'task', order: 50, text: 'TASK' },
  ],
  rules: [{ match: { modelPattern: 'deepseek*' }, overrides: { task: 'V4-TASK' }, append: 'V4-NOTES' }],
  seedLayers: [{ name: 'base', order: 0, text: 'BASE' }],
}

function stubFetch() {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    if (url === '/dsh-agent-toolkit/api/prompt-layers' && method === 'GET') {
      return new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === '/dsh-agent-toolkit/api/prompt-layers' && method === 'PUT') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === '/dsh-agent-toolkit/api/prompt-layers/reset' && method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }))
  return calls
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('加载后按 order 展示层列表与选中编辑器回显', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  expect(await screen.findByText('base')).toBeTruthy()
  expect(screen.getByText('task')).toBeTruthy()
  // 编辑器回显选中层（默认首个 = base）
  expect(screen.getByLabelText('层名')).toHaveProperty('value', 'base')
  expect(screen.getByLabelText('层文本')).toHaveProperty('value', 'BASE')
})

test('编辑层文本并保存 → PUT /prompt-layers 全量携带', async () => {
  const calls = stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('base')

  fireEvent.change(screen.getByLabelText('层文本'), { target: { value: 'NEW BASE' } })
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/prompt-layers' && c.method === 'PUT')
    expect(put).toBeTruthy()
    expect(put?.body).toEqual({
      layers: [
        { name: 'base', order: 0, text: 'NEW BASE' },
        { name: 'task', order: 50, text: 'TASK' },
      ],
    })
  })
})

test('新建层、上移、删除只改内存，保存时统一提交', async () => {
  const calls = stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('base')

  fireEvent.click(screen.getByRole('button', { name: '新建层' }))
  fireEvent.change(screen.getByLabelText('层名'), { target: { value: 'domain' } })
  fireEvent.click(screen.getByRole('button', { name: '上移' }))
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  await vi.waitFor(() => {
    const put = calls.find((c) => c.url === '/dsh-agent-toolkit/api/prompt-layers' && c.method === 'PUT')
    expect(put).toBeTruthy()
    const layers = (put?.body as { layers: Array<{ name: string }> }).layers
    expect(layers.map((l) => l.name)).toEqual(['domain', 'base', 'task'])
  })
})

test('规则只读视图：展开后展示规则，悬空引用标红', async () => {
  stubFetch()
  render(<PromptLayersModal open onClose={() => undefined} />)
  await screen.findByText('base')

  fireEvent.click(screen.getByRole('button', { name: '规则（只读）' }))
  expect(await screen.findByText(/provider=|model=|modelPattern=/)).toBeTruthy()
  expect(screen.getByText('deepseek*')).toBeTruthy()
})
```

新建 `src/client/prompt/prompt-entry.client.spec.tsx`：

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PromptLayersEntry } from './entry.tsx'

const RUNTIME = {
  useSessions: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<SessionListState>,
  useWorkspaces: (() => { throw new Error('unused') }) as unknown as SnapshotSelectorHook<WorkspaceListState>,
}

const PAYLOAD = {
  layers: [{ name: 'base', order: 0, text: 'B' }],
  rules: [],
  seedLayers: [{ name: 'base', order: 0, text: 'B' }],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } })))
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

test('宽栏与窄栏均仅图标（Tooltip/aria-label 提供可访问名）', () => {
  const { unmount } = render(<PromptLayersEntry wide {...RUNTIME} />)
  expect(screen.getByRole('button', { name: '分层提示词' }).textContent).not.toContain('分层提示词')
  unmount()
  render(<PromptLayersEntry wide={false} {...RUNTIME} />)
  expect(screen.getByRole('button', { name: '分层提示词' }).textContent).not.toContain('分层提示词')
})

test('点击打开模态框并拉取列表', async () => {
  render(<PromptLayersEntry wide {...RUNTIME} />)
  screen.getByRole('button', { name: '分层提示词' }).click()
  expect(await screen.findByText('base')).toBeTruthy()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-agent-toolkit test src/client/prompt`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `api.ts`**

新建 `src/client/prompt/api.ts`：

```ts
/** 浏览器半 RPC 封装（fetch → Node 半统一 webServer 路由）。类型全部 import type，不进 bundle。 */
import type { LayerConfig, Rule } from '../../prompt/types.ts'

export interface PromptLayersPayload {
  layers: LayerConfig[]
  rules: Rule[]
  seedLayers: LayerConfig[]
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = init === undefined
    ? await fetch(input)
    : await fetch(input, { ...init, headers: { 'content-type': 'application/json' } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const fetchPromptLayers = () => request<PromptLayersPayload>('/dsh-agent-toolkit/api/prompt-layers')

export const saveLayers = (layers: LayerConfig[]) =>
  request('/dsh-agent-toolkit/api/prompt-layers', { method: 'PUT', body: JSON.stringify({ layers }) })

export const resetLayers = () =>
  request('/dsh-agent-toolkit/api/prompt-layers/reset', { method: 'POST' })
```

- [ ] **Step 4: 实现 `PromptLayersModal.tsx`**

新建 `src/client/prompt/PromptLayersModal.tsx`：

```tsx
/** 分层提示词管理面板：左侧层列表（order 升序、增删/上移下移）+ 右侧编辑器 + 规则只读折叠视图。 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLoadState } from '../shared/load-state.ts'
import { fetchPromptLayers, resetLayers, saveLayers } from './api.ts'
import type { LayerConfig, Rule } from '../../prompt/types.ts'
import css from './prompt.module.css'

export interface PromptLayersModalProps {
  open: boolean
  onClose: () => void
}

export function PromptLayersModal({ open, onClose }: PromptLayersModalProps): ReactNode {
  return (
    <Modal open={open} onClose={onClose} title="分层提示词" closeLabel="关闭" className={css.dialog}>
      {open && <PromptLayersBody />}
    </Modal>
  )
}

function nextOrder(layers: LayerConfig[]): number {
  return layers.reduce((max, layer) => Math.max(max, layer.order), -1) + 10
}

function sortedLayers(layers: LayerConfig[]): LayerConfig[] {
  return [...layers].sort((a, b) => a.order - b.order)
}

function matchSummary(rule: Rule): string {
  const parts: string[] = []
  const m = rule.match
  if (m.provider !== undefined) parts.push(`provider=${m.provider}`)
  if (m.model !== undefined) parts.push(`model=${m.model}`)
  if (m.modelPattern !== undefined) parts.push(`modelPattern=${m.modelPattern}`)
  return parts.join(' AND ')
}

function PromptLayersBody(): ReactNode {
  const { state, reload } = useLoadState<{ layers: LayerConfig[]; rules: Rule[]; seedLayers: LayerConfig[] }>(fetchPromptLayers, [])
  const [layers, setLayers] = useState<LayerConfig[]>([])
  const [rules, setRules] = useState<Rule[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRules, setShowRules] = useState(false)
  const [confirmingReset, setConfirmingReset] = useState(false)

  useEffect(() => {
    if (state.kind !== 'ok' || loaded) return
    setLayers(sortedLayers(state.data.layers))
    setRules(state.data.rules)
    setLoaded(true)
  }, [state, loaded])

  const ordered = sortedLayers(layers)
  const selected = ordered[Math.min(selectedIndex, ordered.length - 1)]
  const layerNames = new Set(ordered.map(l => l.name))

  function updateSelected(patch: Partial<LayerConfig>): void {
    if (selected === undefined) return
    const next = layers.map(l => (l.name === selected.name && l.order === selected.order ? { ...l, ...patch } : l))
    setLayers(next)
    setDirty(true)
  }

  function addLayer(): void {
    const layer: LayerConfig = { name: '', order: nextOrder(layers), text: '' }
    setLayers([...layers, layer])
    setSelectedIndex(layers.length)
    setDirty(true)
  }

  function deleteSelected(): void {
    if (selected === undefined) return
    const next = layers.filter(l => !(l.name === selected.name && l.order === selected.order))
    setLayers(next)
    setSelectedIndex(Math.max(0, selectedIndex - 1))
    setDirty(true)
  }

  function moveSelected(dir: -1 | 1): void {
    if (selected === undefined) return
    const index = ordered.findIndex(l => l.name === selected.name && l.order === selected.order)
    const target = index + dir
    if (index < 0 || target < 0 || target >= ordered.length) return
    const a = ordered[index]
    const b = ordered[target]
    const next = ordered.map((l, i) =>
      i === index ? { ...b, order: a.order } : i === target ? { ...a, order: b.order } : l)
    setLayers(next)
    setSelectedIndex(target)
    setDirty(true)
  }

  async function save(): Promise<void> {
    setError(null)
    setSaving(true)
    try {
      await saveLayers(sortedLayers(layers))
      setDirty(false)
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function reset(): Promise<void> {
    setError(null)
    setSaving(true)
    try {
      await resetLayers()
      setConfirmingReset(false)
      setLoaded(false)
      setSelectedIndex(0)
      setDirty(false)
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={css.split}>
      <div className={css.listPane}>
        {state.kind === 'loading' && <p className={css.hint}>加载中…</p>}
        {state.kind === 'error' && <p className={css.hint}>加载失败，请重试</p>}
        {state.kind === 'ok' && ordered.map((layer, index) => (
          <button key={`${layer.name}-${layer.order}`} type="button"
            className={clsx(css.layerRow, index === selectedIndex && css.layerRowActive)}
            onClick={() => { setSelectedIndex(index) }}>
            <span className={css.layerName}>{layer.name || '(未命名)'}</span>
            <span className={css.layerOrder}>order {layer.order}</span>
          </button>
        ))}
        <Button variant="primary" className={css.createButton} onClick={addLayer}>新建层</Button>
      </div>
      <div className={css.editorPane}>
        {state.kind === 'ok' && selected !== undefined ? (
          <div className={css.editor}>
            <label className={css.field}>
              层名
              <Input value={selected.name} aria-label="层名" className={css.input}
                onChange={(e) => { updateSelected({ name: e.target.value }) }} />
            </label>
            <label className={css.field}>
              order
              <Input value={String(selected.order)} aria-label="order" className={css.input}
                onChange={(e) => {
                  const parsed = Number(e.target.value)
                  if (Number.isFinite(parsed)) updateSelected({ order: parsed })
                }} />
            </label>
            <label className={css.field}>
              层文本
              <textarea className={css.textarea} value={selected.text} aria-label="层文本" rows={8}
                onChange={(e) => { updateSelected({ text: e.target.value }) }} />
            </label>

            <div className={css.rowActions}>
              <Button variant="outline" onClick={() => { moveSelected(-1) }}>上移</Button>
              <Button variant="outline" onClick={() => { moveSelected(1) }}>下移</Button>
              <Button variant="outline" className={css.dangerButton} onClick={deleteSelected}>删除层</Button>
            </div>

            <div className={css.actions}>
              {error !== null && <p role="alert" className={css.error}>{error}</p>}
              {confirmingReset ? (
                <>
                  <span className={css.hint}>确认用默认层覆盖当前层？</span>
                  <Button variant="outline" disabled={saving} onClick={() => { setConfirmingReset(false) }}>取消</Button>
                  <Button variant="primary" disabled={saving} onClick={() => { void reset() }}>确认重置</Button>
                </>
              ) : (
                <Button variant="outline" disabled={saving} onClick={() => { setConfirmingReset(true) }}>重置为默认层</Button>
              )}
              <Button variant="primary" disabled={saving || !dirty} onClick={() => { void save() }}>保存</Button>
            </div>
          </div>
        ) : (
          <p className={css.hint}>{state.kind === 'loading' ? '加载中…' : state.kind === 'error' ? '加载失败，请重试' : '请选择层'}</p>
        )}
      </div>
      <div className={css.rulesPane}>
        <Button variant="outline" onClick={() => { setShowRules(!showRules) }}>规则（只读）</Button>
        {showRules && (
          <ul className={css.ruleList}>
            {rules.map((rule, index) => {
              const dangling = Object.keys(rule.overrides ?? {}).filter(k => !layerNames.has(k))
              return (
                <li key={index} className={css.ruleItem}>
                  <span className={css.ruleMatch}>{matchSummary(rule)}</span>
                  {Object.keys(rule.overrides ?? {}).length > 0 && (
                    <span className={css.ruleOverrides}>
                      overrides: {Object.entries(rule.overrides ?? {}).map(([k, v]) =>
                        <span key={k} className={dangling.includes(k) ? css.dangling : undefined}>{k}</span>).join(', ')}
                    </span>
                  )}
                  {rule.append !== undefined && <span className={css.ruleAppend}>append: {rule.append}</span>}
                  {dangling.length > 0 && <span className={css.error}>悬空层引用：{dangling.join(', ')}</span>}
                </li>
              )
            })}
            {rules.length === 0 && <li className={css.hint}>无规则（rules 由 cordis.yml 配置）</li>}
          </ul>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: 实现 `entry.tsx` / `index.ts` / css / 接线**

`src/client/prompt/entry.tsx`：

```tsx
/** 分层提示词侧边栏底栏入口：createSidebarEntry 工厂产物，点击打开管理模态框。 */
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { IconListPenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSidebarEntry } from '../shared/entry.tsx'
import { PromptLayersModal } from './PromptLayersModal.tsx'

const SidebarEntry = createSidebarEntry({
  id: 'dsh-agent-toolkit:prompt-layers',
  order: 0,
  icon: <IconListPenOutline16 size={18} />,
  title: '分层提示词',
  renderModal: (p) => <PromptLayersModal {...p} />,
})

export function PromptLayersEntry(props: PropsRuntime<'sidebar.footer.action'>): ReactNode {
  return <SidebarEntry wide={props.wide} />
}
```

`src/client/prompt/index.ts`：

```ts
/** dsh-agent-toolkit 分层提示词浏览器半：注册侧边栏底栏入口。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { PromptLayersEntry } from './entry.tsx'

export function setupPromptClient(ctx: Context): void {
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'dsh-agent-toolkit:prompt-layers', order: 0 },
      PromptLayersEntry,
    ))
}
```

`src/client/index.ts`：加 import `import { setupPromptClient } from './prompt/index.ts'`，并在 `apply` 内 `setupAgentsClient(ctx)` 之后加 `setupPromptClient(ctx)`。

`src/client/prompt/prompt.module.css`（复刻 agents 面板的 CSS 变量与布局）：

```css
.dialog { width: 960px; }

.split {
  display: flex;
  gap: 16px;
  min-height: 420px;
}
.listPane {
  flex: none;
  width: 200px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.layerRow {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font: inherit;
  color: inherit;
  text-align: left;
}
.layerRow:hover { background: var(--dsw-alias-interactive-bg-hover); }
.layerRowActive {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.layerName { font-size: 14px; line-height: 22px; }
.layerOrder { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.createButton { margin-top: 8px; }

.editorPane { flex: 1; min-width: 0; max-height: 70vh; overflow-y: auto; }
.editor { display: flex; flex-direction: column; gap: 16px; }
.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.input { width: 100%; }
.textarea {
  width: 100%;
  min-height: 160px;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-elevated, transparent);
  font: inherit;
  color: inherit;
  resize: vertical;
}
.rowActions { display: flex; gap: 8px; }
.actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.dangerButton { color: var(--dsw-alias-status-danger, inherit); }

.rulesPane { flex: none; width: 260px; }
.ruleList { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ruleItem { display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 18px; }
.ruleMatch { color: var(--dsw-alias-label-secondary); }
.ruleOverrides { color: var(--dsw-alias-label-tertiary); }
.ruleAppend { color: var(--dsw-alias-label-tertiary); }
.dangling { color: var(--dsw-alias-status-danger, red); }
.hint { font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.error { font-size: 13px; color: var(--dsw-alias-status-danger, red); }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter dsh-agent-toolkit test src/client/prompt`
Expected: PASS（两个 spec 全绿）。若 `getByLabelText('order')` 与「层文本」标签冲突，以测试实际渲染的 aria-label 为准修正。

- [ ] **Step 7: Commit**

```bash
git add packages/toolkit/src/client/prompt packages/toolkit/src/client/index.ts
git commit -m "feat(toolkit): 新增分层提示词管理面板（浏览器半）"
```

---

### Task 12: 文档更新

**Files:**
- Modify: `docs/usage/prompt-layers.md`
- Modify: `docs/usage/config-reference.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新 `docs/usage/prompt-layers.md`**

在「分层结构」节之后新增一节：

```md
## UI 管理（层）

层列表现在由 UI 管理：`dsh-agent-toolkit` 插件浏览器半新增「分层提示词」侧边栏入口（Agents 之后）。
- 可增删层、上下移（改 order）、编辑层名/order/文本；保存全量替换。
- 「重置为默认层」用 cordis.yml 的 `layers` 种子覆盖当前层（覆盖性操作，需确认）。
- 「规则（只读）」折叠区展示当前 `rules`（仍由 cordis.yml 配置，不在本面板编辑）；引用不存在层的 overrides 会标「悬空」。
- 存储：`dsh_agent_toolkit` 域 `prompt_layers` 表（单行 `layers`），`meta` 表 `prompt_layers_seeded` 首启种子标记。`config.layers` 仅在首次启动（或重置后）作为种子写入，此后运行一律读存储。
```

并把「自定义 layers/rules 整体替换默认值」处补一句：`layers` 若已由 UI 管理，cordis.yml 的 `layers` 仅作种子/重置默认值，不再动态生效。

- [ ] **Step 2: 更新 `docs/usage/config-reference.md`**

在 `layers` 字段说明处加：`（首启种子；若已用 UI 管理分层提示词，此后由存储域生效，此处仅在重置时作为默认值）`。

- [ ] **Step 3: 更新 `AGENTS.md` 测试计数与目录**

- 「单测：…318/318 测试通过」→ 全量跑完后按实际总数更新（见 Task 13）。
- 「`src/shared/` 的 `openDomainSafely` / `registerOptionalRoutes`」句后补：`src/shared/http.ts`（json/readJsonBody 响应助手，agents/prompt 两个 API 共用）。
- 目录结构「packages/toolkit」描述不必改。

- [ ] **Step 4: Commit**

```bash
git add docs/usage/prompt-layers.md docs/usage/config-reference.md AGENTS.md
git commit -m "docs: 更新分层提示词 UI 管理说明与 AGENTS.md"
```

---

### Task 13: 全量验证

**Files:** 无（必要时修编译错误）。

- [ ] **Step 1: 全量单测**

Run: `pnpm --filter dsh-agent-toolkit test`
Expected: PASS，全部用例通过（新增约 20+ 用例）。

- [ ] **Step 2: 类型检查**

Run: `pnpm --filter dsh-agent-toolkit typecheck`
Expected: 0 错误。

- [ ] **Step 3: 构建双半 bundle**

Run: `pnpm --filter dsh-agent-toolkit bundle`
Expected: 产出 `lib/index.js`（Node 半）与 `lib/client.js`（浏览器半）无报错。

- [ ] **Step 4: 回填 AGENTS.md 测试计数**

Run: `pnpm --filter dsh-agent-toolkit test --reporter=dot 2>&1 | tail -n 20` 读总数，把 AGENTS.md 中「318/318」改为实际总数，并提交：

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md 测试计数同步 <N>/<N>"
```

---

## Self-Review

**Spec coverage:** 第 1 节存储（Task 4/5）；第 2 节运行时层源+重注册（Task 1/2/5/7）+ 委派 getter（Task 3）+ 域单开（Task 6）；第 3 节 HTTP API（Task 8/9/10）；第 4 节 UI（Task 11）；第 5 节校验/种子/错误（Task 1/5/9）；第 6 节测试与文档（各 Task 的 test + Task 12/13）。全盖。

**Placeholder scan:** 无 TBD/TODO；每处代码块含真实实现。

**Type consistency:** `LayerView`/`LayerSource`/`PromptLayersRow`/`PromptLayerTables`/`PromptLayersApiDeps`/`PromptLayersPayload` 在各任务签名一致；`createRegistry(warn, tables)` 与 `openLayerSource(tables, seedLayers)` 参数名对齐 Task 6/7 的 apply 调用。
