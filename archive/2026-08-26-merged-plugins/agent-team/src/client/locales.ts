/** agent-team 浏览器半文案：zh 为真源，en 键集严格一致。 */
export const NS = 'agent-team'

export const zh = {
  'card.viewChild': '查看子对话',
  'card.running': '成员执行中',
  'card.failed': '委派失败',
} as const

export type AgentTeamKey = keyof typeof zh

export const en: Record<AgentTeamKey, string> = {
  'card.viewChild': 'View sub-conversation',
  'card.running': 'Member running',
  'card.failed': 'Delegation failed',
}
