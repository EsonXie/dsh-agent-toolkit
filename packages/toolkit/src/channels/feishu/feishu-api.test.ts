/** FeishuApi 薄封装的新增方法：uploadFile（im/v1 files stream 上传）与 sendFile（file 消息）契约。 */
import { describe, expect, test, vi } from 'vitest'
import type * as lark from '@larksuiteoapi/node-sdk'
import { createFeishuApi } from './api.ts'

function mockClient() {
  // 注意与真实 SDK 形态一致：im.file.create 在响应拦截器剥掉 axios 层后再剥一层信封
  // （lib: `return res?.data || null`），resolve 的是内层 data（{ file_key } 或 null），
  // 信封 code/msg 被 SDK 丢弃。已用真实应用凭证实测验证（2026-09-11）。
  const fileCreate = vi.fn(async (payload: { data: { file_type: string; file_name: string; file: Buffer } }): Promise<{ file_key?: string } | null> => ({ file_key: 'file_v3_xxx' }))
  const messageCreate = vi.fn(async () => ({ code: 0, msg: 'success', data: {} }))
  const client = { im: { file: { create: fileCreate }, message: { create: messageCreate } } }
  return { client: client as unknown as lark.Client, fileCreate, messageCreate }
}

describe('FeishuApi.uploadFile / sendFile', () => {
  test('uploadFile：stream 类型上传并返回 file_key', async () => {
    const { client, fileCreate } = mockClient()
    const api = createFeishuApi(client)
    const key = await api.uploadFile('report.md', new TextEncoder().encode('# 报告'))
    expect(key).toBe('file_v3_xxx')
    const call = fileCreate.mock.calls[0][0] as { data: { file_type: string; file_name: string; file: Buffer } }
    expect(call.data.file_type).toBe('stream')
    expect(call.data.file_name).toBe('report.md')
    expect(Buffer.isBuffer(call.data.file)).toBe(true)
  })

  test('uploadFile：SDK 丢弃信封（resolve null）时抛出可读错误', async () => {
    const { client, fileCreate } = mockClient()
    fileCreate.mockResolvedValueOnce(null)
    const api = createFeishuApi(client)
    await expect(api.uploadFile('a.md', new Uint8Array(1))).rejects.toThrow('文件上传失败：飞书接口未返回 file_key')
  })

  test('sendFile：msg_type=file 且 content 携带 file_key', async () => {
    const { client, messageCreate } = mockClient()
    const api = createFeishuApi(client)
    await api.sendFile('oc_1', 'file_v3_xxx')
    expect(messageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_1', msg_type: 'file', content: JSON.stringify({ file_key: 'file_v3_xxx' }) },
    })
  })
})

describe('FeishuApi 出站锚点（replyToMessageId）', () => {
  test('sendText 带锚点时走 im.message.reply', async () => {
    const calls: { method: string; args: unknown }[] = []
    const fakeClient = {
      im: {
        message: {
          create: async (args: unknown) => { calls.push({ method: 'create', args }) },
          reply: async (args: unknown) => { calls.push({ method: 'reply', args }) },
        },
      },
    }
    const api = createFeishuApi(fakeClient as never)
    await api.sendText('oc_1', 'hello', 'om_anchor')
    expect(calls).toEqual([{
      method: 'reply',
      args: { path: { message_id: 'om_anchor' }, data: { msg_type: 'text', content: JSON.stringify({ text: 'hello' }) } },
    }])
  })

  test('sendText 无锚点维持 create', async () => {
    const calls: string[] = []
    const fakeClient = {
      im: {
        message: {
          create: async () => { calls.push('create') },
          reply: async () => { calls.push('reply') },
        },
      },
    }
    const api = createFeishuApi(fakeClient as never)
    await api.sendText('oc_1', 'hello')
    expect(calls).toEqual(['create'])
  })

  test('sendCardMessage 带锚点时走 im.message.reply', async () => {
    const calls: { method: string; args: unknown }[] = []
    const fakeClient = {
      im: {
        message: {
          create: async (args: unknown) => { calls.push({ method: 'create', args }) },
          reply: async (args: unknown) => { calls.push({ method: 'reply', args }) },
        },
      },
    }
    const api = createFeishuApi(fakeClient as never)
    await api.sendCardMessage('oc_1', 'card_v3_xxx', 'om_anchor')
    expect(calls).toEqual([{
      method: 'reply',
      args: { path: { message_id: 'om_anchor' }, data: { msg_type: 'interactive', content: JSON.stringify({ type: 'card', data: { card_id: 'card_v3_xxx' } }) } },
    }])
  })

  test('sendFile 带锚点时走 im.message.reply', async () => {
    const calls: { method: string; args: unknown }[] = []
    const fakeClient = {
      im: {
        message: {
          create: async (args: unknown) => { calls.push({ method: 'create', args }) },
          reply: async (args: unknown) => { calls.push({ method: 'reply', args }) },
        },
      },
    }
    const api = createFeishuApi(fakeClient as never)
    await api.sendFile('oc_1', 'file_v3_xxx', 'om_anchor')
    expect(calls).toEqual([{
      method: 'reply',
      args: { path: { message_id: 'om_anchor' }, data: { msg_type: 'file', content: JSON.stringify({ file_key: 'file_v3_xxx' }) } },
    }])
  })
})
