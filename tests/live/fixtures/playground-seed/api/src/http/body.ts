import type { IncomingMessage } from 'node:http'
import { ValidationError } from '../services/errors.ts'

export async function readJson(req: IncomingMessage, limitBytes = 65_536): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limitBytes) throw new ValidationError('body too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw new ValidationError('empty body')
  try {
    return JSON.parse(text)
  } catch {
    throw new ValidationError('invalid json')
  }
}
