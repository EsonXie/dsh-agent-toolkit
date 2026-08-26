/** shared webServer 助手：可选服务模式下注册路由（headless/CLI 无 webServer 时惰性、不注册、不抛错）。 */
import type { Context } from '@deepseek-ai/cordis'

export function registerOptionalRoutes(
  ctx: Context,
  register: (webCtx: Context) => () => void,
): void {
  // 经 ctx.inject 子 fiber 等待 webServer 挂载后再注册：子 fiber 未激活时惰性、
  // 随父 fiber 卸载而清理；webServer 永不出现时任何分支都不注册。注册走
  // ctx.effect 接线 disposer（"Registrations are effects"），HMR 重挂不会因
  // 重复 exact 路径抛错。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => register(webCtx))
  })
}
