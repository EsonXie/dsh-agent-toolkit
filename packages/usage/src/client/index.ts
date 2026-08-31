/** @dsh-agent-toolkit/token-usage 浏览器半：注册「Token 用量」侧边栏底栏入口。 */
import type { Context } from '@deepseek-ai/cordis'
import { setupUsageClient } from './usage/index.ts'

export const inject = ['slots']

export function apply(ctx: Context): void {
  try {
    setupUsageClient(ctx)
  } catch (error) {
    // 双装：同一侧边栏入口 id 已被先到实例（dsh-agent-toolkit 或本包）注册，slots 重复
    // id 抛错——后到实例自动停用用量面板，不向上抛以免整个浏览器半崩溃。
    console.warn('[dsh-agent-toolkit/token-usage] 侧边栏「Token 用量」入口已由先到实例注册，本实例停用用量面板', error)
  }
}

// 供 dsh-agent-toolkit 浏览器半 bundle 复用（client-module 入口）。
export { setupUsageClient } from './usage/index.ts'
