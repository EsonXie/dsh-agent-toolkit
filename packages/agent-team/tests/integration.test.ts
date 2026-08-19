import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { apply, type Config } from '../src/index.ts'
import { TEAM_SELECTED_EVENT, type TeamProjection } from '../src/types.ts'

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'team-preset')

interface RegisteredTool { name: string; description: string }
interface CommandDef {
  name: string
  handler: (inv: { agent: unknown; rawInput: string }) => { kind: string; text: string }
}
interface ProjectionDef {
  key: string
  init: () => TeamProjection
  apply: (state: TeamProjection, event: SessionEvent) => TeamProjection
}

function fakeCtx(events: SessionEvent[], baseUrl?: string) {
  const tools: RegisteredTool[] = []
  const toolDisposers: (() => void)[] = []
  const sections: { name: string; order: number; text: unknown }[] = []
  const commands: CommandDef[] = []
  const projections: ProjectionDef[] = []
  const appended: SessionEvent[] = []
  const agent = {
    session: {
      events,
      append: (type: string, data: unknown) => {
        const event = { type, data } as SessionEvent
        events.push(event)
        appended.push(event)
      },
    },
  }
  const services: Record<string, unknown> = {
    commands: { register: (def: CommandDef) => { commands.push(def); return () => {} } },
    sessionProjections: { register: (def: ProjectionDef) => { projections.push(def); return () => {} } },
  }
  const ctx = {
    baseUrl,
    agent,
    tools: { register: (tool: RegisteredTool) => { tools.push(tool); const d = () => {}; toolDisposers.push(d); return d } },
    systemPrompt: { section: (s: { name: string; order: number; text: unknown }) => { sections.push(s); return () => {} } },
    subagents: { start: async () => { throw new Error('integration test 不发起真实委派') } },
    inject: (names: string[], cb: (c: unknown) => void) => { cb({ ...ctx, [names[0]]: services[names[0]] }) },
    logger: { info: () => {}, warn: () => {} },
  }
  return { ctx: ctx as unknown as Context, tools, sections, commands, projections, appended, agent }
}

const presetUrl = () => pathToFileURL(FIXTURE_DIR + '/').href

test('激活：注册 team_delegate（默认团队名册入 description）、/team 命令、team 投影与提示段', async () => {
  const { ctx, tools, sections, commands, projections } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  expect(tools.map(t => t.name)).toEqual(['team_delegate'])
  expect(tools[0].description).toContain('reviewer: 代码审查员')   // 默认团队 = 字典序首个 alpha
  expect(tools[0].description).not.toContain('researcher')
  expect(commands.map(c => c.name)).toEqual(['team'])
  expect(projections.map(p => p.key)).toEqual(['team'])
  expect(projections[0].init()).toEqual({
    currentId: 'alpha',
    options: [{ id: 'alpha', summary: '代码审查员' }, { id: 'beta', summary: '资料调研与分析' }],
  })
  expect(sections).toHaveLength(1)
  expect(String(sections[0].text)).toContain('team_delegate')
})

test('defaultTeam 命中时作为初始团队；未命中时激活失败', async () => {
  const ok = fakeCtx([], presetUrl())
  await apply(ok.ctx, { defaultTeam: 'beta' } as Config)
  expect(ok.tools[0].description).toContain('researcher: 资料调研与分析')
  const bad = fakeCtx([], presetUrl())
  await expect(apply(bad.ctx, { defaultTeam: 'ghost' } as Config)).rejects.toThrowError(/ghost/)
})

test('/team 无参数：返回当前团队与可用列表', async () => {
  const { ctx, commands, agent } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const result = commands[0].handler({ agent, rawInput: '' })
  expect(result.kind).toBe('success')
  expect(result.text).toContain('alpha')
})

test('/team 切换成功：旧工具注册被 dispose、新工具 description 含新名册、事件入日志', async () => {
  const { ctx, tools, commands, appended, agent } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const result = commands[0].handler({ agent, rawInput: 'beta' })
  expect(result.kind).toBe('success')
  expect(tools).toHaveLength(2)                                   // 重注册产物
  expect(tools[1].description).toContain('researcher: 资料调研与分析')
  expect(appended.map(e => e.type)).toEqual([TEAM_SELECTED_EVENT])
  expect((appended[0].data as { team: string }).team).toBe('beta')
})

test('/team 未知团队：error 且列出可用团队，不重注册', async () => {
  const { ctx, tools, commands, agent } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const result = commands[0].handler({ agent, rawInput: 'ghost' })
  expect(result.kind).toBe('error')
  expect(result.text).toContain('alpha, beta')
  expect(tools).toHaveLength(1)
})

test('/team 会话已开始：拒绝锁定，不重注册、不入日志', async () => {
  const events = [{ type: 'turn/start', data: {} } as SessionEvent]
  const { ctx, tools, commands, appended, agent } = fakeCtx(events, presetUrl())
  await apply(ctx, {} as Config)
  const result = commands[0].handler({ agent, rawInput: 'beta' })
  expect(result.kind).toBe('error')
  expect(result.text).toContain('锁定')
  expect(tools).toHaveLength(1)
  expect(appended).toHaveLength(0)
})

test('冷恢复：日志含 team/selected 时初始团队与投影 currentId 跟随', async () => {
  const events = [{ type: TEAM_SELECTED_EVENT, data: { team: 'beta' } } as SessionEvent]
  const { ctx, tools, projections } = fakeCtx(events, presetUrl())
  await apply(ctx, {} as Config)
  expect(tools[0].description).toContain('researcher')
  expect(projections[0].init().currentId).toBe('beta')
})

test('投影 apply：team/selected 事件更新 currentId，其他事件原样', async () => {
  const { ctx, projections } = fakeCtx([], presetUrl())
  await apply(ctx, {} as Config)
  const init = projections[0].init()
  const next = projections[0].apply(init, { type: TEAM_SELECTED_EVENT, data: { team: 'beta' } } as SessionEvent)
  expect(next.currentId).toBe('beta')
  expect(projections[0].apply(init, { type: 'user/message', data: {} } as SessionEvent)).toBe(init)
})

test('teamsDir 指向缺失目录时激活失败', async () => {
  const { ctx } = fakeCtx([], presetUrl())
  await expect(apply(ctx, { teamsDir: './missing' } as Config)).rejects.toThrowError(/missing/)
})
