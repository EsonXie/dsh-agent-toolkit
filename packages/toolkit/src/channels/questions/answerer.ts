/** user-questions/request waterfall answerer 工厂：自有 bot 会话走 QuestionCenter（飞书问答卡），
 *  其余 next() 透传（web 浏览器 UI）。prepend 注册与审批 answerer 同款。 */
import type { QuestionAnswerLike, QuestionCenter, QuestionRequestLike } from './center.ts'

export function createQuestionAnswerer(
  centerOf: () => QuestionCenter | undefined,
): (req: QuestionRequestLike, next: () => Promise<QuestionAnswerLike>) => Promise<QuestionAnswerLike> {
  return async (req, next) => {
    const answer = await centerOf()?.handleRequest(req)
    return answer ?? next()
  }
}
