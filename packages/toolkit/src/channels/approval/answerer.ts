/** approval/request waterfall answerer 工厂：自有 bot 会话走 ApprovalCenter（飞书卡片），
 *  其余 next() 透传（web api-proxy / ACP 等）。prepend 注册抢在 api-proxy 前（其从不 next 让出）。 */
import type { ApprovalCenter, ApprovalOutcome, ApprovalRequestLike } from './center.ts'

export function createApprovalAnswerer(
  centerOf: () => ApprovalCenter | undefined,
): (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome> {
  return async (req, next) => {
    const outcome = await centerOf()?.handleRequest(req)
    return outcome ?? next()
  }
}
