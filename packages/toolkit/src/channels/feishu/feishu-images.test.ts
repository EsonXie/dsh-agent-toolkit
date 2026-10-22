/** 出站图片净化纯函数契约：完整引用三态转换、img_v* 幂等、外部形态降级、不完整尾部放行。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { FeishuApi } from './api.ts'
import { ImageResolver, IMAGE_UPLOAD_MAX_BYTES, sanitizeSegments, sanitizeText, stripImages, type ImageLookup, type ImageResolution } from './images.ts'

const ready: ImageLookup = () => ({ status: 'ready', imgKey: 'img_v3_ok' })
const pending: ImageLookup = () => ({ status: 'pending' })
const failed: ImageLookup = () => ({ status: 'failed' })

describe('sanitizeText', () => {
  test('无图片文本恒等', () => {
    expect(sanitizeText('普通 **markdown** [链接](https://a.b/c)', ready)).toBe('普通 **markdown** [链接](https://a.b/c)')
  })

  test('本地路径 ready → ![alt](img_key)（尖括号与裸形态）', () => {
    expect(sanitizeText('见下图 ![chart](<C:\\work\\my chart.png>) 完', ready)).toBe('见下图 ![chart](img_v3_ok) 完')
    expect(sanitizeText('![图](out/a.png)', ready)).toBe('![图](img_v3_ok)')
  })

  test('pending → 上传中占位；failed → 无法发送', () => {
    expect(sanitizeText('![chart](a.png)', pending)).toBe('🖼 chart（图片上传中…）')
    expect(sanitizeText('![chart](a.png)', failed)).toBe('🖼 chart（图片无法发送）')
  })

  test('空 alt 用「图片」；alt 截断 50 code point', () => {
    expect(sanitizeText('![](a.png)', pending)).toBe('🖼 图片（图片上传中…）')
    const longAlt = '字'.repeat(60)
    expect(sanitizeText(`![${longAlt}](a.png)`, failed)).toBe(`🖼 ${'字'.repeat(50)}（图片无法发送）`)
  })

  test('img_v* dest 原样保留（幂等）', () => {
    expect(sanitizeText('![chart](img_v3_abc)', ready)).toBe('![chart](img_v3_abc)')
  })

  test('http(s)/data URI 降级为无法发送', () => {
    expect(sanitizeText('![x](https://a.b/c.png)', ready)).toBe('🖼 x（图片无法发送）')
    expect(sanitizeText('![x](data:image/png;base64,AA==)', ready)).toBe('🖼 x（图片无法发送）')
  })

  test('不完整尾部引用原样放行（流式中间态）', () => {
    expect(sanitizeText('正文 ![chart](<C:\\work\\my', pending)).toBe('正文 ![chart](<C:\\work\\my')
    expect(sanitizeText('正文 ![chart]', pending)).toBe('正文 ![chart]')
  })

  test('同段多图各自独立转换', () => {
    expect(sanitizeText('![a](1.png) 中 ![b](2.png)', ready)).toBe('![a](img_v3_ok) 中 ![b](img_v3_ok)')
  })
})

describe('sanitizeSegments', () => {
  test('text 与 process 段同规则净化', () => {
    const out = sanitizeSegments([
      { kind: 'text', content: '![a](1.png)' },
      { kind: 'process', content: '想 ![b](2.png)' },
    ], ready)
    expect(out).toEqual([
      { kind: 'text', content: '![a](img_v3_ok)' },
      { kind: 'process', content: '想 ![b](img_v3_ok)' },
    ])
  })
})

describe('stripImages', () => {
  test('剥离图片语法留 alt 纯文本；不完整引用不动', () => {
    expect(stripImages('见 ![chart](a.png) 完 ![x](<b c.png>)')).toBe('见 chart 完 x')
    expect(stripImages('尾部 ![chart](<C:\\work')).toBe('尾部 ![chart](<C:\\work')
  })
})

const PNG_1PX = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))

function fakeApi(impl: (data: Uint8Array) => Promise<string>): { api: FeishuApi; uploads: Uint8Array[] } {
  const uploads: Uint8Array[] = []
  const api = { uploadImage: async (data: Uint8Array) => { uploads.push(data); return impl(data) } } as unknown as FeishuApi
  return { api, uploads }
}

// 条件等待：轮询 resolve 直到非 pending（readFile 走线程池，微任务循环不足以等真实 I/O）
const waitSettled = async (r: ImageResolver, path: string): Promise<ImageResolution> => {
  for (let i = 0; i < 100; i++) {
    const s = r.resolve(path)
    if (s.status !== 'pending') return s
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('upload not settled in time')
}

describe('ImageResolver', () => {
  test('首次 resolve 返回 pending 并启动上传；落定后 ready + onSettled 回调', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'img-resolver-'))
    try {
      await writeFile(join(dir, 'a.png'), PNG_1PX)
      let settled = 0
      const { api, uploads } = fakeApi(async () => 'img_v3_up')
      const r = new ImageResolver(api, dir, () => { settled += 1 })
      expect(r.resolve('a.png')).toEqual({ status: 'pending' })
      expect(await waitSettled(r, 'a.png')).toEqual({ status: 'ready', imgKey: 'img_v3_up' })
      expect(uploads.length).toBe(1)
      expect(settled).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('相对路径按项目根解析；绝对路径原样；同路径共享一次上传', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'img-resolver-'))
    try {
      await writeFile(join(dir, 'a.png'), PNG_1PX)
      const { api, uploads } = fakeApi(async () => 'img_v3_up')
      const r = new ImageResolver(api, dir, () => undefined)
      r.resolve('a.png')
      r.resolve(join(dir, 'a.png'))   // 归一化后同键
      await waitSettled(r, 'a.png')
      expect(uploads.length).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('读不到/非图片/上传失败 → failed 永久定格（不重复上传），onSettled 仍回调', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'img-resolver-'))
    try {
      await writeFile(join(dir, 'not-image.txt'), new TextEncoder().encode('hello'))
      await writeFile(join(dir, 'c.png'), PNG_1PX)
      const { api, uploads } = fakeApi(async () => { throw new Error('boom') })
      const r = new ImageResolver(api, dir, () => undefined)
      expect(r.resolve('missing.png')).toEqual({ status: 'pending' })
      expect(r.resolve('not-image.txt')).toEqual({ status: 'pending' })
      expect(r.resolve('c.png')).toEqual({ status: 'pending' })
      expect(await waitSettled(r, 'missing.png')).toEqual({ status: 'failed' })
      expect(await waitSettled(r, 'not-image.txt')).toEqual({ status: 'failed' })
      expect(await waitSettled(r, 'c.png')).toEqual({ status: 'failed' })
      expect(uploads.length).toBe(1)   // missing 读文件失败、not-image 魔数不符，只有 c.png 到达上传
      r.resolve('c.png')
      await waitSettled(r, 'c.png')
      expect(uploads.length).toBe(1)   // failed 定格不重试
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('超过 maxBytes → failed 不上传', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'img-resolver-'))
    try {
      await writeFile(join(dir, 'big.png'), PNG_1PX)
      const { api, uploads } = fakeApi(async () => 'img_v3_up')
      const r = new ImageResolver(api, dir, () => undefined, 4)   // 4 字节上限，1px PNG ~70 字节
      expect(r.resolve('big.png')).toEqual({ status: 'pending' })
      expect(await waitSettled(r, 'big.png')).toEqual({ status: 'failed' })
      expect(uploads.length).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('maxBytes 默认值 = 平台 10MB', () => {
    expect(IMAGE_UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024)
  })
})
