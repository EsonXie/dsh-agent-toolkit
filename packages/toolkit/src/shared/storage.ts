/** shared storage 助手：安全打开存储域（open 失败挂 rejection handler）并在卸载时关闭。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'

/** 类型擦除后的存储域句柄（跨 spec 泛型的统一承载面）。 */
export type DomainHandle = Domain<DomainSpec>

export function openDomainSafely(
  ctx: Context,
  domain: DomainSpec,
  warn: (msg: string) => void,
): Promise<DomainHandle> {
  const ready = ctx.storageDomain.open(domain)
  // open 失败（version-mismatch/malformed-medium/invalid-record）时创建即挂
  // rejection handler：避免 unhandled rejection 崩掉宿主进程（Node 默认 throw）。
  // ready 仍保持 reject，调用方仍感知失败而不次生崩溃。
  ready.catch((error) => {
    warn(error instanceof Error ? error.message : String(error))
  })
  // 域句柄由本 fiber 持有：卸载时 close（消费方自己不关闭）。open 失败时
  // close 无从谈起，吞掉该 rejection，避免卸载路径次生崩溃。
  ctx.effect(() => async () => {
    await ready.then((domain) => domain.close()).catch(() => undefined)
  })
  return ready
}
