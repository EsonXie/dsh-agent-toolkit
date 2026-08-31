/** @dsh-agent-toolkit/token-usage 浏览器半：注册「Token 用量」侧边栏底栏入口。 */
import type { Context } from '@deepseek-ai/cordis'
import { setupUsageClient } from './usage/index.ts'

export const inject = ['slots']

export function apply(ctx: Context): void {
  setupUsageClient(ctx)
}

// 供 dsh-agent-toolkit 浏览器半 bundle 复用（client-module 入口）。
export { setupUsageClient } from './usage/index.ts'
