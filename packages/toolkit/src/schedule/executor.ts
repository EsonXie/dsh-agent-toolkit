/** 定时任务执行器：输入一条 task，输出一条 run 记录（建会话 → followup → whenIdle/超时 → 落库）。 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentRegistry } from '../agents/registry.ts'
import { roleAgentOptions, roleHooks } from '../channels/role-assembly.ts'
import type { AgentHooks, AgentSection, AgentsPort, DefaultModelAccessor, WorkspacePort } from '../channels/ports.ts'
import { trimRuns, type CronRun, type CronTask } from './store.ts'

/** 来源段名：声明本会话由定时任务触发（order 20，与渠道 sender 段同位）。 */
export const TASK_SECTION_NAME = 'dsh-agent-toolkit:schedule:task'

export function taskSectionText(task: CronTask, triggeredAt: string): string {
  return `本会话由定时任务「${task.name}」（id: ${task.id}）于 ${triggeredAt} 触发。`
}

/** 错误摘要最大字符数（对齐 feishu.errorDetailMaxChars 默认 500）。 */
const ERROR_MAX_CHARS = 500

export interface ExecutorDeps {
  agents: AgentsPort
  registry: AgentRegistry
  /** 宿主默认模型（main 形态与未自配模型的角色的模型来源）。 */
  defaultModel: DefaultModelAccessor
  workspace: WorkspacePort
  runs: KvTable<string, CronRun>
  runHistoryLimit: number
  /** 单次运行 followup→whenIdle 超时（Config schedule.runTimeoutMinutes × 60_000）。 */
  runTimeoutMs: number
  warn: (msg: string) => void
  now(): number
  newSessionId(): string
  newRunId(): string
  /** 超时计时（测试注入可控 Promise；生产为 setTimeout 包装）。 */
  delay(ms: number): Promise<void>
}

export interface Executor {
  /** 执行一次任务：永不抛错，结果体现在返回的 run 记录。 */
  trigger(task: CronTask): Promise<CronRun>
}

class RunTimeoutError extends Error {
  constructor() { super('timeout') }
}

export function createExecutor(deps: ExecutorDeps): Executor {
  async function persist(run: CronRun): Promise<void> {
    await deps.runs.put(run.id, run)
    await trimRuns(deps.runs, run.taskId, deps.runHistoryLimit)
  }

  return {
    async trigger(task) {
      const triggeredAt = new Date(deps.now()).toISOString()
      const sessionId = deps.newSessionId()
      const run: CronRun = { id: deps.newRunId(), taskId: task.id, triggeredAt, status: 'running', sessionId }
      await persist(run)
      const finish = async (status: CronRun['status'], error?: string): Promise<CronRun> => {
        const done: CronRun = {
          ...run,
          status,
          finishedAt: new Date(deps.now()).toISOString(),
          ...(error !== undefined ? { error: error.slice(0, ERROR_MAX_CHARS) } : {}),
        }
        await persist(done)
        return done
      }

      // 解析装配（main/role 共用序列，仅装配不同；roleId 缺失降级 main 并 warn，同 Router 语义）。
      const source: AgentSection = { name: TASK_SECTION_NAME, order: 20, text: taskSectionText(task, triggeredAt) }
      let agentOptions: { provider?: string; model?: string }
      let hooks: AgentHooks
      const roleId = task.target.kind === 'role' ? task.target.roleId : 'main'
      const role = roleId === 'main' ? undefined : deps.registry.get(roleId)
      if (roleId === 'main' || role === undefined) {
        if (roleId !== 'main' && role === undefined) {
          deps.warn(`[schedule] 定时任务 "${task.id}" 的角色 "${roleId}" 不存在，降级主 Agent 形态`)
        }
        agentOptions = deps.defaultModel()
        hooks = { sections: [source] }
      } else {
        const base = roleHooks(role)
        agentOptions = roleAgentOptions(role, deps.defaultModel)
        hooks = { ...base, sections: [...(base.sections ?? []), source] }
      }

      let agent
      try {
        agent = await deps.agents.create({ sessionId, cwd: task.cwd, agentOptions, hooks })
      } catch (error) {
        return finish('error', error instanceof Error ? error.message : String(error))
      }
      try {
        await deps.workspace.attach(task.cwd, sessionId)
      } catch (error) {
        // attach 失败仅告警（会话降级为未分组），不阻塞执行——同 Router.attach。
        deps.warn(`[schedule] 会话 ${sessionId} 挂载 workspace 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      // 必须经 createUserMessage 包装（裸字符串会让 turn 管线读 message.source.kind 崩溃）。
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: task.prompt }],
        source: { kind: 'user' },
      }))
      // race 落败方的迟到 rejection 不变 unhandled（先各挂 noop catch；race 自身引用不受影响）。
      const idle = agent.whenIdle()
      idle.catch(() => undefined)
      const timeout = deps.delay(deps.runTimeoutMs).then(() => { throw new RunTimeoutError() })
      timeout.catch(() => undefined)
      try {
        await Promise.race([idle, timeout])
        return await finish('ok')
      } catch (error) {
        if (error instanceof RunTimeoutError) {
          agent.cancel()
          return await finish('error', `timeout（超过 ${Math.round(deps.runTimeoutMs / 60_000)} 分钟未空闲，已取消）`)
        }
        return await finish('error', error instanceof Error ? error.message : String(error))
      }
    },
  }
}
