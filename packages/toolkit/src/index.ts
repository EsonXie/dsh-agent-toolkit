/** dsh-agent-toolkit 插件总入口：Agent 注册表 + 分层提示词 + 并行委派 + 飞书 bots + token 用量。 */
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { createRegistry } from './agents/registry.ts'
import { agentToolkitDomain, type AgentRecord } from './agents/store.ts'
import { openDomainSafely } from './shared/storage.ts'
import { DEFAULT_LAYERS, DEFAULT_RULES } from './prompt/defaults.ts'
import { setupPrompt, validateConfig as validatePromptConfig } from './prompt/index.ts'
import { openLayerSource, type PromptLayersRow } from './prompt/layer-source.ts'
import { setupPromptLayersApi } from './prompt/api.ts'
import type { LayerConfig, Rule } from './prompt/types.ts'
import { setupDelegate } from './delegate/index.ts'
import { createActiveRoutes } from './delegate/active.ts'
import { delegationRoutesDomain, type DelegationRouteRecord } from './delegate/routes.ts'
import { setupDelegateApi } from './delegate/api.ts'
import { setupAgentsApi } from './agents/api.ts'
import { setupCreateAgentCommand } from './agents/create-command.ts'
import { setupBots, type BotsModuleConfig } from './bots/index.ts'
import { setupAgentTeamPreset, type AgentTeamPresetConfig } from './agents/team-preset.ts'
import { setupUsage } from '@dsh-agent-toolkit/token-usage'

export const name = 'dsh-agent-toolkit'

// 全部硬依赖服务（merged 模块直接消费；archive token-usage/project-bot 的 inject 并集）。
// storageDomain（registry/bots/usage 经 openDomainSafely 消费）、tokenMeter（usage）、
// credentials（bots）不在 brief 骨架的 7 项里，但均为插件运行必需，补齐。
export const inject = [
  'storageDomain',
  'tools',
  'subagents',
  'systemPrompt',
  'commands',
  'llm',
  'agentDefaultModel',
  'agents',
  'tokenMeter',
  'credentials',
]

/** 插件配置输出型。 */
export interface Config {
  modules: { feishu: boolean; usage: boolean }
  layers: LayerConfig[]
  rules: Rule[]
  timezone: string
  provider: string
  toolName: string
  feishu: BotsModuleConfig
  agentTeamPreset: AgentTeamPresetConfig
}

/** layers/rules 的 schemastery schema 照归档 prompt-stack/src/index.ts:21-41 逐字段平移（含 overrides transform hack）。 */
export const Config: z<unknown, Config> = z.object({
  modules: z.object({
    feishu: z.boolean().default(true),
    usage: z.boolean().default(true),
  }).default({ feishu: true, usage: true }),
  layers: z.array(z.object({
    name: z.string().required(),
    order: z.number().required(),
    text: z.string().required(),
  })).default(DEFAULT_LAYERS),
  // 元素 cast 为 z<Rule>：Rule.overrides/append 可选，而 z.object 输出键全必填，
  // 直接 .default(DEFAULT_RULES) 会类型不匹配。transform 丢弃空 overrides：
  // z.dict 隐式默认 {}，会给 append-only 默认规则注入 overrides: {}（破坏
  // Config({}) 与 DEFAULT_RULES 的精确相等）。
  rules: z.array((z.object({
    match: z.object({
      provider: z.string(),
      model: z.string(),
      modelPattern: z.string(),
    }).required(),
    overrides: z.transform(z.dict(z.string()), value => Object.keys(value).length === 0 ? undefined : value),
    append: z.string(),
  }) as z<Rule>)).default(DEFAULT_RULES),
  timezone: z.string().default('Asia/Shanghai'),
  provider: z.string().default('spawn'),
  toolName: z.string().default('team_delegate'),
  // feishu 6 个全局可调参数照归档 project-bot/src/index.ts:38-45，字段名/默认值原样平移。
  feishu: z.object({
    cardUpdateThrottleMs: z.number().default(500),
    cardMaxBytes: z.number().default(28_000),
    processMaxBytes: z.number().default(8_000),
    registerAppTimeoutMs: z.number().default(600_000),
    processingReactionEmoji: z.string().default('OneSecond'),
    errorDetailMaxChars: z.number().default(500),
    injectSender: z.boolean().default(true),
  }).default({
    cardUpdateThrottleMs: 500,
    cardMaxBytes: 28_000,
    processMaxBytes: 8_000,
    registerAppTimeoutMs: 600_000,
    processingReactionEmoji: 'OneSecond',
    errorDetailMaxChars: 500,
    injectSender: true,
  }),
  // agent-team preset 自动生成：派生 shipped standard、禁用 subagent 工具族 4 行，
  // 写入首个 trust=user root（spec: docs/superpowers/specs/2026-09-02-agent-team-preset-design.md）。
  agentTeamPreset: z.object({
    enabled: z.boolean().default(true),
    id: z.string().default('agent-team'),
    source: z.string().default('standard'),
    name: z.string().default('Agent 团队'),
    description: z.string().default('Agent 团队模式：禁用原生 subagent 工具族，委派统一走 team_delegate 团队角色'),
  }).default({
    enabled: true,
    id: 'agent-team',
    source: 'standard',
    name: 'Agent 团队',
    description: 'Agent 团队模式：禁用原生 subagent 工具族，委派统一走 team_delegate 团队角色',
  }),
}) as z<unknown, Config>

