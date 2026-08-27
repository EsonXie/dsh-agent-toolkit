import type { IncomingMessage, ServerResponse } from 'node:http'

export const MAX_BODY_BYTES = 64 * 1024

export function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

/** 读 JSON body；超限 413 / 非法 JSON 400（已写响应时返回 undefined）。 */
export async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > MAX_BODY_BYTES) {
      json(res, 413, { error: 'body too large' })
      req.destroy()
      return undefined
    }
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    json(res, 400, { error: 'invalid JSON body' })
    return undefined
  }
}
