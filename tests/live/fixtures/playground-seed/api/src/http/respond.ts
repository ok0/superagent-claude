import type { ServerResponse } from 'node:http'
import type { Logger } from '../log/logger.ts'
import { ServiceError } from '../services/errors.ts'

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export function sendError(res: ServerResponse, error: unknown, logger: Logger): void {
  if (error instanceof ServiceError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message } })
    return
  }
  logger.error('unhandled error', { message: error instanceof Error ? error.message : String(error) })
  sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } })
}
