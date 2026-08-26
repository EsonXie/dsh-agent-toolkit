/** dsh-agent-toolkit 存储域声明：身份、版本、记录 zod schema 的单一来源。 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const BucketSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  /** 估算样本的计费 token 量（usage 缺失时经 tokenMeter 启发式得出）。 */
  estimated: z.number().int().nonnegative(),
})
export type Bucket = z.infer<typeof BucketSchema>

export const DailyRecordSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totals: BucketSchema.extend({ estimatedCalls: z.number().int().nonnegative() }),
  /** 24 小时桶，空小时为全零桶。 */
  hours: z.array(BucketSchema).length(24),
  /** key = 'provider/model'。 */
  byModel: z.record(z.string(), BucketSchema),
  /** key = sessionId。 */
  bySession: z.record(z.string(), BucketSchema.extend({ cwd: z.string() })),
  /** key = cwd（原样存储）。 */
  byProject: z.record(z.string(), BucketSchema),
  /** 压缩摘要调用单列；数值同时已并入 totals/hours。 */
  compaction: BucketSchema,
})
export type DailyRecord = z.infer<typeof DailyRecordSchema>

/** domain 名受 UNIT_NAME_RE 约束（^[a-z][a-z0-9_]*$），不允许连字符。 */
export const tokenUsageDomain = defineDomain({
  name: 'token_usage',
  version: 1,
  tables: { daily: domainTable<string, DailyRecord>(DailyRecordSchema) },
})
