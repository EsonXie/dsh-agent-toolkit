import { describe, expect, test, vi } from 'vitest'
import type { ReplyHandle } from './channel.ts'
import type { AgentPort, AgentsPort, BindingStore, SessionRuntime, WorkspacePort } from './ports.ts'
import { Router } from './router.ts'
import type { BotRecord } from '../bots/store.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import type { AgentRecord } from '../agents/store.ts'

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
  return { sessionId, followup: vi.fn(), cancel: vi.fn(), whenIdle: vi.fn(async () => undefined) }
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
  const agents: AgentsPort = {
    create: async (input) => { const agent = fakeAgent(input.sessionId); created.push({ input: input as unknown as Record<string, unknown>, agent }); return agent },
    resume: async (input) => { const agent = fakeAgent(input.sessionId); resumed.push({ input: input as unknown as Record<string, unknown>, agent }); return agent },
  }
  const bindings = fakeBindings()
  const sessions = new Map<string, SessionRuntime>()
  const defaultModelFn = vi.fn(defaultModel)
  const workspace: WorkspacePort & { attach: ReturnType<typeof vi.fn> } = { attach: vi.fn(async () => undefined) }
  const onWarn = vi.fn()
  return { agents, bindings, sessions, workspace, onWarn, router: new Router(agents, bindings, sessions, defaultModelFn, workspace, onWarn, registry), created, resumed, defaultModel: defaultModelFn }
}

