/** 出站图片净化纯函数契约：完整引用三态转换、img_v* 幂等、外部形态降级、不完整尾部放行。 */
import { describe, expect, test } from 'vitest'
import { sanitizeSegments, sanitizeText, stripImages, type ImageLookup } from './images.ts'

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
