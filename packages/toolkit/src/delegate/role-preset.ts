/** 角色 agent preset 生命周期：名册角色 → agentPresets 声明式组合（persona + 工具白名单）。
 *  0.2.1 委派模型：子代理 persona 与工具构成由所选 preset 承载（SubagentStartRequest 的
 *  persona/toolFilter 已删除）。每角色一个 preset，委派经 request.agentPreset 选择。 */
import type { Context } from '@deepseek-ai/cordis'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { AgentRecord } from '../agents/store.ts'
import type { AgentRegistry } from '../agents/registry.ts'

/** agentPresets 可选服务的结构类型（team-preset.ts:75 先例；可选服务经 ctx.get 读取）。 */
interface AgentPresetsLike {
  register(definition: {
    id: string
    name?: string
    description?: string
    plugins: readonly unknown[]
  }): Promise<() => Promise<void>>
}

/** preset id 白名单镜像宿主（team-preset.ts:68）。 */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/** 角色 preset id 规约：slug 化角色 id（小写字母/数字/连字符，其余折叠为 -）。 */
export function rolePresetId(roleId: string): string {
  const slug = roleId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `dsh-agent-toolkit-role-${slug}`
}

/**
 * 注册一个角色的 preset，返回异步 disposer（宿主对重复 id 抛错，更新须先 dispose 旧的）。
 * 工具白名单在此与全局工具面求交：未知名与 run_code warn-drop（restrict 对未知名响亮
 * 报错；run_code 是保留传输名）。求交为空时不挂 tools 行（role.tools 语义退化为不限制）。
 */
export async function registerRolePreset(
  ctx: Context,
  role: AgentRecord,
  persona: string,
): Promise<(() => Promise<void>) | undefined> {
  const agentPresets = ctx.get('agentPresets', false) as AgentPresetsLike | undefined
  if (agentPresets === undefined) {
    ctx.logger.warn('dsh-agent-toolkit: agentPresets 服务缺席，角色 preset 未注册（委派将无 persona/白名单）')
    return undefined
  }
  if (!PRESET_ID.test(rolePresetId(role.id))) {
    ctx.logger.warn(`dsh-agent-toolkit: 角色 id "${role.id}" 无法 slug 化为合法 preset id，跳过 preset 注册`)
    return undefined
  }
  const plugins: Record<string, unknown>[] = [
    { id: 'persona', name: 'dsh-agent-toolkit/role-persona', config: { prefix: persona } },
  ]
  if (role.tools !== undefined) {
    const global = new Set((ctx.tools.schemas(undefined) as { name: string }[]).map((s) => s.name))
    const effective = role.tools.allow.filter((n) => global.has(n) && n !== RUN_CODE_NAME)
    const dropped = role.tools.allow.filter((n) => !global.has(n) || n === RUN_CODE_NAME)
    if (dropped.length > 0) {
      ctx.logger.warn(`dsh-agent-toolkit: 角色 ${role.id} 白名单含非全局/保留工具，preset 忽略：${dropped.join(', ')}`)
    }
    if (effective.length > 0) {
      plugins.push({ id: 'tools', name: 'dsh-agent-toolkit/role-tools', config: { allow: effective } })
    }
  }
  return agentPresets.register({
    id: rolePresetId(role.id),
    name: role.name,
    description: role.description,
    plugins,
  })
}

/**
 * 挂载角色 preset 生命周期：初始注册全部团队可见角色，订阅名册变更做增/改/删联动
 * （改 = 先 dispose 再注册；宿主重复 id 抛错）。全部 disposer 随 ctx.effect 清理。
 */
export function setupRolePresets(
  ctx: Context,
  registry: AgentRegistry,
  buildPersona: (role: AgentRecord) => string,
): void {
  const disposers = new Map<string, () => Promise<void>>()
  const sync = async (): Promise<void> => {
    const wanted = new Map(registry.list().filter((r) => r.id !== 'main').map((r) => [r.id, r]))
    for (const [id, dispose] of [...disposers]) {
      if (!wanted.has(id)) { disposers.delete(id); await dispose() }
    }
    for (const [id, role] of wanted) {
      const persona = buildPersona(role)
      // 简化策略：任何名册变更都重建该角色 preset（注册便宜，避免 diff persona/白名单）。
      const previous = disposers.get(id)
      if (previous !== undefined) await previous()
      const next = await registerRolePreset(ctx, role, persona)
      if (next !== undefined) disposers.set(id, next)
      else disposers.delete(id)
    }
  }
  ctx.effect(() => {
    void sync()
    const unsubscribe = registry.subscribe(() => { void sync() })
    return () => {
      unsubscribe()
      for (const dispose of disposers.values()) void dispose()
      disposers.clear()
    }
  }, 'dsh-agent-toolkit: role presets')
}
