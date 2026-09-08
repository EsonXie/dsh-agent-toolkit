/** 飞书审批卡片：cardkit 2.0 静态卡（非流式）+ callback 按钮；presenter 挂在渠道 ChannelHandle.approval。 */
import type { FeishuApi } from '../feishu/api.ts'
import { withRetry } from '../feishu/reply.ts'
import type { ApprovalPresentation, ApprovalPresenter, ApprovalPrompt } from './center.ts'

const STATUS_TEXT: Record<'allowed' | 'rejected' | 'cancelled', string> = {
  allowed: '✅ 已允许',
  rejected: '❌ 已拒绝',
  cancelled: '⏹ 已取消',
}

function bodyMarkdown(prompt: ApprovalPrompt): string {
  const lines = [`**Bot**：${prompt.botName}`, `**工具**：\`${prompt.toolName}\``]
  if (prompt.reason !== undefined) lines.push(`**理由**：${prompt.reason}`)
  return lines.join('\n')
}

function button(text: string, type: 'primary' | 'danger', key: string, decision: 'allow' | 'reject'): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value: { key, decision } }],
  }
}

/** 审批卡（带按钮）；summary 供会话列表/推送预览。 */
export function buildApprovalCardJson(prompt: ApprovalPrompt): string {
  return JSON.stringify({
    schema: '2.0',
    config: { summary: { content: `权限申请：${prompt.toolName}` } },
    header: { title: { tag: 'plain_text', content: '权限申请' }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown', content: bodyMarkdown(prompt) },
        { tag: 'action', actions: [button('允许', 'primary', prompt.key, 'allow'), button('拒绝', 'danger', prompt.key, 'reject')] },
      ],
    },
  })
}

/** 终态卡（无按钮）：定格审批结果；operatorName 仅允许/拒绝时有。 */
export function buildApprovalFinalCardJson(prompt: ApprovalPrompt, status: 'allowed' | 'rejected' | 'cancelled', operatorName?: string): string {
  const statusLine = STATUS_TEXT[status] + (operatorName !== undefined ? ` · ${operatorName}` : '')
  const template = status === 'allowed' ? 'green' : status === 'rejected' ? 'red' : 'grey'
  return JSON.stringify({
    schema: '2.0',
    config: { summary: { content: `权限申请${STATUS_TEXT[status].slice(2).trim()}：${prompt.toolName}` } },
    header: { title: { tag: 'plain_text', content: `权限申请 · ${statusLine}` }, template },
    body: { elements: [{ tag: 'markdown', content: bodyMarkdown(prompt) }] },
  })
}

/** 飞书审批能力：present = 建卡 + 发消息；finalize = replaceCard 定格（sequence 从 1 起，create/send 不占）。 */
export class FeishuApprovalPresenter implements ApprovalPresenter {
  constructor(
    private readonly api: FeishuApi,
    private readonly log: (message: string) => void,
  ) {}

  async present(prompt: ApprovalPrompt): Promise<ApprovalPresentation> {
    const cardId = await withRetry(() => this.api.createCard(buildApprovalCardJson(prompt)))
    await withRetry(() => this.api.sendCardMessage(prompt.chatId, cardId))
    return {
      finalize: async (status, operatorName) => {
        try {
          await withRetry(() => this.api.replaceCard(cardId, buildApprovalFinalCardJson(prompt, status, operatorName), 1))
        } catch (error) {
          // 定格失败不吞审批结果：卡片残留按钮但回调侧已 settle（重复点击 toast 已失效）。
          this.log(`[project-bot] 审批卡片定格失败（card ${cardId}）：${error instanceof Error ? error.message : String(error)}`)
        }
      },
    }
  }
}
