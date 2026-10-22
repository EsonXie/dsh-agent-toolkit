/** 出站图片渠道适配：markdown 图片引用净化（纯函数）+ 本地图片上传换 img_key（ImageResolver）。 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { TurnSegment } from '../channel.ts'
import { sniffImageMediaType, type FeishuApi } from './api.ts'

/** 一张图片引用在卡片中的呈现状态。 */
export type ImageResolution =
  | { status: 'ready'; imgKey: string }
  | { status: 'pending' }
  | { status: 'failed' }

/** 净化期查询本地路径解析状态的端口（ImageResolver 实现；imageUpload 关闭时以恒 failed 替代）。 */
export type ImageLookup = (localPath: string) => ImageResolution

/** alt 进占位/降级文案的截断上限（code point）。 */
export const IMAGE_ALT_MAX_CHARS = 50

/** 完整 markdown 图片引用：![alt](dest)，dest 支持尖括号与裸形态；不完整引用（无闭合括号）不匹配、原样放行。 */
const IMAGE_REF = /!\[([^\]\n]*)\]\((<[^>\n]*>|[^)\s]+)\)/g

const truncateAlt = (alt: string): string => {
  const chars = [...alt]
  return chars.length <= IMAGE_ALT_MAX_CHARS ? alt : chars.slice(0, IMAGE_ALT_MAX_CHARS).join('')
}

const uploadingText = (alt: string): string => `🖼 ${truncateAlt(alt) || '图片'}（图片上传中…）`
const failedText = (alt: string): string => `🖼 ${truncateAlt(alt) || '图片'}（图片无法发送）`

/** 把文本中完整图片引用转换为飞书卡片合法形态：img_v* 原样保留；http(s)/data 降级；本地路径按 lookup 三态转换。 */
export function sanitizeText(text: string, lookup: ImageLookup): string {
  return text.replace(IMAGE_REF, (match: string, alt: string, rawDest: string) => {
    const dest = rawDest.startsWith('<') ? rawDest.slice(1, -1) : rawDest
    if (dest.startsWith('img_v')) return match
    if (/^(?:https?:\/\/|data:)/i.test(dest)) return failedText(alt)
    const resolution = lookup(dest)
    if (resolution.status === 'ready') return `![${truncateAlt(alt)}](${resolution.imgKey})`
    if (resolution.status === 'pending') return uploadingText(alt)
    return failedText(alt)
  })
}

/** 200570 兜底：剥离全部完整图片语法，alt 降级为纯文本。 */
export function stripImages(text: string): string {
  return text.replace(IMAGE_REF, (_match: string, alt: string) => alt)
}

/** 段序列净化：text 与 process 段同规则（reasoning 也可能复述图片语法）。 */
export function sanitizeSegments(segments: readonly TurnSegment[], lookup: ImageLookup): TurnSegment[] {
  return segments.map((s) => ({ kind: s.kind, content: sanitizeText(s.content, lookup) }))
}

/** 飞书图片上传大小上限（平台限制 10MB）。 */
export const IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024

/** 本地图片 → img_key 上传器：绝对路径归一化做缓存键，三态永久定格，落定回调触发卡片重刷。 */
export class ImageResolver {
  private readonly cache = new Map<string, ImageResolution>()

  constructor(
    private readonly api: FeishuApi,
    /** 相对路径解析基准（bot 项目根）。 */
    private readonly projectRoot: string,
    /** 上传落定（成功或失败）回调（reply 句柄重刷卡片用）。 */
    private readonly onSettled: () => void,
    private readonly maxBytes: number = IMAGE_UPLOAD_MAX_BYTES,
  ) {}

  resolve(localPath: string): ImageResolution {
    const abs = isAbsolute(localPath) ? localPath : resolvePath(this.projectRoot, localPath)
    const hit = this.cache.get(abs)
    if (hit !== undefined) return hit
    const pending: ImageResolution = { status: 'pending' }
    this.cache.set(abs, pending)
    void this.upload(abs)
    return pending
  }

  private async upload(abs: string): Promise<void> {
    let result: ImageResolution
    try {
      const data = new Uint8Array(await readFile(abs))
      if (data.byteLength === 0 || data.byteLength > this.maxBytes) throw new Error(`图片大小越界（${data.byteLength} 字节）`)
      if (sniffImageMediaType(data) === undefined) throw new Error('魔数不是受支持图片')
      result = { status: 'ready', imgKey: await this.api.uploadImage(data) }
    } catch {
      result = { status: 'failed' }
    }
    this.cache.set(abs, result)
    this.onSettled()
  }
}
