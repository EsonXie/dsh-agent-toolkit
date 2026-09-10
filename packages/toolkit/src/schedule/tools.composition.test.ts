/** 真实组合守护：cron_* 工具输出 schema 必须能被真实 ToolRuntime 的 register 接受
 *  （0.2.x "fake 单测掩盖宿主语义" 事故对策同族：fake register 不校验 schema，真实宿主
 *  register 走 assertSupportedJsonSchema——无 type 的 annotation-only schema 才是宿主接受的
 *  "任意 JSON" 形式；`{ type: 'json' }` 不是受支持的 JSON Schema 子集关键字）。 */
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createCronTools } from './tools.ts'
import type { CronService } from './service.ts'
import type { CronRun, CronTask } from './store.ts'

const CRON_NAMES = ['cron_task_create', 'cron_task_list', 'cron_task_update', 'cron_task_delete', 'cron_task_trigger']

function fakeService(): CronService {
  const task: CronTask = {
    id: 'task-1', name: '日报', prompt: '写日报', cwd: 'D:\\work',
    schedule: { kind: 'cron', expr: '0 9 * * *' }, target: { kind: 'main' },
    catchup: true, enabled: true, nextRunAt: null,
    createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
  }
  const run: CronRun = { id: 'run-1', taskId: 'task-1', triggeredAt: '2026-09-07T00:00:00.000Z', status: 'ok' }
  return {
    list: () => [task],
    get: () => task,
    create: async (input) => ({ ok: true as const, value: { ...task, ...input, nextRunAt: null } }),
    update: async () => ({ ok: true as const, value: task }),
    remove: async () => ({ ok: true as const, value: null }),
    trigger: async () => ({ ok: true as const, value: run }),
    runsOf: () => [],
  }
}

describe('cron 工具真实 ToolRuntime 注册守护', () => {
  test('5 个 cron_ 工具注册进真实 ctx.tools：不抛错、可解析、输出 schema 为宿主接受的 annotation-only 形式', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    const tools = createCronTools(fakeService())
    const disposers = tools.map((tool) => ctx.tools.register(tool))
    for (const name of CRON_NAMES) {
      const registered = ctx.tools.get(name)
      expect(registered).toBeDefined()
      // 钉住宿主 register 接受的"任意 JSON"形式：annotation-only，绝不含 type: 'json'。
      expect(registered!.output.schema).toEqual({})
    }
    for (const dispose of disposers) dispose()
  })
})
