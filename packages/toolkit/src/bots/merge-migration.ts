/** Bot 配置并入 Agent 的一次性迁移：剥离 bot 级 persona/tools（主 Agent 绑定 warn），非 main 绑定剥离 agentOptions。 */
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { BotRecord } from './store.ts'

export const BOTS_AGENT_MERGE_MIGRATED_KEY = 'bots_agent_merge_migrated'

export interface MergeMigrationDeps {
  bots: KvTable<string, BotRecord>
  meta: KvTable<string, { value: string }>
}

export async function migrateBotsIntoAgents(
  deps: MergeMigrationDeps,
  warn: (msg: string) => void,
): Promise<void> {
  if (deps.meta.get(BOTS_AGENT_MERGE_MIGRATED_KEY) !== undefined) return
  for (const id of deps.bots.keys()) {
    const bot = deps.bots.get(id)
    if (bot === undefined) continue
    const ref = bot.agentRef ?? 'main'
    const next = { ...bot }
    let changed = false
    if (bot.persona !== undefined || bot.tools !== undefined) {
      if (ref === 'main') {
        warn(`[project-bot] bot "${id}"：主 Agent 名下的 Bot 不再支持单独 persona/工具白名单，配置已移除；如需差异化 persona 请创建角色 Agent 并绑定`)
      }
      delete next.persona
      delete next.tools
      changed = true
    }
    if (ref !== 'main' && bot.agentOptions !== undefined) {
      delete next.agentOptions
      changed = true
    }
    if (changed) await deps.bots.put(id, next)
  }
  await deps.meta.put(BOTS_AGENT_MERGE_MIGRATED_KEY, { value: '1' })
}
