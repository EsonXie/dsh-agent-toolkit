/** prompt-stack 插件：语义化提示词分层 + 按模型规则覆盖。 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'prompt-stack'

export const inject = ['systemPrompt']

// 占位 apply，Task 4 补全。
export function apply(_ctx: Context): void {}
