/** feishu.permissionPreset 应用器工厂：bot 会话建账时应用宿主权限预设
 *  （典型 danger-full-access = 完全权限不审批）。服务缺席/非法名 warn 降级，不打死聊天链路。
 *  spec: docs/superpowers/specs/2026-09-15-feishu-permission-preset-design.md。 */
import type { Session } from '@deepseek-ai/dsh-session'

/** permissionPresets 服务的结构子集（可选服务经 ctx.get 惰性读取；宿主 dsh-permission-presets）。 */
export interface PermissionPresetsLike {
  readonly names: readonly string[]
  set(session: Session, name: string): void
}

export function createPresetApplier(
  serviceOf: () => PermissionPresetsLike | undefined,
  preset: string,
  warn: (message: string) => void,
): (session: Session) => void {
  let warnedMissing = false
  return (session) => {
    const svc = serviceOf()
    if (svc === undefined) {
      if (!warnedMissing) {
        warnedMissing = true
        warn('[project-bot] 配置了 feishu.permissionPreset 但宿主无 permissionPresets 服务，跳过应用')
      }
      return
    }
    if (!svc.names.includes(preset)) {
      warn(`[project-bot] feishu.permissionPreset "${preset}" 不是合法预设（可用：${svc.names.join(', ')}），跳过应用`)
      return
    }
    // 宿主 set() 幂等：knob 值未变不追加会话事件，resume/接管重复应用无副作用。
    try {
      svc.set(session, preset)
    } catch (error) {
      warn(`[project-bot] feishu.permissionPreset "${preset}" 应用失败：${error instanceof Error ? error.message : String(error)}，跳过应用`)
    }
  }
}
