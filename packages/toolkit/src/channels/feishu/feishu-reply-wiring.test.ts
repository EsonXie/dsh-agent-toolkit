/** 渠道接线契约：imageUpload 决定是否注入 resolver，resolver 以 bot 项目根解析且落定回调重刷卡片。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { ChannelTunables } from '../channel.ts'
import type { FeishuApi } from './api.ts'
import { createReplyHandle } from './index.ts'
import { FeishuReplyHandle } from './reply.ts'

const PNG_1PX = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))

const TUNABLES: ChannelTunables = {
  cardUpdateThrottleMs: 0,
  cardMaxBytes: 26_000,
  cardPrintStep: 5,
  processMaxBytes: 8_000,
  processingReactionEmoji: 'OneSecond',
  imageUpload: true,
}

function fakeApi() {
  const uploads: Uint8Array[] = []
  const elements = new Map<string, string>()
  let cardSeq = 0
  const api: FeishuApi = {
    createCard: async () => `card_${++cardSeq}`,
    sendCardMessage: async () => undefined,
    updateCardElement: async (_cardId, elementId, content) => { elements.set(elementId, content) },
    insertElement: async (_cardId, elementJson) => {
      const el = JSON.parse(elementJson) as { element_id: string; content: string }
      elements.set(el.element_id, el.content)
    },
    setCardStreaming: async () => undefined,
    replaceCard: async () => undefined,
    sendText: async () => undefined,
    addReaction: async () => 'r1',
    removeReaction: async () => undefined,
    downloadImage: async () => ({ data: new Uint8Array(), mediaType: 'image/png' }),
    getBotOpenId: async () => 'ou_bot',
    uploadFile: async () => 'file_1',
    uploadImage: async (data) => { uploads.push(data); return 'img_v3_wired' },
    sendFile: async () => undefined,
  }
  return { api, uploads, elements }
}

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`${label}（等待超时）`)
}

describe('飞书渠道出站图片接线', () => {
  test('imageUpload=true：resolver 以 bot 项目根解析，落定回调经 notifyImageSettled 重刷卡片', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reply-wiring-'))
    try {
      await writeFile(join(dir, 'chart.png'), PNG_1PX)
      const { api, uploads, elements } = fakeApi()
      const settled = vi.spyOn(FeishuReplyHandle.prototype, 'notifyImageSettled')
      try {
        const reply = createReplyHandle(api, dir, { chatId: 'oc_1', messageId: 'om_1' }, TUNABLES, () => undefined)
        await reply.update([{ kind: 'text', content: '![chart](chart.png)' }])
        await waitFor(() => elements.get('seg_1') === '![chart](img_v3_wired)', '卡片未刷为 img_key')
        expect(uploads).toHaveLength(1)
        expect(settled).toHaveBeenCalled()
      } finally {
        settled.mockRestore()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('imageUpload=false：不构造 resolver，本地图片引用全降级且不上传', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feishu-reply-wiring-'))
    try {
      await writeFile(join(dir, 'chart.png'), PNG_1PX)
      const { api, uploads, elements } = fakeApi()
      const reply = createReplyHandle(api, dir, { chatId: 'oc_1', messageId: 'om_1' }, { ...TUNABLES, imageUpload: false }, () => undefined)
      await reply.update([{ kind: 'text', content: '![chart](chart.png)' }])
      await waitFor(() => elements.get('seg_1') === '🖼 chart（图片无法发送）', '卡片未降级为纯文本')
      expect(uploads).toHaveLength(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