export async function apply(ctx: Context, config: Config): Promise<void> {
  validatePromptConfig({ layers: config.layers, rules: config.rules })
  const warn = (msg: string): void => ctx.logger.warn(msg)
  const domain = await openDomainSafely(ctx, agentToolkitDomain, warn)
  const tables = {
    agents: domain.table('agents') as KvTable<string, AgentRecord>,
    meta: domain.table('meta') as KvTable<string, { value: string }>,
    promptLayers: domain.table('prompt_layers') as KvTable<string, PromptLayersRow>,
  }
  const registry = await createRegistry(warn, { agents: tables.agents, meta: tables.meta })
  const layerSource = await openLayerSource({ promptLayers: tables.promptLayers, meta: tables.meta }, config.layers)
  setupPrompt(ctx, { source: layerSource, rules: config.rules })
  const routesDomain = await openDomainSafely(ctx, delegationRoutesDomain, warn)
  const routesTable = routesDomain.table('routes') as KvTable<string, DelegationRouteRecord>
  const activeRoutes = createActiveRoutes()
  setupDelegate(ctx, {
    provider: config.provider,
    toolName: config.toolName,
    rules: config.rules,
  }, registry, {
    active: activeRoutes,
    recordRoute: async (childSessionId, route) => {
      await routesTable.put(childSessionId, { provider: route.provider, model: route.model, at: Date.now() })
    },
  })
  setupDelegateApi(ctx, { active: activeRoutes, routes: routesTable })
  // agents/providers/tools RPC 为核心恒启用（Agents 面板总是挂载，端点缺失即「加载失败」），
  // 不随 modules.feishu 门控；仅 bots 分支受 feishu 开关控制。
  const listTools = (): string[] => ctx.tools.schemas().map((s) => s.name)
  setupAgentsApi(ctx, {
    registry,
    listTools,
    listProviders: () => ctx.llm.listProviders().map(({ id, name }) => ({ id, name })),
    listModels: (provider) => ctx.llm.listModels(provider).then((models) => models.map(({ id, name }) => ({ id, name }))),
  })
  // /create-agent 命令恒启用（引导主 Agent 访谈并复用面板 API 落库，不新增工具/API）。
  setupCreateAgentCommand(ctx, { registry, listTools })
  setupPromptLayersApi(ctx, {
    source: layerSource,
    rules: config.rules,
    seedLayers: config.layers,
    // 裸组装探测：面板只读区展示原生 sections 与动态层 contexts 的当前快照。
    probe: async () => {
      const assembly = await ctx.systemPrompt.assemble({})
      return {
        sections: assembly.sections.map(({ name: n, text }) => ({ name: n, text })),
        contexts: assembly.contexts.map(({ name: n, text }) => ({ name: n, text })),
      }
    },
  })
  // agentPresets 为可选服务（rc2 旧宿主缺席时内部静默跳过），不进 inject。
  await setupAgentTeamPreset(ctx, config.agentTeamPreset)
  if (config.modules.feishu) setupBots(ctx, config.feishu, { registry })
  if (config.modules.usage) setupUsage(ctx, { timezone: config.timezone }, name)
}
