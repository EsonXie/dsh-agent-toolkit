/** 角色组合：委派子会话继承父 preset，再在子 scope 叠加角色 persona 与工具白名单。
 *  0.2.1 的显式 agentPreset 是完整组合，不继承父 preset；因此委派请求不选 preset，
 *  改由 agent/created（首条 prompt 入队前、串行 await）在子 scope 做 scope-local 叠加。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { AgentRecord } from '../agents/store.ts'
import type { AgentRegistry } from '../agents/registry.ts'

/** team_delegate 写入 descriptor 的角色标签前缀；解析时要求完整 `role:<id>: `。 */
const ROLE_LABEL = /^role:([a-z][a-z0-9-]{0,31}): /

/** 从 descriptor label 解析角色 id；非本工具创建的委派返回 undefined。 */
export function roleIdFromLabel(label: string): string | undefined {
  return ROLE_LABEL.exec(label)?.[1]
}

/** descriptor 的 label 是持久化字段，冷恢复后可再次解析；取最后一条 descriptor。 */
export function delegatedRoleId(events: readonly { readonly type: string; readonly data?: unknown }[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'subagent/descriptor') continue
    const data = event.data
    if (typeof data !== 'object' || data === null) continue
    const label = (data as { label?: unknown }).label
    if (typeof label === 'string') return roleIdFromLabel(label)
  }
  return undefined
}

export interface RoleCompositionDeps {
  readonly getRole: (id: string) => AgentRecord | undefined
  readonly buildPersona: (role: AgentRecord) => string
  readonly warn: (message: string) => void
}

/**
 * 在子 Agent scope 安装角色组合。persona 段遮蔽父 preset 的 deployment persona；
 * tools.restrict 作用于子 scope 的继承面（父 preset + global），own 层不受影响。
 * 白名单先与子会话当前可见面求交，未知名与 run_code warn-drop；求交为空时
 * 保持 fail-closed（allow: []），避免配置错误的角色意外获得全部工具。
 * @param agent - 刚创建（含冷恢复）的子 Agent。
 * @param deps - 角色查询、persona 渲染与诊断出口。
 */
export function applyRoleComposition(agent: Agent, deps: RoleCompositionDeps): void {
  const roleId = delegatedRoleId(agent.session.snapshotEvents())
  if (roleId === undefined) return
  const role = deps.getRole(roleId)
  if (role === undefined) {
    deps.warn(`dsh-agent-toolkit: 委派子会话引用的角色 "${roleId}" 已不存在，跳过 persona/工具白名单`)
    return
  }
  const roleCtx = agent.ctx
  roleCtx.effect(() => roleCtx.systemPrompt.section({
    name: 'deployment:persona-prefix',
    order: roleCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: deps.buildPersona(role),
  }), 'dsh-agent-toolkit: role persona')
  if (role.tools === undefined) return
  const visible = new Set(roleCtx.tools.schemas(scopeOf(roleCtx)).map((schema) => schema.name))
  const effective = role.tools.allow.filter((name) => visible.has(name) && name !== RUN_CODE_NAME)
  const dropped = role.tools.allow.filter((name) => !visible.has(name) || name === RUN_CODE_NAME)
  if (dropped.length > 0) {
    deps.warn(`dsh-agent-toolkit: 角色 ${role.id} 白名单含子会话不可见工具，已忽略：${dropped.join(', ')}`)
  }
  if (effective.length === 0) {
    deps.warn(`dsh-agent-toolkit: 角色 ${role.id} 白名单与子会话工具面无交集，成员将无可用工具`)
  }
  roleCtx.effect(() => roleCtx.tools.restrict({ allow: effective }), 'dsh-agent-toolkit: role tools')
}

/** 挂载角色组合监听：所有子 Agent 创建/冷恢复都会经过 agent/created。 */
export function setupRoleComposition(
  ctx: Context,
  registry: AgentRegistry,
  buildPersona: (role: AgentRecord) => string,
): void {
  ctx.on('agent/created', ({ agent }) => {
    try {
      applyRoleComposition(agent, {
        getRole: (id) => registry.get(id),
        buildPersona,
        warn: (message) => ctx.logger.warn(message),
      })
    } catch (error) {
      ctx.logger.warn(`dsh-agent-toolkit: 角色组合应用失败，已跳过：${String(error)}`)
    }
  })
}
