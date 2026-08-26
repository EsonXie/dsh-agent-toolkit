/** 名册解析管线：内置保底 ← 用户级目录（同名整角色覆盖）。 */
import type { Role } from './roles.ts'
import { BUILTIN_ROLES } from './builtin-roles.ts'
import { loadRolesDir } from './roles.ts'

/** 合并产物：最终名册 + 被用户覆盖的内置角色名（观测日志用）。 */
export interface Roster {
  readonly roles: readonly Role[]
  readonly overridden: readonly string[]
}

/**
 * 解析当前生效名册：内置角色为底，用户目录同名角色整角色覆盖、异名追加在后。
 * @param userDir - 用户级 roles 目录（不存在/为空属正常态）。
 * @throws 用户目录存在但含非法文件（loadRolesDir 原样上抛）。
 */
export async function resolveRoster(userDir: string): Promise<Roster> {
  const userRoles = await loadRolesDir(userDir)
  const userByName = new Map(userRoles.map(r => [r.name, r]))
  const overridden: string[] = []
  const roles: Role[] = BUILTIN_ROLES.map((role) => {
    const userRole = userByName.get(role.name)
    if (userRole === undefined) return role
    overridden.push(role.name)
    userByName.delete(role.name)
    return userRole
  })
  for (const role of userByName.values()) roles.push(role)
  return { roles, overridden }
}
