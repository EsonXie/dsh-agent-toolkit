import { describe, expect, test, vi } from 'vitest'
import type { ReplyHandle } from './channel.ts'
import type { AgentPort, AgentsPort, BindingStore, SessionRuntime, WorkspacePort } from './ports.ts'
import { Router } from './router.ts'
import type { BotRecord } from '../bots/store.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import type { AgentRecord } from '../agents/store.ts'

const GUIDANCE = { name: 'dsh-agent-toolkit:channel:guidance', order: 15, text: '本会话经 feishu 渠道进行。如需用户补充信息或做出决策，优先使用 ask_user_question 工具；该工具不可用时，直接在回复中提问并等待用户下一条消息。' }
const SENDER = { name: 'dsh-agent-toolkit:channel:sender', order: 20, text: '本会话由 feishu 渠道的单聊会话发起。发起人 ID（feishu open_id）：`ou_u1`。' }

function fakeRegistry(records: AgentRecord[] = []): { registry: AgentRegistry; get: ReturnType<typeof vi.fn> } {
  const map = new Map(records.map((r) => [r.id, r]))
  const get = vi.fn((id: string) => map.get(id))
  const registry: AgentRegistry = {
    list: () => [...map.values()],
    get,
    upsert: async () => undefined,
    remove: async () => undefined,
    subscribe: () => () => undefined,
  }
  return { registry, get }
}

const MAIN_ROLE: AgentRecord = { id: 'main', name: '主 Agent', description: '默认编码 Agent' }

const REVIEWER_ROLE: AgentRecord = {
  id: 'reviewer', name: '评审',
  persona: '你是团队的评审成员。\n只审查 diff，不修改代码。',
  model: { provider: 'deepseek', model: 'deepseek-reasoner' },
  tools: { allow: ['bash', 'fs_read'] },
}

function fakeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: 'reviewer', name: '评审', channel: 'feishu',
    feishu: { appId: 'cli_a1b2c3d4e5f60718', appSecretRef: 'project_bot_reviewer' },
    project: 'D:\\work\\demo', persona: '你是评审助手', tools: ['bash'],
    createdAt: 0, updatedAt: 0, ...overrides,
  }
}

function fakeAgent(sessionId: string) {
  return { sessionId, followup: vi.fn(), cancel: vi.fn(), whenIdle: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined) }
}

function fakeBindings(): BindingStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get: (b, c) => map.get(`${b}:${c}`),
    set: async (b, c, s) => { map.set(`${b}:${c}`, s) },
    delete: async (b, c) => { map.delete(`${b}:${c}`) },
    deleteBot: async (b) => { for (const k of [...map.keys()]) if (k.startsWith(`${b}:`)) map.delete(k) },
  }
}

const reply = {} as ReplyHandle

function setup(
  defaultModel = () => ({ provider: 'deepseek', model: 'deepseek-v4' }),
  registry: AgentRegistry = fakeRegistry().registry,
) {
  const created: { input: Record<string, unknown>; agent: AgentPort }[] = []
  const resumed: { input: Record<string, unknown>; agent: AgentPort }[] = []
  const live = new Map<string, AgentPort>()
  const agents: AgentsPort = {
    get: (sessionId) => live.get(sessionId),
    create: async (input) => { const agent = fakeAgent(input.sessionId); created.push({ input: input as unknown as Record<string, unknown>, agent }); return agent },
    resume: async (input) => { const agent = fakeAgent(input.sessionId); resumed.push({ input: input as unknown as Record<string, unknown>, agent }); return agent },
  }
  const bindings = fakeBindings()
  const sessions = new Map<string, SessionRuntime>()
  const defaultModelFn = vi.fn(defaultModel)
  const workspace: WorkspacePort & { attach: ReturnType<typeof vi.fn> } = { attach: vi.fn(async () => undefined) }
  const onWarn = vi.fn()
  return { agents, bindings, sessions, workspace, onWarn, router: new Router(agents, bindings, sessions, defaultModelFn, workspace, onWarn, registry), created, resumed, live, defaultModel: defaultModelFn }
}

