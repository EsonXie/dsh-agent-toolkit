/** 委派路由持久存储域：子会话头部 chip 的数据源（schema 与 domain 布局的单一来源在本文件）。 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 一条持久化的委派路由记录。at = 写入时间戳（预留清理依据，暂无自动清理）。 */
export interface DelegationRouteRecord {
  provider: string
  model: string
  at: number
}

export const DelegationRouteRecordSchema = z.object({
  provider: z.string(),
  model: z.string(),
  at: z.number(),
})

// 独立于 agentToolkitDomain（v1 布局不变）：domain version 是格式版本，
// 改既有域表结构会 version-mismatch 拒绝存量介质且无迁移。
export const delegationRoutesDomain = defineDomain({
  name: 'dsh_agent_toolkit_routes',
  version: 1,
  tables: {
    // key = childSessionId（本地 run 的 run.id 契约上即子 session id）
    routes: domainTable<string, DelegationRouteRecord>(DelegationRouteRecordSchema),
  },
})