describe('Router.ensure', () => {
  test('无绑定：create 新 agent 并写绑定，persona/tools/cwd 透传', async () => {
    const { router, bindings, created } = setup()
    const rt = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(created).toHaveLength(1)
    expect(created[0].input.cwd).toBe('D:\\work\\demo')
    expect(created[0].input.hooks).toEqual({ persona: '你是评审助手', tools: ['bash'], sections: [SENDER] })
    expect(bindings.get('reviewer', 'oc_1')).toBe(rt.sessionId)
    expect(rt.reply).toBe(reply)
  })

  test('有绑定且进程内有 runtime：直接复用并刷新 reply', async () => {
    const { router, created, resumed } = setup()
    const first = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    const reply2 = {} as ReplyHandle
    const second = await router.ensure(fakeBot(), 'oc_1', reply2, 'ou_u1')
    expect(second).toBe(first)
    expect(first.reply).toBe(reply2)
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

  test('bot 无 agentOptions：create 回退宿主默认模型（{provider, model}）', async () => {
    const { router, created, defaultModel } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).toHaveBeenCalledOnce()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
  })

  test('bot 有 agentOptions：原样透传，不触发默认模型回退', async () => {
    const { router, created, defaultModel } = setup()
    await router.ensure(fakeBot({ agentOptions: { provider: 'openai', model: 'gpt-4o' } }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).not.toHaveBeenCalled()
    expect(created[0].input.agentOptions).toEqual({ provider: 'openai', model: 'gpt-4o' })
  })

  test('resume 恢复路径：无 agentOptions 同样回退默认模型', async () => {
    const { router, bindings, resumed, defaultModel } = setup()
    await bindings.set('reviewer', 'oc_1', 'sess-old')
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).toHaveBeenCalledOnce()
    expect(resumed[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
  })

  test('create 后 attach 到 bot 项目 workspace（原生 UI 同款挂载）', async () => {
    const { router, workspace } = setup()
    const rt = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(workspace.attach).toHaveBeenCalledWith('D:\\work\\demo', rt.sessionId)
  })

  test('resume 后同样 attach（bootstrap 之后才建的会话兜底归组）', async () => {
    const { router, bindings, workspace } = setup()
    await bindings.set('reviewer', 'oc_1', 'sess-old')
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(workspace.attach).toHaveBeenCalledWith('D:\\work\\demo', 'sess-old')
  })

  test('进程内复用路径不重复 attach', async () => {
    const { router, workspace } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(workspace.attach).toHaveBeenCalledOnce()
  })

  test('attach 失败仅告警，不阻塞 ensure', async () => {
    const { router, workspace, onWarn } = setup()
    workspace.attach.mockRejectedValueOnce(new Error('no workspaceRegistry'))
    const rt = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(rt.sessionId).toBeTruthy()
    expect(onWarn).toHaveBeenCalledOnce()
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
})

test('Router.lookup 按绑定反查 runtime', async () => {
  const { router } = setup()
  expect(router.lookup('reviewer', 'oc_1')).toBeUndefined()
  const rt = await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
  expect(router.lookup('reviewer', 'oc_1')).toBe(rt)
})

describe('Router.ensure agentRef 绑定', () => {
  test('agentRef 指向 main：不注册角色 section、不 restrict，agentOptions 走默认模型回退', async () => {
    const { router, created, defaultModel } = setup(undefined, fakeRegistry([MAIN_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'main' }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).toHaveBeenCalledOnce()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
    expect(created[0].input.hooks).toEqual({ persona: '你是评审助手', tools: ['bash'], sections: [SENDER] })
  })

  test('agentRef 指向角色：注册单 persona section + tools.restrict({ allow }) + agentOptions=role.model', async () => {
    const { router, created, defaultModel } = setup(undefined, fakeRegistry([MAIN_ROLE, REVIEWER_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'reviewer' }), 'oc_1', reply, 'ou_u1')
    expect(defaultModel).not.toHaveBeenCalled()
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    expect(created[0].input.hooks).toEqual({
      sections: [
        { name: 'dsh-agent-toolkit:agent:persona', order: 0, text: '你是团队的评审成员。\n只审查 diff，不修改代码。' },
        SENDER,
      ],
      tools: ['bash', 'fs_read'],
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
        SENDER,
      ],
      tools: ['bash', 'fs_read'],
    })
  })

  test('agentRef 指向不存在角色：warn 并降级 main（默认模型 + hooksOf，不注册 section）', async () => {
    const { router, created, onWarn } = setup(undefined, fakeRegistry([MAIN_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'ghost' }), 'oc_1', reply, 'ou_u1')
    expect(onWarn).toHaveBeenCalledOnce()
    expect(onWarn.mock.calls[0][0]).toContain('ghost')
    expect(created[0].input.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
    expect(created[0].input.hooks).toEqual({ persona: '你是评审助手', tools: ['bash'], sections: [SENDER] })
  })
})

describe('Router 发起人提示段', () => {
  test('create（主 Agent 形态）：hooks.sections 末尾追加 sender 段', async () => {
    const { router, created } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(created[0].input.hooks).toEqual({ persona: '你是评审助手', tools: ['bash'], sections: [SENDER] })
  })

  test('resume 路径同样注入', async () => {
    const { router, bindings, resumed } = setup()
    await bindings.set('reviewer', 'oc_1', 'sess-old')
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(resumed[0].input.hooks).toMatchObject({ sections: [SENDER] })
  })

  test('角色形态：sender 段追加在角色 persona 段之后', async () => {
    const { router, created } = setup(undefined, fakeRegistry([MAIN_ROLE, REVIEWER_ROLE]).registry)
    await router.ensure(fakeBot({ agentRef: 'reviewer' }), 'oc_1', reply, 'ou_u1')
    expect(created[0].input.hooks).toEqual({
      sections: [
        { name: 'dsh-agent-toolkit:agent:persona', order: 0, text: '你是团队的评审成员。\n只审查 diff，不修改代码。' },
        SENDER,
      ],
      tools: ['bash', 'fs_read'],
    })
  })

  test('injectSender=false：不追加 sender 段', async () => {
    const { agents, bindings, sessions, workspace, onWarn, defaultModel, created } = setup()
    const router = new Router(agents, bindings, sessions, defaultModel, workspace, onWarn, fakeRegistry().registry, false)
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    expect(created[0].input.hooks).toEqual({ persona: '你是评审助手', tools: ['bash'] })
    expect(created[0].input.hooks).not.toHaveProperty('sections')
  })

  test('/new 重置后新会话仍注入（发起人取当前消息发送人）', async () => {
    const { router, created } = setup()
    await router.ensure(fakeBot(), 'oc_1', reply, 'ou_u1')
    await router.reset(fakeBot(), 'oc_1', reply, 'ou_u2')
    expect(created[1].input.hooks).toMatchObject({
      sections: [{ name: SENDER.name, order: 20, text: '本会话由 feishu 渠道的单聊会话发起。发起人 ID（feishu open_id）：`ou_u2`。' }],
    })
  })
})
