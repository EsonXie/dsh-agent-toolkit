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