describe('Router.ensure', () => {
  test('无绑定：create 新 agent 并写绑定，cwd 透传，bot 级 persona/tools 不再注入', async () => {
    const { router, bindings, created } = setup()
    const rt = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(created).toHaveLength(1)
    expect(created[0].input.cwd).toBe('D:\\work\\demo')
    expect(created[0].input.hooks).toEqual({ sections: [GUIDANCE, SENDER] })
    expect(bindings.get('reviewer', 'oc_1')).toBe(rt.sessionId)
    expect(rt.reply).toBe(reply)
  })

  test('ensure 把发起人 open_id 落进 SessionRuntime', async () => {
    const { router } = setup()
    const rt = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_initiator_1')
    expect(rt.initiatorOpenId).toBe('ou_initiator_1')
  })

  test('已存在会话直接返回：不改 initiatorOpenId（发起人不变）', async () => {
    const { router } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_first')
    const reused = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_other')
    expect(reused.initiatorOpenId).toBe('ou_first')
  })

  test('有绑定且进程内有 runtime：直接复用；reply 刷新移交 Inbound 准入后执行', async () => {
    const { router, created, resumed } = setup()
    const first = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const reply2 = {} as ReplyHandle
    const second = await router.ensure(fakeBot(), 'oc_1', reply2, 'ou_u1')
    expect(second).toBe(first)
    // ensure 不再触碰存量会话的 reply：运行中 turn 的出站须留在原句柄收尾（Task 5）。
    expect(first.reply).toBe(reply)
    expect(created).toHaveLength(1)
    expect(resumed).toHaveLength(0)
  })

  test('有绑定但进程内无 runtime（重启后）：resume 恢复', async () => {
    const { router, bindings, resumed } = setup()
    await bindings.set('reviewer', 'oc_1', 'sess-old')
    const rt = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(resumed).toHaveLength(1)
    expect(resumed[0].input.sessionId).toBe('sess-old')
    expect(rt.sessionId).toBe('sess-old')
  })

  test('retiring 中的会话不复用（重绑窗口）：resume + adopt 重建同一会话，替换后旧 retire 摘除不误删', async () => {
    const { router, bindings, sessions, resumed } = setup()
    const first = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    // 模拟 unbindBot 的 retire：绑定保留、runtime 标记 retiring（已 cancel、收尾中）
    first.retiring = true
    const second = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(second).not.toBe(first)                    // 不复用已取消的 runtime
    expect(second.sessionId).toBe(first.sessionId)    // 绑定保留：同一会话 resume 接续
    expect(resumed).toHaveLength(1)
    expect(resumed[0].input.sessionId).toBe(first.sessionId)
    expect(sessions.get(first.sessionId)).toBe(second) // 替换已生效
    expect(second.retiring).toBe(false)
    expect(bindings.get('reviewer', 'oc_1')).toBe(first.sessionId)
  })

  test('create 会话以宿主默认模型创建（{provider, model}）', async () => {
    const { router, created, defaultModel } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).toHaveBeenCalledOnce()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
  })

  test('resume 恢复路径：同样取宿主默认模型', async () => {
    const { router, bindings, resumed, defaultModel } = setup()
    await bindings.set('reviewer', 'oc_1', 'sess-old')
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).toHaveBeenCalledOnce()
    expect(resumed[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
  })

  test('bot 有 agentOptions：原样透传（绑 main 的 bot 自配模型优先于宿主默认）', async () => {
    const { router, created, defaultModel } = setup()
    await router.ensure(fakeBot({ agentOptions: { provider: 'acme', model: 'acme-x' } }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).not.toHaveBeenCalled()
    expect(created[0].input.agentOptions).toEqual({ provider: 'acme', model: 'acme-x' })
  })

  test('create 后不 attach：空白会话不进 workspace（防 web「新会话」blank 复用捕获渠道绑定会话）', async () => {
    const { router, workspace } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(workspace.attach).not.toHaveBeenCalled()
  })

  test('resume 后同样不 attach（空白窗口期一律不挂载）', async () => {
    const { router, bindings, workspace } = setup()
    await bindings.set('reviewer', 'oc_1', 'sess-old')
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(workspace.attach).not.toHaveBeenCalled()
  })
})

describe('Router.reset（/new）', () => {
  test('取消旧 agent、清绑定、开新会话', async () => {
    const { router, bindings, created } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const next = await router.reset(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(old.agent.cancel).toHaveBeenCalledOnce()
    expect(next.sessionId).not.toBe(old.sessionId)
    expect(bindings.get('reviewer', 'oc_1')).toBe(next.sessionId)
    expect(created).toHaveLength(2)
  })

  test('无旧绑定时直接开新会话', async () => {
    const { router, created } = setup()
    await router.reset(fakeBot(), 'oc_9', reply, 'ou_u1')
    expect(created).toHaveLength(1)
  })

  test('/new：旧会话等 turn 落定后再摘出 sessions（旧卡可 finalize）', async () => {
    const { router, sessions } = setup()
    const rt = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const oldSessionId = rt.sessionId
    let idle!: () => void
    rt.agent.whenIdle = () => new Promise<void>((resolve) => { idle = resolve })
    const done = router.reset(fakeBot(), 'oc_1', reply, 'ou_u1')
    await done
    expect(sessions.has(oldSessionId)).toBe(true)      // 未落定前仍在 map（turn/end 可达）
    idle()
    await new Promise((r) => setTimeout(r, 0))
    expect(sessions.has(oldSessionId)).toBe(false)     // 落定后摘除
    expect(router.lookup('reviewer', 'oc_1')?.sessionId).not.toBe(oldSessionId)
  })
})

test('Router.lookup 按绑定反查 runtime', async () => {
  const { router } = setup()
  expect(router.lookup('reviewer', 'oc_1')).toBeUndefined()
  const rt = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
  expect(router.lookup('reviewer', 'oc_1')).toBe(rt)
})

describe('Router.ensure agentRef 绑定', () => {
  test('agentRef 指向 main：不注册角色 section、不 restrict，模型取宿主默认，bot 残留 persona/tools 被忽略', async () => {
    const { router, created, defaultModel } = setup(undefined, fakeRegistry([MAIN_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'main' }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).toHaveBeenCalledOnce()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
    expect(created[0].input.hooks).toEqual({ sections: [GUIDANCE, SENDER] })
  })

  test('agentRef 指向角色：注册单 persona section + tools.restrict({ allow }) + agentOptions=role.model', async () => {
    const { router, created, defaultModel } = setup(undefined, fakeRegistry([MAIN_ROLE, REVIEWER_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'reviewer' }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).not.toHaveBeenCalled()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(created[0].input.hooks).toEqual({
      sections: [
        { name: 'dsh-agent-toolkit:agent:persona', order: 0, text: '你是团队的评审成员。\n只审查 diff，不修改代码。' },
        GUIDANCE,
        SENDER,
      ],
      tools: ['bash', 'fs_read'],
    })
  })

  test('agentRef 指向角色：记录残留的 agentOptions 不读（角色模型优先）', async () => {
    const { router, created, defaultModel } = setup(undefined, fakeRegistry([MAIN_ROLE, REVIEWER_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'reviewer', agentOptions: { provider: 'acme', model: 'acme-x' } }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).not.toHaveBeenCalled()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
  })

  test('agentRef 指向角色且角色未配 model：回退宿主默认模型', async () => {
    const NO_MODEL_ROLE: AgentRecord = { id: 'scout', name: '侦察', persona: '负责侦察。' }
    const { router, created, defaultModel } = setup(undefined, fakeRegistry([MAIN_ROLE, NO_MODEL_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'scout' }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).toHaveBeenCalledOnce()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
    expect(created[0].input.hooks).toEqual({
      sections: [
        { name: 'dsh-agent-toolkit:agent:persona', order: 0, text: '负责侦察。' },
        GUIDANCE,
        SENDER,
      ],
    })
  })

  test('resume 恢复路径同样按角色组装 section/tools/agentOptions', async () => {
    const { router, bindings, resumed, defaultModel } = setup(undefined, fakeRegistry([MAIN_ROLE, REVIEWER_ROLE]).registry)
    await bindings.set('reviewer', 'oc_1', 'sess-old')
    await router.ensure(fakeBot({ agentRef: 'reviewer' }), 'oc_1', reply, 'ou_u1')
    expect(resumed).toHaveLength(1)
    expect(defaultModel).not.toHaveBeenCalled()
    expect(resumed[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(resumed[0].input.hooks).toEqual({
      sections: [
        { name: 'dsh-agent-toolkit:agent:persona', order: 0, text: '你是团队的评审成员。\n只审查 diff，不修改代码。' },
        GUIDANCE,
        SENDER,
      ],
      tools: ['bash', 'fs_read'],
    })
  })

  test('agentRef 指向团队不可见角色：bot 绑定照常（角色形态 section/tools/agentOptions）', async () => {
    const hidden: AgentRecord = { ...REVIEWER_ROLE, visibleInTeam: false }
    const { router, created, defaultModel } = setup(undefined, fakeRegistry([MAIN_ROLE, hidden]).registry)
    await router.ensure(fakeBot({ agentRef: 'reviewer' }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).not.toHaveBeenCalled()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(created[0].input.hooks).toEqual({
      sections: [
        { name: 'dsh-agent-toolkit:agent:persona', order: 0, text: '你是团队的评审成员。\n只审查 diff，不修改代码。' },
        GUIDANCE,
        SENDER,
      ],
      tools: ['bash', 'fs_read'],
    })
  })

  test('agentRef 指向不存在角色：warn 并降级 main（默认模型，bot 残留 persona/tools 被忽略）', async () => {
    const { router, created, onWarn } = setup(undefined, fakeRegistry([MAIN_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'ghost' }), 'oc_1', reply, 'ou_u1')
    expect(onWarn).toHaveBeenCalledOnce()
    expect(onWarn.mock.calls[0][0]).toContain('ghost')
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
    expect(created[0].input.hooks).toEqual({ sections: [GUIDANCE, SENDER] })
  })
})

describe('Router 发起人提示段', () => {
  test('create（主 Agent 形态）：hooks.sections 末尾追加 sender 段', async () => {
    const { router, created } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(created[0].input.hooks).toEqual({ sections: [GUIDANCE, SENDER] })
  })

  test('resume 路径同样注入', async () => {
    const { router, bindings, resumed } = setup()
    await bindings.set('reviewer', 'oc_1', 'sess-old')
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(resumed[0].input.hooks).toMatchObject({ sections: [GUIDANCE, SENDER] })
  })

  test('角色形态：sender 段追加在角色 persona 段之后', async () => {
    const { router, created } = setup(undefined, fakeRegistry([MAIN_ROLE, REVIEWER_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'reviewer' }), 'oc_1', reply, 'ou_u1')
    expect(created[0].input.hooks).toEqual({
      sections: [
        { name: 'dsh-agent-toolkit:agent:persona', order: 0, text: '你是团队的评审成员。\n只审查 diff，不修改代码。' },
        GUIDANCE,
        SENDER,
      ],
      tools: ['bash', 'fs_read'],
    })
  })

  test('injectSender=false：不追加 sender 段，但 guidance 段仍注入', async () => {
    const { agents, bindings, sessions, workspace, onWarn, defaultModel, created } = setup()
    const router = new Router(agents, bindings, sessions, defaultModel, workspace, onWarn, fakeRegistry().registry, false)
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(created[0].input.hooks).toEqual({ sections: [GUIDANCE] })
  })

  test('/new 重置后新会话仍注入（发起人取当前消息发送人）', async () => {
    const { router, created } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    await router.reset(fakeBot(), 'oc_1', reply, 'ou_u2')
    expect(created[1].input.hooks).toMatchObject({
      sections: [
        GUIDANCE,
        { name: SENDER.name, order: 20, text: '本会话由 feishu 渠道的单聊会话发起。发起人 ID（feishu open_id）：`ou_u2`。' },
      ],
    })
  })
})

describe('Router 渠道段（guidance + sender）', () => {
  test('bot 会话 hooks.sections 含 IM 引导段（order 15）与 sender 段（order 20）', async () => {
    const { router, created } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const sections = (created[0].input.hooks as { sections: { name: string; order: number; text: string }[] }).sections
    const guidance = sections.find((s) => s.name === 'dsh-agent-toolkit:channel:guidance')
    expect(guidance).toMatchObject({ order: 15 })
    expect(guidance?.text).toContain('ask_user_question')
    expect(sections).toContainEqual(SENDER)
  })
})

describe('Router.switchTo（/switch）', () => {
  test('boundSessionId：读绑定表（不要求进程内有 runtime）', async () => {
    const { router, bindings } = setup()
    expect(router.boundSessionId('reviewer', 'oc_1')).toBeUndefined()
    await bindings.set('reviewer', 'oc_1', 'sess-x')
    expect(router.boundSessionId('reviewer', 'oc_1')).toBe('sess-x')
  })

  test('切到不在内存的会话：resume 接管（装配照常）+ 绑定覆盖不 delete', async () => {
    const { router, bindings, resumed, defaultModel } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const rt = await router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u2')
    expect(resumed).toHaveLength(1)
    expect(resumed[0].input.sessionId).toBe('sess-target')
    expect(defaultModel).toHaveBeenCalledTimes(2)   // create + resume 各一次
    expect(rt.sessionId).toBe('sess-target')
    expect(rt.initiatorOpenId).toBe('ou_u2')         // 切换人成为发起人（审批校验用）
    expect(bindings.get('reviewer', 'oc_1')).toBe('sess-target')
    expect(old.agent.cancel).not.toHaveBeenCalled()  // 旧会话不取消
  })

  test('切到已在内存的会话：直接复用 runtime，不 resume、initiator 不变', async () => {
    const { router, bindings, sessions, resumed } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    await router.switchTo(fakeBot(), 'oc_1', 'sess-b', reply, 'ou_u1')
    const rtB = sessions.get('sess-b')!
    const back = await router.switchTo(fakeBot(), 'oc_1', 'sess-b', reply, 'ou_u2')
    expect(back).toBe(rtB)
    expect(back.initiatorOpenId).toBe('ou_u1')
    expect(resumed).toHaveLength(1)                  // 仅第一次切 sess-b 时 resume
    expect(bindings.get('reviewer', 'oc_1')).toBe('sess-b')
  })

  test('切走的旧 runtime 不 retire：idle 落定且未重新绑定后摘出 sessions', async () => {
    const { router, sessions } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const oldId = old.sessionId
    await router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u1')
    await new Promise((r) => setTimeout(r, 0))        // releaseUnbound 落定
    expect(sessions.has(oldId)).toBe(false)
    expect(old.agent.cancel).not.toHaveBeenCalled()
  })

  test('旧会话有在飞 turn：等 whenIdle 落定后才摘除（卡片照常收尾）', async () => {
    const { router, sessions } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const oldId = old.sessionId
    let idle!: () => void
    old.agent.whenIdle = () => new Promise<void>((resolve) => { idle = resolve })
    await router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u1')
    await new Promise((r) => setTimeout(r, 0))
    expect(sessions.has(oldId)).toBe(true)            // turn 未落定不摘
    idle()
    await new Promise((r) => setTimeout(r, 0))
    expect(sessions.has(oldId)).toBe(false)
  })

  test('摘除窗口内被切回：runtime 保留不误删', async () => {
    const { router, sessions } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const oldId = old.sessionId
    let idle!: () => void
    old.agent.whenIdle = () => new Promise<void>((resolve) => { idle = resolve })
    await router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u1')
    await router.switchTo(fakeBot(), 'oc_1', oldId, reply, 'ou_u1')   // 切回（内存复用）
    idle()
    await new Promise((r) => setTimeout(r, 0))
    expect(sessions.get(oldId)).toBe(old)             // 重新绑定后不摘
  })

  test('resume 失败：binding 不变，旧 runtime 不动', async () => {
    const { router, bindings, sessions, agents } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const oldId = old.sessionId
    agents.resume = async () => { throw new Error('session corrupted') }
    await expect(router.switchTo(fakeBot(), 'oc_1', 'sess-bad', reply, 'ou_u1')).rejects.toThrow('session corrupted')
    expect(bindings.get('reviewer', 'oc_1')).toBe(oldId)
    expect(sessions.get(oldId)).toBe(old)
  })

  test('binding 覆盖失败：摘除本次 adopt 的 runtime 并抛错（不留孤儿）', async () => {
    const { router, bindings, sessions, resumed } = setup()
    const original = bindings.set.bind(bindings)
    bindings.set = async (..._args: Parameters<typeof original>) => { throw new Error('storage down') }
    await expect(router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u1')).rejects.toThrow('storage down')
    expect(sessions.has('sess-target')).toBe(false)
    expect(resumed[0].agent.dispose).toHaveBeenCalledTimes(1)   // 释放写句柄，否则重试即 already owned
  })

  test('摘除时 dispose 释放宿主写句柄：之后可 resume 切回（already owned 回归）', async () => {
    const { router, sessions, resumed } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const oldId = old.sessionId
    await router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u1')
    await new Promise((r) => setTimeout(r, 0))        // releaseUnbound 落定
    expect(sessions.has(oldId)).toBe(false)
    expect(old.agent.dispose).toHaveBeenCalledTimes(1)
    // 写句柄已释放：切回走 resume（真实宿主此时不再报 already owned）
    await router.switchTo(fakeBot(), 'oc_1', oldId, reply, 'ou_u1')
    expect(resumed.filter((r) => r.input.sessionId === oldId)).toHaveLength(1)
  })

  test('摘除窗口内被切回：不 dispose（runtime 仍存活复用）', async () => {
    const { router, sessions } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const oldId = old.sessionId
    let idle!: () => void
    old.agent.whenIdle = () => new Promise<void>((resolve) => { idle = resolve })
    await router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u1')
    await router.switchTo(fakeBot(), 'oc_1', oldId, reply, 'ou_u1')   // 切回（内存复用）
    idle()
    await new Promise((r) => setTimeout(r, 0))
    expect(sessions.get(oldId)).toBe(old)
    expect(old.agent.dispose).not.toHaveBeenCalled()
  })

  test('switchTo 不 attach：目标会话可能仍是空白（挂载延迟到首条消息投递）', async () => {
    const { router, workspace } = setup()
    await router.switchTo(fakeBot(), 'oc_1', 'sess-target', reply, 'ou_u1')
    expect(workspace.attach).not.toHaveBeenCalled()
  })

  test('/new retire：收尾落定后 dispose 释放写句柄（旧会话之后可被 /switch resume 接管）', async () => {
    const { router, sessions } = setup()
    const old = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const oldId = old.sessionId
    await router.reset(fakeBot(), 'oc_1', reply, 'ou_u1')
    await new Promise((r) => setTimeout(r, 0))        // retire 收尾落定
    expect(old.agent.cancel).toHaveBeenCalled()
    expect(sessions.has(oldId)).toBe(false)
    expect(old.agent.dispose).toHaveBeenCalledTimes(1)
  })

  test('目标在宿主内存存活（web 界面持有写句柄）：接管复用，不 resume（宿主 createOrAdopt 同款）', async () => {
    const { router, bindings, live, resumed, defaultModel } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const webOwned = fakeAgent('sess-web')
    live.set('sess-web', webOwned)
    const rt = await router.switchTo(fakeBot(), 'oc_1', 'sess-web', reply, 'ou_u2')
    expect(resumed).toHaveLength(0)                   // live 直接复用，resume 会 already owned
    expect(rt.agent).toBe(webOwned)
    expect(rt.initiatorOpenId).toBe('ou_u2')          // 切换人成为发起人（审批校验用）
    expect(defaultModel).toHaveBeenCalledTimes(1)     // 接管不重跑装配（保持其当前装配）
    expect(bindings.get('reviewer', 'oc_1')).toBe('sess-web')
  })

  test('ensure：绑定会话在宿主存活但不在插件 map（重启窗口外被 web 接管）→ 复用不 resume', async () => {
    const { router, bindings, live, resumed } = setup()
    await bindings.set('reviewer', 'oc_1', 'sess-web')
    const webOwned = fakeAgent('sess-web')
    live.set('sess-web', webOwned)
    const rt = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(resumed).toHaveLength(0)
    expect(rt.agent).toBe(webOwned)
  })
})

describe('Router.attachOnce（首条消息投递时的惰性 workspace 挂载）', () => {
  test('首次调用 attach 到 bot 项目 workspace', async () => {
    const { router, workspace } = setup()
    await router.attachOnce(fakeBot(), 'sess-1')
    expect(workspace.attach).toHaveBeenCalledWith('D:\\work\\demo', 'sess-1')
  })

  test('同一会话重复调用只 attach 一次（每进程幂等）', async () => {
    const { router, workspace } = setup()
    await router.attachOnce(fakeBot(), 'sess-1')
    await router.attachOnce(fakeBot(), 'sess-1')
    expect(workspace.attach).toHaveBeenCalledOnce()
  })

  test('不同会话各自 attach 一次', async () => {
    const { router, workspace } = setup()
    await router.attachOnce(fakeBot(), 'sess-1')
    await router.attachOnce(fakeBot(), 'sess-2')
    expect(workspace.attach).toHaveBeenCalledTimes(2)
  })

  test('attach 失败仅告警、不计入已挂载（下条消息重试）', async () => {
    const { router, workspace, onWarn } = setup()
    workspace.attach.mockRejectedValueOnce(new Error('no workspaceRegistry'))
    await router.attachOnce(fakeBot(), 'sess-1')       // 不抛出
    expect(onWarn).toHaveBeenCalledOnce()
    await router.attachOnce(fakeBot(), 'sess-1')       // 重试
    expect(workspace.attach).toHaveBeenCalledTimes(2)
  })
})
