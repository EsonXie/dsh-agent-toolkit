/** user-questions/request waterfall answerer 工厂：自有 bot 会话走 QuestionCenter（飞书问答卡），
 *  其余 next() 透传（web 浏览器 UI）。prepend 注册与审批 answerer 同款。 */
import type { DebugSink } from '../channel.ts'
import type { QuestionAnswerLike, QuestionCenter, QuestionRequestLike } from './center.ts'

export function createQuestionAnswerer(
  centerOf: () => QuestionCenter | undefined,
  debug?: DebugSink,
): (req: QuestionRequestLike, next: () => Promise<QuestionAnswerLike>) => Promise<QuestionAnswerLike> {
  return async (req, next) => {
    const center = centerOf()
    // 入场事件：fall-through 的 warn 在 dsh web 不可见（2026-09-17 排障），定位依赖此事件序列。
    debug?.({
      event: 'question-request',
      sessionId: req.agent === undefined ? undefined : String(req.agent.session.id),
      qCount: req.questions.length,
      centerReady: center !== undefined,
    })
    const answer = await center?.handleRequest(req)
    return answer ?? next()
  }
}
