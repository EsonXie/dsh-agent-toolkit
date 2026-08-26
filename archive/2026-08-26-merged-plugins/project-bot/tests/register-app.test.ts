import { describe, expect, test, vi } from 'vitest'
import { RegisterAppService, type RegisterAppFn } from '../src/register-app.ts'

function harness(registerApp: RegisterAppFn, timeoutMs = 60_000) {
  const stored: { appId: string; secret: string }[] = []
  let n = 0
  const svc = new RegisterAppService({
    registerApp,
    storeSecret: async (appId, secret) => {
      stored.push({ appId, secret })
      return `project_bot_${appId.slice(4, 12)}`
    },
    timeoutMs,
    newId: () => `reg_${++n}`,
  })
  return { svc, stored }
}

describe('RegisterAppService', () => {
  test('完整流程：pending(带 url) → done(凭证已入库)', async () => {
    const registerApp: RegisterAppFn = async (options) => {
      options.onQRCodeReady({ url: 'https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH', expireIn: 600 })
      return { client_id: 'cli_a1b2c3d4e5f60718', client_secret: 's3cret' }
    }
    const { svc, stored } = harness(registerApp)
    const id = svc.start()
    await vi.waitFor(() => { expect(svc.get(id)).toMatchObject({ status: 'pending', url: 'https://open.feishu.cn/page/launcher?user_code=ABCD-EFGH' }) })
    await vi.waitFor(() => { expect(svc.get(id)?.status).toBe('done') })
    expect(svc.get(id)).toMatchObject({ status: 'done', appId: 'cli_a1b2c3d4e5f60718', credentialRef: 'project_bot_a1b2c3d4' })
    expect(stored).toEqual([{ appId: 'cli_a1b2c3d4e5f60718', secret: 's3cret' }])
    svc.dispose()
  })

  test('用户拒绝 → error（code 透传）', async () => {
    const registerApp: RegisterAppFn = async () => {
      throw Object.assign(new Error('denied'), { code: 'access_denied' })
    }
    const { svc } = harness(registerApp)
    const id = svc.start()
    await vi.waitFor(() => { expect(svc.get(id)).toMatchObject({ status: 'error', code: 'access_denied' }) })
    svc.dispose()
  })

  test('超时自动 abort → error', async () => {
    const registerApp: RegisterAppFn = (options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'abort' })))
    })
    const { svc } = harness(registerApp, 50)
    const id = svc.start()
    await vi.waitFor(() => { expect(svc.get(id)).toMatchObject({ status: 'error', code: 'abort' }) }, { timeout: 2000 })
    svc.dispose()
  })

  test('dispose 中断进行中的轮询', async () => {
    let aborted = false
    const registerApp: RegisterAppFn = (options) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('x'), { code: 'abort' })) })
    })
    const { svc } = harness(registerApp)
    svc.start()
    svc.dispose()
    await vi.waitFor(() => { expect(aborted).toBe(true) })
  })
})
