/** createAgentsPort：applyPreset 三路径调用语义 + cronExcludedSessions 登记语义。 */
import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { createAgentsPort } from './agents-port.ts'
import type { ScopeJoiner } from './scope-joiner.ts'

const joiner: ScopeJoiner = { join: async () => undefined }
const hooks = {}

function fakeAgent(id: string, session: Session) {
  return { id, session, followup: vi.fn(), cancel: vi.fn(), whenIdle: vi.fn(async () => undefined) }
}

function fakeCtx(agent: ReturnType<typeof fakeAgent>): Context {
  const handle = { agent, dispose: vi.fn(async () => undefined) }
  return {
    agents: {
      create: vi.fn(async () => handle),
      resume: vi.fn(async () => handle),
      get: vi.fn(() => agent),
    },
  } as unknown as Context
}

describe('createAgentsPort applyPreset', () => {
  test('create：以 agent.session 调用 applyPreset', async () => {
    const session = { marker: 1 } as unknown as Session
    const applyPreset = vi.fn()
    const port = createAgentsPort(fakeCtx(fakeAgent('s1', session)), joiner, undefined, applyPreset)
    await port.create({ sessionId: 's1', cwd: 'D:\\p', hooks })
    expect(applyPreset).toHaveBeenCalledTimes(1)
    expect(applyPreset).toHaveBeenCalledWith(session)
  })

  test('resume：以 agent.session 调用 applyPreset', async () => {
    const session = { marker: 2 } as unknown as Session
    const applyPreset = vi.fn()
    const port = createAgentsPort(fakeCtx(fakeAgent('s2', session)), joiner, undefined, applyPreset)
    await port.resume({ sessionId: 's2', hooks })
    expect(applyPreset).toHaveBeenCalledTimes(1)
    expect(applyPreset).toHaveBeenCalledWith(session)
  })

  test('get（接管宿主存活 agent）：以 agent.session 调用 applyPreset', () => {
    const session = { marker: 3 } as unknown as Session
    const applyPreset = vi.fn()
    const port = createAgentsPort(fakeCtx(fakeAgent('s3', session)), joiner, undefined, applyPreset)
    expect(port.get('s3')).toBeDefined()
    expect(applyPreset).toHaveBeenCalledTimes(1)
    expect(applyPreset).toHaveBeenCalledWith(session)
  })

  test('未传 applyPreset：三路径正常返回且不抛错（schedule 形态）', async () => {
    const port = createAgentsPort(fakeCtx(fakeAgent('s4', {} as Session)), joiner)
    await expect(port.create({ sessionId: 's4', cwd: 'D:\\p', hooks })).resolves.toBeDefined()
    await expect(port.resume({ sessionId: 's4', hooks })).resolves.toBeDefined()
    expect(port.get('s4')).toBeDefined()
  })

  test('未传 cronExcludedSessions 时 create/resume 不登记任何排除集', async () => {
    const excluded = new Set<string>()
    // schedule 路径：传排除集 → create/resume 均登记（cron_* 门控据此排除执行会话）。
    const schedulePort = createAgentsPort(fakeCtx(fakeAgent('sess-exec', {} as Session)), joiner, excluded)
    await schedulePort.create({ sessionId: 'sess-exec', cwd: 'D:\\p', hooks })
    await schedulePort.resume({ sessionId: 'sess-resume', hooks })
    expect([...excluded].sort()).toEqual(['sess-exec', 'sess-resume'])
    // bots 路径：不传排除集 → 不向任何集合登记（bot 聊天会话与 web 主会话对齐，可建定时任务）。
    const botsPort = createAgentsPort(fakeCtx(fakeAgent('sess-chat', {} as Session)), joiner)
    await botsPort.create({ sessionId: 'sess-chat', cwd: 'D:\\p', hooks })
    await botsPort.resume({ sessionId: 'sess-chat', hooks })
    expect([...excluded].sort()).toEqual(['sess-exec', 'sess-resume'])
  })
})
